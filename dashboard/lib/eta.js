// When will a queued run start, and when will it be green?
//
// "Queued 9 minutes" answers the wrong question. The person looking at a
// yellow PR wants to know whether to wait, and for how long; the agent session
// running `cockpit wait` wants to know whether waiting will ever end. Both are
// answerable from what the fleet already records: which runner the run is
// waiting behind, how long that runner's current job usually takes, and how
// long this workflow usually takes once it starts.
//
// Every estimate is a RANGE — p50 to p90 of the relevant history — because a
// single number states a precision this data does not have. And a run whose
// queue cause is structural (no runner, labels match nothing, the runner is
// down) gets no estimate at all: it will not start on its own, and a number
// would say it will.

import { buildDurationBaselines, resolveBaseline } from './long-running.js';

// Queue causes after which waiting does not end.
export const NEVER_STARTS = new Set([
  'runner-down', 'unserved', 'role-unserved', 'label-mismatch', 'github-hosted', 'telemetry-unavailable',
]);

const DISPATCH_MS = [0, 60 * 1000];
const UNKNOWN_START_MS = [0, 2 * 60 * 1000];

/**
 * p50 and p90 baselines, cached: the history they come from moves by a run or
 * two per tick, and the query scans 45 days.
 */
export function createEtaBaselines(db, { ttlMs = 5 * 60 * 1000 } = {}) {
  let cache = null;
  return (now = Date.now()) => {
    if (cache && now - cache.at < ttlMs) return cache;
    cache = {
      at: now,
      p50: buildDurationBaselines(db, { percentile: 50, now }),
      p90: buildDurationBaselines(db, { percentile: 90, now }),
    };
    return cache;
  };
}

function range(baselines, repo, workflow) {
  const lo = resolveBaseline(baselines.p50, repo, workflow)?.expectedMs ?? null;
  const hi = resolveBaseline(baselines.p90, repo, workflow)?.expectedMs ?? null;
  if (lo == null && hi == null) return null;
  return [lo ?? hi, Math.max(lo ?? hi, hi ?? lo)];
}

const startedAt = (run) => Date.parse(run.startedAt ?? run.createdAt) || null;

/**
 * @param {object} p
 * @param {object[]} p.queue   snapshot.queue entries (id, repo, workflowName, cause, queuedSinceMs)
 * @param {object[]} p.active  snapshot.active runs (status, repo, workflowName, startedAt)
 * @param {{p50, p90}} p.baselines
 * @returns {Map<number, {etaStartMs: number[]|null, etaDoneMs: number[]|null, basis: string}>}
 */
export function estimateQueue({ queue = [], active = [], baselines, now = Date.now() }) {
  const out = new Map();
  const running = active.filter((r) => r.status === 'in_progress');
  const remaining = (run) => {
    const r = range(baselines, run.repo, run.workflowName);
    const t0 = startedAt(run);
    if (!r || !t0) return null;
    const elapsed = Math.max(0, now - t0);
    return [Math.max(0, r[0] - elapsed), Math.max(0, r[1] - elapsed)];
  };
  const soonest = (runs) => {
    let best = null;
    for (const run of runs) {
      const rem = remaining(run);
      if (rem && (!best || rem[0] < best[0])) best = rem;
    }
    return best;
  };

  // Queue order within a repo: the oldest waiter goes first.
  const byRepo = new Map();
  for (const q of [...queue].sort((a, b) => (b.queuedSinceMs ?? 0) - (a.queuedSinceMs ?? 0))) {
    if (!byRepo.has(q.repo)) byRepo.set(q.repo, []);
    byRepo.get(q.repo).push(q);
  }

  for (const q of queue) {
    const own = range(baselines, q.repo, q.workflowName);
    if (NEVER_STARTS.has(q.cause)) {
      out.set(q.id, { etaStartMs: null, etaDoneMs: null, basis: `${q.cause}: will not start on its own` });
      continue;
    }
    let start;
    let basis;
    if (q.cause === 'github-delay') {
      start = [...DISPATCH_MS];
      basis = 'an idle runner is available; GitHub dispatch';
    } else {
      const ahead = byRepo.get(q.repo).indexOf(q);
      const pool = q.cause === 'host-saturation' || q.cause === 'concurrency-block'
        ? running
        : running.filter((r) => r.repo === q.repo);
      const slot = soonest(pool);
      if (slot) {
        start = [slot[0], slot[1]];
        basis = q.cause === 'host-saturation'
          ? 'the next job to finish anywhere on the host'
          : 'the job ahead on this repo\'s runner';
      } else {
        start = [...UNKNOWN_START_MS];
        basis = 'nothing running to wait behind';
      }
      if (ahead > 0 && own) {
        start = [start[0] + ahead * own[0], start[1] + ahead * own[1]];
        basis += `, then ${ahead} queued ahead`;
      }
    }
    const done = own ? [start[0] + own[0], start[1] + own[1]] : null;
    out.set(q.id, { etaStartMs: start.map(Math.round), etaDoneMs: done?.map(Math.round) ?? null, basis });
  }
  return out;
}
