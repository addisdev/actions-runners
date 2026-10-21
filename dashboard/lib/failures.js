// Why a job failed, as opposed to that it failed.
//
// `conclusion = 'failure'` is one value covering causes that need completely
// different people to do completely different things. Measured on this fleet
// over 2026-07-29 to 2026-08-08: 55 job failures across 9 repos were the
// account's Actions spending limit refusing to start the job at all. Those jobs
// never reached a runner, never ran a step, and had nothing to do with the code
// being pushed — but they arrive as `failure`, they are indistinguishable from a
// broken test in the runs table, and `newly-failing` alerts on them identically.
//
// The cause is in the job's *annotations*, which is one API call per failed job
// and is the only place GitHub writes it down. Storing the class alongside the
// job means the question "is CI broken, or is the account blocked" is answerable
// from the dashboard rather than by opening ten tabs at 3am.
//
// Each class below corresponds to a different first move. That is the test for
// whether a class deserves to exist — not whether the message is distinctive.

export const FAILURE_CLASSES = {
  'account-blocked': {
    label: 'Account blocked',
    blame: 'account',
    hint: 'Actions refused to start the job: payment failed or the spending limit is reached. '
      + 'Nothing on this machine is wrong and no runner was involved — the job never started. '
      + 'Self-hosted jobs are blocked by this too, even though they consume no Actions minutes.',
  },
  'account-quota': {
    label: 'Account quota',
    blame: 'account',
    hint: 'A storage or artifact quota is full. The job ran; it could not publish its output.',
  },
  'runner-lost': {
    label: 'Runner lost contact',
    blame: 'host',
    hint: 'The runner stopped talking to GitHub mid-job — CPU/memory starvation on the host, or '
      + 'the network dropping. Check host load around that time before suspecting the code.',
  },
  'host-broken': {
    label: 'Host needs attention',
    blame: 'host',
    hint: 'The workflow ran and recognised the host as the cause: a simulator that will not boot, '
      + 'or a CoreSimulator older than the installed Xcode needs. Fix the host (the annotation '
      + 'says how), then re-run. Changing the code will not turn it green.',
  },
  'no-runner': {
    label: 'No runner matched',
    blame: 'config',
    hint: 'Nothing carrying the required labels picked the job up. See the Lint tab for '
      + 'unmatched runs-on labels.',
  },
  'admission-hold': {
    label: 'Timed out while held',
    blame: 'host',
    hint: 'The fleet\'s admission hook held this job at "Set up runner" for a host slot, and the hold '
      + 'counted against the job\'s timeout-minutes, so GitHub cancelled it. Re-run it; the code '
      + 'was not the cause. Repeats mean a host is at its admission cap with nowhere to park.',
  },
  'job-failed': {
    label: 'Job failed',
    blame: 'code',
    hint: 'The job ran on a runner and a step exited non-zero. This is the ordinary case: read '
      + 'the step log.',
  },
  'unknown': {
    label: 'Cause not recorded',
    blame: 'unknown',
    hint: 'No failure annotation was retained. GitHub expires annotations with the run logs, so '
      + 'failures older than the retention window cannot be classified after the fact.',
  },
};

// Ordered: the first match wins, so the specific account- and host-level causes
// are tested before the catch-all. A billing block also emits nothing else, but
// a quota failure can co-occur with a step failure, and the quota is the cause
// worth reporting because it is the one that repeats until someone acts.
const PATTERNS = [
  [/recent account payments have failed|spending limit needs to be increased/i, 'account-blocked'],
  [/storage quota has been hit|artifact storage quota|quota has been exceeded/i, 'account-quota'],
  [/self-hosted runner lost communication|runner has received a shutdown signal/i, 'runner-lost'],
  // The launch kit's workflows end every host diagnosis with this phrase.
  [/the runner host needs attention, this is not a code failure/i, 'host-broken'],
  [/no runner matched|unable to find a runner|no self-hosted runner/i, 'no-runner'],
];

// messages: the `message` strings of failure-level annotations for one job.
export function classifyAnnotations(messages) {
  const list = (messages ?? []).filter((m) => typeof m === 'string');
  for (const [re, cls] of PATTERNS) {
    for (const m of list) if (re.test(m)) return cls;
  }
  return list.length ? 'job-failed' : 'unknown';
}

export function blameOf(cls) {
  return FAILURE_CLASSES[cls]?.blame ?? 'unknown';
}

// A one-line summary for an alert body or a tile. Deliberately short: the point
// is to redirect the reader, not to explain the whole failure.
export function describe(cls) {
  return FAILURE_CLASSES[cls]?.label ?? cls;
}

// GitHub reports a job that ran out of timeout-minutes as `cancelled`, with
// this as its only failure annotation, the same conclusion as a run a newer
// push superseded. Only the annotation tells them apart.
const TIMED_OUT = /has exceeded the maximum execution time/i;

// A hold shorter than this did not decide a timeout.
export const HOLD_BLAME_MIN_S = 120;

/**
 * How long the admission hook held one job, from admission_events rows for its
 * run: those on the job's runner between its start and its end. The hook logs
 * `held` once, then `continued-hold`, and one closing event carrying the total
 * in waited_s; a job cancelled before any closing event was held to its end.
 *
 * @param {object[]} events - { ts (s), event, runner, waited_s }
 * @param {object} job      - { runner_name, started_at, completed_at } (ISO)
 * @returns {number} seconds held, 0 when there is no hold
 */
export function heldSeconds(events, job) {
  const start = Date.parse(job?.started_at) / 1000;
  const end = Date.parse(job?.completed_at) / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const mine = (events ?? []).filter((e) => e.runner === job.runner_name && e.ts >= start - 5 && e.ts <= end + 5);
  const held = mine.find((e) => e.event === 'held');
  if (!held) return 0;
  const closed = mine.filter((e) => ['admitted', 'cancelled', 'timeout', 'orphaned'].includes(e.event) && e.ts >= held.ts);
  if (closed.length) return Math.max(...closed.map((e) => Number(e.waited_s) || 0));
  return Math.max(0, Math.round(end - held.ts));
}

/**
 * The class of a `cancelled` job, or null when it is no failure (superseded,
 * or cancelled by hand). Only a timeout after a real hold is the fleet's.
 */
export function classifyCancelled(messages, heldS) {
  const list = (messages ?? []).filter((m) => typeof m === 'string');
  if (!list.some((m) => TIMED_OUT.test(m))) return null;
  return heldS >= HOLD_BLAME_MIN_S ? 'admission-hold' : null;
}
