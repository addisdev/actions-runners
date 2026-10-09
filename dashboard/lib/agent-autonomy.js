// The agent's autonomy rule for standby tiers (docs/design/tiers.md).
//
// The tiers controller runs inside the coordinator and drains this host's
// overflow runners while the primary host copes. If the coordinator goes
// away — its host roams, sleeps in clamshell, reboots with nobody logged in —
// nothing would ever resume them, and the fleet would lose the very capacity
// it needs when the primary is gone. So the agent watches its own heartbeats:
// after `afterMs` without one succeeding, it resumes every runner the
// controller drained (marker `by=tiers`), and never one an operator drained.
// When heartbeats succeed again it stops acting on its own; the controller's
// next decision drains whatever should be drained.
//
// Pure: the agent feeds it the clock, its last good heartbeat and the runners
// it can see, and carries out the resumes it returns.

export const AUTONOMY_DEFAULT_MS = 180_000;
const OWNER = 'tiers';

/**
 * @param {object} p
 * @param {number} p.now
 * @param {number} p.lastOkAt     - when a heartbeat last succeeded (or the agent started)
 * @param {boolean} p.autonomous  - whether the previous step was autonomous
 * @param {number} p.afterMs      - silence before acting alone; 0 disables the rule
 * @param {object[]} p.runners    - { dirName, drainState, drainBy }
 * @returns {{ autonomous: boolean, entered: boolean, left: boolean, silentMs: number, release: string[] }}
 */
export function autonomyStep({ now, lastOkAt, autonomous = false, afterMs = AUTONOMY_DEFAULT_MS, runners = [] }) {
  const silentMs = Math.max(0, now - (lastOkAt ?? now));
  if (!afterMs || silentMs < afterMs) {
    return { autonomous: false, entered: false, left: Boolean(autonomous), silentMs, release: [] };
  }
  const release = runners
    .filter((r) => r.drainState && r.drainBy === OWNER)
    .map((r) => r.dirName);
  return { autonomous: true, entered: !autonomous, left: false, silentMs, release };
}
