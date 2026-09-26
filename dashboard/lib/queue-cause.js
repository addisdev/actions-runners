// Evidence-based queue-cause classifier.
//
// Every queued run that has waited past a threshold gets a structured
// diagnosis: one primary cause, a confidence level, a list of evidence
// items that drove it, and a recommended action.
//
// WHY A CLASSIFIER OVER A BOOLEAN FLAG
//
// The existing `stuck-queue` drift rule forks on a single question: is there an
// idle runner or not? That answers two of seven causes. The others are invisible
// — a label mismatch looks like a capacity problem when you can see only that
// "all runners are busy", and host saturation looks like a capacity problem when
// the headroom gate is refusing additions. Misreading the cause leads to the
// wrong remedy: duplicating a runner into a label mismatch adds a second runner
// that also never matches. The fleet has already made that mistake.
//
// CAUSE PRECEDENCE (conservative order: most definitive first)
//
// 1. telemetry-unavailable  — GitHub or local probes failed; cannot diagnose
// 2. github-hosted          — the job asked for a GitHub-hosted runner, not this fleet
// 3. unserved               — no runner registered for this repo at all
// 4. role-unserved          — repo has runners, but not for this known job role
// 5. label-mismatch         — no runner matches the job's runs-on labels
// 6. runner-down            — the repo's runner exists but is offline/dead/draining
// 7. concurrency-block      — workflow concurrency group limit reached, or account blocked
// 8. host-saturation        — the headroom gate is refusing additions
// 9. repo-capacity          — all matching runners are busy; adding one would help
// 10. github-delay          — eligible idle runner exists; probable GitHub dispatch lag
//
// "probable" for github-delay because the API does not expose a dispatch-reason
// field — an idle runner that should have accepted a job is strong circumstantial
// evidence, but not proof.
//
// CONFIDENCE LEVELS
// high   — structural proof (no runner exists, labels do not match, all probes present)
// medium — corroborated but not definitive (busy + no capacity issues)
// low    — indirect evidence only (everything looks fine, still queued)

import { roleLabel } from './state.js';

export const CAUSES = {
  TELEMETRY_UNAVAILABLE: 'telemetry-unavailable',
  GITHUB_HOSTED: 'github-hosted',
  UNSERVED: 'unserved',
  ROLE_UNSERVED: 'role-unserved',
  LABEL_MISMATCH: 'label-mismatch',
  RUNNER_DOWN: 'runner-down',
  CONCURRENCY_BLOCK: 'concurrency-block',
  HOST_SATURATION: 'host-saturation',
  REPO_CAPACITY: 'repo-capacity',
  GITHUB_DELAY: 'github-delay',
};

export const RECOMMENDED = {
  [CAUSES.TELEMETRY_UNAVAILABLE]: 'Wait for the next collector tick; act only once telemetry is restored.',
  [CAUSES.GITHUB_HOSTED]: 'Nothing to do here — this job runs on GitHub-hosted runners. If it is not starting, check GitHub Actions minutes, spending limits and the service status page.',
  [CAUSES.UNSERVED]: 'Register a runner for this repo.',
  [CAUSES.ROLE_UNSERVED]: 'Register a runner carrying this job role and its required labels.',
  [CAUSES.LABEL_MISMATCH]: 'Check that runs-on labels match a runner\'s labels. Do NOT add a runner — it will share the mismatch.',
  [CAUSES.RUNNER_DOWN]: 'Run health.sh --repair or restart the runner from the dashboard.',
  [CAUSES.CONCURRENCY_BLOCK]: 'GitHub is holding this run before dispatch. Check workflow concurrency, required approvals, billing, and GitHub Actions status.',
  [CAUSES.HOST_SATURATION]: 'Do not add another runner on this host. Let running jobs finish, reduce workflow fan-out, or add capacity on another host.',
  [CAUSES.REPO_CAPACITY]: 'Add a runner for this repo. The Capacity tab shows whether the host can take one.',
  [CAUSES.GITHUB_DELAY]: 'Probably fine — GitHub dispatch takes a few seconds. If the job is still queued in 2 minutes, check for GitHub API errors.',
};

/**
 * Classify why a single queued run has not been picked up.
 *
 * @param {object} opts
 * @param {object}   opts.run      - Shaped run from shapeRun(); must have status='queued'
 * @param {object[]} opts.runners  - Current snapshot.runners
 * @param {object}   opts.capacity - Current snapshot.capacity from headroom()
 * @param {object}   opts.api      - Current snapshot.api (remaining, etc.)
 * @param {object}   [opts.collector] - Current snapshot.collector
 * @param {string[]} [opts.runLabels] - Labels the queued run's jobs need (from jobsForRun)
 * @param {boolean}  [opts.hasLintFindings] - Whether this workflow has open lint findings
 * @returns {{ cause, confidence, evidence: string[], recommended, actionEligible }}
 */
export function classifyQueueCause({ run, runners, capacity, api = {}, collector = {}, runLabels = null, hasLintFindings = false } = {}) {
  const evidence = [];

  // ---- telemetry availability -------------------------------------------
  // `lastError` is the fleet-wide collector summary shown in the footer. It
  // must not poison every queued run when one unrelated repository fails. New
  // snapshots carry the underlying errors keyed by repository; retain the
  // summary fallback only for older snapshots and direct callers.
  const hasScopedErrors = collector?.repoErrors
    && typeof collector.repoErrors === 'object'
    && !Array.isArray(collector.repoErrors);
  const collectorError = hasScopedErrors
    ? collector.repoErrors[run?.repo] ?? null
    : collector?.lastError;
  const apiFailure = collectorError || (api.remaining != null && api.remaining < 10);
  const repoRunners = runners.filter((r) => r.repo === run.repo);
  const anyGhUnknown = repoRunners.some((r) => r.ghUnknown);

  if (apiFailure || anyGhUnknown) {
    if (apiFailure) evidence.push(`GitHub API: ${collectorError ?? `only ${api.remaining} requests remaining`}`);
    if (anyGhUnknown) evidence.push('GitHub runner status unavailable for this repo this tick');
    return result(CAUSES.TELEMETRY_UNAVAILABLE, 'low', evidence, false);
  }

  // ---- the job was never going to run here -------------------------------
  // A `runs-on:` without `self-hosted` names a GitHub-hosted image, and no fact
  // about this fleet explains or changes why it is queued. Checked before the
  // repo's own runners are considered, because the answer does not depend on
  // them: a repo with no runner is not `unserved` if its work does not want one.
  //
  // Without this the fleet reported `label-mismatch` at CRITICAL for a
  // example Android job asking for `ubuntu-latest` — evidence reading "Job
  // needs labels [ubuntu-latest] / Runners carry [self-hosted, macOS, ARM64]",
  // which is true, and a recommendation to go and reconcile those labels, which
  // would mean editing a workflow that is behaving correctly. A job queued on
  // GitHub's side is usually minutes, a spending limit or an incident, and all
  // three are somewhere this dashboard cannot see.
  if (runLabels && runLabels.length > 0 && !runLabels.some((l) => l.toLowerCase() === 'self-hosted')) {
    evidence.push(`Job asked for [${runLabels.join(', ')}], which is a GitHub-hosted runner`);
    evidence.push('No self-hosted runner can take this job, and none should');
    return result(CAUSES.GITHUB_HOSTED, 'high', evidence, false);
  }

  // ---- no runners at all -------------------------------------------------
  if (repoRunners.length === 0) {
    evidence.push('No runner is registered for this repo');
    // Action-eligible, unlike every other non-capacity cause here. The field
    // means "adding a runner would help", and for the six causes marked false it
    // genuinely would not — a second runner shares a label mismatch, and another
    // runner on a saturated host makes the saturation worse. A repo with no
    // runner is the opposite case: one runner is the entire remedy, and
    // RECOMMENDED has said so all along.
    //
    // This was false only because nothing could carry the recommendation out.
    // planScaleUp now registers a first runner for this cause; whether it may is
    // decided by the provisionUnserved setting, which gates the sizing row that
    // reaches the planner, not by pretending here that the remedy is unknown.
    return result(CAUSES.UNSERVED, 'high', evidence, true);
  }

  // ---- label mismatch ----------------------------------------------------
  // Only run if we have label information from the job API call.
  if (runLabels && runLabels.length > 0) {
    const needsLabels = runLabels.filter((l) => !['self-hosted', 'macos', 'linux', 'windows', 'x64', 'arm64'].includes(l.toLowerCase()));
    if (needsLabels.length > 0) {
      const registered = repoRunners.filter((r) => r.registered && r.ghStatus === 'online');
      const anyMatch = registered.some((r) =>
        needsLabels.every((l) => r.labels.map((x) => x.toLowerCase()).includes(l.toLowerCase()))
      );
      if (!anyMatch && registered.length > 0) {
        evidence.push(`Job needs labels [${needsLabels.join(', ')}]`);
        evidence.push(`Runners carry [${[...new Set(registered.flatMap((r) => r.labels))].join(', ')}]`);
        const role = roleLabel(needsLabels);
        const roleExists = role
          && registered.some((r) => roleLabel(r.extraLabels ?? r.labels) === role);
        if (role && !roleExists) {
          evidence.push(`No ${role} runner is registered for this repo`);
          return result(CAUSES.ROLE_UNSERVED, 'high', evidence, true);
        }
        return result(CAUSES.LABEL_MISMATCH, 'high', evidence, false);
      }
    }
  }

  // ---- lint-detected mismatch (structural, pre-job) ----------------------
  if (hasLintFindings) {
    evidence.push('Workflow lint detected a label mismatch or unmatched runs-on');
    return result(CAUSES.LABEL_MISMATCH, 'medium', evidence, false);
  }

  // ---- runners exist but are down/draining --------------------------------
  const onlineRunners = repoRunners.filter((r) => r.registered && r.ghStatus === 'online' && r.launchdState === 'running' && !r.drainState);
  const downRunners = repoRunners.filter((r) => r.registered && (r.ghStatus !== 'online' || r.launchdState !== 'running' || r.drainState));

  if (onlineRunners.length === 0 && downRunners.length > 0) {
    for (const r of downRunners) {
      if (r.drainState) {
        evidence.push(`${r.name} is ${r.drainState}`);
      } else if (r.launchdState !== 'running') {
        evidence.push(`${r.name} launchd state: ${r.launchdState}`);
      } else {
        evidence.push(`${r.name} GitHub status: ${r.ghStatus}`);
      }
    }
    return result(CAUSES.RUNNER_DOWN, 'high', evidence, false);
  }

  // ---- workflow concurrency group ----------------------------------------
  // If an online idle runner exists but is not accepting work, the likely cause
  // is GitHub's workflow concurrency mechanism rather than anything on this host.
  // We have no API access to concurrency slot state, so this is inferential.
  const idleOnline = onlineRunners.filter((r) => !r.ghBusy && !r.workingLocally);
  if (idleOnline.length > 0) {
    // This is GitHub-delay if the wait is short, concurrency-block if it is not.
    // We'll distinguish by wait time: >3 min with an idle runner is a strong
    // signal that something is holding the slot.
    const queuedSince = Math.max(
      new Date(run.createdAt).getTime(),
      new Date(run.startedAt ?? run.createdAt).getTime()
    );
    const waitMs = Date.now() - queuedSince;

    if (waitMs > 3 * 60 * 1000) {
      evidence.push(`${idleOnline.length} idle online runner(s) exist but the run is not dispatched`);
      evidence.push(`Queued ${Math.round(waitMs / 60000)}m — longer than typical GitHub dispatch latency`);
      // GitHub exposes the queued state, but not the reason it has not created
      // or dispatched a job. Calling this a definite concurrency block was
      // false precision: approvals, billing and a GitHub-side incident look
      // identical from here. An unchanged run with no jobs for an hour is,
      // however, safe to identify as stale and offer for explicit cancellation.
      const jobs = Array.isArray(run.jobs) ? run.jobs : [];
      const updatedAt = new Date(run.updatedAt ?? run.createdAt).getTime();
      const unchangedMs = Date.now() - updatedAt;
      const stale = jobs.length === 0
        && Number.isFinite(unchangedMs)
        && waitMs > 60 * 60 * 1000
        && unchangedMs > 60 * 60 * 1000;
      if (jobs.length === 0) evidence.push('GitHub has not created any jobs for this workflow run');
      if (stale) {
        evidence.push(`Run state has not changed for ${Math.round(unchangedMs / 60000)}m`);
        return result(CAUSES.CONCURRENCY_BLOCK, 'low', evidence, false, {
          recommended: 'This run is stale on GitHub. Cancel it, then rerun the workflow if the work is still needed.',
          remediation: { action: 'run.cancel', label: 'Cancel stale run' },
        });
      }
      return result(CAUSES.CONCURRENCY_BLOCK, 'low', evidence, false);
    }

    evidence.push(`${idleOnline.length} idle online runner(s) exist`);
    evidence.push(`Queued ${Math.round(waitMs / 1000)}s — within normal dispatch latency`);
    return result(CAUSES.GITHUB_DELAY, 'low', evidence, false);
  }

  // ---- host saturation ----------------------------------------------------
  if (capacity && !capacity.ok) {
    for (const reason of capacity.reasons ?? []) {
      evidence.push(reason);
    }
    evidence.push('Headroom gate is refusing scale-up additions');
    return result(CAUSES.HOST_SATURATION, 'high', evidence, false);
  }

  // ---- repo capacity (all runners busy) ------------------------------------
  const busyRunners = onlineRunners.filter((r) => r.ghBusy || r.workingLocally);
  if (busyRunners.length > 0) {
    evidence.push(`All ${busyRunners.length} runner(s) for this repo are executing a job`);
    if (capacity?.ok) evidence.push('Host has headroom to accept a new runner');
    return result(CAUSES.REPO_CAPACITY, 'high', evidence, true);
  }

  // ---- fallback: something unclear happened --------------------------------
  evidence.push('No clear structural cause found; telemetry is present and runners appear healthy');
  return result(CAUSES.GITHUB_DELAY, 'low', evidence, false);
}

function result(cause, confidence, evidence, actionEligible, { recommended, remediation } = {}) {
  return {
    cause,
    confidence,
    evidence,
    recommended: recommended ?? RECOMMENDED[cause] ?? 'Investigate manually.',
    actionEligible,
    remediation: remediation ?? null,
  };
}

/**
 * The labels to diagnose a queued run against.
 *
 * A run's jobs each carry their own `runs-on:`, so their label sets must never
 * be merged. An example Android repo had a branch whose `build` ran on
 * `ubuntu-latest` and whose `instrumentation` ran on `[self-hosted, macOS]`;
 * merging them produced `[self-hosted, macOS, ubuntu-latest]`, a set no machine
 * can ever carry. That set cleared the GitHub-hosted check (it contains
 * `self-hosted`) and then failed the label check, so a correct workflow was
 * reported as a critical label-mismatch, and autoscale, reading the same merged
 * set, would have registered a runner advertising `ubuntu-latest`.
 *
 * Only jobs that are themselves queued explain why a run is queued — a sibling
 * that is running or finished has by definition already found a runner. Among
 * those, a self-hosted job wins, because it is the only kind this fleet can do
 * anything about; a GitHub-hosted sibling is waiting somewhere we cannot see.
 *
 * @param {object} run - A shaped run, with `jobs` from shapeJob
 * @returns {string[]|null} One job's labels, or null when there is nothing to go on
 */
export function queuedJobLabels(run) {
  const jobs = run?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return null;

  const waiting = jobs.filter((j) => j.status === 'queued');
  const pool = waiting.length ? waiting : jobs;

  const chosen =
    pool.find((j) => (j.labels ?? []).some((l) => String(l).toLowerCase() === 'self-hosted')) ?? pool[0];

  return chosen?.labels?.length ? [...chosen.labels] : null;
}

/**
 * Classify all queued runs in the snapshot.
 *
 * @param {object} snap - snapshot from fleetd
 * @param {Map}    [lintByRepo] - Optional: Set of repos with open lint findings
 * @returns {Map<number, ReturnType<classifyQueueCause>>}  Keyed by run.id
 */
export function classifyQueuedRuns(snap, lintByRepo = new Set()) {
  const results = new Map();
  for (const run of snap.active ?? []) {
    if (run.status !== 'queued') continue;
    const classification = classifyQueueCause({
      run,
      runners: snap.runners ?? [],
      capacity: snap.capacity ?? { ok: true, reasons: [] },
      api: snap.api ?? {},
      collector: snap.collector ?? {},
      // shapeRun does not hoist labels onto the run — they belong to individual
      // jobs, since a run's jobs can target different runners. Reading
      // run.labels here meant this path never saw any labels at all and so
      // could never reach label-mismatch, while the daemon's own call site
      // could. Same derivation as fleetd.js now.
      runLabels: queuedJobLabels(run),
      hasLintFindings: lintByRepo.has(run.repo),
    });
    results.set(run.id, classification);
  }
  return results;
}
