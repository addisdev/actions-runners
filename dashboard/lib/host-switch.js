// Switching a host off (scripts/host-drain.sh --off), and keeping drains held.
//
// Off is a drain of every runner on the host, written --by=host so --on can
// bring back exactly those and nothing an operator stopped. This module is the
// pure part: what switching a host off would cost, and which drained runners
// are running anyway and need stopping again.
//
// The second matters because a drain does not survive a reboot on its own.
// Runner plists set RunAtLoad and `svc.sh stop` only unloads the job, so the
// next login loads and starts every drained runner again. On 2026-10-12 a
// reboot of runner-host brought back all ten runners an operator had drained,
// and each went back to taking jobs.

export const HOST_OWNER = 'host';

// A runner that would take a job for its repo right now.
const serving = (r) => !r.drainState && !r.hostOff && !r.hostStale && !r.ephemeral
  && r.ghStatus === 'online' && !r.ghUnknown;

/**
 * What switching one host off would do.
 *
 * `stranded` is every repo the host serves today that has no runner online on
 * any other host: its jobs queue until this host is back on. Repo-level on
 * purpose, as a warning: a runner elsewhere whose labels do not match a job
 * would not save it either, so this can only undercount.
 *
 * @param {string}   hostId
 * @param {object[]} fleetRunners - { name, repo, hostId, drainState, hostOff,
 *   hostStale, ghStatus, ghUnknown, workingLocally, ghBusy, ephemeral }
 * @returns {{ runners: number, active: number, busy: string[], stranded: string[] }}
 */
export function switchOffImpact(hostId, fleetRunners = []) {
  const here = fleetRunners.filter((r) => r.hostId === hostId && !r.ephemeral);
  const active = here.filter((r) => !r.drainState);
  const elsewhere = new Set(fleetRunners.filter((r) => r.hostId !== hostId && serving(r)).map((r) => r.repo));
  return {
    runners: here.length,
    active: active.length,
    busy: active.filter((r) => r.workingLocally || r.ghBusy).map((r) => r.name).sort(),
    stranded: [...new Set(here.filter(serving).map((r) => r.repo))].filter((repo) => !elsewhere.has(repo)).sort(),
  };
}

/**
 * Drained runners whose service is running anyway, due to be drained again.
 *
 * A draining runner in the middle of a job is left alone: it stops when the
 * job ends. Anything else with a drain marker and a running service is a drain
 * that did not hold. A runner is due once it has stayed that way for `graceMs`
 * (so the moment between a job ending and drain-stop-when-idle.sh stopping the
 * service is not mistaken for one), and not again for `retryMs` after that.
 *
 * @param {object}   p
 * @param {object[]} p.runners - this host's runners: { name, dirName, drainState,
 *   drainBy, launchdState, workingLocally }
 * @param {number}   p.now
 * @param {Map}      [p.seen]  - the previous call's `seen`
 * @returns {{ due: { name, dirName, by }[], seen: Map }}
 */
export function drainsToReassert({ runners = [], now, seen = new Map(), graceMs = 30_000, retryMs = 300_000 }) {
  const next = new Map();
  const due = [];
  for (const r of runners) {
    if (!r.dirName || !r.drainState || r.launchdState !== 'running') continue;
    if (r.drainState === 'draining' && r.workingLocally) continue;
    const prev = seen.get(r.dirName) ?? { since: now, actedAt: null };
    const s = { ...prev };
    next.set(r.dirName, s);
    if (now - s.since < graceMs) continue;
    if (s.actedAt != null && now - s.actedAt < retryMs) continue;
    s.actedAt = now;
    due.push({ name: r.name, dirName: r.dirName, by: r.drainBy ?? null });
  }
  return { due, seen: next };
}

/**
 * Whether a runner's .drain marker, read again just before acting, still says
 * what `drainsToReassert` saw. The runner list is a tick old by then, and the
 * tiers controller may have resumed the runner since; re-draining it would
 * undo that.
 *
 * @param {string|null} text - the marker file's contents, null when absent
 * @param {string|null} by   - the owner `drainsToReassert` reported
 */
export function markerStillHeld(text, by) {
  if (!text) return false;
  const lines = text.split('\n').map((l) => l.trim());
  if (lines[0] !== 'drained' && lines[0] !== 'draining') return false;
  const owner = lines.find((l) => l.startsWith('by='))?.slice(3) || null;
  return owner === (by ?? null);
}

// drain-runner.sh arguments that re-apply a drain under the owner it already
// has: an operator drain stays an operator drain, a tiers drain stays the
// controller's, so whoever drained it is still the one who can resume it.
export function reassertArgs({ dirName, by }) {
  return [dirName, '--drain', ...(by ? [`--by=${by}`] : [])];
}
