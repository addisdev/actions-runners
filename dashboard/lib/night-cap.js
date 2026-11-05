// The night cap: at most N busy CI runners on this host inside a nightly
// window (default 2 from 22:00 to 06:00 local), so the night queue's batch
// jobs get the machine. It is the night queue's own limit (CI_MAX_BUSY in
// Model Ladder's studio/harness/night.py, decision D4 of NIGHT-QUEUE-PLAN.md,
// 2026-11-04), held until a separate CI box takes CI off ultra.
//
// HOW IT HOLDS JOBS. GitHub hands a queued job to the first online idle runner
// whose labels match; nothing here can refuse one a runner has already taken.
// A hold in the admission hook (hooks/job-started.sh) would sit at "Set up
// runner" with the clock running against the job's timeout-minutes, and the
// held job's Runner.Worker would still count as busy to the night queue. So
// the cap works like the tiers controller's parking (lib/tiers.js): inside
// the window, every runner that is not running a job and has no slot is taken
// offline with `drain-runner.sh --drain --by=night-cap`, and its jobs wait in
// GitHub's queue, where the wait costs them nothing. As slots free, one parked
// runner per free slot comes back for the oldest queued job it can take. When
// the window ends, or the cap is switched off, every runner it parked comes
// back.
//
// WHAT IT NEVER DOES. It never stops a running job. A busy runner is drained
// only while the host is over the cap (the window opened on a busy host), and
// drain-runner.sh lets a busy runner finish: it marks the runner draining and
// the job-completed hook stops the service once the job has reported. It
// never touches a runner an operator, the host switch or the tiers controller
// drained, and it sends nothing while the host is switched off.
//
// This module is pure: settings, clock and runners in, decision out. fleetd
// carries out the actions on every fast tick.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from './admit-gate.js';

export const NIGHT_CAP_MODES = ['off', 'observe', 'enforce'];

// The owner written into .drain markers. Only markers it wrote are resumed.
export const NIGHT_CAP_OWNER = 'night-cap';

export const NIGHT_CAP_DEFAULTS = {
  mode: 'off',
  // Minutes after local midnight. A window whose start is after its end runs
  // across midnight.
  start: 22 * 60,
  end: 6 * 60,
  maxBusy: 2,
  // IANA zone; null is the host's own zone (what `date` shows on it).
  timeZone: null,
  // An action not yet reflected in the runners' state is not re-sent sooner.
  retryMs: 180_000,
};

// Queue causes a runner coming online does not move (lib/tiers.js has the
// same list): a slot kept for such a job would sit unused.
const NOT_RUNNER_CAUSES = ['concurrency-block', 'github-hosted', 'label-mismatch', 'telemetry-unavailable'];

const pad = (n) => String(n).padStart(2, '0');
export const hhmm = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** "22:00-06:00" (a hyphen or an en dash) → { start, end } in minutes, or null. */
export function parseWindow(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  return start === end ? null : { start, end };
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The cap's settings: the process environment, then fleet.env over it, the
 * way lib/admit-gate.js reads the hooks' settings. Read on every call, so an
 * edit to fleet.env (FLEET_NIGHT_CAP_MODE=off) takes effect on the next tick
 * without a restart. A value that does not parse keeps its default and is
 * named in `problems`; an unknown mode is off, never the stricter reading.
 */
export function nightCapConfig({ root, env = process.env, read = readFileSync } = {}) {
  let file = {};
  if (root) {
    try { file = parseEnvFile(read(join(root, 'fleet.env'), 'utf8')); } catch { /* no fleet.env */ }
  }
  const v = (k) => (file[k] !== undefined ? file[k] : env[k]);
  const problems = [];
  const cfg = { ...NIGHT_CAP_DEFAULTS, problems };

  const mode = String(v('FLEET_NIGHT_CAP_MODE') ?? 'off').trim().toLowerCase();
  if (NIGHT_CAP_MODES.includes(mode)) cfg.mode = mode;
  else problems.push(`FLEET_NIGHT_CAP_MODE=${mode} is not off, observe or enforce: read as off`);

  const win = v('FLEET_NIGHT_CAP_WINDOW');
  if (win != null && String(win).trim() !== '') {
    const w = parseWindow(win);
    if (w) Object.assign(cfg, w);
    else problems.push(`FLEET_NIGHT_CAP_WINDOW=${win} is not HH:MM-HH:MM: kept ${hhmm(cfg.start)}-${hhmm(cfg.end)}`);
  }

  const max = v('FLEET_NIGHT_CAP_MAX_BUSY');
  if (max != null && String(max).trim() !== '') {
    if (/^[0-9]+$/.test(String(max).trim())) cfg.maxBusy = Number(String(max).trim());
    else problems.push(`FLEET_NIGHT_CAP_MAX_BUSY=${max} is not a whole number: kept ${cfg.maxBusy}`);
  }

  const tz = String(v('FLEET_NIGHT_CAP_TZ') ?? '').trim();
  if (tz) {
    if (validTimeZone(tz)) cfg.timeZone = tz;
    else problems.push(`FLEET_NIGHT_CAP_TZ=${tz} is not a time zone: using the host's own`);
  }
  return cfg;
}

// ---- local time -------------------------------------------------------------
// Everything is done in wall-clock terms of the zone, through Intl, so a DST
// change is the zone's business: the window opens when the clock there reads
// the start time and closes when it reads the end time, whatever the length
// of the night in between (9 hours in New York on 2026-11-01, 7 on
// 2027-03-14).

const formatters = new Map();
function formatter(timeZone) {
  const key = timeZone ?? '';
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone ?? undefined,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(key);
}

/** The wall clock in `timeZone` at instant `t`: { y, mo, d, h, mi, s }. */
export function wallClock(t, timeZone = null) {
  const p = {};
  for (const part of formatter(timeZone).formatToParts(new Date(t))) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

// Wall-clock minus UTC at instant t, in ms.
function offsetMs(t, timeZone) {
  const w = wallClock(t, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant the clock in `timeZone` first reads `minutes` after midnight on
 * local date y-mo-d. A time the clock shows twice (the hour repeated when DST
 * ends) is its first showing; one it skips (the hour lost when DST starts) is
 * the moment the clock jumps past it.
 */
export function localInstant(y, mo, d, minutes, timeZone = null) {
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const offsets = new Set([-36, -12, 0, 12, 36].map((h) => offsetMs(wall + h * 3_600_000, timeZone)));
  const exact = [...offsets].map((o) => wall - o).filter((c) => c + offsetMs(c, timeZone) === wall);
  if (exact.length) return Math.min(...exact);
  // A skipped time: the transition lies between the candidates. Find the
  // first instant whose wall clock is past `wall`, to the minute.
  const cands = [...offsets].map((o) => wall - o);
  let lo = Math.min(...cands);
  let hi = Math.max(...cands);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (mid + offsetMs(mid, timeZone) >= wall) hi = mid; else lo = mid;
  }
  return hi;
}

const addDays = (y, mo, d, n) => {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};

/**
 * Where `now` stands against the window.
 *
 * @returns {{ active: boolean, startsAt: number|null, endsAt: number|null,
 *   start: string, end: string, until: string|null, timeZone: string }}
 *   endsAt while inside it, startsAt (the next opening) while outside; `until`
 *   is the local time the cap holds until, as the clock will read it then.
 */
export function nightWindow(now, cfg = NIGHT_CAP_DEFAULTS) {
  const { start, end } = { ...NIGHT_CAP_DEFAULTS, ...cfg };
  const tz = cfg.timeZone ?? null;
  const w = wallClock(now, tz);
  const spans = [];
  for (const n of [-1, 0, 1]) {
    const [y, mo, d] = addDays(w.y, w.mo, w.d, n);
    const s = localInstant(y, mo, d, start, tz);
    const [ey, emo, ed] = end > start ? [y, mo, d] : addDays(y, mo, d, 1);
    spans.push([s, localInstant(ey, emo, ed, end, tz)]);
  }
  const inside = spans.find(([s, e]) => now >= s && now < e);
  const timeZone = tz ?? formatter(null).resolvedOptions().timeZone;
  if (inside) {
    const e = wallClock(inside[1], tz);
    return { active: true, startsAt: null, endsAt: inside[1], start: hhmm(start), end: hhmm(end), until: `${pad(e.h)}:${pad(e.mi)}`, timeZone };
  }
  const next = spans.map(([s]) => s).filter((s) => s > now).sort((a, b) => a - b)[0] ?? null;
  return { active: false, startsAt: next, endsAt: null, start: hhmm(start), end: hhmm(end), until: null, timeZone };
}

// ---- the controller ---------------------------------------------------------

const lower = (labels) => (labels ?? []).map((l) => String(l).toLowerCase());
const covers = (have, need) => {
  const h = new Set(lower(have));
  return lower(need).every((l) => h.has(l));
};

/**
 * The queued jobs a runner on this host could start: every `queued` job of an
 * active run (a run already in progress keeps queued jobs too: a matrix, or
 * jobs whose needs just finished), and a queued run whose jobs are not known
 * yet as one job of its own.
 *
 * @param {object[]} active - snapshot.active runs ({ id, repo, status, jobs, createdAt, startedAt })
 * @param {Map<number,string>} [causes] - queued run id → queue cause
 */
export function queuedJobs(active = [], now = Date.now(), causes = new Map()) {
  const out = [];
  for (const run of active) {
    const since = Math.max(Date.parse(run.createdAt) || 0, Date.parse(run.startedAt ?? run.createdAt) || 0);
    const queuedSinceMs = since ? Math.max(0, now - since) : 0;
    const jobs = (run.jobs ?? []).filter((j) => j.status === 'queued');
    const cause = causes.get(run.id) ?? null;
    if (jobs.length) {
      for (const j of jobs) out.push({ key: `${run.id}/${j.id ?? j.name}`, runId: run.id, repo: run.repo, labels: j.labels ?? [], queuedSinceMs, cause });
    } else if (run.status === 'queued' && !(run.jobs ?? []).length) {
      out.push({ key: `${run.id}`, runId: run.id, repo: run.repo, labels: [], queuedSinceMs, cause });
    }
  }
  return out;
}

/**
 * One step.
 *
 * @param {object} input
 * @param {object} input.config   - nightCapConfig()
 * @param {object} input.window   - nightWindow(now, config)
 * @param {number} input.now
 * @param {object|null} input.state - the previous step's `state`
 * @param {boolean} [input.hostOff] - the host is switched off (host-drain.sh --off)
 * @param {object[]} input.runners - this host's runners: { name, dirName, repo, labels,
 *   ghStatus, ghUnknown, workingLocally, ghBusy, drainState, drainBy, ephemeral }
 * @param {object[]} input.jobs    - queuedJobs()
 * @returns {{ state: object, decision: object }}
 */
export function decideNightCap({ config, window: win, now, state = null, hostOff = false, runners = [], jobs = [] }) {
  const cfg = { ...NIGHT_CAP_DEFAULTS, ...config };
  const prev = state ?? {};
  const own = (r) => Boolean(r.drainState) && r.drainBy === NIGHT_CAP_OWNER;
  const others = (r) => Boolean(r.drainState) && r.drainBy !== NIGHT_CAP_OWNER;
  const busy = (r) => Boolean(r.workingLocally || r.ghBusy);
  const online = (r) => r.ghStatus === 'online' && !r.ghUnknown;
  const ours = runners.filter((r) => !r.ephemeral && r.dirName);

  const busyN = runners.filter(busy).length;
  const capping = cfg.mode !== 'off' && Boolean(win?.active);
  const until = win?.until ?? hhmm(cfg.end);

  const pending = {};
  for (const [name, p] of Object.entries(prev.pending ?? {})) {
    if (now - p.at < cfg.retryMs) pending[name] = p;
  }
  const actions = [];
  const deferred = [];
  const want = (r, action, reason) => {
    const done = action === 'drain' ? own(r) : !r.drainState;
    if (done) {
      delete pending[r.name];
      return;
    }
    if (pending[r.name]?.action === action) return;
    actions.push({ name: r.name, dirName: r.dirName, repo: r.repo, action, reason });
  };

  const slotted = new Map();
  let slots = 0;
  const held = new Set();
  if (!capping) {
    const why = cfg.mode === 'off' ? 'night cap switched off' : `night window ended at ${win?.end ?? hhmm(cfg.end)}`;
    for (const r of ours) if (own(r)) want(r, 'resume', why);
  } else {
    // Free slots go to the oldest queued jobs first, each to one runner that
    // can take it: one already online and idle, else one this cap parked.
    // A runner GitHub has handed a job whose Worker has not started yet is
    // already busy, so it is counted and left alone.
    slots = Math.max(0, cfg.maxBusy - busyN);
    const fits = (q, r) => r.repo === q.repo && covers(r.labels, q.labels ?? []);
    const parkable = (r) => !others(r) && !busy(r);
    const waiting = jobs
      .filter((q) => !NOT_RUNNER_CAUSES.includes(q.cause) && ours.some((r) => fits(q, r)))
      .sort((a, b) => (b.queuedSinceMs ?? 0) - (a.queuedSinceMs ?? 0));
    let left = slots;
    for (const q of waiting) {
      if (left <= 0) break;
      const fit = ours.filter((r) => fits(q, r) && parkable(r) && !slotted.has(r.name));
      const r = fit.find((x) => !x.drainState && online(x))
        ?? fit.find((x) => pending[x.name]?.action === 'resume')
        ?? fit.find(own);
      if (!r) continue;
      slotted.set(r.name, q.key);
      left -= 1;
    }
    // Every run with a job still waiting is held, including one whose other
    // job just got a slot.
    const given = new Set(slotted.values());
    for (const q of waiting) if (!given.has(q.key)) held.add(q.runId);

    for (const r of ours) {
      if (others(r)) continue;
      if (slotted.has(r.name)) {
        if (own(r)) want(r, 'resume', `a slot is free for queued job ${slotted.get(r.name)}`);
        continue;
      }
      if (busy(r)) {
        // Over the cap (the window opened with more running): drained now, it
        // stops once its job ends instead of taking the next one. A runner
        // with no Worker yet is left until its Worker shows.
        if (busyN > cfg.maxBusy && r.workingLocally && !own(r)) {
          want(r, 'drain', `${busyN} busy, over the night cap of ${cfg.maxBusy}: stops after its current job, until ${until}`);
        }
        continue;
      }
      if (own(r)) { delete pending[r.name]; continue; }
      // Offline runners take nothing; parking one would start it at the end.
      if (!online(r)) continue;
      want(r, 'drain', `parked by the night cap: at most ${cfg.maxBusy} busy until ${until}`);
    }
  }

  const issued = [];
  for (const a of actions) {
    if (hostOff) deferred.push({ name: a.name, reason: 'the host is switched off' });
    else issued.push(a);
  }
  const applied = cfg.mode === 'enforce' || (cfg.mode === 'off' && issued.length > 0);
  if (applied) for (const a of issued) pending[a.name] = { action: a.action, at: now };

  const parked = ours.filter(own).length;
  const reason = !capping
    ? (cfg.mode === 'off' ? 'off' : `outside the window (${win?.start ?? hhmm(cfg.start)}-${win?.end ?? hhmm(cfg.end)})`)
    : `at most ${cfg.maxBusy} busy CI runners until ${until}: ${busyN} busy, ${held.size ? `${held.size} run(s) waiting for a slot` : 'nothing waiting'}`;

  return {
    state: { pending },
    decision: {
      mode: cfg.mode,
      ts: now,
      active: capping,
      inWindow: Boolean(win?.active),
      window: `${win?.start ?? hhmm(cfg.start)}-${win?.end ?? hhmm(cfg.end)}`,
      timeZone: win?.timeZone ?? cfg.timeZone ?? null,
      maxBusy: cfg.maxBusy,
      busy: busyN,
      slots,
      until: capping ? until : null,
      endsAt: win?.endsAt ?? null,
      startsAt: win?.startsAt ?? null,
      parked,
      held: [...held].sort((a, b) => a - b),
      slotted: Object.fromEntries(slotted),
      reason,
      actions: issued,
      applied,
      deferred,
      problems: cfg.problems ?? [],
    },
  };
}

/**
 * The words every surface uses for a run the cap is holding: the queue row,
 * `cockpit why`, and a wait's pending reason. `nc` is a decision (or the
 * glance's copy of one).
 */
export function heldSentence(nc, host = 'this host') {
  if (!nc?.active) return null;
  return `held by the night cap until ${nc.until}: ${host} runs at most ${nc.maxBusy} CI jobs from `
    + `${String(nc.window).replace('-', ' to ')} and ${nc.busy} ${nc.busy === 1 ? 'is' : 'are'} running. `
    + 'It starts when a slot frees or the window ends. Not your code: keep waiting.';
}

/** A decision while it is actually holding jobs (enforce, inside the window), else null. */
export function enforcingNightCap(nc) {
  return nc && nc.mode === 'enforce' && nc.active ? nc : null;
}
