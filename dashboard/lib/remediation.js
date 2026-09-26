// Remediation candidates — which recently failed runs are actionable and how.
//
// A failed run is one of four things, and the distinction determines who (or
// what) handles it:
//
//   infra-rerun  — runner lost contact mid-job; the code was fine; retrying
//                  is the correct response. Safe to do automatically.
//
//   ai-fix       — a step exited non-zero, or no runner matched the required
//                  labels; the cause is in the workflow or the code. A cloud
//                  agent can read the logs and propose a fix.
//
//   diagnose     — account billing, quota, or unclassified jobs. Nothing
//                  fixable by retrying or editing a file.
//
//   skip         — wrong event type, no jobs yet, or a non-fixable conclusion
//                  (cancelled, skipped, etc.).
//
// The policy below is deterministic and conservative. Any uncertainty defaults
// to 'diagnose'. Nothing here touches the fleet or files a PR.
//
// The 2-hour window is chosen to pair with the backfill interval: a failure
// classified after the 10-minute backfill pass remains in the window long
// enough for the bridge to act on it (the bridge sweeps every 60 seconds).

// Events where automated action is safe. These all originate from trusted code
// on the target repo: push, same-repo PRs, manual dispatch, and scheduled
// runs are equivalent from a trust standpoint. repository_dispatch and other
// external triggers are excluded.
export const SAFE_EVENTS = new Set(['push', 'pull_request', 'workflow_dispatch', 'schedule']);

export const MAX_CANDIDATE_AGE_MS = 2 * 60 * 60 * 1000;

export function remediationCandidates(db, { maxAgeMs = MAX_CANDIDATE_AGE_MS, now = Date.now() } = {}) {
  const since = new Date(now - maxAgeMs).toISOString();

  // Every run in the window, whatever its status, ordered newest-first within
  // each workflow. Successes and still-running attempts have to be in this set:
  // they are the only evidence that a failure has already been dealt with.
  // Filtering the query down to failure/timed_out instead would drop the very
  // rows that make an older failure moot.
  const runs = db.prepare(`
    SELECT r.id, r.repo, r.workflow_name, r.workflow_path, r.head_branch,
           r.head_sha, r.pr_number, r.actor, r.event, r.html_url,
           r.run_attempt, r.status, r.conclusion, r.run_started_at,
           ro.default_branch
    FROM runs r
    LEFT JOIN repos ro ON ro.full_name = r.repo
    WHERE r.run_started_at >= ?
    ORDER BY r.repo, r.workflow_name, r.run_started_at DESC`).all(since);

  // One candidate per (repo, workflow_name), and only when the newest run of
  // that workflow is itself a completed failure. Two kinds of supersession are
  // rejected here, both of which mean someone or something is already on it:
  //
  //   failed, then a later run passed  — re-dispatched or re-run and green now.
  //   failed, and a later run is live  — a retry is in flight; let it land.
  //
  // Marking the key as seen before either check is what makes this work: the
  // newest run speaks for the workflow, so a green or in-flight run suppresses
  // the older red ones rather than being skipped over in favour of them.
  const seen = new Set();
  const latest = [];
  for (const r of runs) {
    const key = `${r.repo}\x00${r.workflow_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.status !== 'completed') continue;
    if (r.conclusion === 'failure' || r.conclusion === 'timed_out') latest.push(r);
  }

  const jobQuery = db.prepare(`
    SELECT id, name, conclusion, failure_class, failure_detail, runner_name, html_url
    FROM jobs
    WHERE run_id = ? AND id > 0
    ORDER BY id`);

  const candidates = [];
  for (const run of latest) {
    const jobs = jobQuery.all(run.id);
    const strategy = classifyRun(run, jobs);
    candidates.push({
      repo: run.repo,
      runId: run.id,
      runAttempt: run.run_attempt ?? 1,
      runStartedAt: run.run_started_at ?? null,
      workflowName: run.workflow_name ?? null,
      workflowPath: run.workflow_path ?? null,
      event: run.event ?? null,
      branch: run.head_branch ?? null,
      sha: run.head_sha ?? null,
      prNumber: run.pr_number ?? null,
      actor: run.actor ?? null,
      url: run.html_url ?? null,
      conclusion: run.conclusion,
      defaultBranch: run.default_branch ?? null,
      strategy,
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        conclusion: j.conclusion,
        failureClass: j.failure_class ?? null,
        // Truncated: failure details can be multi-kilobyte annotation texts.
        failureDetail: (j.failure_detail ?? null)?.slice(0, 500) ?? null,
        runnerName: j.runner_name ?? null,
        url: j.html_url ?? null,
      })),
    });
  }

  return candidates;
}

// Deterministic policy. Returns one of:
//   'infra-rerun' | 'ai-fix' | 'diagnose' | 'skip'
//
// The conservative bias is intentional. Any uncertainty returns 'diagnose'
// rather than 'skip', so a human will at least see the alert from the
// existing escalation path that fires on newly-failing workflows.
export function classifyRun(run, jobs) {
  // Unsupported event types: repository_dispatch, deployment, merge_group, etc.
  if (run.event && !SAFE_EVENTS.has(run.event)) return 'skip';

  // No jobs recorded yet — backfill has not reached this run.
  // Return 'diagnose' so the candidate appears in the response and the operator
  // knows a decision is pending, rather than 'skip' which hides it entirely.
  if (!jobs.length) return 'diagnose';

  const failedJobs = jobs.filter(
    (j) => j.conclusion === 'failure' || j.conclusion === 'timed_out',
  );

  // No failed jobs, but at least one job has no conclusion recorded yet —
  // backfill has seen the run and not yet the outcome. Same incomplete-evidence
  // case as the NULL failure_class check below, and it resolves on a later
  // sweep once the job rows are filled in.
  if (!failedJobs.length && jobs.some((j) => j.conclusion == null)) return 'diagnose';

  // Run completed as failure/timed_out but every job has a conclusion and none
  // of them failed: unusual (cancelled mid-run, or a workflow-level failure
  // before jobs started).
  if (!failedJobs.length) return 'skip';

  const classes = new Set(failedJobs.map((j) => j.failure_class));

  // Any NULL failure_class means backfill has not classified that job yet.
  // Do not act on incomplete evidence.
  if (classes.has(null)) return 'diagnose';

  // Account-level blocks are not fixable by retrying or editing the code.
  if (classes.has('account-blocked') || classes.has('account-quota')) return 'diagnose';

  // Expired annotations: we cannot establish what went wrong.
  if (classes.has('unknown')) return 'diagnose';

  // All failures are runner-lost: the runner crashed under load or lost
  // its connection. The code was fine; retrying is the correct response.
  if ([...classes].every((c) => c === 'runner-lost')) return 'infra-rerun';

  // Code or config failures only when every failed job is one of these.
  // Mixed runner-lost plus code failure is treated as diagnose: the infra
  // symptom may have caused the step failure, and an AI fix would be wrong.
  if ([...classes].every((c) => c === 'job-failed' || c === 'no-runner')) return 'ai-fix';

  // Mixed or unrecognised failure classes.
  return 'diagnose';
}
