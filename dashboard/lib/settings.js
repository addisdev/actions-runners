// Settings that can be changed while the daemon is running.
//
// Everything here used to be an environment variable baked into a LaunchAgent
// plist, which meant changing a threshold was: edit fleet.env, re-run
// `fleetctl.sh install` to regenerate the plist, restart the daemon, lose the
// in-memory snapshot. Nobody tunes a value that costs that much, so the values
// never got tuned.
//
// PRECEDENCE: stored setting, then environment, then built-in default.
//
// The environment SEEDS a setting; it does not override one. That direction is
// deliberate and it is the only one that works — if env won, a value edited in
// the UI would silently revert on the next restart, and the screen would appear
// to do nothing. The cost is that editing the plist no longer changes a setting
// somebody has already overridden here, which is why the API reports the source
// of every value.
//
// Some things genuinely cannot live here: the port and host are bound once at
// startup, and the database path is needed to read this table. They stay
// environment-only and are marked as such so the UI can say so rather than
// offering an edit that will not take.

export const ENV_ONLY = ['FLEET_PORT', 'FLEET_HOST', 'FLEET_DB', 'FLEET_TOKEN_FILE',
  'FLEET_ADMISSION_LOG'];

// type drives both parsing and validation. Anything rejected leaves the previous
// value in place — a settings screen that can brick the daemon with a typo is
// worse than no settings screen.
export const SCHEMA = {
  // ---- grouping ----------------------------------------------------------
  groupsEnabled: { type: 'bool', default: true, env: 'FLEET_GROUPS', envFalse: ['off', '0'],
    label: 'Group runners by project' },
  groupMin: { type: 'int', default: 2, min: 1, max: 20, env: 'FLEET_GROUP_MIN',
    label: 'Repos sharing a name before they form a group' },
  groupIgnore: { type: 'list', default: [], env: 'FLEET_GROUP_IGNORE',
    label: 'Never group these names' },
  projects: { type: 'list', default: [], env: 'FLEET_PROJECTS',
    label: 'Pinned groups, shown first in this order' },

  // ---- capacity ----------------------------------------------------------
  // See lib/capacity.js for why the ceiling is this low. It is the single most
  // consequential number in the fleet: it decides how much of the machine CI is
  // allowed to take.
  maxTotalRunners: { type: 'int', default: 32, min: 1, max: 200,
    label: 'Most runners the fleet may have (the real concurrency cap)' },
  ceiling: { type: 'int', default: 3, min: 1, max: 32, env: 'FLEET_CEILING',
    label: 'Do not add runners while this many jobs are running' },
  loadPerCore: { type: 'float', default: 4, min: 0.5, max: 64,
    label: 'Refuse to scale above this load per core' },
  minFreeDiskGb: { type: 'int', default: 40, min: 5, max: 2000,
    label: 'Keep at least this much disk free (GB)' },
  maxSwapinsPerSec: { type: 'int', default: 20, min: 1, max: 100000,
    label: 'Refuse to scale above this swap-in rate' },
  blockOnPressure: { type: 'bool', default: true,
    label: 'Refuse to scale under kernel memory pressure' },
  maxInstancesPerRepo: { type: 'int', default: 4, min: 1, max: 8,
    label: 'Most runners one repo may have' },

  // ---- autoscaling -------------------------------------------------------
  autoscale: { type: 'bool', default: false,
    label: 'Add runners automatically when work is queued' },
  autoscaleDryRun: { type: 'bool', default: true,
    label: 'Decide but do not act (leave on until the log looks right)' },
  minQueuedMs: { type: 'int', default: 600000, min: 60000, max: 86400000,
    label: 'How long work must be queued before scaling up (ms)' },
  scaleCooldownMs: { type: 'int', default: 1800000, min: 60000, max: 86400000,
    label: 'Minimum gap between scale-ups for one repo (ms)' },
  // Three days, not the six hours this started at. A dry run with a 6h TTL
  // immediately proposed removing a duplicate that had run 103 jobs and last
  // worked that morning — 6h does not mean "unused", it means "overnight", and
  // the runner would be re-added the next working day and removed again the
  // night after. The signal that a duplicate is genuinely unwanted is days of
  // silence, not hours.
  idleTtlMs: { type: 'int', default: 259200000, min: 3600000, max: 2592000000,
    label: 'Remove a duplicate idle for this long (ms)' },
  scaleDown: { type: 'bool', default: false,
    label: 'Remove idle duplicates automatically' },

  // ---- billing (optional) -------------------------------------------------
  // Leave this blank to disable billing queries. Set to your GitHub org or
  // username to probe the consolidated billing API on each slow tick. If the
  // token does not have billing scope the probe silently marks itself as
  // "unavailable" — it is never treated as an error.
  billingOrg: { type: 'string', default: '', env: 'FLEET_BILLING_ORG',
    label: 'GitHub org or user to check billing for (leave blank to disable)' },
};

function parseValue(type, raw, def) {
  if (raw == null) return def;
  switch (type) {
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      return !['0', 'false', 'off', 'no', ''].includes(String(raw).toLowerCase());
    case 'int': {
      const n = Number(raw);
      return Number.isInteger(n) ? n : def;
    }
    case 'float': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def;
    }
    case 'list':
      if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
      return String(raw).split(/[\s,]+/).filter(Boolean);
    default:
      return String(raw);
  }
}

function fromEnv(spec) {
  if (!spec.env) return undefined;
  const raw = process.env[spec.env];
  if (raw == null || raw === '') return undefined;
  // FLEET_GROUPS is documented as `off` rather than `0`, and a couple of other
  // flags predate this file. envFalse keeps those spellings working.
  if (spec.type === 'bool' && spec.envFalse) {
    return !spec.envFalse.includes(raw.toLowerCase());
  }
  return parseValue(spec.type, raw, undefined);
}

export function createSettings(db) {
  const read = db.prepare('SELECT key, value, updated_at FROM settings');
  const write = db.prepare(
    'INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const drop = db.prepare('DELETE FROM settings WHERE key = ?');

  // Cached, because this is read on every tick and by every action. Invalidated
  // on write rather than expiring — there is exactly one writer, in-process.
  let cache = null;

  function load() {
    if (cache) return cache;
    const stored = new Map();
    try {
      for (const row of read.all()) stored.set(row.key, row);
    } catch {
      // A missing table means an older database; defaults are the right answer.
    }
    const out = {};
    const meta = {};
    for (const [key, spec] of Object.entries(SCHEMA)) {
      const row = stored.get(key);
      if (row) {
        out[key] = parseValue(spec.type, JSON.parse(row.value ?? 'null'), spec.default);
        meta[key] = { source: 'setting', updatedAt: row.updated_at ?? null };
        continue;
      }
      const env = fromEnv(spec);
      if (env !== undefined) {
        out[key] = env;
        meta[key] = { source: `env:${spec.env}`, updatedAt: null };
        continue;
      }
      out[key] = spec.default;
      meta[key] = { source: 'default', updatedAt: null };
    }
    cache = { values: out, meta };
    return cache;
  }

  function validate(key, value) {
    const spec = SCHEMA[key];
    if (!spec) throw new Error(`unknown setting: ${key}`);
    const parsed = parseValue(spec.type, value, undefined);
    if (parsed === undefined || parsed === null) throw new Error(`${key}: not a ${spec.type}`);
    if (spec.type === 'int' && !Number.isInteger(parsed)) throw new Error(`${key}: must be a whole number`);
    if ((spec.type === 'int' || spec.type === 'float')) {
      if (spec.min != null && parsed < spec.min) throw new Error(`${key}: minimum is ${spec.min}`);
      if (spec.max != null && parsed > spec.max) throw new Error(`${key}: maximum is ${spec.max}`);
    }
    if (spec.type === 'list') {
      for (const item of parsed) {
        if (!/^[A-Za-z0-9._-]{1,60}$/.test(item)) throw new Error(`${key}: unusable entry "${item}"`);
      }
    }
    if (spec.type === 'string' && String(parsed).length > 200) throw new Error(`${key}: too long`);
    return parsed;
  }

  return {
    all: () => load().values,
    meta: () => load().meta,
    get: (key) => load().values[key],

    set(key, value) {
      const parsed = validate(key, value);
      write.run(key, JSON.stringify(parsed), Date.now());
      cache = null;
      return parsed;
    },

    // Back to whatever the environment or the default says. Distinct from
    // setting it to the default value: the row goes away, so a later plist
    // change takes effect again.
    reset(key) {
      if (!SCHEMA[key]) throw new Error(`unknown setting: ${key}`);
      drop.run(key);
      cache = null;
      return load().values[key];
    },

    // The subset lib/capacity.js understands, so callers do not have to know
    // which of these are capacity limits and which are not.
    limits() {
      const v = load().values;
      return {
        maxTotalRunners: v.maxTotalRunners,
        ceiling: v.ceiling,
        loadPerCore: v.loadPerCore,
        minFreeDiskGb: v.minFreeDiskGb,
        maxSwapinsPerSec: v.maxSwapinsPerSec,
        blockOnPressure: v.blockOnPressure,
        maxInstancesPerRepo: v.maxInstancesPerRepo,
      };
    },
  };
}
