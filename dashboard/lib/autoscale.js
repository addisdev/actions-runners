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
// ONE ACTION PER SWEEP, always. Registering a runner takes tens of seconds and
// changes the very inputs this reads, so a batch decision is stale before it
// finishes. Scaling five repos at once is also how a bad threshold becomes a
// bad afternoon.
//
// WHAT THIS CANNOT DO. It cannot make a fan-out burst faster. Peak demand for one
// repo on this fleet is 33 simultaneous jobs and a runner takes tens of seconds
// to create, so by the time capacity arrives the burst is over. It is aimed at
// the SUSTAINED case: the repo that has queued for ten minutes because it owns
// one runner and wants two.

// A runner to clone from. Prefers an idle one so the summary reads sensibly, but
// any sibling will do — duplicate only reads its repo and labels.
//
// A draining runner is excluded as a source. Its labels are probably fine, but
// somebody is in the middle of retiring it, and copying from it produces a new
// runner modelled on the one being removed — which reads, correctly, as the
// scaler and the operator working against each other.
function cloneSource(siblings, preferRole = null) {
  // When a preferred role is supplied (e.g. 'ci'), use runners of that role as
  // the clone template. Falls back to any non-draining runner if no role match
  // exists, so the first-runner path still works.
  const pool = preferRole != null
    ? (siblings.filter((r) => !r.drainState && (r.extraLabels ?? []).includes(preferRole)).length
        ? siblings.filter((r) => !r.drainState && (r.extraLabels ?? []).includes(preferRole))
        : siblings.filter((r) => !r.drainState))
    : siblings.filter((r) => !r.drainState);
  return pool.find((r) => !r.workingLocally && !r.ghBusy) ?? pool[0] ?? null;
}

/**
 * @returns {{ act: false, reason: string } | { act: true, name, repo, reason }}
 */
export function planScaleUp({
  sizing = [],
  capacity = { ok: false, reasons: [] },
  runners = [],
  active = [],
  lastUpByRepo = {},
  limits = {},
  now = Date.now(),
  queueCauses = null,
} = {}) {
  if (!capacity.ok) {
    return { act: false, reason: `no headroom: ${capacity.reasons.join('; ')}` };
  }

  const cooldown = limits.scaleCooldownMs ?? 1800000;
  const minQueued = limits.minQueuedMs ?? 600000;

  // Adding a runner is the right answer to exactly one of the reasons a job sits
  // queued: every runner for the repo is busy and the host has room for another.
  // For the other six it is somewhere between useless and harmful — cloning a
  // runner whose labels do not match the workflow produces a second runner that
  // also never matches, which is how one idle runner became two.
  //
  // So the classifier is consulted before acting, and only a HIGH-confidence
  // repo-capacity verdict clears the gate. Medium and low confidence mean the
  // evidence was circumstantial, and spending a concurrency slot on a guess is
  // not what an unattended process should do. When no classifier is supplied
  // this is skipped and the older heuristics stand alone.
  const causeAllows = (repo) => {
    if (!queueCauses) return { ok: true };
    const causes = [...queueCauses.values()].filter((c) => c.repo === repo);
    if (!causes.length) return { ok: true };
    const eligible = causes.find((c) => c.actionEligible && c.confidence === 'high');
    if (eligible) return { ok: true };
    const worst = causes[0];
    return { ok: false, why: `diagnosed as ${worst.cause} (${worst.confidence} confidence), not capacity` };
  };

  // Queued work, and for how long. Time queued is the whole justification: a job
  // that has been waiting twenty seconds is not evidence of anything, and adding
  // a runner takes longer than that to help.
  const queuedSince = new Map();
  for (const a of active) {
    if (a.status !== 'queued') continue;
    const at = Date.parse(a.startedAt ?? a.createdAt ?? '');
    if (!Number.isFinite(at)) continue;
    const prev = queuedSince.get(a.repo);
    if (prev == null || at < prev) queuedSince.set(a.repo, at);
  }

  const blocked = [];
  for (const row of sizing) {
    if (row.delta <= 0) continue;

    const since = queuedSince.get(row.repo);
    if (since == null) {
      blocked.push(`${short(row.repo)}: wants ${row.want} but nothing is queued`);
      continue;
    }
    const waited = now - since;
    if (waited < minQueued) {
      blocked.push(`${short(row.repo)}: queued ${Math.round(waited / 60000)}m, needs ${Math.round(minQueued / 60000)}m`);
      continue;
    }

    const last = lastUpByRepo[row.repo] ?? 0;
    if (now - last < cooldown) {
      blocked.push(`${short(row.repo)}: scaled up ${Math.round((now - last) / 60000)}m ago`);
      continue;
    }

    const allowed = causeAllows(row.repo);
    if (!allowed.ok) {
      blocked.push(`${short(row.repo)}: ${allowed.why}`);
      continue;
    }

    const siblings = runners.filter((r) => r.repo === row.repo);
    const source = cloneSource(siblings);
    if (!source) {
      blocked.push(`${short(row.repo)}: no existing runner to copy labels from`);
      continue;
    }

    return {
      act: true,
      name: source.name,
      repo: row.repo,
      reason:
        `queued ${Math.round(waited / 60000)}m with ${row.have} runner(s); ` +
        `${row.reason}`,
    };
  }

  return {
    act: false,
    reason: blocked.length ? blocked.join(' · ') : 'nothing under-provisioned with queued work',
  };
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
