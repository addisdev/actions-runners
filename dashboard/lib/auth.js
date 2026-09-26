// Auth for the mutating routes.
//
// Read routes stay open on loopback; every action on the fleet requires a bearer
// token. The exception is a mutation that is not an action on the fleet — see
// isLocalRequest in lib/remote.js for the one case and why it is not a hole. The
// token is NOT served to the page — you paste it in once (`./fleetctl.sh token`)
// and the browser keeps it in localStorage. That distinction is the whole point:
// if the daemon handed the token to anything that could GET, then binding to the
// LAN, or any other process on the machine, would carry the right to restart
// runners and delete caches along with the right to look.
//
// Requiring it in an Authorization header rather than a cookie also means a
// random page in another tab cannot forge a request — a cross-origin form post
// cannot set that header, and the Origin check in remote.js closes the rest.
//
// Per-device tokens (from lib/devices.js) are also accepted here so that paired
// phones can use controls without the master token being sent to them.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { sameOrigin } from './remote.js';

export function loadOrCreateToken(path, log) {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return token;
    log(`token file ${path} looks too short — regenerating`);
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  log(`generated a new control token at ${path}`);
  return token;
}

// Constant-time compare, and length-checked first because timingSafeEqual
// throws on a length mismatch rather than returning false.
// expected is null in read-only mode — reject everything in that case.
export function tokenMatches(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

// authorize checks the bearer token against the master token (CONTROL_TOKEN)
// and optionally against per-device tokens via checkDevice(token) -> boolean.
// sameOrigin from remote.js is the final gate so LAN + Tailscale origins pass.
export function authorize(req, expected, { port, host }, checkDevice = null) {
  const given = bearerToken(req);
  if (!given) return { ok: false, status: 401, error: 'missing bearer token — ./fleetctl.sh token' };

  const masterOk = tokenMatches(given, expected);
  const deviceOk = !masterOk && checkDevice ? checkDevice(given) : false;

  if (!masterOk && !deviceOk) return { ok: false, status: 403, error: 'bad token' };
  return sameOrigin(req, { port, host });
}
