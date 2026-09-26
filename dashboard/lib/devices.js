// Per-device pairing tokens.
//
// Mobile devices and remote browsers that want to use the control plane are
// given their own bearer token via a time-limited pairing code.  The master
// bearer token never leaves the machine — instead an authorised session
// (master token or existing device token) generates a 6-digit code, the remote
// device enters or scans it, and gets back a device token it stores in
// localStorage.
//
// Device tokens are stored as SHA-256 hashes so a leaked token store does not
// give write access to the fleet.  Each entry records a name, createdAt, and
// lastSeenAt for the revoke UI.
//
// Pairing codes are single-use, expire after 5 minutes, and live in memory
// only — they are not persisted anywhere.  Rate limiting on the /api/pair
// exchange blocks brute-force guessing.

import {
  createHash, randomBytes, randomInt, timingSafeEqual,
} from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, chmodSync, renameSync,
} from 'node:fs';

const DIGEST = (v) => createHash('sha256').update(String(v)).digest('hex');
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = PAIRING_CODE_TTL_MS;
const RATE_WINDOW_MS = 60 * 1000;   // 1 minute window
const RATE_LIMIT = 5;                // failures per client before lockout
// Behind Tailscale Serve every client shares one peer address, and a LAN
// attacker can rotate addresses, so the per-client limit alone does not bound
// guessing. Past this many failures in a window from anyone, every pending code
// is burned and must be regenerated.
const GLOBAL_FAILURE_LIMIT = 20;

// ---- persistent store -------------------------------------------------------

function readStore(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(path, data) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

// ---- in-memory state --------------------------------------------------------

// Map<code -> { expires, used }>
const pendingCodes = new Map();

// Map<ip -> { failures: number, windowStart: number }>
const rateLimitState = new Map();

// ---- code generation --------------------------------------------------------

export function createPairingCode() {
  // purge expired codes
  const now = Date.now();
  for (const [code, entry] of pendingCodes) {
    if (entry.expires < now) pendingCodes.delete(code);
  }
  let code;
  do {
    code = String(randomInt(100000, 1000000));
  } while (pendingCodes.has(code));
  pendingCodes.set(code, { expires: now + CODE_TTL_MS, used: false });
  return code;
}

// ---- global failure budget --------------------------------------------------

let globalFailures = { count: 0, windowStart: 0 };

function recordGlobalFailure() {
  const now = Date.now();
  if (now - globalFailures.windowStart > RATE_WINDOW_MS) globalFailures = { count: 0, windowStart: now };
  globalFailures.count += 1;
  if (globalFailures.count >= GLOBAL_FAILURE_LIMIT) pendingCodes.clear();
}

function globallyLocked() {
  return Date.now() - globalFailures.windowStart <= RATE_WINDOW_MS
    && globalFailures.count >= GLOBAL_FAILURE_LIMIT;
}

// Test hook: the limiter state is module-global.
export function resetPairingState() {
  pendingCodes.clear();
  rateLimitState.clear();
  globalFailures = { count: 0, windowStart: 0 };
}

// ---- rate limiting ----------------------------------------------------------

// Returns true when this IP is locked out.
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitState.get(ip);
  if (!entry) return false;
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitState.delete(ip);
    return false;
  }
  return entry.failures >= RATE_LIMIT;
}

function recordFailure(ip) {
  const now = Date.now();
  recordGlobalFailure();
  if (rateLimitState.size > 1000) {
    for (const [key, e] of rateLimitState) {
      if (now - e.windowStart > RATE_WINDOW_MS) rateLimitState.delete(key);
    }
  }
  const entry = rateLimitState.get(ip) ?? { failures: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.failures = 0;
    entry.windowStart = now;
  }
  entry.failures += 1;
  rateLimitState.set(ip, entry);
}

function clearFailures(ip) {
  rateLimitState.delete(ip);
}

// ---- token exchange ---------------------------------------------------------

// Returns { token, error }
export function exchangeCode(path, code, name, ip) {
  if (isRateLimited(ip) || globallyLocked()) {
    return { error: 'too many failed attempts — wait a minute and try again', rateLimited: true };
  }

  const now = Date.now();
  const normalized = String(code ?? '').replace(/\D/g, '');
  const entry = pendingCodes.get(normalized);
  if (!entry || entry.used || entry.expires < now) {
    recordFailure(ip);
    return { error: 'invalid or expired pairing code' };
  }

  entry.used = true;
  pendingCodes.delete(normalized);
  clearFailures(ip);

  const token = randomBytes(32).toString('hex');
  const store = readStore(path);
  const safeName = String(name ?? 'device')
    .replace(/[^\p{L}\p{N} ()._·'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  const baseName = safeName || 'device';

  // Two identical phones produce identical default names. Replacing the entry
  // on a name match would silently revoke the first phone, so names are made
  // unique instead and every pairing gets its own key.
  const taken = new Set(Object.values(store).map((v) => v.name));
  let deviceName = baseName;
  for (let n = 2; taken.has(deviceName); n++) deviceName = `${baseName} (${n})`;
  const key = randomBytes(8).toString('hex');

  store[key] = {
    name: deviceName,
    hash: DIGEST(token),
    createdAt: now,
    lastSeenAt: now,
  };
  writeStore(path, store);
  return { token, name: deviceName };
}

// ---- token validation -------------------------------------------------------

export function deviceTokenMatches(path, token) {
  if (!token || typeof token !== 'string') return false;
  const store = readStore(path);
  const actual = Buffer.from(DIGEST(token));
  for (const [key, entry] of Object.entries(store)) {
    const expected = Buffer.from(String(entry.hash ?? ''));
    if (
      actual.length === expected.length
      && timingSafeEqual(actual, expected)
    ) {
      // Avoid a synchronous disk rewrite on every authenticated API request.
      // Five-minute precision is enough for the device-management UI.
      try {
        if (Date.now() - (entry.lastSeenAt ?? 0) < 5 * 60 * 1000) return true;
        entry.lastSeenAt = Date.now();
        store[key] = entry;
        writeStore(path, store);
      } catch { /* best effort */ }
      return true;
    }
  }
  return false;
}

// ---- device list ------------------------------------------------------------

export function listDevices(path) {
  const store = readStore(path);
  return Object.entries(store).map(([key, entry]) => ({
    key,
    name: entry.name,
    createdAt: entry.createdAt,
    lastSeenAt: entry.lastSeenAt,
  }));
}

export function revokeDevice(path, key) {
  const store = readStore(path);
  if (!store[key]) return false;
  delete store[key];
  writeStore(path, store);
  return true;
}
