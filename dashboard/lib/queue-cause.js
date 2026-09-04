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
// 2. unserved               — no runner registered for this repo at all
// 3. label-mismatch         — no runner matches the job's runs-on labels
// 4. runner-down            — the repo's runner exists but is offline/dead/draining
// 5. concurrency-block      — workflow concurrency group limit reached, or account blocked
// 6. host-saturation        — the headroom gate is refusing additions
// 7. repo-capacity          — all matching runners are busy; adding one would help
// 8. github-delay           — eligible idle runner exists; probable GitHub dispatch lag
//
// "probable" for github-delay because the API does not expose a dispatch-reason
// field — an idle runner that should have accepted a job is strong circumstantial
// evidence, but not proof.
//
// CONFIDENCE LEVELS
// high   — structural proof (no runner exists, labels do not match, all probes present)
// medium — corroborated but not definitive (busy + no capacity issues)
// low    — indirect evidence only (everything looks fine, still queued)

export const CAUSES = {
  TELEMETRY_UNAVAILABLE: 'telemetry-unavailable',
  UNSERVED: 'unserved',
  LABEL_MISMATCH: 'label-mismatch',
  RUNNER_DOWN: 'runner-down',
  CONCURRENCY_BLOCK: 'concurrency-block',
  HOST_SATURATION: 'host-saturation',
  REPO_CAPACITY: 'repo-capacity',
  GITHUB_DELAY: 'github-delay',
};

export const RECOMMENDED = {
  [CAUSES.TELEMETRY_UNAVAILABLE]: 'Wait for the next collector tick; act only once telemetry is restored.',
  [CAUSES.UNSERVED]: 'Register a runner for this repo.',
  [CAUSES.LABEL_MISMATCH]: 'Check that runs-on labels match a runner\'s labels. Do NOT add a runner — it will share the mismatch.',
  [CAUSES.RUNNER_DOWN]: 'Run health.sh --repair or restart the runner from the dashboard.',
  [CAUSES.CONCURRENCY_BLOCK]: 'Review the concurrency group for this workflow. Another job from the same group may be running.',
  [CAUSES.HOST_SATURATION]: 'Wait for running jobs to finish. Check the headroom panel before adding any runners.',
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
  const apiFailure = collector?.lastError || (api.remaining != null && api.remaining < 10);
  const repoRunners = runners.filter((r) => r.repo === run.repo);
  const anyGhUnknown = repoRunners.some((r) => r.ghUnknown);

  if (apiFailure || anyGhUnknown) {
    if (apiFailure) evidence.push(`GitHub API: ${collector.lastError ?? `only ${api.remaining} requests remaining`}`);
    if (anyGhUnknown) evidence.push('GitHub runner status unavailable for this repo this tick');
    return result(CAUSES.TELEMETRY_UNAVAILABLE, 'low', evidence, false);
  }

  // ---- no runners at all -------------------------------------------------
  if (repoRunners.length === 0) {
    evidence.push('No runner is registered for this repo');
    return result(CAUSES.UNSERVED, 'high', evidence, false);
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
      return result(CAUSES.CONCURRENCY_BLOCK, 'medium', evidence, false);
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

function result(cause, confidence, evidence, actionEligible) {
  return {
    cause,
    confidence,
    evidence,
    recommended: RECOMMENDED[cause] ?? 'Investigate manually.',
    actionEligible,
  };
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
      runLabels: run.jobs?.flatMap((j) => j.labels ?? []) ?? null,
      hasLintFindings: lintByRepo.has(run.repo),
    });
    results.set(run.id, classification);
  }
  return results;
}
