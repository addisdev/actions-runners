// The System V shared memory table, as the dashboard sees it.
//
// hooks/shm-reap.sh removes the segments killed Postgres clusters leave behind
// and logs what it did to shm.ndjson. Until this file nothing read that log,
// and the failure it guards against arrives as a step log line
//   FATAL: could not create shared memory segment: No space left on device
// which no annotation carries, so lib/failures.js called it an ordinary red
// job and the verdict said nothing. On 2026-10-13 the table was found full by
// hand, one PR at a time.
//
// Two readings, because each misses something the other sees:
//   - a live sample (`ipcs -m -o -p`) says how full the table is NOW. It counts
//     orphans by the hook's own three rules, because an orphan is gone the
//     moment the next job's hook runs and is not what fills the table.
//   - the hook's log says what happened BETWEEN samples. Live clusters that
//     filled the table during a burst are gone by the next tick; the `low`
//     event the hook wrote at the time is the only trace. The `reaped` events
//     are the leak rate.
//
// The result rides on the host vitals (`host.shm`). An agent host sends its
// vitals in every heartbeat already, so the coordinator sees every host's table
// without a second log-shipping path like the admission one.
import os from 'node:os';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { sh } from './local.js';

export const SHM_DEFAULTS = {
  // The hook's FLEET_SHM_LOW_FREE, read from the same variable.
  lowFree: 4,
  // How long a `low` event the hook logged still explains a red Postgres job.
  // Long enough to cover `cockpit why` run after the failure; short enough that
  // a burst this morning is not the verdict this afternoon.
  lowWindowMs: 30 * 60 * 1000,
  // The leak-rate window.
  reapWindowMs: 24 * 60 * 60 * 1000,
  // Lines are ~200 bytes, so this is about a thousand events: far more than a
  // day of reaping on a fleet that is not already on fire.
  tailBytes: 256 * 1024,
};

// Parsed as the hook parses it, so a value the hook rejects is rejected here too.
export function lowFreeFromEnv(env = process.env) {
  const raw = String(env.FLEET_SHM_LOW_FREE ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : SHM_DEFAULTS.lowFree;
}

/**
 * `ipcs -m -o -p` → segments, or null when the header does not name the
 * columns. Found by header name like the hook does; a column read from the
 * wrong place would count a live segment as an orphan.
 */
export function parseIpcs(text) {
  let cols = null;
  const segments = [];
  for (const line of String(text ?? '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (!cols && f[0] === 'T') {
      const at = (name) => f.indexOf(name);
      cols = { id: at('ID'), owner: at('OWNER'), nattch: at('NATTCH'), cpid: at('CPID') };
      if (Object.values(cols).some((i) => i < 0)) return null;
      continue;
    }
    if (cols && f[0] === 'm') {
      segments.push({
        id: f[cols.id],
        owner: f[cols.owner],
        nattch: Number(f[cols.nattch]),
        cpid: Number(f[cols.cpid]),
      });
    }
  }
  return cols ? segments : null;
}

// EPERM is a live process owned by someone else, the same distinction the hook
// draws by using ps instead of kill -0.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Segments the next job hook would remove: ours, unattached, creator gone. */
export function countOrphans(segments, { user, alive = pidAlive }) {
  return segments.filter((s) => s.owner === user && s.nattch === 0 && !alive(s.cpid)).length;
}

/**
 * The hook's NDJSON → what the dashboard shows. `ts` in the log is epoch
 * seconds; everything returned is milliseconds.
 */
export function summarizeShmLog(text, now = Date.now(), opts = {}) {
  const o = { ...SHM_DEFAULTS, ...opts };
  const out = { reaped: 0, reapEvents: 0, lastReapedAt: null, lastLow: null };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      // The first line of a tail read is usually cut in half.
      continue;
    }
    const at = Number(e?.ts) * 1000;
    if (!Number.isFinite(at) || at <= 0) continue;
    const reaped = Number(e.reaped) || 0;
    if (reaped > 0 && now - at <= o.reapWindowMs) {
      out.reaped += reaped;
      out.reapEvents += 1;
    }
    if (reaped > 0 && (out.lastReapedAt == null || at > out.lastReapedAt)) out.lastReapedAt = at;
    if (e.event === 'low' && (out.lastLow == null || at > out.lastLow.at)) {
      const limit = Number(e.limit) || null;
      const used = Number.isFinite(Number(e.used)) ? Number(e.used) : null;
      out.lastLow = {
        at,
        used,
        limit,
        free: limit != null && used != null ? Math.max(0, limit - used) : null,
        runner: e.runner || null,
        repo: e.repo || null,
      };
    }
  }
  return out;
}

export function readTail(path, bytes = SHM_DEFAULTS.tailBytes) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.allocUnsafe(size - start);
  const fd = openSync(path, 'r');
  try {
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * One sampler per process. The limit is fixed at boot and the log is re-read
 * only when it has grown, so the fast loop pays for one `ipcs` and nothing else.
 */
export function createShmSampler({
  logPath,
  lowFree = SHM_DEFAULTS.lowFree,
  user = os.userInfo().username,
  run = sh,
  alive = pidAlive,
  opts = {},
} = {}) {
  let limit = null;
  let cached = { key: null, text: '' };
  return async function sample(now = Date.now()) {
    if (limit == null) {
      const n = Number(String(await run('sysctl', ['-n', 'kern.sysv.shmmni'])).trim());
      if (Number.isInteger(n) && n > 0) limit = n;
    }
    const segments = parseIpcs(await run('ipcs', ['-m', '-o', '-p']));
    let log = { reaped: 0, reapEvents: 0, lastReapedAt: null, lastLow: null };
    try {
      if (logPath && existsSync(logPath)) {
        const st = statSync(logPath);
        const key = `${st.size}:${st.mtimeMs}`;
        if (key !== cached.key) cached = { key, text: readTail(logPath, opts.tailBytes) };
      }
      log = summarizeShmLog(cached.text, now, opts);
    } catch { /* an unreadable log is no history, not a failed tick */ }
    if (!segments && limit == null && !log.lastLow && !log.reapEvents) return null;
    return {
      limit,
      used: segments ? segments.length : null,
      orphaned: segments ? countOrphans(segments, { user, alive }) : null,
      lowFree,
      sampledAt: now,
      reaped24h: log.reaped,
      reapEvents24h: log.reapEvents,
      lastReapedAt: log.lastReapedAt,
      lastLow: log.lastLow,
    };
  };
}

/**
 * Whether a host's table is a finding, and the numbers to say it with. Pure;
 * the verdict and the alert both read it, so they cannot disagree.
 *
 * Free is counted AFTER the orphans: the next job's hook removes them before
 * its own steps start a cluster, so they are not what makes shmget fail.
 */
export function shmPressure(shm, now = Date.now(), opts = {}) {
  if (!shm) return null;
  const o = { ...SHM_DEFAULTS, ...opts };
  const lowFree = shm.lowFree ?? o.lowFree;
  const live = shm.limit > 0 && shm.used != null;
  const free = live ? Math.max(0, shm.limit - shm.used + (shm.orphaned ?? 0)) : null;
  const liveLow = live && free < lowFree;
  const recent = shm.lastLow && now - shm.lastLow.at <= o.lowWindowMs ? shm.lastLow : null;
  return {
    low: Boolean(liveLow || recent),
    liveLow: Boolean(liveLow),
    full: live && free === 0,
    free,
    limit: shm.limit ?? null,
    used: shm.used ?? null,
    orphaned: shm.orphaned ?? null,
    lowFree,
    recentLow: recent,
    reaped24h: shm.reaped24h ?? 0,
  };
}
