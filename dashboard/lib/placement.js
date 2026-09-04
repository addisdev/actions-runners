// Which host should get the next runner.
//
// WHY PLACEMENT IS A SEPARATE, PURE MODULE
//
// The decision is the part worth testing and the part that will be argued with,
// so it takes plain data and returns a decision plus its reasoning, and it
// executes nothing. Every recorded decision can then be replayed later against
// the same inputs — which is what makes "why did it choose that host" answerable
// a week afterwards rather than a matter of opinion.
//
// WHAT IT DELIBERATELY REFUSES TO DO
//
// It will not place a runner on a host it has not heard from recently. A stale
// heartbeat means the coordinator's picture of that host is old, and placing
// work against an old picture is how two coordinators put four runners on a
// machine that had room for one. A host that has gone quiet is skipped with that
// as the stated reason, which is more useful than a silent omission.
//
// It will also not treat "no eligible host" as an error. A federated fleet that
// is genuinely full should say so plainly, because the operator's next move is
// to add a host or wait, not to debug the placer.

// A host whose heartbeat is older than this is not a candidate. Chosen against
// the agent's 30-second heartbeat: three missed beats is a host that is off,
// asleep, or partitioned, and none of those should receive a runner.
export const STALE_HEARTBEAT_MS = 120_000;

/**
 * Choose a host for a new runner.
 *
 * @param {object}   opts
 * @param {object[]} opts.hosts   - [{ id, name, capacity, runnerCount, lastHeartbeat, labels, drained }]
 * @param {string}   opts.repo    - the repo needing a runner
 * @param {string[]} [opts.requiredLabels]
 * @param {number}   [opts.now]
 * @returns {{ chosen: string|null, reason: string, considered: object[] }}
 */
export function choosePlacement({ hosts = [], repo, requiredLabels = [], now = Date.now() } = {}) {
  const considered = [];

  for (const host of hosts) {
    const age = now - (host.lastHeartbeat ?? 0);
    const record = { host: host.name ?? host.id, eligible: false, reason: null, score: null };

    if (host.drained) {
      record.reason = 'host is drained';
    } else if (!host.lastHeartbeat || age > STALE_HEARTBEAT_MS) {
      // Stated rather than skipped. "I have not heard from this host in 6
      // minutes" is the most useful thing the placer can say about a host that
      // ought to be available and is not.
      record.reason = host.lastHeartbeat
        ? `last heartbeat ${Math.round(age / 1000)}s ago (stale over ${STALE_HEARTBEAT_MS / 1000}s)`
        : 'never sent a heartbeat';
    } else if (!(host.capacity?.ok ?? false)) {
      record.reason = `no headroom: ${(host.capacity?.reasons ?? ['unknown']).join('; ')}`;
    } else if (requiredLabels.length && !hasLabels(host, requiredLabels)) {
      const missing = requiredLabels.filter(
        (l) => !(host.labels ?? []).map((x) => String(x).toLowerCase()).includes(String(l).toLowerCase())
      );
      // The label case is worth naming precisely, because the fix is on the host
      // rather than in the fleet: a host missing `xcode-16` cannot be made
      // eligible by waiting.
      record.reason = `missing required label(s): ${missing.join(', ')}`;
    } else {
      record.eligible = true;
      record.score = scoreHost(host, repo);
      record.reason = `eligible (${host.runnerCount ?? 0} runner(s), load/core `
        + `${loadPerCoreOf(host).toFixed(2)})`;
    }

    considered.push(record);
  }

  const eligible = considered.filter((c) => c.eligible);
  if (!eligible.length) {
    return {
      chosen: null,
      // Not phrased as a failure. A full fleet is a capacity fact, and the
      // operator's next step is to add a host, not to debug this.
      reason: hosts.length
        ? `no eligible host: ${considered.map((c) => `${c.host} — ${c.reason}`).join('; ')}`
        : 'no hosts are registered',
      considered,
    };
  }

  // Highest score wins; ties break on host name so the same inputs always give
  // the same answer. A placer that picks differently on identical input cannot
  // be reasoned about after the fact.
  eligible.sort((a, b) => b.score - a.score || String(a.host).localeCompare(String(b.host)));
  const winner = eligible[0];

  return {
    chosen: winner.host,
    reason: `${winner.host}: ${winner.reason}`
      + (eligible.length > 1
        ? ` — preferred over ${eligible.slice(1).map((c) => c.host).join(', ')}`
        : ' — the only eligible host'),
    considered,
  };
}

// Load per core, derived from the vitals the agent reports rather than read off
// the capacity verdict. headroom() returns {ok, busy, ceiling, reasons} and
// treats loadPerCore as one of its input limits, so reading it back off the
// result yielded undefined for every host — which scored as zero load, gave
// every host full marks for headroom, and removed load from the ranking
// entirely. The inputs it needs are already on the heartbeat.
function loadPerCoreOf(host) {
  const vitals = host.host ?? {};
  const cores = Number(vitals.cores);
  const load1 = Number(vitals.load1);
  if (!Number.isFinite(cores) || cores <= 0 || !Number.isFinite(load1)) return 0;
  return load1 / cores;
}

// Higher is better.
//
// Spare capacity dominates deliberately. Spreading work across hosts is the
// whole reason federation exists, and a rule that packed one host until it was
// full would reproduce single-host contention on a fleet that had been expanded
// specifically to escape it.
//
// Locality is a small nudge, not a tiebreak on its own: a host that already
// serves the repo has its checkout and caches warm, which is worth real minutes
// on an Xcode build — but not worth queueing behind a busy host for.
function scoreHost(host, repo) {
  const loadPerCore = loadPerCoreOf(host);
  const runnerCount = host.runnerCount ?? 0;
  // maxTotalRunners is the concurrency cap; `ceiling` is the separate "do not add
  // while this many jobs are running" gate, which real hosts report as 3. Reading
  // the latter here made every host with three runners score as having no free
  // slots — the same wrong-field mistake as the `maxRunners` version before it,
  // just with a plausible-looking number instead of undefined.
  const maxRunners = host.capacity?.maxTotalRunners ?? 8;

  const freeSlots = Math.max(0, maxRunners - runnerCount);
  const loadHeadroom = Math.max(0, 2 - loadPerCore) / 2;
  const servesRepo = (host.repos ?? []).includes(repo) ? 1 : 0;

  return freeSlots * 10 + loadHeadroom * 5 + servesRepo * 2;
}

function hasLabels(host, required) {
  const have = new Set((host.labels ?? []).map((l) => String(l).toLowerCase()));
  return required.every((l) => have.has(String(l).toLowerCase()));
}

/**
 * Merge per-host snapshots into one fleet view.
 *
 * Every runner carries the host it came from, and a stale host's runners are
 * marked rather than dropped. Dropping them would make a partitioned host's
 * runners silently vanish from the dashboard, which looks like they were removed
 * — the single most alarming way to render a network problem.
 */
export function mergeHostSnapshots({ hosts = [], now = Date.now() } = {}) {
  const runners = [];
  const summaries = [];

  for (const host of hosts) {
    const age = now - (host.lastHeartbeat ?? 0);
    const stale = !host.lastHeartbeat || age > STALE_HEARTBEAT_MS;

    for (const r of host.runners ?? []) {
      runners.push({
        ...r,
        hostId: host.id,
        hostName: host.name ?? host.id,
        // The UI greys these and says why, rather than showing state that was
        // true several minutes ago as though it were current.
        hostStale: stale,
        staleForMs: stale ? age : 0,
      });
    }

    summaries.push({
      id: host.id,
      name: host.name ?? host.id,
      stale,
      lastHeartbeat: host.lastHeartbeat ?? null,
      staleForMs: stale ? age : 0,
      runnerCount: (host.runners ?? []).length,
      busyCount: (host.runners ?? []).filter((r) => r.ghBusy || r.workingLocally).length,
      capacity: host.capacity ?? null,
      labels: host.labels ?? [],
      drained: Boolean(host.drained),
      version: host.version ?? null,
    });
  }

  return {
    runners,
    hosts: summaries.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    // Counted so the UI can lead with it. A federated view that is 40% stale is
    // not a view of the fleet, and saying so is more honest than rendering it.
    staleHosts: summaries.filter((h) => h.stale).length,
    totalHosts: summaries.length,
  };
}
