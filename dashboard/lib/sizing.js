// How many runners each repo should have, and why.
//
// The question this answers is not "is the fleet busy" but "which repo is
// queueing behind itself". Those are different, and on this fleet's history they
// are wildly different: average concurrent jobs across 27 runners is 0.2, so the
// machine is idle almost all the time, and yet 21% of 7,631 jobs waited over a
// minute to start and one repo averaged a 28-minute wait. Work was queueing
// while 26 runners sat idle, because a runner serves one job at a time and each
// repo had exactly one.
//
// So sizing is per repo, and the input is that repo's own CONCURRENT demand —
// how many of its jobs wanted to run at the same moment — not the length of the
// fleet-wide queue.
//
// WHY NOT SIZE TO PEAK. Peak demand for one repo here is 33 simultaneous jobs, a
// matrix fan-out. Thirty-three concurrent jobs on 12 cores is how this host
// recorded a load average of 760. Sizing to peak would encode the worst moment
// as the steady state. p90 is used instead: it covers the common bursts and
// ignores the once-a-month fan-out, which is what the queue is for.

// Concurrent demand per repo, measured from job history.
//
// Sampled at each job's START rather than by integrating over time. A job that
// runs for an hour alongside nothing else would otherwise dominate the
// distribution with idle minutes and drag every percentile to 1, hiding exactly
// the short overlapping bursts that cause queueing.
export function concurrencyByRepo(db, { days = 30 } = {}) {
  const since = Date.now() - days * 86400000;
  const rows = db
    .prepare(
      `SELECT repo, started_at, completed_at FROM jobs
        WHERE started_at IS NOT NULL AND completed_at IS NOT NULL
          AND queued_ms IS NOT NULL`
    )
    .all();

  const byRepo = new Map();
  for (const r of rows) {
    const start = Date.parse(r.started_at);
    const end = Date.parse(r.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (start < since) continue;
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push([start, end]);
  }

  const out = new Map();
  for (const [repo, intervals] of byRepo) {
    const starts = intervals.map(([s]) => s).sort((a, b) => a - b);
    const ends = intervals.map(([, e]) => e).sort((a, b) => a - b);
    const samples = [];
    let peak = 0;
    // Two sorted cursors rather than a nested scan: some repos have thousands of
    // jobs and this runs in the slow loop, not in a background thread.
    let ei = 0;
    let open = 0;
    for (const s of starts) {
      while (ei < ends.length && ends[ei] <= s) {
        open -= 1;
        ei += 1;
      }
      open += 1;
      peak = Math.max(peak, open);
      samples.push(open);
    }
    samples.sort((a, b) => a - b);
    const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
    out.set(repo, { jobs: intervals.length, peak, p50: at(0.5), p90: at(0.9) });
  }
  return out;
}

/**
 * Desired runner count per repo.
 *
 * @returns array of { repo, have, want, delta, reason, concurrency }
 *   sorted worst-first, so the repo most starved of runners is at the top.
 */
export function sizeFleet({ runners = [], active = [], concurrency = new Map(), limits = {} } = {}) {
  const cap = limits.maxInstancesPerRepo ?? 4;

  const have = new Map();
  for (const r of runners) have.set(r.repo, (have.get(r.repo) ?? 0) + 1);

  // Live queue, per repo. A queued run means work is waiting right now, which is
  // evidence history cannot provide and which decays the moment it starts.
  const queued = new Map();
  for (const a of active) {
    if (a.status === 'queued') queued.set(a.repo, (queued.get(a.repo) ?? 0) + 1);
  }

  const out = [];
  for (const [repo, count] of have) {
    const c = concurrency.get(repo) ?? { jobs: 0, peak: 0, p50: 0, p90: 0 };
    const nowQueued = queued.get(repo) ?? 0;

    // The larger of what history says it usually needs and what is waiting right
    // now. History alone is blind to a repo that just started fanning out; the
    // live queue alone is blind to a repo whose burst has not begun yet.
    const wanted = Math.max(c.p90, count + nowQueued, 1);
    const want = Math.min(cap, wanted);

    let reason;
    if (want <= count) {
      reason = c.jobs
        ? `p90 concurrent demand is ${c.p90} over ${c.jobs} jobs`
        : 'no measured history';
    } else if (nowQueued > 0) {
      reason = `${nowQueued} job(s) queued right now, p90 demand ${c.p90}`;
    } else {
      reason = `p90 concurrent demand is ${c.p90} over ${c.jobs} jobs`;
    }

    // Called out explicitly because it is the case where this screen has nothing
    // useful to offer and should say so, rather than showing want === cap and
    // implying the cap is the answer.
    const capped = wanted > cap;

    out.push({
      repo,
      have: count,
      want,
      delta: want - count,
      capped,
      reason,
      concurrency: c,
    });
  }

  out.sort((a, b) => b.delta - a.delta || b.concurrency.p90 - a.concurrency.p90);
  return out;
}

// p90, not the median, and this matters more than it looks. Median queue wait
// across this fleet is about six seconds, so a median comparison reports "0.1m
// before, 0.0m after" and makes every duplicate look pointless. The waiting is
// all in the tail: 21% of 7,631 jobs waited over a minute and one repo averaged
// 28 minutes. p90 is where the problem being solved actually lives.
function p90(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

// Did adding a runner actually help? Median queue wait for a repo before and
// after its second runner appeared.
//
// This exists because every other number in this file is a prediction, and a
// system that predicts without ever checking itself will recommend the same
// useless thing forever. The split point is the duplicate's own directory
// creation time, which is durable and needs no bookkeeping — it survives daemon
// restarts and does not depend on the scaler having been the one to add it, so
// the three duplicates somebody created by hand are measured too.
//
// Honest about what it is: observational, not a controlled comparison. A repo
// whose builds got slower for unrelated reasons will look like the runner made
// no difference. It is evidence, not proof, and enough to notice a duplicate
// that changed nothing.
export function queueEffect(db, splits = []) {
  const stmt = db.prepare(
    'SELECT started_at, queued_ms FROM jobs WHERE repo = ? AND queued_ms IS NOT NULL AND started_at IS NOT NULL'
  );
  const out = [];
  for (const { repo, at } of splits) {
    if (!Number.isFinite(at)) continue;
    const before = [];
    const after = [];
    for (const row of stmt.all(repo)) {
      const t = Date.parse(row.started_at);
      if (!Number.isFinite(t)) continue;
      (t < at ? before : after).push(row.queued_ms);
    }
    // Both sides need enough jobs for a median worth printing. Ten either side
    // of the split still swings on one slow build, but below that the number is
    // noise wearing a statistic's clothes.
    if (before.length < 10 || after.length < 10) continue;
    out.push({
      repo,
      at,
      beforeMs: p90(before),
      afterMs: p90(after),
      beforeN: before.length,
      afterN: after.length,
    });
  }
  // Biggest improvement first.
  return out.sort((a, b) => b.beforeMs - b.afterMs - (a.beforeMs - a.afterMs));
}
