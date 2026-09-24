// Decides whether to add or remove one runner. Decides only — the caller
// executes, so every decision here is testable without touching the fleet.
//
// WHY THIS LIVES IN THE COLLECTOR AND NOT IN AUTOFIX. Autofix remediates faults:
// something is broken, restart it. Scaling is capacity management, and the two
// want opposite dispositions — autofix should act fast on a clear fault, while a
// scaler should act slowly and reluctantly because it is spending a shared
// resource. Putting it here also avoids widening autofix's action allowlist to
// include registration and removal, which it deliberately excludes.
//
// ONE ACTION PER SWEEP by default, always. Registering a runner takes tens of
// seconds and changes the very inputs this reads, so a batch decision is stale
// before it finishes. When the caller opts into `revalidate`, a bounded list may
// be returned — but only if the executor re-runs this planner between actions.
//
// WHAT THIS CANNOT DO. It cannot make a fan-out burst faster. Peak demand for one
// repo on this fleet is 33 simultaneous jobs and a runner takes tens of seconds
// to create, so by the time capacity arrives the burst is over. Burst mode only
// shortens the *wait* before the first addition; it still adds one runner per
// validated sweep. It is aimed at the SUSTAINED case: the repo that has queued
// for ten minutes because it owns one runner and wants two.

import { queuedJobLabels } from './queue-cause.js';
import { roleFromExtraLabels, roleFromJobLabels, sizingKey } from './sizing.js';

const isSelfHosted = (labels) => labels.some((l) => String(l).toLowerCase() === 'self-hosted');

// Labels every self-hosted runner on this fleet already carries, so they say
// nothing about what a NEW runner would need. register.sh applies them itself;
// passing them back as extra labels would ask config.sh for a duplicate of
// `arm64` and fail the registration. Kept in step with the same list in
// lib/queue-cause.js, which strips them for the same reason.
const PLATFORM_LABELS = new Set(['self-hosted', 'macos', 'linux', 'windows', 'x64', 'arm64']);

function extraFromJobLabels(labels = []) {
  return (labels ?? []).filter((l) => !PLATFORM_LABELS.has(String(l).toLowerCase()));
}

function cooldownKey(repo, role) {
  return sizingKey(repo, role);
}

/**
 * Pick burst vs sustained thresholds for one repo+role row.
 *
 * @returns {{ mode: 'burst'|'sustained', minQueuedMs: number, cooldownMs: number }}
 */
export function resolveScaleMode({ queuedCount = 0, waitedMs = 0, limits = {} } = {}) {
  const burstEnabled = limits.burstScale ?? false;
  const burstMinJobs = limits.burstMinQueuedJobs ?? 2;
  const burstMinMs = limits.burstMinQueuedMs ?? 120000;
  const sustainedMinMs = limits.minQueuedMs ?? 600000;

  if (burstEnabled && queuedCount >= burstMinJobs && waitedMs >= burstMinMs) {
    return {
      mode: 'burst',
      minQueuedMs: burstMinMs,
      cooldownMs: limits.burstScaleCooldownMs ?? 300000,
    };
  }
  return {
    mode: 'sustained',
    minQueuedMs: sustainedMinMs,
    cooldownMs: limits.scaleCooldownMs ?? 1800000,
  };
}

// A runner to clone from. Prefers an idle one so the summary reads sensibly, but
// any sibling will do — duplicate only reads its repo and labels.
//
// A draining runner is excluded as a source. Its labels are probably fine, but
// somebody is in the middle of retiring it, and copying from it produces a new
// runner modelled on the one being removed — which reads, correctly, as the
// scaler and the operator working against each other.
function cloneSource(siblings, preferRole = null) {
  const nonDraining = siblings.filter((r) => !r.drainState);
  const pool = preferRole != null
    ? (nonDraining.filter((r) => roleFromExtraLabels(r.extraLabels) === preferRole).length
        ? nonDraining.filter((r) => roleFromExtraLabels(r.extraLabels) === preferRole)
        : nonDraining)
    : nonDraining;
  return pool.find((r) => !r.workingLocally && !r.ghBusy) ?? pool[0] ?? null;
}

function sameRoleSiblings(siblings, role) {
  return siblings.filter((r) => roleFromExtraLabels(r.extraLabels) === role);
}

/**
 * Full scale-up evaluation. Returns the next action plus any remaining deficit.
 *
 * @returns {{
 *   act: boolean,
 *   reason: string,
 *   mode?: 'burst'|'sustained',
 *   deficit?: number,
 *   revalidate?: boolean,
 *   actions?: object[],
 *   register?: boolean,
 *   name?: string|null,
 *   repo?: string,
 *   role?: string|null,
 *   extraLabels?: string[],
 * }}
 */
export function buildScaleUpPlan({
  sizing = [],
  capacity = { ok: false, reasons: [] },
  runners = [],
  active = [],
  lastUpByRepo = {},
  limits = {},
  now = Date.now(),
  queueCauses = null,
  revalidate = false,
} = {}) {
  const rows = capacity.ok ? sizing : sizing.filter((r) => r.unserved);
  if (!capacity.ok && !rows.length) {
    return { act: false, reason: `no headroom: ${capacity.reasons.join('; ')}`, deficit: 0 };
  }

  const causeAllows = (repo, role, runIdsForRole) => {
    if (!queueCauses) return { ok: true };
    const roleSpecific = [...queueCauses.entries()]
      .filter(([runId]) => runIdsForRole.has(runId))
      .map(([, c]) => c)
      .filter((c) => c.repo === repo);
    // When run ids are present, honour per-run verdicts. Otherwise fall back to
    // the repo-wide map fleetd already supplies for backward compatibility.
    const causes = roleSpecific.length
      ? roleSpecific
      : [...queueCauses.values()].filter((c) => c.repo === repo);
    if (!causes.length) return { ok: true };
    const eligible = causes.find((c) => c.actionEligible && c.confidence === 'high');
    if (eligible) return { ok: true };
    const worst = causes[0];
    const tag = role ? `${short(repo)}/${role}` : short(repo);
    return {
      ok: false,
      why: `${tag}: diagnosed as ${worst.cause} (${worst.confidence} confidence), not capacity`,
    };
  };

  const queuedSince = new Map();
  const queuedLabels = new Map();
  const queuedCount = new Map();
  const runIdsByKey = new Map();

  for (const a of active) {
    if (a.status !== 'queued') continue;
    const at = Date.parse(a.startedAt ?? a.createdAt ?? '');
    if (!Number.isFinite(at)) continue;

    const labels = queuedJobLabels(a);
    const role = roleFromJobLabels(labels ?? []);
    const key = sizingKey(a.repo, role);

    const prev = queuedSince.get(key);
    if (prev == null || at < prev) queuedSince.set(key, at);
    queuedCount.set(key, (queuedCount.get(key) ?? 0) + 1);
    if (!runIdsByKey.has(key)) runIdsByKey.set(key, new Set());
    runIdsByKey.get(key).add(a.id);

    if (labels?.length) {
      const prevLabels = queuedLabels.get(key);
      if (!prevLabels || (!isSelfHosted([...prevLabels]) && isSelfHosted(labels))) {
        queuedLabels.set(key, new Set(labels));
      }
    }
  }

  const blocked = [];
  const candidates = [];

  for (const row of rows) {
    if (row.delta <= 0) continue;

    const key = sizingKey(row.repo, row.role ?? null);
    const since = queuedSince.get(key);
    if (since == null) {
      blocked.push(`${label(row)}: wants ${row.want} but nothing is queued for this role`);
      continue;
    }

    const waited = now - since;
    const qCount = queuedCount.get(key) ?? 0;
    const scale = resolveScaleMode({ queuedCount: qCount, waitedMs: waited, limits });

    if (waited < scale.minQueuedMs) {
      blocked.push(
        `${label(row)}: queued ${Math.round(waited / 60000)}m, needs ${Math.round(scale.minQueuedMs / 60000)}m (${scale.mode})`
      );
      continue;
    }

    const last = lastUpByRepo[cooldownKey(row.repo, row.role ?? null)]
      ?? lastUpByRepo[row.repo]
      ?? 0;
    if (now - last < scale.cooldownMs) {
      blocked.push(
        `${label(row)}: scaled up ${Math.round((now - last) / 60000)}m ago (${scale.mode} cooldown)`
      );
      continue;
    }

    const allowed = causeAllows(row.repo, row.role ?? null, runIdsByKey.get(key) ?? new Set());
    if (!allowed.ok) {
      blocked.push(allowed.why);
      continue;
    }

    const siblings = runners.filter((r) => r.repo === row.repo);
    const role = row.role ?? null;
    const roleSiblings = role != null ? sameRoleSiblings(siblings, role) : siblings;
    const source = cloneSource(siblings, role);

    if (!source) {
      if (!row.unserved) {
        blocked.push(`${label(row)}: no existing runner to copy labels from`);
        continue;
      }

      const asked = [...(queuedLabels.get(key) ?? [])];
      if (!asked.some((l) => l.toLowerCase() === 'self-hosted')) {
        blocked.push(
          asked.length
            ? `${label(row)}: queued work targets GitHub-hosted runners`
            : `${label(row)}: no job labels available to size a runner from`
        );
        continue;
      }

      candidates.push({
        row,
        scale,
        action: {
          register: true,
          firstRunner: true,
          name: null,
          repo: row.repo,
          role,
          extraLabels: extraFromJobLabels(asked),
          reason:
            `queued ${Math.round(waited / 60000)}m with no runner registered; ` +
            `${row.reason}`,
        },
      });
      continue;
    }

    const asked = [...(queuedLabels.get(key) ?? [])];
    const extraLabels = roleSiblings.length
      ? (source.extraLabels ?? [])
      : extraFromJobLabels(asked.length ? asked : (source.extraLabels ?? []));
    const registerRole = role != null && roleSiblings.length === 0;

    candidates.push({
      row,
      scale,
      action: {
        // A repo can already have a runner while this role has none. Duplicating
        // an arbitrary sibling would copy the wrong labels locally; register the
        // first runner for the new role explicitly from queued-job labels.
        register: registerRole,
        firstRunner: false,
        name: registerRole ? null : source.name,
        repo: row.repo,
        role,
        extraLabels,
        reason:
          `queued ${Math.round(waited / 60000)}m with ${row.have} ${role ?? 'unroled'} runner(s); ` +
          `${row.reason}`,
      },
    });
  }

  if (!candidates.length) {
    return {
      act: false,
      reason: blocked.length ? blocked.join(' · ') : 'nothing under-provisioned with queued work',
      deficit: 0,
    };
  }

  // Worst deficit first — same ordering as sizeFleet.
  candidates.sort((a, b) => b.row.delta - a.row.delta || b.row.concurrency.p90 - a.row.concurrency.p90);

  const totalDeficit = candidates.reduce((sum, c) => sum + c.row.delta, 0);

  if (revalidate && (limits.burstScale ?? false)) {
    const maxBatch = limits.burstMaxAdditionsPerRepo ?? 2;
    const actions = candidates.slice(0, maxBatch).map(({ action, scale, row }) => ({
      ...action,
      mode: scale.mode,
      deficit: Math.max(0, row.delta - 1),
    }));
    return {
      act: true,
      revalidate: true,
      actions,
      mode: actions[0]?.mode ?? 'sustained',
      deficit: Math.max(0, totalDeficit - actions.length),
      reason: actions.map((a) => a.reason).join(' · '),
      ...actions[0],
    };
  }

  const pick = candidates[0];
  const deficit = Math.max(0, totalDeficit - 1);
  return {
    act: true,
    mode: pick.scale.mode,
    deficit,
    ...pick.action,
  };
}

/**
 * @returns {{ act: false, reason: string, deficit?: number } | { act: true, name, repo, reason, mode, deficit, role?, register?, extraLabels?, revalidate?, actions? }}
 */
export function planScaleUp(opts = {}) {
  return buildScaleUpPlan(opts);
}

/**
 * @param idle  Map of runner name -> { lastJobAt: ms|null, ageMs: number }
 * @returns {{ act: false, reason } | { act: true, name, repo, reason }}
 */
export function planScaleDown({
  runners = [],
  active = [],
  idle = new Map(),
  limits = {},
  now = Date.now(),
} = {}) {
  const ttl = limits.idleTtlMs ?? 21600000;

  // Any queued or running work for a repo takes all of its runners off the table,
  // not just the busy one: removing a sibling while its repo has a backlog is
  // removing capacity from the exact repo that is asking for it.
  const workingRepos = new Set(active.map((a) => a.repo));

  const skipped = [];
  const candidates = runners
    // Instance 1 is never a candidate. Removing it does not free contention, it
    // takes a repo's CI away entirely.
    .filter((r) => (r.instance ?? 1) > 1)
    .sort((a, b) => (b.instance ?? 1) - (a.instance ?? 1));

  for (const r of candidates) {
    if (r.workingLocally || r.ghBusy) {
      skipped.push(`${r.name}: busy`);
      continue;
    }
    // A runner mid-drain belongs to whoever started the drain. Removing it here
    // would be the right outcome by the wrong route: the operator's own removal
    // step then reports a runner that has already vanished, which reads like the
    // drain broke something.
    if (r.drainState) {
      skipped.push(`${r.name}: ${r.drainState} — left to the operator who drained it`);
      continue;
    }
    if (workingRepos.has(r.repo)) {
      skipped.push(`${r.name}: its repo has active work`);
      continue;
    }
    const info = idle.get(r.name) ?? {};
    // A duplicate created two minutes ago has run nothing yet, which under a
    // "no recent jobs" test alone makes it instantly removable — the scaler
    // would add a runner and then delete it before it could pick up the job it
    // was added for. Its own age is the guard against that.
    if ((info.ageMs ?? 0) < ttl) {
      skipped.push(`${r.name}: only ${Math.round((info.ageMs ?? 0) / 3600000)}h old`);
      continue;
    }
    if (info.lastJobAt != null && now - info.lastJobAt < ttl) {
      skipped.push(`${r.name}: ran a job ${Math.round((now - info.lastJobAt) / 3600000)}h ago`);
      continue;
    }

    return {
      act: true,
      name: r.name,
      repo: r.repo,
      reason: info.lastJobAt
        ? `idle ${Math.round((now - info.lastJobAt) / 3600000)}h (ttl ${Math.round(ttl / 3600000)}h)`
        : `never ran a job, ${Math.round((info.ageMs ?? 0) / 3600000)}h old`,
    };
  }

  return {
    act: false,
    reason: skipped.length ? skipped.join(' · ') : 'no duplicate runners to remove',
  };
}

function short(repo) {
  return String(repo).split('/').pop();
}

function label(row) {
  return row.role ? `${short(row.repo)}/${row.role}` : short(row.repo);
}
