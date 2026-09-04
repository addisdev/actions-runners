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
  'no-runner': {
    label: 'No runner matched',
    blame: 'host',
    hint: 'Nothing carrying the required labels picked the job up. See the Lint tab for '
      + 'unmatched runs-on labels.',
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
