// The aggregates behind the analytics screen.
//
// Percentiles are computed in JS rather than SQL because SQLite has no
// percentile function, and the row counts here are small enough (~1k runs,
// ~2k jobs) that pulling the durations out and sorting them costs nothing.
// p50 and p95 rather than a mean: CI durations are long-tailed — one cold
// build drags an average somewhere no individual run has ever been.

import { FAILURE_CLASSES } from './failures.js';

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};

const nums = (rows, key) =>
  rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);

const shortRepo = (r) => r.split('/').pop();

// Composite map keys are JSON arrays, not joined strings. Workflow, job and step
// names are free text and routinely contain spaces and punctuation — "iOS
// Release (TestFlight)", "Run every suite" — so any single-character join is a
// key that cannot be reliably split back apart.
const k = (...parts) => JSON.stringify(parts);
const unk = (key) => JSON.parse(key);

const isFail = (c) => c === 'failure' || c === 'timed_out';

// A cancelled run's duration measures how long until something killed it, not
// how long the work takes. Including them puts a 24-hour outlier in the same
// percentile as a 90-second test suite. Timed-out runs stay: hitting the
// timeout IS the duration story.
const timesWork = (c) => c === 'success' || c === 'failure' || c === 'timed_out';

// A run that sat for hours and was then cancelled never got a runner. That is
// almost always a `runs-on:` label no live runner carries — the failure mode the
// abandoned `ollama` label produced for months. GitHub cancels these at 24h, so
// anything past an hour is already pathological.
const ZOMBIE_MS = 60 * 60 * 1000;
const isZombie = (r) => r.conclusion === 'cancelled' && (r.duration_ms ?? 0) > ZOMBIE_MS;

// A job that actually executed on a runner. The distinction matters more than it
// looks: a job that queued 24 hours and was then cancelled still carries a
// started_at and a completed_at, so it presents as a 24-hour interval. Counted
// as work, 139 of those overlap everything else and report a peak concurrency of
// 34 on a host that has 16 runners and therefore cannot exceed 16.
const ran = (j) => Boolean(j.runner_name) && timesWork(j.conclusion);

export function analytics(db, { days = 30, runnersByRepo = new Map() } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const runs = db.prepare(`
    SELECT id, repo, workflow_name, event, status, conclusion, head_sha, head_branch,
           run_started_at, duration_ms
    FROM runs WHERE run_started_at >= ? ORDER BY run_started_at`).all(since);

  // id > 0 skips the negative-id markers the backfill writes for runs whose job
  // detail GitHub no longer serves.
  const jobs = db.prepare(`
    SELECT j.id, j.run_id, j.repo, j.name, j.conclusion, j.runner_name,
           j.started_at, j.completed_at, j.queued_ms, j.duration_ms,
           j.failure_class, r.workflow_name
    FROM jobs j LEFT JOIN runs r ON r.id = j.run_id
    WHERE j.started_at >= ? AND j.id > 0`).all(since);

  const completed = runs.filter((r) => r.status === 'completed');
  const successes = completed.filter((r) => r.conclusion === 'success').length;
  const failures = completed.filter((r) => isFail(r.conclusion)).length;

  // Every runner in this fleet is macOS, and macOS is the expensive one: it
  // bills at 10x against the included allowance on private repos. That
  // multiplier is the entire reason a fleet like this exists — one iOS repo
  // exhausting the allowance blocks Actions ACCOUNT-WIDE, taking the cheap
  // Ubuntu jobs in unrelated repos down with it.
  const selfHostedMs = jobs
    .filter((j) => j.runner_name)
    .reduce((s, j) => s + (j.duration_ms ?? 0), 0);
  const ciMinutes = selfHostedMs / 60000;

  // ---- per repo, with the second-runner question answered explicitly -------
  const byRepo = new Map();
  const bucket = (repo) => {
    if (!byRepo.has(repo)) byRepo.set(repo, { runs: [], jobs: [] });
    return byRepo.get(repo);
  };
  for (const r of completed) bucket(r.repo).runs.push(r);
  for (const j of jobs) bucket(j.repo).jobs.push(j);

  const repos = [...byRepo.entries()].map(([repo, d]) => {
    const durs = nums(d.runs.filter((r) => timesWork(r.conclusion)), 'duration_ms');
    const executed = d.jobs.filter(ran);
    const queues = nums(executed, 'queued_ms');
    const jobDurs = nums(executed, 'duration_ms');
    const runCount = d.runs.length;
    const fails = d.runs.filter((r) => isFail(r.conclusion)).length;
    const p95Queue = pct(queues, 95);
    const runners = runnersByRepo.get(repo) ?? 0;

    // Jobs per run is measured only over runs whose job detail was actually
    // fetched. Dividing by every known run instead makes the ratio track how far
    // the backfill has got, which reads as "0.04 jobs per run" and turns the
    // verdict into confident nonsense.
    const sampledRuns = new Set(d.jobs.map((j) => j.run_id)).size;
    const jobsPerRun = sampledRuns ? d.jobs.length / sampledRuns : null;

    // The lesson this fleet already paid for: a second runner only helps a repo
    // whose workflows have more than one job. A second runner added to a repo
    // whose every workflow was a single job never ran one job in its life. This
    // states that before the registration rather than after it — but only once
    // there is enough job detail to say so.
    let verdict, verdictTone;
    if (!runCount) {
      verdict = 'no completed runs in this window';
      verdictTone = 'muted';
    } else if (sampledRuns < 5) {
      verdict = `only ${sampledRuns} run${sampledRuns === 1 ? '' : 's'} with job detail so far — not enough to judge`;
      verdictTone = 'muted';
    } else if (jobsPerRun < 1.05) {
      verdict = runners > 1
        ? `${runners} runners, but every workflow is a single job — the extra one cannot help`
        : 'single-job workflows — a second runner cannot help';
      verdictTone = runners > 1 ? 'warning' : 'muted';
    } else if (p95Queue != null && p95Queue > 60000) {
      verdict = `${jobsPerRun.toFixed(1)} jobs/run, p95 queue ${Math.round(p95Queue / 1000)}s — a second runner would cut queueing`;
      verdictTone = 'serious';
    } else {
      verdict = `${jobsPerRun.toFixed(1)} jobs/run, p95 queue under a minute — keeping up`;
      verdictTone = 'good';
    }

    return {
      repo,
      name: shortRepo(repo),
      runs: runCount,
      jobs: d.jobs.length,
      sampledRuns,
      jobsPerRun,
      runners,
      zombies: d.runs.filter(isZombie).length,
      p50Duration: pct(durs, 50),
      p95Duration: pct(durs, 95),
      p50Queue: pct(queues, 50),
      p95Queue,
      p50JobDuration: pct(jobDurs, 50),
      failureRate: runCount ? fails / runCount : 0,
      verdict,
      verdictTone,
    };
  }).sort((a, b) => b.jobs - a.jobs);

  // ---- per workflow --------------------------------------------------------
  const wfMap = new Map();
  for (const r of completed) {
    const key = k(r.repo, r.workflow_name);
    if (!wfMap.has(key)) wfMap.set(key, []);
    wfMap.get(key).push(r);
  }
  const workflows = [...wfMap.entries()].map(([key, list]) => {
    const [repo, workflow] = unk(key);
    const timed = list.filter((r) => timesWork(r.conclusion));
    const durs = nums(timed, 'duration_ms');
    const fails = list.filter((r) => isFail(r.conclusion)).length;
    const zombies = list.filter(isZombie);
    return {
      repo, name: shortRepo(repo), workflow,
      runs: list.length,
      timedRuns: timed.length,
      p50: pct(durs, 50),
      p95: pct(durs, 95),
      failureRate: timed.length ? fails / timed.length : 0,
      failures: fails,
      zombies: zombies.length,
      lastZombie: zombies.map((r) => r.run_started_at).sort().pop() ?? null,
    };
  }).filter((w) => w.runs > 0).sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));

  // Workflows that produced runs which queued until GitHub killed them. Ranked
  // by count, because one is an incident and a hundred is a workflow pointed at
  // a label no runner has ever carried.
  const zombies = workflows
    .filter((w) => w.zombies > 0)
    .map((w) => ({
      repo: w.repo, name: w.name, workflow: w.workflow,
      count: w.zombies, lastAt: w.lastZombie, runs: w.runs,
    }))
    .sort((a, b) => b.count - a.count);

  // ---- daily volume --------------------------------------------------------
  const dayMap = new Map();
  for (const r of completed) {
    const day = (r.run_started_at ?? '').slice(0, 10);
    if (!day) continue;
    if (!dayMap.has(day)) dayMap.set(day, { day, success: 0, failure: 0, other: 0 });
    const b = dayMap.get(day);
    if (r.conclusion === 'success') b.success++;
    else if (isFail(r.conclusion)) b.failure++;
    else b.other++;
  }
  const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  // ---- flaky: the same commit red once and green another time --------------
  const shaMap = new Map();
  for (const r of completed) {
    if (!r.head_sha) continue;
    const key = k(r.repo, r.workflow_name, r.head_sha);
    if (!shaMap.has(key)) shaMap.set(key, []);
    shaMap.get(key).push(r);
  }
  const flaky = [];
  for (const [key, list] of shaMap) {
    const [repo, workflow, sha] = unk(key);
    const good = list.some((r) => r.conclusion === 'success');
    const bad = list.some((r) => isFail(r.conclusion));
    if (good && bad) {
      flaky.push({
        repo, name: shortRepo(repo), workflow, sha: String(sha).slice(0, 7),
        attempts: list.length,
        branch: list[0].head_branch,
        lastAt: list.map((r) => r.run_started_at).sort().pop(),
      });
    }
  }
  flaky.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  // ---- where the time goes, step by step -----------------------------------
  const stepRows = db.prepare(`
    SELECT j.repo, r.workflow_name, j.name AS job_name, s.name AS step_name, s.duration_ms
    FROM steps s
    JOIN jobs j ON j.id = s.job_id
    LEFT JOIN runs r ON r.id = j.run_id
    WHERE s.duration_ms IS NOT NULL AND j.started_at >= ?
      AND j.runner_name IS NOT NULL AND j.runner_name != ''`).all(since);

  const stepMap = new Map();
  for (const s of stepRows) {
    const key = k(s.repo, s.workflow_name, s.job_name, s.step_name);
    if (!stepMap.has(key)) stepMap.set(key, []);
    stepMap.get(key).push(s.duration_ms);
  }
  const steps = [...stepMap.entries()].map(([key, list]) => {
    const [repo, workflow, job, step] = unk(key);
    const sorted = list.slice().sort((a, b) => a - b);
    const p50 = pct(sorted, 50);
    const p95 = pct(sorted, 95);
    return {
      repo, name: shortRepo(repo), workflow, job, step,
      samples: list.length,
      p50, p95,
      totalMs: list.reduce((a, b) => a + b, 0),
      // A step that is fast most of the time and slow sometimes is a cache that
      // misses sometimes. That is the `actions/checkout` clean:true class of
      // problem — on one iOS repo here it was 236s per run, rebuilding a
      // SwiftPM build directory that checkout had just deleted.
      bimodal: p50 != null && p95 != null && p50 > 1000 && p95 > p50 * 4 && list.length >= 4,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);

  // ---- concurrency: a sweep line over job intervals -------------------------
  // How often two heavy builds were on the machine at once, which is the
  // question the 16 GB box answered painfully and the 32 GB one still can.
  const events = [];
  for (const j of jobs) {
    if (!ran(j) || !j.started_at || !j.completed_at) continue;
    events.push([new Date(j.started_at).getTime(), 1]);
    events.push([new Date(j.completed_at).getTime(), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, maxConcurrent = 0, lastTs = null;
  const histogram = new Map();
  for (const [ts, delta] of events) {
    if (lastTs != null && cur > 0) histogram.set(cur, (histogram.get(cur) ?? 0) + (ts - lastTs));
    cur += delta;
    maxConcurrent = Math.max(maxConcurrent, cur);
    lastTs = ts;
  }

  // ---- why the failures failed ---------------------------------------------
  // A failure rate is two numbers wearing one hat. Over 2026-07-29 to 08-08 this
  // fleet took 55 job failures that were the account's Actions spending limit
  // refusing to start the job — no runner involved, no code at fault — and they
  // are indistinguishable from a broken test in the runs table. Splitting by
  // blame is what makes the rate mean something: 'code' is yours to fix, 'host'
  // is this machine's, and 'account' is a billing page.
  const failedJobs = jobs.filter((j) => j.conclusion === 'failure');
  const causeCounts = new Map();
  const blameCounts = new Map();
  const causeRepos = new Map();
  for (const j of failedJobs) {
    const cls = j.failure_class ?? null;
    const key = cls ?? 'unclassified';
    causeCounts.set(key, (causeCounts.get(key) ?? 0) + 1);
    if (!causeRepos.has(key)) causeRepos.set(key, new Set());
    causeRepos.get(key).add(j.repo);
    const blame = cls ? (FAILURE_CLASSES[cls]?.blame ?? 'unknown') : 'unclassified';
    blameCounts.set(blame, (blameCounts.get(blame) ?? 0) + 1);
  }
  const failureCauses = {
    failedJobs: failedJobs.length,
    classified: failedJobs.filter((j) => j.failure_class).length,
    causes: [...causeCounts.entries()]
      .map(([cls, n]) => ({
        cls,
        n,
        repos: causeRepos.get(cls).size,
        label: FAILURE_CLASSES[cls]?.label ?? 'Not classified yet',
        blame: FAILURE_CLASSES[cls]?.blame ?? 'unclassified',
        hint: FAILURE_CLASSES[cls]?.hint ?? null,
      }))
      .sort((a, b) => b.n - a.n),
    blame: [...blameCounts.entries()].map(([k, n]) => ({ blame: k, n })).sort((a, b) => b.n - a.n),
  };

  return {
    window: { days, since },
    failureCauses,
    totals: {
      runs: runs.length,
      completedRuns: completed.length,
      jobs: jobs.length,
      successes,
      failures,
      zombieRuns: completed.filter(isZombie).length,
      // Rate over runs that actually ran. Counting runs that never got a runner
      // as "failures" understates a suite that is in fact green.
      successRate: (() => {
        const timed = completed.filter((r) => timesWork(r.conclusion)).length;
        return timed ? successes / timed : null;
      })(),
      ciMinutes,
      // What these minutes would have consumed on GitHub-hosted macOS, where
      // private repos bill at 10x against the included allowance.
      allowanceMinutes: ciMinutes * 10,
    },
    repos,
    workflows,
    zombies,
    daily,
    flaky: flaky.slice(0, 20),
    steps: steps.slice(0, 40),
    concurrency: {
      max: maxConcurrent,
      histogram: [...histogram.entries()].map(([n, ms]) => ({ n, ms })).sort((a, b) => a.n - b.n),
    },
    // --- per-runner utilization -------------------------------------------
    // One row per runner that handled at least one job in the window. The busy
    // fraction is job time / window length, which understates busyness because
    // runners have other overhead, but it is the number the operator can act on.
    runnerStats: (() => {
      const byRunner = new Map();
      for (const j of jobs.filter(ran)) {
        if (!j.runner_name) continue;
        if (!byRunner.has(j.runner_name)) byRunner.set(j.runner_name, { jobs: 0, failures: 0, totalMs: 0 });
        const s = byRunner.get(j.runner_name);
        s.jobs++;
        if (isFail(j.conclusion)) s.failures++;
        s.totalMs += j.duration_ms ?? 0;
      }
      const windowMs = days * 86400000;
      return [...byRunner.entries()]
        .map(([name, s]) => ({
          name,
          jobs: s.jobs,
          failures: s.failures,
          failureRate: s.jobs ? s.failures / s.jobs : 0,
          totalMs: s.totalMs,
          busyFrac: windowMs > 0 ? s.totalMs / windowMs : 0,
        }))
        .sort((a, b) => b.jobs - a.jobs)
        .slice(0, 30);
    })(),
    // --- run event-type breakdown ------------------------------------------
    // What kind of work the fleet is actually doing, by GitHub event name.
    // Helps spot a repo whose every push triggers 12 jobs vs. one that only
    // builds on pull_request.
    eventBreakdown: (() => {
      const m = new Map();
      for (const r of completed) {
        const ev = r.event ?? 'unknown';
        if (!m.has(ev)) m.set(ev, 0);
        m.set(ev, m.get(ev) + 1);
      }
      return [...m.entries()].map(([event, n]) => ({ event, n })).sort((a, b) => b.n - a.n);
    })(),
    // --- alert frequency and MTTR -----------------------------------------
    // How often each rule fires and how long it typically stays open. The MTTR
    // matters because a rule that fires for 30 seconds every build is noise;
    // one that stays open for hours is a real problem.
    alertStats: (() => {
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT rule, severity,
                 COUNT(*) AS count,
                 AVG(CASE WHEN closed_at IS NOT NULL THEN closed_at - opened_at ELSE NULL END) AS avg_duration_ms,
                 SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS still_open
          FROM alerts
          WHERE opened_at >= ?
          GROUP BY rule, severity
          ORDER BY count DESC`).all(new Date(Date.now() - days * 86400000).getTime());
      } catch { /* alerts table may not yet exist on a pre-migration db */ }
      return rows.map((r) => ({
        rule: r.rule, severity: r.severity,
        count: r.count, stillOpen: r.still_open,
        avgDurationMs: r.avg_duration_ms ? Math.round(r.avg_duration_ms) : null,
      }));
    })(),
    // --- backfill coverage ------------------------------------------------
    // How much of the historical record has been collected, and whether there
    // are gaps that would make the analytics above incomplete. Every aggregate
    // on this page is only as good as what the backfill has reached.
    backfillCoverage: (() => {
      let pendingRuns = 0;
      let unclassified = 0;
      let totalRuns = 0;
      try {
        pendingRuns = db.prepare(
          `SELECT COUNT(*) AS n FROM runs r WHERE r.status = 'completed'
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = r.id)`
        ).get().n;
        unclassified = db.prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE conclusion = 'failure' AND failure_class IS NULL AND id > 0`
        ).get().n;
        totalRuns = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE status = \'completed\'').get().n;
      } catch { /* ignore */ }
      const sampledRuns = totalRuns - pendingRuns;
      return {
        totalRuns,
        sampledRuns,
        pendingRuns,
        unclassified,
        coveragePct: totalRuns > 0 ? Math.round((sampledRuns / totalRuns) * 100) : null,
      };
    })(),
    // --- host pressure trend (downsampled to 1 point per day) -------------
    // A single line answer to "has this machine been struggling". Minutes under
    // non-normal pressure per day — not individual samples, which would be ~1440
    // rows per day.
    hostPressureTrend: (() => {
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT
            date(ts / 1000, 'unixepoch') AS day,
            SUM(CASE WHEN pressure != 'normal' AND pressure IS NOT NULL THEN 60 ELSE 0 END) AS pressure_secs,
            AVG(load1) AS avg_load,
            MAX(load1) AS max_load,
            COUNT(*) AS samples
          FROM host_samples
          WHERE ts >= ?
          GROUP BY day ORDER BY day`).all((Date.now() - days * 86400000) * 1);
      } catch { /* ignore */ }
      return rows.slice(-90);
    })(),
  };
}

// Everything the repo drawer needs: its workflows, its recent runs, and where
// the time inside its slowest job actually goes.
export function repoDetail(db, repo, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const runs = db.prepare(`
    SELECT id, workflow_name, status, conclusion, head_branch, head_sha,
           run_started_at, duration_ms, html_url, run_number
    FROM runs WHERE repo = ? ORDER BY run_started_at DESC LIMIT 40`).all(repo);

  const jobRows = db.prepare(`
    SELECT j.id, j.name, j.conclusion, j.runner_name, j.started_at, j.queued_ms,
           j.duration_ms, j.failure_class, j.failure_detail, r.workflow_name
    FROM jobs j LEFT JOIN runs r ON r.id = j.run_id
    WHERE j.repo = ? AND j.started_at >= ? AND j.id > 0
    ORDER BY j.started_at DESC`).all(repo, since);

  const jobMap = new Map();
  for (const j of jobRows) {
    const key = k(j.workflow_name, j.name);
    if (!jobMap.has(key)) jobMap.set(key, []);
    jobMap.get(key).push(j);
  }
  const jobs = [...jobMap.entries()].map(([key, list]) => {
    const [workflow, name] = unk(key);
    const executed = list.filter(ran);
    const durs = nums(executed, 'duration_ms');
    const queues = nums(executed, 'queued_ms');
    // Why this job's failures failed, most common first. A job that is red
    // because the account is blocked and a job that is red because a test broke
    // look identical in the trend sparkline; this is the line that separates them.
    const causeCounts = new Map();
    for (const j of list) {
      if (j.conclusion !== 'failure') continue;
      const key = j.failure_class ?? 'unclassified';
      causeCounts.set(key, (causeCounts.get(key) ?? 0) + 1);
    }
    return {
      workflow, name, samples: list.length,
      p50: pct(durs, 50), p95: pct(durs, 95),
      p50Queue: pct(queues, 50),
      failures: [...causeCounts.entries()]
        .map(([cls, n]) => ({
          cls, n,
          label: FAILURE_CLASSES[cls]?.label ?? 'Not classified yet',
          blame: FAILURE_CLASSES[cls]?.blame ?? 'unclassified',
        }))
        .sort((a, b) => b.n - a.n),
      // Newest first from SQL; reverse so the sparkline reads left to right.
      trend: list.slice(0, 24).reverse().map((j) => ({
        at: j.started_at, ms: j.duration_ms, conclusion: j.conclusion,
        failureClass: j.failure_class ?? null,
      })),
      runners: [...new Set(list.map((j) => j.runner_name).filter(Boolean))],
    };
  }).sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));

  // Step breakdown for the slowest job — the one actually worth optimising.
  let stepBreakdown = null;
  if (jobs.length) {
    const target = jobs[0];
    const rows = db.prepare(`
      SELECT s.name, s.duration_ms
      FROM steps s JOIN jobs j ON j.id = s.job_id
      LEFT JOIN runs r ON r.id = j.run_id
      WHERE j.repo = ? AND j.name = ? AND r.workflow_name IS ?
        AND s.duration_ms IS NOT NULL AND j.started_at >= ?
        AND j.runner_name IS NOT NULL AND j.runner_name != ''`)
      .all(repo, target.name, target.workflow, since);
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.name)) m.set(r.name, []);
      m.get(r.name).push(r.duration_ms);
    }
    const list = [...m.entries()].map(([name, vals]) => {
      const sorted = vals.slice().sort((a, b) => a - b);
      return { name, p50: pct(sorted, 50), p95: pct(sorted, 95), samples: vals.length };
    }).sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));
    stepBreakdown = { job: `${target.workflow} · ${target.name}`, steps: list };
  }

  return { repo, runs, jobs, stepBreakdown };
}
