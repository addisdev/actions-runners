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
//   parked    a self-drained primary runner with NO standby twin (the standby
//             host is drained, cannot admit, or does not serve the repo). Its
//             jobs wait in GitHub's queue, where the wait does not count
//             against `timeout-minutes`, instead of in the admission hook,
//             where it does. While its lane sheds, the controller brings
//             parked runners back one per free slot, for the oldest queued
//             run first, so the hook rarely holds anything.
//
// A host that CANNOT ADMIT (its hook would hold every job: the disk floor,
// lib/admit-gate.js) gets no runner online at all, floor runners included,
// and is no twin and no overflow target. A runner cannot refuse a job once
// GitHub has given it one; it can only be offline before that.
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
  // Self-drain a runner that has no standby twin too ("park" it), releasing
  // parked runners one per free lane slot. Off restores the older rule, which
  // left a twinless runner online at cap: every job it took then sat in the
  // admission hook, and that hold is charged to the job's own timeout-minutes
  // (2026-10-16, ultra drained: homelake release-check timed out at 30 min
  // after a 26 min hold for a 4 min job; `words` died at 10 min six times).
  park: true,
  // Self-drain has hysteresis, because the cap is the lane's normal operating
  // point: with a build cap of 2 the lane crosses it every time a job starts or
  // ends, and with no hold each crossing drained or resumed ~50 runners
  // (runner-host, 10-10..10-13: 489 drain batches, a median hold of 2.9 min).
  // A lane starts shedding (drains its idle runners) after being at cap this
  // long...
  selfDrainAfterMs: 60_000,
  // ...stops (resumes them) once it has had room this long...
  selfResumeAfterMs: 300_000,
  // ...but never sooner than this after it started shedding...
  selfMinHoldMs: 600_000,
  // ...and does not start shedding again sooner than this after it stopped.
  selfMinOpenMs: 300_000,
  // A host that could not admit is trusted again only after it has been able
  // to for this long: the disk floor is crossed in both directions by every
  // job's checkout and cleanup, and each crossing would otherwise drain or
  // resume a whole host.
  admitResumeAfterMs: 300_000,
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

// Queue causes (lib/queue-cause.js) that no amount of online runners moves:
// GitHub holding a run for a concurrency group or approval, a job for
// GitHub-hosted runners, a label no runner has, or no telemetry at all. Such a
// run neither resumes the overflow tier nor keeps it online.
export const NOT_RUNNER_CAUSES = ['concurrency-block', 'github-hosted', 'label-mismatch', 'telemetry-unavailable'];

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
    park: String(env.FLEET_TIERS_PARK ?? '1') !== '0',
    selfDrainAfterMs: s('FLEET_TIERS_SELF_DRAIN_AFTER_S', TIERS_DEFAULTS.selfDrainAfterMs),
    selfResumeAfterMs: s('FLEET_TIERS_SELF_RESUME_AFTER_S', TIERS_DEFAULTS.selfResumeAfterMs),
    selfMinHoldMs: s('FLEET_TIERS_SELF_MIN_HOLD_S', TIERS_DEFAULTS.selfMinHoldMs),
    selfMinOpenMs: s('FLEET_TIERS_SELF_MIN_OPEN_S', TIERS_DEFAULTS.selfMinOpenMs),
    admitResumeAfterMs: s('FLEET_TIERS_ADMIT_RESUME_AFTER_S', TIERS_DEFAULTS.admitResumeAfterMs),
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
  // disk-floor names the hosts whose disk holds jobs (null = the coordinator):
  // a standby host's floor is not the primary's.
  const disk = (verdict?.open ?? []).find((o) => o.id === 'disk-floor');
  if (disk) {
    const hosts = disk.hosts ?? [null];
    if (hosts.some((h) => (h == null ? primaryIsLocal : h === primaryId))) rungs.push('disk-floor');
  }
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
 * @param {object} input.primary    - { id, lastHeartbeat, memPressure, rungs: [], off, cannotAdmit }
 * @param {object[]} input.standby  - [{ id, name, lastHeartbeat, memPressure, off, cannotAdmit }]
 *   `off`: the host is switched off (host-drain.sh --off). It takes no jobs,
 *   so it is never sent an action, and an off primary wakes the overflow tier.
 *   `cannotAdmit`: lib/admit-gate.js admissionBlocker() as the host reported
 *   it ({ reason, ... }), or null. Its runners are kept offline.
 * @param {object[]} input.runners  - fleet runners: { name, dirName, repo, hostId,
 *   local, labels, ghStatus, ghUnknown, workingLocally, ghBusy, drainState,
 *   drainBy, ephemeral }
 * @param {object[]} input.queue    - queued runs: { id, repo, labels, queuedSinceMs, cause }
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

  // ---- hosts that cannot admit -------------------------------------------------
  // On as soon as a host reports a blocker; off only after it has reported
  // none for admitResumeAfterMs. Null (an agent too old to say) is "can".
  const admit = {};
  for (const h of [primary, ...standby]) {
    if (!h?.id) continue;
    const p = prev.admit?.[h.id];
    if (h.cannotAdmit) {
      admit[h.id] = { on: true, since: p?.on ? p.since : now, clearSince: null, reason: h.cannotAdmit.reason ?? 'admission blocked' };
    } else if (p?.on) {
      const clearSince = p.clearSince ?? now;
      admit[h.id] = now - clearSince >= cfg.admitResumeAfterMs
        ? { on: false, since: now, clearSince: null, reason: null }
        : { ...p, clearSince };
    } else {
      admit[h.id] = { on: false, since: p?.since ?? null, clearSince: null, reason: null };
    }
  }
  const blockedWhy = (id) => {
    const a = admit[id];
    if (!a?.on) return null;
    return a.clearSince == null ? a.reason : `${a.reason} until ${secs(now - a.clearSince)} ago`;
  };
  const primaryBlocked = Boolean(admit[primary.id]?.on);

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

  // ---- self-drain hysteresis ---------------------------------------------------
  // Whether each lane is shedding (its idle primary runners drained), with
  // `since` the time it last started or stopped. Entering needs the lane at cap
  // for selfDrainAfterMs and open for selfMinOpenMs; leaving needs room for
  // selfResumeAfterMs and a hold of selfMinHoldMs. At start a lane whose
  // runners the controller already drained is shedding, held from now.
  const shed = {};
  for (const [lane, l] of Object.entries(lanes)) {
    let s = prev.shed?.[lane];
    if (!s) {
      const members = primaryRunners.filter((r) => (lane === 'simulator' ? isSim(r) : !isSim(r)));
      s = members.some(own) ? { on: true, since: now } : { on: false, since: null };
    }
    if (!s.on && l.atCap && l.atCapForMs >= cfg.selfDrainAfterMs
      && (s.since == null || now - s.since >= cfg.selfMinOpenMs)) {
      s = { on: true, since: now };
    } else if (s.on && !l.atCap && l.freeForMs >= cfg.selfResumeAfterMs
      && now - s.since >= cfg.selfMinHoldMs) {
      s = { on: false, since: now };
    }
    shed[lane] = s;
    l.shedding = s.on;
    l.shedSince = s.since;
  }
  // A runner is held drained while any of its lanes is shedding, and newly
  // drained only while such a lane is also at cap right now: a hold delays
  // resumes, it never drains more of a lane that has room.
  const lanesOf = (r) => Object.keys(shed).filter((k) => k === 'build' || isSim(r));
  // A primary that cannot admit holds every runner drained, whatever its lanes.
  const held = (r) => primaryBlocked || lanesOf(r).some((k) => shed[k].on);
  const drainLane = (r) => (primaryBlocked ? 'admission' : lanesOf(r).find((k) => shed[k].on && lanes[k].atCap) ?? null);

  // ---- standby hosts ---------------------------------------------------------
  const hostInfo = new Map(standby.map((h) => {
    const age = h.lastHeartbeat ? now - h.lastHeartbeat : Infinity;
    return [h.id, {
      id: h.id,
      name: h.name ?? h.id,
      reachable: age <= cfg.commandStaleMs,
      critical: h.memPressure === 'critical',
      off: Boolean(h.off),
      cannotAdmit: blockedWhy(h.id),
      heartbeatAgeMs: Number.isFinite(age) ? age : null,
    }];
  }));
  const usableHost = (id) => {
    const h = hostInfo.get(id);
    return Boolean(h && h.reachable && !h.critical && !h.off && !h.cannotAdmit);
  };

  // ---- queue -----------------------------------------------------------------
  const jobFits = (q, r) => r.repo === q.repo && covers(r.labels, q.labels ?? []);
  const idlePrimaryFor = (q) => primaryRunners.some((r) => jobFits(q, r) && online(r) && !r.drainState && !busy(r));
  // Only work the fleet could actually run counts. A run waiting for a label
  // no runner carries is config drift; resuming a host would not move it.
  const servable = queue.filter((q) => !NOT_RUNNER_CAUSES.includes(q.cause)
    && (primaryRunners.some((r) => jobFits(q, r)) || standbyRunners.some((r) => jobFits(q, r))));
  const stuck = servable.filter((q) => (q.queuedSinceMs ?? 0) > cfg.queueAgeMs
    && !idlePrimaryFor(q)
    && standbyRunners.some((r) => jobFits(q, r)));

  // ---- resume triggers ---------------------------------------------------------
  const triggers = [];
  const primaryAge = primary.lastHeartbeat ? now - primary.lastHeartbeat : Infinity;
  if (primaryAge > cfg.primaryStaleMs) {
    triggers.push({ id: 'primary-down', detail: Number.isFinite(primaryAge) ? `no heartbeat for ${secs(primaryAge)}` : 'never reported' });
  }
  if (primary.off) triggers.push({ id: 'primary-off', detail: 'the primary is switched off' });
  for (const rung of primary.rungs ?? []) {
    if (UNFIT_RUNGS.includes(rung)) triggers.push({ id: `primary-${rung}`, detail: `verdict rung ${rung} on the primary` });
  }
  if (primary.memPressure === 'critical') triggers.push({ id: 'primary-memory-critical', detail: 'memory pressure critical on the primary' });
  if (primaryBlocked) triggers.push({ id: 'primary-cannot-admit', detail: `the primary cannot start jobs: ${blockedWhy(primary.id)}` });
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
    // Never drained by the controller, except on a host that cannot admit:
    // there a floor runner only takes jobs to hold them. One it drained (for
    // that, or under an older floor list) goes back online.
    if (operatorDrained(r)) continue;
    const why = hostInfo.get(r.hostId)?.cannotAdmit;
    if (why && !off) {
      want(r, 'drain', 'floor', `${hostInfo.get(r.hostId).name} cannot start jobs: ${why}`);
      continue;
    }
    if (own(r)) want(r, 'resume', 'floor', 'floor runners stay online');
  }

  for (const r of overflowRunners) {
    if (operatorDrained(r)) continue;
    const h = hostInfo.get(r.hostId);
    if (off) {
      if (own(r)) want(r, 'resume', 'overflow', 'tiers switched off');
      continue;
    }
    const wantOnline = overflow === 'active' && !h?.critical && !h?.cannotAdmit;
    if (wantOnline) {
      if (own(r)) want(r, 'resume', 'overflow', reason);
      continue;
    }
    if (r.drainState) continue;
    // Never drain the twin a self-drained primary runner is relying on: the
    // primary runner comes back first (its lane has room by now), then this.
    // A runner on a host that cannot admit is covering nothing: the primary
    // runner is resumed this same step (it has no twin), and this one goes.
    const covering = !h?.cannotAdmit
      && primaryRunners.some((p) => own(p) && p.repo === r.repo && covers(r.labels, p.labels));
    if (covering) {
      deferred.push({ name: r.name, reason: 'still covering a self-drained primary runner' });
      continue;
    }
    const why = h?.cannotAdmit ? `${h.name} cannot start jobs: ${h.cannotAdmit}`
      : h?.critical ? 'memory pressure critical on the standby host' : reason;
    want(r, 'drain', 'overflow', why);
  }

  // A standby runner that is online now and will stay online: what a primary
  // runner needs before it may be drained.
  const twinFor = (p) => standbyRunners.find((r) => r.repo === p.repo
    && covers(r.labels, p.labels)
    && online(r) && !r.drainState && !drainingNow.has(r.name)
    && usableHost(r.hostId));

  const selfDrain = cfg.selfDrain && !off;
  const park = selfDrain && cfg.park;
  // With parking on, a primary-only repo is simply twinless: it is never sent
  // to the standby host, but it may wait in GitHub's queue like any other.
  const twinOf = (p) => (repoIn(p.repo, cfg.primaryOnlyRepos) ? null : twinFor(p));

  // ---- metered release of parked runners ---------------------------------------
  // A parked runner coming back takes a queued job at once, so bringing every
  // parked runner back when one slot frees would only move the hold back into
  // the hook. Instead each lane's free slots (cap minus Workers, held jobs
  // included) go to the oldest queued runs a twinless primary runner can
  // serve: first a runner already online and idle for it, else a parked one.
  // A runner GitHub has handed a job whose Worker has not started yet is
  // already spending a slot. A primary that cannot admit has no slots.
  const slotted = new Map();
  const slots = {};
  if (park) {
    for (const [k, l] of Object.entries(lanes)) slots[k] = primaryBlocked ? 0 : Math.max(0, l.cap - l.busy);
    const spend = (r) => { for (const k of lanesOf(r)) slots[k] -= 1; };
    for (const r of primaryRunners) if (r.ghBusy && !r.workingLocally) spend(r);
    const parkable = (r) => !operatorDrained(r) && !busy(r) && !twinOf(r)
      && (own(r) || (!r.drainState && online(r)));
    // `servable` leaves out runs GitHub itself is holding (concurrency-block,
    // which lib/queue-cause.js now reports only while a runner that fits is
    // idle and online): a slot kept for one would sit unused.
    const waiting = [...servable].sort((a, b) => (b.queuedSinceMs ?? 0) - (a.queuedSinceMs ?? 0));
    for (const q of waiting) {
      const fit = primaryRunners.filter((r) => jobFits(q, r) && parkable(r) && !slotted.has(r.name));
      const r = fit.find((x) => !x.drainState)
        ?? fit.find((x) => pending[x.name]?.action === 'resume')
        ?? fit[0];
      if (!r || !lanesOf(r).every((k) => slots[k] > 0)) continue;
      spend(r);
      slotted.set(r.name, q.id);
    }
  }

  for (const p of primaryRunners) {
    if (operatorDrained(p)) continue;
    const pinned = repoIn(p.repo, cfg.primaryOnlyRepos);
    const twin = park ? twinOf(p) : twinFor(p);
    if (own(p)) {
      if (!selfDrain) want(p, 'resume', 'primary', off ? 'tiers switched off' : 'self-drain disabled');
      else if (!park && pinned) want(p, 'resume', 'primary', 'repo is primary-only');
      else if (!park && !twin) want(p, 'resume', 'primary', 'no online standby twin');
      else if (!held(p)) {
        const freeFor = Math.min(...lanesOf(p).map((k) => lanes[k].freeForMs));
        want(p, 'resume', 'primary', Number.isFinite(freeFor) ? `lane below cap for ${secs(freeFor)}` : 'no lane to shed');
      } else if (!twin && slotted.has(p.name)) {
        want(p, 'resume', 'primary', `a host slot is free for queued run ${slotted.get(p.name)}`);
      }
      // Otherwise it stays drained: onto its twin, or parked with its jobs
      // queued at GitHub.
      continue;
    }
    const lane = drainLane(p);
    if (!selfDrain || (!park && pinned) || p.drainState || !lane) continue;
    // A repo is never left with only drained runners unless parking is on:
    // then its jobs wait in GitHub's queue and a parked runner comes back for
    // them as slots free. Idle only for a lane at cap, whose jobs start in
    // minutes; a busy runner on a primary that cannot admit is drained too (it
    // stops when its job ends), or it takes the next job to hold it.
    if ((busy(p) && lane !== 'admission') || !online(p)) continue;
    if (!twin) {
      if (!park) {
        deferred.push({ name: p.name, reason: 'no online standby twin' });
        continue;
      }
      want(p, 'drain', 'primary', lane === 'admission'
        ? `parked, no standby twin: the primary cannot start jobs: ${blockedWhy(primary.id)}`
        : `parked, no standby twin: ${lane} lane at cap, so its jobs wait in GitHub's queue, not against their timeout`);
      continue;
    }
    want(p, 'drain', 'primary', lane === 'admission' ? `the primary cannot start jobs: ${blockedWhy(primary.id)}` : `${lane} lane at cap`);
  }

  // Commands only reach a host whose agent is reporting, and never one that is
  // switched off: resuming even the controller's own drain there would put an
  // off host back to work.
  const issued = [];
  for (const a of actions) {
    const hostOff = a.hostId === primary.id ? Boolean(primary.off) : Boolean(hostInfo.get(a.hostId)?.off);
    if (hostOff) {
      deferred.push({ name: a.name, reason: `${hostInfo.get(a.hostId)?.name ?? a.hostId} is switched off` });
      continue;
    }
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

  const nextState = { overflow, since, reason, atCapSince, freeSince, quietSince, shed, admit, pending };
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
      primaryCannotAdmit: blockedWhy(primary.id),
      hosts: [...hostInfo.values()],
      counts: {
        floor: count(floorRunners),
        overflow: count(overflowRunners),
        primary: count(primaryRunners),
      },
      // Parked runners kept or brought online this step, by the queued run
      // each one's slot is for, and the lane slots left over.
      release: park ? { slots, runners: Object.fromEntries(slotted) } : null,
      // What this step would do (observe) or does (enforce).
      actions: issued,
      applied: cfg.mode === 'enforce' || (off && issued.length > 0),
      deferred,
    },
  };
}
