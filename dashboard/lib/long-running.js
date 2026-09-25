// Long-running / hung-job detection from historical duration baselines.
//
// Expected duration comes from completed runs in SQLite, not from a guess.
// Active runs are compared against a percentile baseline with a configurable
// floor and multiplier so a fast workflow is not flagged at ten minutes while
// a slow one still gets a meaningful threshold.
//
// Baselines degrade in steps when history is sparse: workflow → repo → fleet.
// Without enough samples at any level, the run is left unflagged rather than
// compared to a meaningless number.

export const DEFAULTS = {
  historyDays: 45,
  percentile: 95,
  multiplier: 1.5,
  floorMs: 15 * 60 * 1000,
  minSamples: 3,
};

const timesWork = (c) => c === 'success' || c === 'failure' || c === 'timed_out';
const ZOMBIE_MS = 60 * 60 * 1000;
const isZombie = (r) => r.conclusion === 'cancelled' && (r.duration_ms ?? 0) > ZOMBIE_MS;

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};

const wfKey = (repo, workflow) => `${repo}\u0000${workflow ?? ''}`;
const repoKey = (repo) => `${repo}\u0000*`;

export function percentile(sorted, p) {
  return pct(sorted, p);
}

export function thresholdMs(expectedDurationMs, { multiplier = DEFAULTS.multiplier, floorMs = DEFAULTS.floorMs } = {}) {
  if (expectedDurationMs == null || !Number.isFinite(expectedDurationMs)) return floorMs;
  return Math.max(floorMs, Math.round(expectedDurationMs * multiplier));
}

/**
 * Build duration baselines from completed runs and jobs.
 *
 * @returns {{ byWorkflow: Map<string, { expectedMs: number, n: number, scope: string }>,
 *             byRepo: Map<string, { expectedMs: number, n: number, scope: string }>,
 *             fleet: { expectedMs: number|null, n: number, scope: string } }}
 */
export function buildDurationBaselines(db, opts = {}) {
  const {
    historyDays = DEFAULTS.historyDays,
    percentile: p = DEFAULTS.percentile,
    minSamples = DEFAULTS.minSamples,
    now = Date.now(),
  } = opts;

  const since = new Date(now - historyDays * 86400000).toISOString();
  const empty = {
    byWorkflow: new Map(),
    byRepo: new Map(),
    fleet: { expectedMs: null, n: 0, scope: 'fleet' },
  };

  if (!db) return empty;

  let runs;
  let jobs;
  try {
    runs = db.prepare(`
      SELECT repo, workflow_name, duration_ms, conclusion
      FROM runs
      WHERE status = 'completed'
        AND conclusion IN ('success', 'failure', 'timed_out')
        AND run_started_at >= ?
        AND duration_ms IS NOT NULL
        AND duration_ms > 0`).all(since);

    jobs = db.prepare(`
      SELECT repo, name, duration_ms, conclusion, runner_name
      FROM jobs
      WHERE started_at >= ?
        AND id > 0
        AND duration_ms IS NOT NULL
        AND duration_ms > 0
        AND runner_name IS NOT NULL`).all(since);
  } catch {
    return empty;
  }

  const runDurs = new Map();
  const repoDurs = new Map();
  const fleetDurs = [];

  for (const r of runs) {
    if (isZombie(r) || !timesWork(r.conclusion)) continue;
    const d = r.duration_ms;
    if (!Number.isFinite(d)) continue;
    const wk = wfKey(r.repo, r.workflow_name);
    if (!runDurs.has(wk)) runDurs.set(wk, []);
    runDurs.get(wk).push(d);
    if (!repoDurs.has(r.repo)) repoDurs.set(r.repo, []);
    repoDurs.get(r.repo).push(d);
    fleetDurs.push(d);
  }

  // Job durations supplement repo/fleet baselines when run rows lack duration_ms.
  for (const j of jobs) {
    if (!timesWork(j.conclusion)) continue;
    const d = j.duration_ms;
    if (!Number.isFinite(d)) continue;
    if (!repoDurs.has(j.repo)) repoDurs.set(j.repo, []);
    repoDurs.get(j.repo).push(d);
    fleetDurs.push(d);
  }

  const byWorkflow = new Map();
  for (const [key, durs] of runDurs) {
    if (durs.length < minSamples) continue;
    durs.sort((a, b) => a - b);
    byWorkflow.set(key, { expectedMs: pct(durs, p), n: durs.length, scope: 'workflow' });
  }

  const byRepo = new Map();
  for (const [repo, durs] of repoDurs) {
    if (durs.length < minSamples) continue;
    durs.sort((a, b) => a - b);
    byRepo.set(repo, { expectedMs: pct(durs, p), n: durs.length, scope: 'repo' });
  }

  fleetDurs.sort((a, b) => a - b);
  const fleet = fleetDurs.length >= minSamples
    ? { expectedMs: pct(fleetDurs, p), n: fleetDurs.length, scope: 'fleet' }
    : { expectedMs: null, n: fleetDurs.length, scope: 'fleet' };

  return { byWorkflow, byRepo, fleet, minSamples, percentile: p };
}

export function resolveBaseline(baselines, repo, workflowName) {
  const wf = baselines.byWorkflow.get(wfKey(repo, workflowName));
  if (wf) return wf;
  const repoBl = baselines.byRepo.get(repo);
  if (repoBl) return repoBl;
  if (baselines.fleet.expectedMs != null) return baselines.fleet;
  return null;
}

function startedMs(run, now) {
  const raw = run.startedAt ?? run.run_started_at ?? run.createdAt ?? run.created_at;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

/**
 * Annotate in-progress active runs with duration hints for fleetd/UI and alerts.
 * Mutates each matching entry in place and returns the same array.
 */
export function annotateActiveRuns(active, baselines, opts = {}) {
  const {
    multiplier = DEFAULTS.multiplier,
    floorMs = DEFAULTS.floorMs,
    now = Date.now(),
  } = opts;

  for (const run of active ?? []) {
    if (run.status !== 'in_progress') {
      run.longRunning = false;
      run.elapsedMs = null;
      run.expectedDurationMs = null;
      run.thresholdMs = null;
      run.reason = null;
      continue;
    }

    const elapsedMs = startedMs(run, now);
    run.elapsedMs = elapsedMs;

    const baseline = resolveBaseline(baselines, run.repo, run.workflowName ?? run.workflow_name);
    if (!baseline?.expectedMs) {
      run.expectedDurationMs = null;
      run.thresholdMs = floorMs;
      run.longRunning = false;
      run.reason = 'insufficient history for a baseline';
      continue;
    }

    run.expectedDurationMs = baseline.expectedMs;
    const thresh = thresholdMs(baseline.expectedMs, { multiplier, floorMs });
    run.thresholdMs = thresh;
    run.longRunning = elapsedMs != null && elapsedMs > thresh;
    run.reason = run.longRunning
      ? `elapsed ${elapsedMs}ms exceeds ${thresh}ms threshold `
        + `(p${baselines.percentile ?? DEFAULTS.percentile} ${baseline.expectedMs}ms `
        + `× ${multiplier}, floor ${floorMs}ms, ${baseline.scope} baseline, n=${baseline.n})`
      : null;
  }

  return active;
}

export function annotateActiveFromDb(db, active, opts = {}) {
  const baselines = buildDurationBaselines(db, opts);
  return annotateActiveRuns(active, baselines, opts);
}

/** Findings for the alert engine from already-annotated snapshot.active entries. */
export function longRunningAlertFindings(active) {
  const out = [];
  for (const run of active ?? []) {
    if (run.status !== 'in_progress' || !run.longRunning) continue;
    const repoShort = (run.repo ?? '?').split('/').pop();
    const wf = run.workflowName ?? run.workflow_name ?? 'workflow';
    const elapsed = run.elapsedMs ?? 0;
    const expected = run.expectedDurationMs;
    const thresh = run.thresholdMs;
    out.push({
      key: `run:long-running:${run.id}`,
      rule: 'long-running-job',
      severity: 'warning',
      title: `${repoShort} · ${wf} running long`,
      body: [
        `Elapsed ${Math.round(elapsed / 60000)}m — expected p95 ${expected != null ? `${Math.round(expected / 60000)}m` : '?'}, `
          + `threshold ${Math.round(thresh / 60000)}m.`,
        run.reason,
        run.url ?? run.html_url ?? '',
      ].filter(Boolean).join('\n'),
      runId: run.id,
      repo: run.repo,
    });
  }
  return out;
}
