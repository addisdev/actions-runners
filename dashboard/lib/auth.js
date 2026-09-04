// Auth for the mutating routes.
//
// Read routes stay open on loopback; every action requires a bearer token. The
// token is NOT served to the page — you paste it in once (`./fleetctl.sh token`
// prints it) and the browser keeps it in localStorage. That distinction is the
// whole point: if the daemon handed the token to anything that could GET, then
// binding to the LAN, or any other process on the machine, would carry the
// right to restart runners and delete caches along with the right to look.
//
// Requiring it in an Authorization header rather than a cookie also means a
// random page in another tab cannot forge a request — a cross-origin form post
// cannot set that header, and the Origin check below closes the rest.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

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
function tokenMatches(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function authorize(req, expected, { port, host }) {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!given) return { ok: false, status: 401, error: 'missing bearer token — ./fleetctl.sh token' };
  if (!tokenMatches(given, expected)) return { ok: false, status: 403, error: 'bad token' };

  // A browser sets Origin on cross-origin requests. Same-origin fetches from the
  // dashboard itself either omit it or send our own origin.
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([
      `http://${host}:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);
    if (!allowed.has(origin)) return { ok: false, status: 403, error: `cross-origin request from ${origin}` };
  }
  return { ok: true };
}
