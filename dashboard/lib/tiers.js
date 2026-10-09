// Standby tiers: run CI on the primary host first, spill to a standby host
// only when the primary is full or not working.
//
// GitHub decides which runner takes a job, not this daemon: a queued job goes
// to the first online, idle runner whose labels match, and a user account has
// no runner groups to express "prefer this host". The fleet's only lever is
// WHICH RUNNERS ARE ONLINE. So "primary first" is built as:
//
//   floor     a small set of standby-host runners (by repo) that are always
//             online. The controller never drains them.
//   overflow  every other standby-host runner. Drained (offline) while the
//             primary copes; resumed the moment it does not.
//   primary   the primary host's own runners. While a primary lane is at its
//             admission cap, the IDLE ones are drained too ("self-drain"), so
//             GitHub stops handing the primary jobs it would only hold at
//             "Set up runner"; they come back when the lane has room.
//
// Every drain this controller makes is written with `drain-runner.sh --by=tiers`
// and it only ever resumes runners whose marker says so. A runner an operator
// drained is never touched, on either host.
//
// This module is pure: inputs in, decision out, timers carried in `state`.
// fleetd gathers the inputs on every fast tick and carries out the actions.
// docs/design/tiers.md explains the thresholds.

export const TIER_MODES = ['off', 'observe', 'enforce'];

// The owner name written into .drain markers (drain-runner.sh --by=tiers).
export const DRAIN_OWNER = 'tiers';

export const TIERS_DEFAULTS = {
  mode: 'off',
  // null → the coordinator's own host.
  primaryHost: null,
  standbyHosts: [],
  floorRepos: [],
  // Repos the primary must keep serving itself, whatever the standby host has.
  primaryOnlyRepos: [],
  // Resume overflow when a primary lane has been at its cap this long.
  resumeAfterBusyMs: 60_000,
  // ...or when a queued run has waited this long with no idle primary runner.
  queueAgeMs: 120_000,
  // Drain overflow again after this long with headroom and nothing queued.
  drainAfterQuietMs: 600_000,
  // The primary counts as down when its heartbeat is older than this.
  primaryStaleMs: 180_000,
  // A standby host only receives commands while its heartbeat is this fresh
  // (the coordinator refuses to queue work for a staler host anyway).
  commandStaleMs: 120_000,
  selfDrain: true,
  // A self-drained primary runner comes back after its lane has had room
  // this long. Short, but not zero: a lane that frees and refills within
  // seconds would otherwise stop and start every idle listener each time.
  selfResumeAfterMs: 30_000,
  // An action not yet reflected in the reported state is not re-sent for
  // this long.
  retryMs: 180_000,
  // The primary's admission caps (hooks: FLEET_ADMIT_MAX_CONCURRENT and
  // FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT). A cap of 0 means no such lane.
  caps: { build: 3, simulator: 0 },
  // Shell-style patterns for runners in the Simulator lane
  // (FLEET_SIMULATOR_RUNNERS, matched against the runner name like the hook).
  simulatorRunners: [],
};

// Verdict rungs that make the primary unfit to carry the load alone.
// `blind` is a cockpit-only rung (the viewer's network) and never reaches here.
export const UNFIT_RUNGS = ['host-down', 'disk-floor', 'dead-service', 'saturated'];

const list = (v) => String(v ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const int = (v, d) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * Config from the environment (fleet.env via the fleetd plist).
 * @param {object} env
 * @param {object} [opts]
 * @param {string} [opts.localHostId] - the coordinator's host id (default primary)
 */
export function tiersConfigFromEnv(env = {}, { localHostId = null } = {}) {
  const mode = String(env.FLEET_TIERS_MODE ?? 'off').trim().toLowerCase();
  const s = (key, d) => int(env[key], d / 1000) * 1000;
  return {
    ...TIERS_DEFAULTS,
    // Anything unrecognised is off, matching FLEET_ADMIT_MODE: a typo must
    // not read as the most expensive interpretation.
    mode: TIER_MODES.includes(mode) ? mode : 'off',
    primaryHost: String(env.FLEET_TIERS_PRIMARY_HOST ?? '').trim() || localHostId,
    standbyHosts: list(env.FLEET_TIERS_STANDBY_HOSTS),
    floorRepos: list(env.FLEET_TIERS_FLOOR_REPOS),
    primaryOnlyRepos: list(env.FLEET_TIERS_PRIMARY_ONLY_REPOS),
    resumeAfterBusyMs: s('FLEET_TIERS_RESUME_AFTER_S', TIERS_DEFAULTS.resumeAfterBusyMs),
    queueAgeMs: s('FLEET_TIERS_QUEUE_AGE_S', TIERS_DEFAULTS.queueAgeMs),
    drainAfterQuietMs: s('FLEET_TIERS_DRAIN_AFTER_S', TIERS_DEFAULTS.drainAfterQuietMs),
    primaryStaleMs: s('FLEET_TIERS_PRIMARY_STALE_S', TIERS_DEFAULTS.primaryStaleMs),
    selfDrain: String(env.FLEET_TIERS_SELF_DRAIN ?? '1') !== '0',
    selfResumeAfterMs: s('FLEET_TIERS_SELF_RESUME_AFTER_S', TIERS_DEFAULTS.selfResumeAfterMs),
    caps: {
      build: int(env.FLEET_TIERS_BUILD_CAP, int(env.FLEET_ADMIT_MAX_CONCURRENT, TIERS_DEFAULTS.caps.build)),
      simulator: int(env.FLEET_TIERS_SIMULATOR_CAP, int(env.FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT, 0)),
    },
    simulatorRunners: list(env.FLEET_SIMULATOR_RUNNERS),
  };
}

// The hook matches FLEET_SIMULATOR_RUNNERS with `case`, so `*` and `?` are the
// only metacharacters that matter.
function globToRegExp(glob) {
  const body = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

export function isSimulatorRunner(name, patterns) {
  return (patterns ?? []).some((p) => globToRegExp(p).test(String(name ?? '')));
}

// "app-ios" matches "owner/app-ios"; "owner/app-ios" matches only itself.
export function repoIn(repo, entries) {
  const r = String(repo ?? '');
  return (entries ?? []).some((e) => e && (r === e || r.endsWith(`/${e}`)));
}

const lower = (labels) => (labels ?? []).map((l) => String(l).toLowerCase());
const covers = (have, need) => {
  const h = new Set(lower(have));
  return lower(need).every((l) => h.has(l));
};
const secs = (ms) => (ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);

/**
 * Which of the verdict's open rungs are about the primary host.
 *
 * The ladder is fleet-wide. disk-floor and saturated are read from the
 * coordinator's own vitals, so they describe the primary only when the primary
 * is the coordinator; dead-service counts when a runner on the primary is dead
 * or offline; host-down when the primary itself is a stale remote host.
 *
 * @param {object} verdict         - { open: [{ id }] }
 * @param {Iterable} runnerStates  - verdict runner states: { hostId, state }
 * @param {object} opts
 * @param {string} opts.primaryId
 * @param {boolean} opts.primaryIsLocal
 * @param {string[]} [opts.staleHostIds]
 */
export function primaryRungs(verdict, runnerStates, { primaryId, primaryIsLocal, staleHostIds = [] }) {
  const open = new Set((verdict?.open ?? []).map((o) => o.id));
  const rungs = [];
  if (open.has('host-down') && !primaryIsLocal && staleHostIds.includes(primaryId)) rungs.push('host-down');
  if (primaryIsLocal && open.has('disk-floor')) rungs.push('disk-floor');
  if (open.has('dead-service')) {
    const dead = [...(runnerStates ?? [])].some((r) => r.hostId === primaryId && (r.state === 'dead' || r.state === 'offline'));
    if (dead) rungs.push('dead-service');
  }
  if (primaryIsLocal && open.has('saturated')) rungs.push('saturated');
  return rungs;
}

/**
 * One controller step.
 *
 * @param {object} input
 * @param {object} input.config     - tiersConfigFromEnv()
 * @param {number} input.now
 * @param {object|null} input.state - the previous step's `state`, or null at start
 * @param {object} input.primary    - { id, lastHeartbeat, memPressure, rungs: [] }
 * @param {object[]} input.standby  - [{ id, name, lastHeartbeat, memPressure }]
 * @param {object[]} input.runners  - fleet runners: { name, dirName, repo, hostId,
 *   local, labels, ghStatus, ghUnknown, workingLocally, ghBusy, drainState,
 *   drainBy, ephemeral }
 * @param {object[]} input.queue    - queued runs: { id, repo, labels, queuedSinceMs }
 * @returns {{ state: object, decision: object }}
 */
export function decideTiers({ config, now, state = null, primary, standby = [], runners = [], queue = [] }) {
  const cfg = { ...TIERS_DEFAULTS, ...config, caps: { ...TIERS_DEFAULTS.caps, ...(config?.caps ?? {}) } };
  const prev = state ?? {};
  const standbyIds = new Set(standby.map((h) => h.id));
  const own = (r) => Boolean(r.drainState) && r.drainBy === DRAIN_OWNER;
  const operatorDrained = (r) => Boolean(r.drainState) && r.drainBy !== DRAIN_OWNER;
  const busy = (r) => Boolean(r.workingLocally || r.ghBusy);
  const online = (r) => r.ghStatus === 'online' && !r.ghUnknown;

  // The primary's runners are the ones it hosts and reports itself. Runners
  // GitHub knows about on machines with no agent (another host's release
  // runners) carry no hostId and are never the controller's to touch.
  const primaryRunners = runners.filter((r) => !r.ephemeral && r.hostId === primary.id && r.local !== false && r.dirName);
  const standbyRunners = runners.filter((r) => !r.ephemeral && standbyIds.has(r.hostId));
  const isFloor = (r) => repoIn(r.repo, cfg.floorRepos);
  const overflowRunners = standbyRunners.filter((r) => !isFloor(r));
  const floorRunners = standbyRunners.filter(isFloor);
  const isSim = (r) => isSimulatorRunner(r.name, cfg.simulatorRunners);

  // ---- primary lanes ---------------------------------------------------------
  // Busy is the number of jobs with a Runner.Worker on the primary, which
  // includes jobs the admission hook is holding: a held job means the lane is
  // full (or the disk floor is, which the disk-floor rung reports).
  const lanes = {};
  const laneDefs = [
    ['build', cfg.caps.build, primaryRunners],
    ['simulator', cfg.caps.simulator, primaryRunners.filter(isSim)],
  ];
  const atCapSince = { ...(prev.atCapSince ?? {}) };
  const freeSince = { ...(prev.freeSince ?? {}) };
  for (const [lane, cap, members] of laneDefs) {
    if (!cap) continue;
    const n = members.filter((r) => r.workingLocally).length;
    const atCap = n >= cap;
    atCapSince[lane] = atCap ? (atCapSince[lane] ?? now) : null;
    freeSince[lane] = atCap ? null : (freeSince[lane] ?? now);
    lanes[lane] = {
      busy: n,
      cap,
      atCap,
      atCapForMs: atCap ? now - atCapSince[lane] : 0,
      freeForMs: atCap ? 0 : now - freeSince[lane],
    };
  }
  const laneAtCap = (r) => Boolean(lanes.build?.atCap || (isSim(r) && lanes.simulator?.atCap));
  const laneFreeForMs = (r) => Math.min(
    lanes.build ? lanes.build.freeForMs : Infinity,
    isSim(r) && lanes.simulator ? lanes.simulator.freeForMs : Infinity,
  );

  // ---- standby hosts ---------------------------------------------------------
  const hostInfo = new Map(standby.map((h) => {
    const age = h.lastHeartbeat ? now - h.lastHeartbeat : Infinity;
    return [h.id, {
      id: h.id,
      name: h.name ?? h.id,
      reachable: age <= cfg.commandStaleMs,
      critical: h.memPressure === 'critical',
      heartbeatAgeMs: Number.isFinite(age) ? age : null,
    }];
  }));
  const usableHost = (id) => {
    const h = hostInfo.get(id);
    return Boolean(h && h.reachable && !h.critical);
  };

  // ---- queue -----------------------------------------------------------------
  const jobFits = (q, r) => r.repo === q.repo && covers(r.labels, q.labels ?? []);
  const idlePrimaryFor = (q) => primaryRunners.some((r) => jobFits(q, r) && online(r) && !r.drainState && !busy(r));
  // Only work the fleet could actually run counts. A run waiting for a label
  // no runner carries is config drift; resuming a host would not move it.
  const servable = queue.filter((q) => primaryRunners.some((r) => jobFits(q, r)) || standbyRunners.some((r) => jobFits(q, r)));
  const stuck = servable.filter((q) => (q.queuedSinceMs ?? 0) > cfg.queueAgeMs
    && !idlePrimaryFor(q)
    && standbyRunners.some((r) => jobFits(q, r)));

  // ---- resume triggers ---------------------------------------------------------
  const triggers = [];
  const primaryAge = primary.lastHeartbeat ? now - primary.lastHeartbeat : Infinity;
  if (primaryAge > cfg.primaryStaleMs) {
    triggers.push({ id: 'primary-down', detail: Number.isFinite(primaryAge) ? `no heartbeat for ${secs(primaryAge)}` : 'never reported' });
  }
  for (const rung of primary.rungs ?? []) {
    if (UNFIT_RUNGS.includes(rung)) triggers.push({ id: `primary-${rung}`, detail: `verdict rung ${rung} on the primary` });
  }
  if (primary.memPressure === 'critical') triggers.push({ id: 'primary-memory-critical', detail: 'memory pressure critical on the primary' });
  for (const [lane, l] of Object.entries(lanes)) {
    if (l.atCap && l.atCapForMs >= cfg.resumeAfterBusyMs) {
      triggers.push({ id: 'primary-at-cap', detail: `${lane} lane ${l.busy}/${l.cap} for ${secs(l.atCapForMs)}` });
    }
  }
  if (stuck.length) {
    const repos = [...new Set(stuck.map((q) => String(q.repo).split('/').pop()))];
    triggers.push({ id: 'queue-age', detail: `${stuck.length} run(s) queued over ${secs(cfg.queueAgeMs)} with no idle primary runner: ${repos.slice(0, 4).join(', ')}` });
  }

  const anyLaneAtCap = Object.values(lanes).some((l) => l.atCap);
  const quiet = !anyLaneAtCap && servable.length === 0 && triggers.length === 0;
  const quietSince = quiet ? (prev.quietSince ?? now) : null;
  const quietForMs = quiet ? now - quietSince : 0;

  // ---- the overflow tier -------------------------------------------------------
  // At start, the tier is whatever the runners say: a fleet with overflow
  // runners online starts active and is drained only after a full quiet period.
  let overflow = prev.overflow
    ?? (overflowRunners.some((r) => !r.drainState) ? 'active' : 'standby');
  let since = prev.since ?? now;
  let reason = prev.reason ?? (overflow === 'active' ? 'overflow runners were online at start' : 'overflow runners were drained at start');
  const anyUsable = standby.some((h) => usableHost(h.id));
  if (triggers.length) {
    if (overflow !== 'active' && anyUsable) {
      overflow = 'active';
      since = now;
      reason = triggers.map((t) => t.detail).join('; ');
    }
  } else if (overflow === 'active' && quiet && quietForMs >= cfg.drainAfterQuietMs) {
    overflow = 'standby';
    since = now;
    reason = `primary had headroom and nothing queued for ${secs(quietForMs)}`;
  }

  // ---- per-runner actions --------------------------------------------------------
  const pending = {};
  for (const [name, p] of Object.entries(prev.pending ?? {})) {
    if (now - p.at < cfg.retryMs) pending[name] = p;
  }
  const actions = [];
  const deferred = [];
  const drainingNow = new Set();
  const want = (r, action, tier, why) => {
    const done = action === 'drain' ? own(r) : !r.drainState;
    if (done) {
      delete pending[r.name];
      return;
    }
    // Counted as on its way out even while a drain sent earlier is in flight,
    // so nothing below leans on it as a twin.
    if (action === 'drain') drainingNow.add(r.name);
    if (pending[r.name]?.action === action) return;
    actions.push({ hostId: r.hostId, name: r.name, dirName: r.dirName ?? r.name, repo: r.repo, action, tier, reason: why });
  };

  const off = cfg.mode === 'off';
  for (const r of floorRunners) {
    // Never drained by the controller. One it drained under an older floor
    // list goes back online.
    if (own(r)) want(r, 'resume', 'floor', 'floor runners stay online');
  }

  for (const r of overflowRunners) {
    if (operatorDrained(r)) continue;
    const h = hostInfo.get(r.hostId);
    if (off) {
      if (own(r)) want(r, 'resume', 'overflow', 'tiers switched off');
      continue;
    }
    const wantOnline = overflow === 'active' && !h?.critical;
    if (wantOnline) {
      if (own(r)) want(r, 'resume', 'overflow', reason);
      continue;
    }
    if (r.drainState) continue;
    // Never drain the twin a self-drained primary runner is relying on: the
    // primary runner comes back first (its lane has room by now), then this.
    const covering = primaryRunners.some((p) => own(p) && p.repo === r.repo && covers(r.labels, p.labels));
    if (covering) {
      deferred.push({ name: r.name, reason: 'still covering a self-drained primary runner' });
      continue;
    }
    want(r, 'drain', 'overflow', h?.critical ? 'memory pressure critical on the standby host' : reason);
  }

  // A standby runner that is online now and will stay online: what a primary
  // runner needs before it may be drained.
  const twinFor = (p) => standbyRunners.find((r) => r.repo === p.repo
    && covers(r.labels, p.labels)
    && online(r) && !r.drainState && !drainingNow.has(r.name)
    && usableHost(r.hostId));

  const selfDrain = cfg.selfDrain && !off;
  for (const p of primaryRunners) {
    if (operatorDrained(p)) continue;
    const pinned = repoIn(p.repo, cfg.primaryOnlyRepos);
    if (own(p)) {
      if (!selfDrain) want(p, 'resume', 'primary', off ? 'tiers switched off' : 'self-drain disabled');
      else if (pinned) want(p, 'resume', 'primary', 'repo is primary-only');
      else if (!twinFor(p)) want(p, 'resume', 'primary', 'no online standby twin');
      else if (!laneAtCap(p) && laneFreeForMs(p) >= cfg.selfResumeAfterMs) {
        want(p, 'resume', 'primary', `lane below cap for ${secs(laneFreeForMs(p))}`);
      }
      continue;
    }
    if (!selfDrain || pinned || p.drainState || !laneAtCap(p)) continue;
    // Idle only, and only with a twin online elsewhere: a repo must never be
    // left with nothing but drained runners.
    if (busy(p) || !online(p)) continue;
    if (!twinFor(p)) {
      deferred.push({ name: p.name, reason: 'no online standby twin' });
      continue;
    }
    want(p, 'drain', 'primary', `${lanes.build?.atCap ? 'build' : 'simulator'} lane at cap`);
  }

  // Commands only reach a host whose agent is reporting.
  const issued = [];
  for (const a of actions) {
    if (a.hostId !== primary.id && !hostInfo.get(a.hostId)?.reachable) {
      deferred.push({ name: a.name, reason: `${hostInfo.get(a.hostId)?.name ?? a.hostId} is not reporting` });
      continue;
    }
    issued.push(a);
  }
  const acting = cfg.mode === 'enforce' || off;
  if (acting) for (const a of issued) pending[a.name] = { action: a.action, at: now };

  const count = (rs) => ({
    total: rs.length,
    online: rs.filter((r) => !r.drainState && online(r)).length,
    drainedByTiers: rs.filter(own).length,
    drainedByOperator: rs.filter(operatorDrained).length,
  });

  const nextState = { overflow, since, reason, atCapSince, freeSince, quietSince, pending };
  return {
    state: nextState,
    decision: {
      mode: cfg.mode,
      ts: now,
      overflow,
      since,
      reason,
      triggers,
      quietForMs,
      drainInMs: overflow === 'active' && quiet ? Math.max(0, cfg.drainAfterQuietMs - quietForMs) : null,
      lanes,
      hosts: [...hostInfo.values()],
      counts: {
        floor: count(floorRunners),
        overflow: count(overflowRunners),
        primary: count(primaryRunners),
      },
      // What this step would do (observe) or does (enforce).
      actions: issued,
      applied: cfg.mode === 'enforce' || (off && issued.length > 0),
      deferred,
    },
  };
}
