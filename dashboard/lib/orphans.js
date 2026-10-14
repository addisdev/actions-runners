// Jobs whose work is done but whose result never reached GitHub, because
// their runner went away while the job was finishing.
//
// addisdev/lake-api PR #73, 2026-10-12/13: three jobs on runners the tiers
// controller was draining passed every step, then sat `in_progress` for 10-25
// minutes with "Complete runner" cancelled or stuck and "Complete job" in
// progress. `gh run cancel` did nothing; `POST …/runs/<id>/force-cancel`
// completed the run about a minute later and a re-run then passed in 15 s.
// Anything waiting on those checks waits forever unless it is told.
//
// The same rules as cockpit's OrphanedJob.swift, and the same fixtures test
// both (test/orphans.test.js).

// The completion hook normally takes seconds.
export const MIN_STUCK_MS = 180_000;

// Runner states that mean the runner is not finishing this job.
const GONE = new Set(['draining', 'offline', 'dead', 'lost', 'host-down']);

const PASSED = new Set(['success', 'skipped', 'neutral']);

const isFinal = (step) => typeof step.name === 'string' && step.name.startsWith('Complete ');

function ms(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
}

// Just what classification reads, so the daemon can hold every active job's
// steps between ticks without holding GitHub's whole job body.
export function trimJob(job) {
  return {
    id: job.id,
    run_id: job.run_id,
    name: job.name,
    status: job.status,
    runner_name: job.runner_name || null,
    html_url: job.html_url ?? null,
    steps: (job.steps ?? []).map((s) => ({
      name: s.name, status: s.status, conclusion: s.conclusion ?? null, started_at: s.started_at ?? null,
    })),
  };
}

function formatDuration(msValue) {
  const m = Math.round(msValue / 60_000);
  return m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${(msValue / 3_600_000).toFixed(1)} h`;
}

function describe(o) {
  const who = o.runner ? `${o.runner}${o.runnerState ? ` (${o.runnerState})` : ''}` : 'its runner';
  const stuck = `stuck at "${o.stuckStep}" for ${formatDuration(o.stuckForMs)}`;
  return o.workPassed
    ? `${o.job}: orphaned by a draining runner — not your code. Every step passed, then ${who} went away; ${stuck}.`
    : `${o.job}: orphaned by a draining runner after "${o.failedStep ?? 'a step'}" failed; ${who} went away, ${stuck}.`;
}

// Orphaned means: the job is in progress; every step that is not a
// "Complete …" step has completed; a "Complete …" step has been cancelled or
// unfinished for at least minStuckMs; and the runner is gone or a "Complete …"
// step was cancelled. A cancelled completion step is proof on its own: the
// worker cancels it only when the listener shuts down, and a run someone
// cancelled does not stay in progress for minutes afterwards. That matters
// because a drained runner the controller resumed reads "busy" again while
// GitHub still holds the orphan.
export function classifyJob(job, { repo, runner = null, now = Date.now(), minStuckMs = MIN_STUCK_MS } = {}) {
  const steps = job?.steps ?? [];
  if (job?.status !== 'in_progress' || !steps.length) return null;
  const work = steps.filter((s) => !isFinal(s));
  if (!work.length || !work.every((s) => s.status === 'completed')) return null;
  const finals = steps.filter(isFinal);
  const open = finals.filter((s) => s.status !== 'completed' || s.conclusion === 'cancelled');
  if (!open.length) return null;
  const cancelled = finals.some((s) => s.conclusion === 'cancelled');
  const gone = runner ? GONE.has(runner.state) : false;
  if (!cancelled && !gone) return null;

  const starts = open.map((s) => ms(s.started_at)).filter((t) => t !== null);
  if (!starts.length) return null;
  const since = Math.min(...starts);
  const stuckForMs = now - since;
  if (stuckForMs < minStuckMs) return null;
  const stuck = [...open].reverse().find((s) => s.status !== 'completed') ?? open[0];
  const failed = work.find((s) => !PASSED.has(s.conclusion ?? ''));

  const runId = job.run_id ?? 0;
  const o = {
    repo,
    runId,
    jobId: job.id,
    job: job.name ?? 'job',
    runner: job.runner_name || null,
    runnerState: runner?.state ?? null,
    stuckStep: stuck.name,
    stuckSince: since,
    stuckForMs,
    workPassed: !failed,
    failedStep: failed?.name ?? null,
    url: job.html_url ?? null,
  };
  return {
    ...o,
    summary: describe(o),
    // force-cancel completes the run in about a minute (plain cancel does
    // nothing here), and only then does GitHub accept a re-run.
    recovery: [
      `gh api -X POST repos/${repo}/actions/runs/${runId}/force-cancel`,
      '# about a minute later, once the run shows completed:',
      `gh run rerun ${runId} -R ${repo}`,
    ],
  };
}

// Every orphaned job across `runs` ({ repo, jobs }), each job's runner looked
// up in `runners` (the glance's runner rows), oldest first.
export function findOrphans(runs, runners = [], now = Date.now()) {
  const byName = new Map(runners.map((r) => [r.name, r]));
  const out = [];
  for (const run of runs ?? []) {
    for (const job of run.jobs ?? []) {
      const o = classifyJob(job, { repo: run.repo, runner: byName.get(job.runner_name) ?? null, now });
      if (o) out.push(o);
    }
  }
  return out.sort((a, b) => a.stuckSince - b.stuckSince);
}
