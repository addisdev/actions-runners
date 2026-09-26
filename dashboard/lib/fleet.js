// Fleet-wide runner and host views for placement and classification.
//
// The coordinator's local snapshot and agent heartbeats live in different
// shapes and come from different sources. This module merges them into the
// single authoritative fleet picture that sizing, queue classification, and
// placement all need.
//
// Local runners have full GitHub state (labels, ghStatus, ghBusy) plus local
// process state (launchdState, workingLocally). Remote runners arrive via two
// independent channels that are fused here:
//
//   elsewhere[]  — from the coordinator's GitHub polling: labels, ghStatus, ghBusy
//   hostState    — from agent heartbeats: workingLocally, drainState, launchdState
//
// Neither channel alone is sufficient. GitHub knows what is registered and
// what labels a runner carries; the agent heartbeat knows whether a job is
// executing right now without a poll interval in the way.

import { STALE_HEARTBEAT_MS } from './placement.js';

// Stable ID for the coordinator host, shared with the /api/hosts handler.
export const LOCAL_HOST_ID = '__local__';

/**
 * Adapt an elsewhere entry (GitHub-registered runner on a remote host) to the
 * full runner shape used by sizing and queue classification.
 *
 * Agent heartbeat data, when available, enriches the entry with instantaneous
 * local signals that GitHub's polling interval cannot provide.
 *
 * @param {object} r           - Entry from buildRunners() elsewhere array
 * @param {object} [agentData] - Matching runner from hostState, or null
 */
export function adaptRemoteRunner(r, agentData = null) {
  const ghOnline = r.ghStatus === 'online';
  return {
    name: r.name,
    repo: r.repo,
    project: r.project ?? null,
    dirName: agentData?.dirName ?? r.name,
    instance: agentData?.instance ?? r.instance ?? 1,
    // Agent launchdState is direct observation; fall back to GitHub-derived guess
    // so the classifier can still identify a down runner when no agent is connected.
    launchdState: agentData?.launchdState ?? (ghOnline ? 'running' : 'dead'),
    drainState: agentData?.drainState ?? null,
    // Agent workingLocally is instantaneous. ghBusy lags by one GitHub poll
    // interval, which matters most during burst ramp-up.
    workingLocally: agentData ? Boolean(agentData.workingLocally) : Boolean(r.ghBusy),
    registered: true,
    ghUnknown: false,
    ghId: r.ghId ?? null,
    ghStatus: r.ghStatus,
    ghBusy: r.ghBusy ?? false,
    labels: r.labels ?? [],
    extraLabels: r.extraLabels ?? [],
    role: r.role ?? null,
    ephemeral: Boolean(r.ephemeral),
    createdAt: agentData?.createdAt ?? null,
    launchdLabel: agentData?.launchdLabel ?? null,
    lastExit: agentData?.lastExit ?? null,
    pid: agentData?.pid ?? null,
    rssMb: agentData?.rssMb ?? null,
    uptime: agentData?.uptime ?? null,
    dir: agentData?.dir ?? null,
    version: agentData?.version ?? null,
    // Host attribution for placement decisions and the Hosts tab.
    hostName: agentData?.hostName ?? null,
    hostId: agentData?.hostId ?? null,
    hostStale: Boolean(agentData?.hostStale),
    staleForMs: agentData?.staleForMs ?? 0,
  };
}

/**
 * Build a fleet-wide runner list from local runners, the coordinator's GitHub
 * runner state for remote hosts, and agent heartbeat data.
 *
 * This is the authoritative input for fleet sizing and queue classification.
 * Control-plane actions (drain, duplicate, deregister) still operate on local
 * runners only — they shell out to scripts that only exist on the coordinator.
 *
 * @param {object[]} localRunners - snapshot.runners (coordinator-local)
 * @param {object[]} elsewhere    - snapshot.elsewhere (GitHub-registered on other hosts)
 * @param {Map}      hostState    - In-memory agent heartbeats (name → host object)
 * @returns {object[]}
 */
export function buildFleetRunners(localRunners, elsewhere, hostState, now = Date.now()) {
  // Index agent runner data by runner name for O(1) enrichment below.
  // Runner names are globally unique within a GitHub account, so there is no
  // ambiguity here even when two hosts serve the same repo.
  const agentByName = new Map();
  for (const h of hostState.values()) {
    const staleForMs = Math.max(0, now - (h.lastHeartbeat ?? 0));
    const hostStale = !h.lastHeartbeat || staleForMs > STALE_HEARTBEAT_MS;
    for (const r of h.runners ?? []) {
      agentByName.set(r.name, {
        ...r,
        hostName: h.name,
        hostId: h.id,
        hostStale,
        staleForMs,
      });
    }
  }

  const fleet = [...localRunners];
  const included = new Set(localRunners.map((r) => r.name));
  for (const r of elsewhere) {
    // Ephemeral runners are one-shot. They are never duplicated and their
    // lifecycle is independent of the fleet's runner management. Including them
    // in sizing inflates the runner count and makes repos look better served
    // than they are.
    if (r.ephemeral) continue;
    fleet.push(adaptRemoteRunner(r, agentByName.get(r.name) ?? null));
    included.add(r.name);
  }
  // Keep directly observed remote listeners visible during a GitHub API outage
  // or a newly registered runner's first polling interval. Their GitHub state
  // is explicitly unknown rather than guessed from the heartbeat.
  for (const [name, r] of agentByName) {
    if (included.has(name)) continue;
    fleet.push({
      ...r,
      name,
      labels: [],
      extraLabels: [],
      role: null,
      registered: true,
      ghUnknown: true,
      ghStatus: 'unknown',
      ghBusy: false,
      ephemeral: Boolean(r.ephemeral),
    });
  }
  return fleet;
}

/**
 * Build the host list for choosePlacement().
 *
 * The coordinator is always first, using state from the current fast tick.
 * Each agent host uses its most recent heartbeat from hostState. Stale hosts
 * are included because choosePlacement() states the reason for refusal rather
 * than silently omitting them — "last heartbeat 6 minutes ago" is more useful
 * than nothing when an operator is diagnosing why a host was skipped.
 *
 * @param {object}   localSnapshot              - Partial snapshot: ts, runners, host, capacity
 * @param {Map}      hostState                  - In-memory agent heartbeats
 * @param {object}   [opts]
 * @param {string[]} [opts.coordinatorLabels]   - Capability labels for the coordinator host
 * @param {boolean}  [opts.coordinatorDrained]  - Whether the coordinator host is drained
 * @param {string}   [opts.coordinatorName]     - Display name for the coordinator
 * @param {string}   [opts.coordinatorId]       - Stable id for the coordinator replica
 */
export function buildHostList(localSnapshot, hostState, {
  coordinatorLabels = [],
  coordinatorDrained = false,
  coordinatorName = LOCAL_HOST_ID,
  coordinatorId = LOCAL_HOST_ID,
} = {}) {
  const local = {
    id: coordinatorId,
    name: coordinatorName,
    lastHeartbeat: localSnapshot.ts ?? Date.now(),
    labels: coordinatorLabels,
    runners: localSnapshot.runners ?? [],
    repos: [...new Set((localSnapshot.runners ?? []).map((r) => r.repo))],
    host: localSnapshot.host ?? {},
    capacity: localSnapshot.capacity ?? null,
    runnerCount: (localSnapshot.runners ?? []).length,
    drained: coordinatorDrained,
    local: true,
  };

  const remotes = [...hostState.values()].map((h) => ({
    id: h.id,
    name: h.name,
    lastHeartbeat: h.lastHeartbeat ?? null,
    labels: h.labels ?? [],
    runners: h.runners ?? [],
    repos: h.repos ?? [],
    host: h.host ?? {},
    capacity: h.capacity ?? null,
    runnerCount: h.runnerCount ?? (h.runners ?? []).length,
    drained: Boolean(h.drained),
  }));

  return [local, ...remotes];
}

/**
 * Whether any host in the fleet has capacity to accept a new runner.
 *
 * Used as the pre-gate for planScaleUp in a federated fleet so that a
 * saturated coordinator does not block scale-up on a remote host that has
 * room. Stale hosts are excluded because a picture from three minutes ago is
 * not a reliable capacity signal.
 *
 * @param {object[]} hosts - Result of buildHostList()
 * @param {number}   [now] - Override for stale detection (default Date.now())
 */
export function anyHostHasCapacity(hosts, now = Date.now()) {
  return hosts.some((h) => {
    if (h.drained) return false;
    const age = now - (h.lastHeartbeat ?? 0);
    if (!h.lastHeartbeat || age > STALE_HEARTBEAT_MS) return false;
    return h.capacity?.ok === true;
  });
}
