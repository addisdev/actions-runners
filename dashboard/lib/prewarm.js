// Forecast-driven pre-warming. Decides only — the caller duplicates a runner.
//
// Pre-warming is deliberately conservative: one duplicate per call, only when
// shadow evaluation says the forecast is trustworthy, the burst window is close
// enough to matter but not yet here, and reactive autoscale is not already
// handling the repo. A wrong pre-warm spends disk and a concurrency slot; a
// missed one costs a few minutes of queue wait — so every guard below errs toward
// staying quiet.

const CONF_RANK = { high: 2, medium: 1, low: 0 };

function confidenceMeets(confidence, minConfidence) {
  return (CONF_RANK[confidence] ?? 0) >= (CONF_RANK[minConfidence] ?? 1);
}

function repoRunners(runners, repo) {
  return runners.filter((r) => r.repo === repo);
}

function cloneSource(siblings) {
  const pool = siblings.filter((r) => !r.drainState);
  return pool.find((r) => !r.workingLocally && !r.ghBusy) ?? pool[0] ?? null;
}

function repoHasActiveWork(active, repo) {
  return active.some(
    (a) => a.repo === repo && (a.status === 'queued' || a.status === 'in_progress')
  );
}

function short(repo) {
  return String(repo).split('/').pop();
}

/**
 * Plan at most one forecast-driven duplicate runner.
 *
 * @param {object} opts
 * @param {boolean}  opts.enabled
 * @param {object[]} opts.predictions - from forecastDemand()
 * @param {object}   opts.gate - from evaluateGate()
 * @param {object[]} opts.runners
 * @param {object[]} opts.active
 * @param {object}   [opts.lastPrewarmByRepo] - repo -> last prewarm ms
 * @param {number}   [opts.now]
 * @param {number}   [opts.leadMs] - act only when windowStart is within this lead
 * @param {number}   [opts.cooldownMs]
 * @param {string}   [opts.minConfidence] - 'medium' | 'high'
 * @param {number}   [opts.cap] - maxInstancesPerRepo
 * @returns {{ act: false, reason: string, deficit?: number } | { act: true, name: string, repo: string, reason: string, deficit: number, mode: 'prewarm' }}
 */
export function planPrewarm({
  enabled = false,
  predictions = [],
  gate = { passed: false, reasons: [] },
  runners = [],
  active = [],
  lastPrewarmByRepo = {},
  now = Date.now(),
  leadMs = 3_600_000,
  cooldownMs = 3_600_000,
  minConfidence = 'medium',
  cap = 4,
} = {}) {
  if (!enabled) {
    return { act: false, reason: 'prewarm disabled', deficit: 0 };
  }

  if (!gate?.passed) {
    const why = gate?.reasons?.length ? gate.reasons.join('; ') : 'forecast gate not passed';
    return { act: false, reason: `forecast gate: ${why}`, deficit: 0 };
  }

  const blocked = [];
  const candidates = [];

  for (const prediction of predictions) {
    if (!confidenceMeets(prediction.confidence, minConfidence)) {
      continue;
    }

    const lead = prediction.windowStart - now;
    if (lead <= 0) {
      blocked.push(`window at ${new Date(prediction.windowStart).toISOString()}: already started`);
      continue;
    }
    if (lead > leadMs) {
      blocked.push(
        `window at ${new Date(prediction.windowStart).toISOString()}: `
        + `${Math.round(lead / 60_000)}m away, outside ${Math.round(leadMs / 60_000)}m lead`
      );
      continue;
    }

    for (const repoPred of prediction.repos ?? []) {
      const { repo, expectedPeak } = repoPred;
      if (!repo || !(expectedPeak > 0)) continue;

      const siblings = repoRunners(runners, repo);
      const have = siblings.length;

      if (expectedPeak <= have) {
        blocked.push(
          `${short(repo)}: expected peak ${expectedPeak} does not exceed ${have} registered runner(s)`
        );
        continue;
      }

      if (have >= cap) {
        blocked.push(`${short(repo)}: already at per-repo cap (${cap})`);
        continue;
      }

      const source = cloneSource(siblings);
      if (!source) {
        blocked.push(`${short(repo)}: no non-draining runner to copy labels from`);
        continue;
      }

      if (repoHasActiveWork(active, repo)) {
        blocked.push(`${short(repo)}: queued or in-progress work — reactive autoscale applies`);
        continue;
      }

      const last = lastPrewarmByRepo[repo] ?? 0;
      if (now - last < cooldownMs) {
        blocked.push(
          `${short(repo)}: prewarmed ${Math.round((now - last) / 60_000)}m ago `
          + `(cooldown ${Math.round(cooldownMs / 60_000)}m)`
        );
        continue;
      }

      const deficit = Math.max(0, Math.min(expectedPeak - have - 1, cap - have - 1));
      candidates.push({
        repo,
        source,
        deficit,
        expectedPeak,
        windowStart: prediction.windowStart,
        confidence: prediction.confidence,
        evidence: repoPred.evidence ?? repoPred.source ?? 'forecast',
      });
    }
  }

  if (!candidates.length) {
    return {
      act: false,
      reason: blocked.length ? blocked.join(' · ') : 'no repos within prewarm lead window',
      deficit: 0,
    };
  }

  // Highest deficit first; tie-break toward the soonest window.
  candidates.sort(
    (a, b) => b.deficit - a.deficit || a.windowStart - b.windowStart
  );

  const pick = candidates[0];
  const mins = Math.round((pick.windowStart - now) / 60_000);
  return {
    act: true,
    mode: 'prewarm',
    name: pick.source.name,
    repo: pick.repo,
    deficit: pick.deficit,
    reason:
      `forecast ${pick.confidence} confidence: peak ${pick.expectedPeak} in ~${mins}m `
      + `(${pick.evidence}); ${pick.deficit ? `${pick.deficit} more runner(s) may be needed after this` : 'one runner ahead of demand'}`,
  };
}
