// Whether this host can take one more concurrent job right now.
//
// Every scale-up consults this — the button, and the autoscaler. The difference
// is what they do with a "no": a person is shown the reasons and may override,
// automation stops.
//
// WHY A CEILING AT ALL. Adding a runner does not add capacity, it adds
// concurrency on fixed capacity. On this fleet's own history, each concurrent
// job costs an enormous amount of load on a 12-core machine:
//
//     concurrent jobs   median load1     samples
//     0                 1.7              23,490
//     1                 15.1              2,593
//     2                 60.4                684
//     3                 91.4                199
//     4                127.5                 98
//     5                236.4                 19
//
// Two jobs already put load at 5x the core count. So the honest ceiling is low,
// and the queue is not a failure — past a handful of concurrent jobs, queueing
// is what stops the machine thrashing. What the fleet had before was the worst
// of both: jobs queued behind a single runner while 26 sat idle, AND nothing
// stopping a burst reaching eight at once.
//
// WHAT IS NOT USED HERE, both learned the hard way and documented in the README:
//
//   swap USED — an accumulator, not a gauge. macOS never proactively reclaims
//   swap, so pages written during any peak in the machine's uptime stay counted.
//   4.3 GB showed as "used" with memory 71% free and zero swap activity.
//
//   memory pressure and swap-in rate as PRIMARY gates — both are real signals,
//   but they arrive late: pressure read "warning" in 1.3% of 27,093 samples and
//   swap-ins are 0.1/sec at p90. A gate that only fires then has already let the
//   machine get into trouble. They are kept as backstops below, not as the test.
//
// Load is the early signal precisely because it tracks concurrency so tightly.

// WHAT LIMITS CONCURRENCY. This paragraph used to say that nothing throttles
// EXECUTION, that there is no scheduler, and therefore that the number of
// runners IS the concurrency limit. That was true when it was written and has
// not been true since 2026-09-11, when job admission control went to enforce:
// a job-started hook in every runner holds a job until the host is under
// FLEET_ADMIT_MAX_CONCURRENT (2, and 1 for the simulator runners). That hook,
// not this file, is what stops a burst — and it is deliberately enforced inside
// the runner so it survives this daemon being down.
//
// The stale premise had a cost. `maxTotalRunners` kept being read as the
// concurrency cap, so 43 idle listeners — 901 MB of RSS, executing nothing —
// were counted as "43 jobs that could start at once" and refused every
// scale-up, while admission was independently holding execution at 2. The queue
// could not be served and the reason given was a limit that no longer described
// what it was limiting.
//
// So, honestly: admission caps CONCURRENT JOBS. `maxTotalRunners` caps how many
// runner directories may exist, which is a disk and memory bound (~1.3-2.3 GB
// on disk and ~17-35 MB resident each), not a concurrency one. `ceiling` is a
// "not right now" check that stops growth while the machine is already working.
// Size maxTotalRunners against the disk, not against the core count.
export const CAPACITY_DEFAULTS = {
  // Fleet-wide cap on how many runner directories may exist. A disk and memory
  // bound — NOT a concurrency one; admission control owns concurrency. See the
  // note above before lowering this to "protect" the host.
  maxTotalRunners: 32,
  // Refuse to ADD a runner while this many jobs are already running. Not a cap
  // on execution — see above — just a refusal to make a busy moment busier.
  ceiling: 3,
  // Refuse when load per core is already past this, whatever the job count says.
  // Catches load the fleet did not cause — the operator's own Xcode build counts
  // against the same cores.
  loadPerCore: 4,
  // Each runner directory is ~1.3 GB fresh and ~2.3 GB once it has a checkout.
  minFreeDiskGb: 40,
  // Backstops. A page read back is a thread stopped waiting for memory.
  maxSwapinsPerSec: 20,
  blockOnPressure: true,
};

export function busyCount(runners = []) {
  // Local truth first: a Runner.Worker process is running a job right now, and
  // costs no API call to see. ghBusy agrees a poll interval later.
  return runners.filter((r) => r.workingLocally || r.ghBusy).length;
}

/**
 * @returns {{ ok: boolean, busy: number, ceiling: number, maxTotalRunners: number,
 *   reasons: string[] }}
 *   reasons is empty when ok. Every string is written to be shown verbatim in
 *   the UI — "not scaling" with no reason is indistinguishable from a bug, and
 *   this gate is expected to refuse often.
 *
 *   Both limits are echoed back because the two are easy to confuse and the
 *   consequences differ: `ceiling` is the "not right now" gate on a busy moment,
 *   `maxTotalRunners` is the actual concurrency cap. A caller wanting to know how
 *   many more runners a host could hold needs the latter, and reading `ceiling`
 *   for that — which a remote host reports as 3 — makes any host with three
 *   runners look full.
 */
export function headroom({ host = {}, runners = [], limits = {} } = {}) {
  const lim = { ...CAPACITY_DEFAULTS, ...limits };
  const busy = busyCount(runners);
  const reasons = [];

  if (runners.length >= lim.maxTotalRunners) {
    // The parenthetical used to read "(every runner is a job that could start at
    // once)". With admission control enforcing, that is simply false, and it was
    // the sentence that talked operators out of raising a limit they should
    // have raised. State what the limit actually governs.
    reasons.push(
      `${runners.length} runners already exist, the fleet limit of ${lim.maxTotalRunners} ` +
        '(a disk and memory bound on how many runners may exist — concurrent jobs are capped separately by admission control)'
    );
  }

  if (busy >= lim.ceiling) {
    reasons.push(`${busy} job(s) already running, at the limit of ${lim.ceiling} for adding more`);
  }

  const cores = host.cores || 1;
  if (host.load1 != null) {
    const perCore = host.load1 / cores;
    if (perCore > lim.loadPerCore) {
      reasons.push(
        `load ${host.load1.toFixed(0)} on ${cores} cores is ${perCore.toFixed(1)}x per core ` +
          `(limit ${lim.loadPerCore}x)`
      );
    }
  }

  if (host.diskFreeGb != null && host.diskFreeGb < lim.minFreeDiskGb) {
    reasons.push(
      `${host.diskFreeGb.toFixed(0)} GB disk free, below the ${lim.minFreeDiskGb} GB floor ` +
        '(a new runner needs 1.3-2.3 GB)'
    );
  }

  if (lim.blockOnPressure && host.memPressure && host.memPressure !== 'normal') {
    reasons.push(`kernel memory pressure is "${host.memPressure}"`);
  }

  if (host.swapinsPerSec != null && host.swapinsPerSec > lim.maxSwapinsPerSec) {
    reasons.push(`${host.swapinsPerSec.toFixed(0)} swap-ins/sec — threads are waiting on memory`);
  }

  return { ok: reasons.length === 0, busy, ceiling: lim.ceiling, maxTotalRunners: lim.maxTotalRunners, reasons };
}
