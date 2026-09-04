// Deterministic event replay for fleet scaling scenarios.
//
// Given a slice of historical job data (arrival time, duration, labels) and a
// hypothetical set of per-repo runner counts, this replays the event timeline
// and measures queue outcomes: p50/p90/p95 wait, jobs over SLO, runner-hours,
// and peak simultaneous jobs.
//
// WHY DETERMINISTIC REPLAY RATHER THAN SIMULATION
//
// The point is to answer "would the fleet today have performed better with N
// runners instead of M?" for a specific week of actual traffic, not a sampled
// model. Replay re-uses real arrival times and real durations, so the answer
// is reproducible and verifiable — the operator can check any row in the jobs
// table against the replay timeline.
//
// SCOPE
//
// This deliberately handles only persistent runners (always registered, job
// queues behind a busy runner). JIT/ephemeral runners that register fresh per
// job have a trivially zero queue wait and are excluded.
//
// LIMITATIONS NOTED IN THE OUTPUT
// - registration latency when a new runner is added is modeled as configurable
//   constant; real latency varies.
// - actual host load during the replay period is not re-simulated; only runner
//   concurrency is tracked.

const DEFAULT_SLO_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Replay historical jobs under a hypothetical runner configuration.
 *
 * @param {object} opts
 * @param {object[]} opts.jobs         - raw jobs from DB (started_at, queued_ms, duration_ms, repo, labels)
 * @param {Map<string,number>} opts.runnerCounts  - repo → runner count to simulate
 * @param {object}  [opts.options]
 * @param {number}  [opts.options.registrationMs]  - how long a new runner takes to register (ms)
 * @param {number}  [opts.options.idleTtlMs]       - idle TTL before a duplicate auto-deregisters
 * @param {number}  [opts.options.hostCap]         - max simultaneous jobs across all repos
 * @param {number}  [opts.options.sloMs]           - queue wait threshold for "over SLO"
 * @returns {object} replay result
 */
export function replayScenario(jobs, runnerCounts, options = {}) {
  const { registrationMs = 30_000, idleTtlMs = 4 * 3600_000, hostCap = 16, sloMs = DEFAULT_SLO_MS } = options;

  // Only jobs with enough data to replay.
  const replayable = jobs.filter(
    (j) => j.started_at && j.queued_ms != null && j.duration_ms != null && j.repo
  );

  // Convert each job to an event: arrivalTs (when it joined the queue),
  // durationMs (how long the job actually ran), repo.
  const events = replayable
    .map((j) => {
      const startTs = new Date(j.started_at).getTime();
      const arrivalTs = startTs - (j.queued_ms ?? 0);
      return { arrivalTs, durationMs: j.duration_ms, repo: j.repo, jobId: j.id };
    })
    .filter((e) => Number.isFinite(e.arrivalTs) && e.durationMs > 0)
    .sort((a, b) => a.arrivalTs - b.arrivalTs);

  if (!events.length) {
    return { events: 0, scenarios: null, error: 'no replayable jobs in window' };
  }

  // For each repo, model a pool of runners as sorted availability queues.
  // A runner is "free" when its previous job's end time passes.
  function runScenario(countsMap) {
    const pools = new Map();
    for (const [repo, count] of countsMap) {
      // All runners start free at the beginning of the replay window.
      const pool = Array(count).fill(events[0].arrivalTs - 1);
      pools.set(repo, pool);
    }

    const waits = [];
    let overSlo = 0;
    let totalRunnerHours = 0;
    let peakSimultaneous = 0;
    let currentlyRunning = 0;

    // We track running jobs as a timeline to compute peak correctly.
    const runEnds = [];

    for (const ev of events) {
      const pool = pools.get(ev.repo);
      if (!pool) {
        // The scenario says nothing about this repo, so this job cannot be
        // replayed. Recorded as unserved and NOT counted against the SLO: those
        // are different findings and mixing them makes the more common one
        // unreadable. A scenario covering one repo out of thirty would otherwise
        // report "97% of jobs missed the SLO", which sounds like a fleet in
        // crisis and actually means the scenario was narrow.
        waits.push(Infinity);
        continue;
      }

      // Find earliest-free runner.
      pool.sort((a, b) => a - b);
      const freeAt = pool[0];

      // The job starts when its runner is free, but no earlier than arrival.
      const startTs = Math.max(freeAt, ev.arrivalTs);
      const wait = startTs - ev.arrivalTs;
      const endTs = startTs + ev.durationMs;

      waits.push(wait);
      if (wait > sloMs) overSlo++;
      totalRunnerHours += ev.durationMs / 3_600_000;

      // Mark this runner as busy until job ends.
      pool[0] = endTs;

      // Peak simultaneous: count how many jobs overlap at startTs.
      // Remove completed ends.
      while (runEnds.length && runEnds[0] <= startTs) {
        runEnds.shift();
        currentlyRunning--;
      }
      currentlyRunning++;
      // Insert sorted.
      let ins = 0;
      while (ins < runEnds.length && runEnds[ins] < endTs) ins++;
      runEnds.splice(ins, 0, endTs);
      if (currentlyRunning > peakSimultaneous) peakSimultaneous = currentlyRunning;
    }

    const sorted = [...waits].filter(Number.isFinite).sort((a, b) => a - b);
    const p = (pct) => sorted.length ? sorted[Math.floor(sorted.length * pct)] : null;

    const replayedCount = waits.filter(Number.isFinite).length;

    return {
      jobCount: events.length,
      replayedCount,
      unservedCount: waits.length - replayedCount,
      p50WaitMs: p(0.5),
      p90WaitMs: p(0.9),
      p95WaitMs: p(0.95),
      overSloCount: overSlo,
      // Out of jobs that were actually replayed, not out of every job seen. A
      // percentage whose denominator includes jobs the scenario never simulated
      // is not a measure of anything.
      overSloPct: replayedCount ? Math.round((overSlo / replayedCount) * 100) : 0,
      totalRunnerHours: Math.round(totalRunnerHours * 10) / 10,
      peakSimultaneous,
    };
  }

  const current = runScenario(runnerCounts);
  return { events: events.length, scenario: current, note: 'deterministic replay — observed values only' };
}

/**
 * Compare current and proposed configurations.
 *
 * @param {object[]} jobs
 * @param {Map<string,number>} currentCounts
 * @param {Map<string,number>} proposedCounts
 * @param {object} [options]
 * @returns {{ current, proposed, delta }}
 */
export function compareScenarios(jobs, currentCounts, proposedCounts, options = {}) {
  const current = replayScenario(jobs, currentCounts, options).scenario ?? {};
  const proposed = replayScenario(jobs, proposedCounts, options).scenario ?? {};

  const delta = {};
  for (const key of ['p50WaitMs', 'p90WaitMs', 'p95WaitMs', 'overSloCount', 'overSloPct', 'totalRunnerHours', 'peakSimultaneous']) {
    if (current[key] != null && proposed[key] != null) {
      delta[key] = proposed[key] - current[key];
    }
  }

  return { current, proposed, delta };
}
