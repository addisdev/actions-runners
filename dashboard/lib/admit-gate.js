// Whether a host's admission hook would hold ANY job it accepted right now.
//
// The hook (hooks/job-started.sh) runs only after a runner has taken a job from
// GitHub, so a hold cannot hand the job back: it sits at "Set up runner" until
// the disk is freed or GitHub cancels it. A per-job reason (the host's lane is
// at its cap) clears on its own in minutes. A host-wide one, the disk floor,
// does not, and while it lasts every runner on the host that stays online is a
// trap: GitHub gives it a job a runner elsewhere could have started at once.
// Seen 2026-10-15 on ultra: 97 GB usable under a 100 GB floor, every job it
// took held 30–60 min and cancelled, while runner-host had room.
//
// So the host computes this itself, from the same settings and the same disk
// figure the hook uses, and the coordinator keeps the runners of a host that
// cannot admit offline (lib/tiers.js), so GitHub routes the job elsewhere.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// KEY=VALUE lines, as the hooks source them. Quotes are stripped; anything
// that is not a plain assignment (expansions, commands) is ignored rather than
// guessed at.
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

// hooks/common.sh's admit_int: a whole number, or the default.
const wholeOr = (v, d) => (/^[0-9]+$/.test(String(v ?? '')) ? Number(v) : d);

/**
 * The admission settings in force on this host, resolved the way
 * hooks/common.sh resolves them: the process environment, then fleet.env
 * sourced over it. Read on every call, because the hook re-reads fleet.env for
 * every job and an edit there takes effect without a restart.
 */
export function admissionSettings({ root, env = process.env, read = readFileSync } = {}) {
  let file = {};
  if (root) {
    try { file = parseEnvFile(read(join(root, 'fleet.env'), 'utf8')); } catch { /* no fleet.env */ }
  }
  const v = (k) => (file[k] !== undefined ? file[k] : env[k]);
  const mode = String(v('FLEET_ADMIT_MODE') ?? 'off');
  return {
    mode: mode === 'observe' || mode === 'enforce' ? mode : 'off',
    minFreeDiskGb: wholeOr(v('FLEET_ADMIT_MIN_FREE_DISK_GB'), 40),
    minPlainFreeGb: wholeOr(v('FLEET_ADMIT_MIN_PLAIN_FREE_GB'), 15),
    // Lanes: a job with a recent median run under this many seconds is light.
    shortJobS: wholeOr(v('FLEET_ADMIT_SHORT_JOB_S'), 90) || 90,
  };
}

/**
 * Why the hook would hold every job on this host right now, or null.
 * Compares whole gigabytes, as the hook does, against the same figures
 * (lib/local.js hostVitals: usable space, and df's plain free beside it).
 *
 * @param {object} host     - hostVitals(): { diskFreeGb, diskPlainFreeGb }
 * @param {object} settings - admissionSettings()
 * @returns {{ kind: string, freeGb: number, floorGb: number, reason: string } | null}
 */
export function admissionBlocker(host, settings) {
  if (!settings || settings.mode !== 'enforce') return null;
  const usable = Number(host?.diskFreeGb);
  if (host?.diskFreeGb != null && Number.isFinite(usable) && Math.floor(usable) < settings.minFreeDiskGb) {
    const freeGb = Math.floor(usable);
    return { kind: 'disk', freeGb, floorGb: settings.minFreeDiskGb, reason: `${freeGb} GB disk free, below the ${settings.minFreeDiskGb} GB floor` };
  }
  const plain = Number(host?.diskPlainFreeGb);
  if (host?.diskPlainFreeGb != null && Number.isFinite(plain) && Math.floor(plain) < settings.minPlainFreeGb) {
    const freeGb = Math.floor(plain);
    return { kind: 'plain-disk', freeGb, floorGb: settings.minPlainFreeGb, reason: `${freeGb} GB plain disk free, below the ${settings.minPlainFreeGb} GB hard floor` };
  }
  return null;
}

/** The heartbeat's `admission` block: settings plus the blocker, if any. */
export function admissionReport(host, settings) {
  return { ...settings, blocked: admissionBlocker(host, settings) };
}
