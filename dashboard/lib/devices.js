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

// Map<code -> { expires, used, scopes }>
const pendingCodes = new Map();

// Map<ip -> { failures: number, windowStart: number }>
const rateLimitState = new Map();

// ---- code generation --------------------------------------------------------

// `scopes` limits the token the code is exchanged for (lib/scopes.js); null
// means every scope, which is what pairing a browser has always granted.
export function createPairingCode({ scopes = null } = {}) {
  // purge expired codes
  const now = Date.now();
  for (const [code, entry] of pendingCodes) {
    if (entry.expires < now) pendingCodes.delete(code);
  }
  let code;
  do {
    code = String(randomInt(100000, 1000000));
  } while (pendingCodes.has(code));
  pendingCodes.set(code, { expires: now + CODE_TTL_MS, used: false, scopes });
  return code;
}

// Spends a pairing code without issuing a device token, for a caller that
// issues its own credential (the OAuth consent page). Same single use, same
// rate limits. Returns { scopes } or { error, rateLimited }.
export function redeemCode(code, ip) {
  if (isRateLimited(ip) || globallyLocked()) {
    return { error: 'too many failed attempts — wait a minute and try again', rateLimited: true };
  }
  const normalized = String(code ?? '').replace(/\D/g, '');
  const entry = pendingCodes.get(normalized);
  if (!entry || entry.used || entry.expires < Date.now()) {
    recordFailure(ip);
    return { error: 'invalid or expired pairing code' };
  }
  entry.used = true;
  pendingCodes.delete(normalized);
  clearFailures(ip);
  return { scopes: entry.scopes };
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
  return addToken(path, { name, scopes: entry.scopes });
}

// Expired OAuth grants, dropped whenever the store is written anyway.
function prune(store, now) {
  for (const [key, entry] of Object.entries(store)) {
    if (entry.refreshExpiresAt && entry.refreshExpiresAt < now) delete store[key];
  }
}

// Issues a token straight into the store: the pairing exchange above, and
// `fleetctl.sh agent-token`, which an authorised session calls for a named,
// scoped token. Returns { token, name, key }; the token is never stored.
//
// An OAuth grant also passes ttlMs, refreshTtlMs and clientId: the token then
// expires, and a refresh token (returned as refreshToken) replaces it.
export function addToken(path, {
  name, scopes = null, kind = 'device', ttlMs = null, refreshTtlMs = null, clientId = null,
}) {
  const now = Date.now();
  const token = randomBytes(32).toString('hex');
  const refreshToken = refreshTtlMs ? randomBytes(32).toString('hex') : null;
  const store = readStore(path);
  prune(store, now);
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
    ...(kind !== 'device' ? { kind } : {}),
    ...(scopes ? { scopes } : {}),
    ...(ttlMs ? { expiresAt: now + ttlMs } : {}),
    ...(refreshToken ? { refreshHash: DIGEST(refreshToken), refreshExpiresAt: now + refreshTtlMs, clientId } : {}),
  };
  writeStore(path, store);
  return {
    token,
    name: deviceName,
    key,
    ...(ttlMs ? { expiresAt: now + ttlMs } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

// Trades a refresh token for a new token pair on the same entry, so revoking
// the entry ends the grant however many times it has been refreshed. The old
// pair stops working. Returns { token, refreshToken, expiresAt, scopes, key }
// or null for a token that is unknown, expired or another client's.
export function refreshGrant(path, refreshToken, { clientId, ttlMs, refreshTtlMs }) {
  if (!refreshToken || typeof refreshToken !== 'string') return null;
  const now = Date.now();
  const store = readStore(path);
  const actual = Buffer.from(DIGEST(refreshToken));
  for (const [key, entry] of Object.entries(store)) {
    const expected = Buffer.from(String(entry.refreshHash ?? ''));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) continue;
    if (entry.clientId !== clientId || !(entry.refreshExpiresAt > now)) return null;
    const token = randomBytes(32).toString('hex');
    const next = randomBytes(32).toString('hex');
    store[key] = {
      ...entry,
      hash: DIGEST(token),
      refreshHash: DIGEST(next),
      expiresAt: now + ttlMs,
      refreshExpiresAt: now + refreshTtlMs,
      lastSeenAt: now,
    };
    prune(store, now);
    writeStore(path, store);
    return { token, refreshToken: next, expiresAt: now + ttlMs, scopes: entry.scopes ?? null, key };
  }
  return null;
}

// ---- token validation -------------------------------------------------------

// The store entry a token belongs to, as { key, name, kind, scopes }, or
// null. scopes is null for an entry from before scopes: every scope.
export function deviceTokenEntry(path, token) {
  if (!token || typeof token !== 'string') return null;
  const store = readStore(path);
  const actual = Buffer.from(DIGEST(token));
  for (const [key, entry] of Object.entries(store)) {
    const expected = Buffer.from(String(entry.hash ?? ''));
    if (
      actual.length === expected.length
      && timingSafeEqual(actual, expected)
    ) {
      if (entry.expiresAt && entry.expiresAt <= Date.now()) return null;
      // Avoid a synchronous disk rewrite on every authenticated API request.
      // Five-minute precision is enough for the device-management UI.
      try {
        if (Date.now() - (entry.lastSeenAt ?? 0) >= 5 * 60 * 1000) {
          entry.lastSeenAt = Date.now();
          store[key] = entry;
          writeStore(path, store);
        }
      } catch { /* best effort */ }
      return { key, name: entry.name, kind: entry.kind ?? 'device', scopes: entry.scopes ?? null };
    }
  }
  return null;
}

export function deviceTokenMatches(path, token) {
  return deviceTokenEntry(path, token) !== null;
}

// ---- device list ------------------------------------------------------------

export function listDevices(path) {
  const store = readStore(path);
  return Object.entries(store).map(([key, entry]) => ({
    key,
    name: entry.name,
    kind: entry.kind ?? 'device',
    scopes: entry.scopes ?? null,
    createdAt: entry.createdAt,
    lastSeenAt: entry.lastSeenAt,
    ...(entry.refreshExpiresAt ? { expiresAt: entry.refreshExpiresAt } : {}),
  }));
}

export function revokeDevice(path, key) {
  const store = readStore(path);
  if (!store[key]) return false;
  delete store[key];
  writeStore(path, store);
  return true;
}
