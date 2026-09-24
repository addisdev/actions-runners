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

import { queuedJobLabels } from './queue-cause.js';
import { roleLabel } from './state.js';

const PLATFORM_LABELS = new Set(['self-hosted', 'macos', 'linux', 'windows', 'x64', 'arm64']);

/** @returns {string|null} */
export function roleFromExtraLabels(extraLabels = []) {
  return roleLabel(extraLabels ?? []) ?? null;
}

/** @returns {string|null} */
export function roleFromJobLabels(labels = []) {
  const extra = (labels ?? []).filter((l) => !PLATFORM_LABELS.has(String(l).toLowerCase()));
  return roleLabel(extra) ?? null;
}

/** @param {string} repo @param {string|null} role */
export function sizingKey(repo, role) {
  return `${repo}\0${role ?? ''}`;
}

/** @param {string} key */
export function parseSizingKey(key) {
  const idx = key.indexOf('\0');
  if (idx === -1) return { repo: key, role: null };
  const role = key.slice(idx + 1);
  return { repo: key.slice(0, idx), role: role || null };
}

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
 * Desired runner count per repo and role.
 *
 * @returns array of { repo, role, have, want, delta, reason, concurrency }
 *   sorted worst-first, so the repo most starved of runners is at the top.
 */
export function sizeFleet({ runners = [], active = [], concurrency = new Map(), limits = {}, includeUnserved = false } = {}) {
  const cap = limits.maxInstancesPerRepo ?? 4;

  const have = new Map();
  const rolesByRepo = new Map();
  for (const r of runners) {
    const role = roleFromExtraLabels(r.extraLabels);
    const key = sizingKey(r.repo, role);
    have.set(key, (have.get(key) ?? 0) + 1);
    if (!rolesByRepo.has(r.repo)) rolesByRepo.set(r.repo, new Set());
    rolesByRepo.get(r.repo).add(role);
  }

  // Live queue, per repo and role. A queued run means work is waiting right now.
  const queued = new Map();
  for (const a of active) {
    if (a.status !== 'queued') continue;
    const labels = queuedJobLabels(a);
    const role = roleFromJobLabels(labels ?? []);
    const key = sizingKey(a.repo, role);
    queued.set(key, (queued.get(key) ?? 0) + 1);
    if (!rolesByRepo.has(a.repo)) rolesByRepo.set(a.repo, new Set());
    rolesByRepo.get(a.repo).add(role);
  }

  const reposWithRunners = new Set(runners.map((r) => r.repo));
  const keys = new Set([...have.keys()]);
  // Queued work for a repo that still has runners creates or enlarges a role row.
  // Repos with no runners at all are handled only via includeUnserved below.
  for (const key of queued.keys()) {
    const { repo } = parseSizingKey(key);
    if (reposWithRunners.has(repo)) keys.add(key);
  }

  const out = [];
  for (const key of keys) {
    const { repo, role } = parseSizingKey(key);
    const count = have.get(key) ?? 0;
    const c = concurrency.get(repo) ?? { jobs: 0, peak: 0, p50: 0, p90: 0 };
    const nowQueued = queued.get(key) ?? 0;
    const roleCount = rolesByRepo.get(repo)?.size ?? 1;

    // History is per repo, not per role. When a repo runs multiple roles the
    // p90 is applied only if there is a single role bucket; otherwise the live
    // queue is the honest signal for each role separately.
    const historyWant = roleCount === 1 ? c.p90 : 0;
    const wanted = Math.max(historyWant, count + nowQueued, 1);
    const want = Math.min(cap, wanted);

    let reason;
    if (want <= count) {
      reason = c.jobs
        ? `p90 concurrent demand is ${c.p90} over ${c.jobs} jobs`
        : 'no measured history';
    } else if (nowQueued > 0) {
      reason = role
        ? `${nowQueued} ${role} job(s) queued, p90 demand ${c.p90}`
        : `${nowQueued} job(s) queued right now, p90 demand ${c.p90}`;
    } else {
      reason = `p90 concurrent demand is ${c.p90} over ${c.jobs} jobs`;
    }

    const capped = wanted > cap;

    out.push({
      repo,
      role,
      have: count,
      want,
      delta: want - count,
      capped,
      reason,
      concurrency: c,
    });
  }

  // Repos with NO runner at all for any role — one row per queued role bucket.
  if (includeUnserved) {
    for (const [key, nowQueued] of queued) {
      const { repo, role } = parseSizingKey(key);
      if (reposWithRunners.has(repo)) continue;
      const c = concurrency.get(repo) ?? { jobs: 0, peak: 0, p50: 0, p90: 0 };
      out.push({
        repo,
        role,
        have: 0,
        want: 1,
        delta: 1,
        capped: false,
        unserved: true,
        reason: `${nowQueued} job(s) queued and no runner is registered`,
        concurrency: c,
      });
    }
  }

  // maxInstancesPerRepo is a repo-wide safety limit, not a per-role allowance.
  // Without a final allocation pass, two role rows could each request `cap`
  // runners and quietly double the operator's configured maximum.
  const byRepo = new Map();
  for (const row of out) {
    if (!byRepo.has(row.repo)) byRepo.set(row.repo, []);
    byRepo.get(row.repo).push(row);
  }
  for (const rows of byRepo.values()) {
    const totalHave = rows.reduce((sum, row) => sum + row.have, 0);
    let additionsLeft = Math.max(0, cap - totalHave);
    // Live deficits first; stable role ordering makes identical inputs replay.
    rows.sort((a, b) => b.delta - a.delta || String(a.role ?? '').localeCompare(String(b.role ?? '')));
    for (const row of rows) {
      const requested = Math.max(0, row.delta);
      const granted = Math.min(requested, additionsLeft);
      if (granted < requested) {
        row.capped = true;
        row.reason += `; repo-wide cap ${cap} leaves room for ${granted} more in this role`;
      }
      row.want = row.have + granted;
      row.delta = granted;
      additionsLeft -= granted;
    }
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
  return out.sort((a, b) => b.beforeMs - b.beforeMs - (a.beforeMs - a.afterMs));
}
