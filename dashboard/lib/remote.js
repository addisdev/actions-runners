// Remote access helpers.
//
// Manages the host allowlist (DNS-rebinding defence), proxy-aware origin
// derivation, the reachable-URL list, and the access summary at /api/access.
//
// Request-path functions stay synchronous. The slow lookups — Tailscale status
// and the Bonjour name — run asynchronously in refreshNetworkIdentity() and are
// cached, because a blocking child process on the request path would stall
// every other request the daemon is serving.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Network identity: Tailscale + Bonjour
// ---------------------------------------------------------------------------

// launchd hands the daemon a minimal PATH, and the Mac App Store build of
// Tailscale does not put its CLI on PATH at all, so a bare `tailscale` lookup
// silently finds nothing and every tailnet request is then refused as an
// unknown host.
const TAILSCALE_CANDIDATES = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

let tailscaleStatus = null; // { dnsName, user, online, serving } | null
let bonjourName = null;     // e.g. "tads-mac-studio.local"

function tailscaleBinary() {
  if (process.env.FLEET_TAILSCALE === 'off') return null;
  if (process.env.FLEET_TAILSCALE_BIN) return process.env.FLEET_TAILSCALE_BIN;
  return TAILSCALE_CANDIDATES.find((p) => existsSync(p)) ?? 'tailscale';
}

async function run(bin, args) {
  const { stdout } = await execFileAsync(bin, args, { timeout: 3000 });
  return stdout.toString();
}

// Does any Serve handler proxy to this daemon's port?
export function serveTargetsPort(serveJson, port) {
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}/?$`);
  for (const site of Object.values(serveJson?.Web ?? {})) {
    for (const handler of Object.values(site?.Handlers ?? {})) {
      if (typeof handler?.Proxy === 'string' && target.test(handler.Proxy)) return true;
    }
  }
  return false;
}

async function refreshTailscale(port) {
  const bin = tailscaleBinary();
  if (!bin) { tailscaleStatus = null; return; }
  try {
    const data = JSON.parse(await run(bin, ['status', '--json']));
    const self = data?.Self ?? {};
    let serving = false;
    try {
      serving = serveTargetsPort(JSON.parse(await run(bin, ['serve', 'status', '--json']) || '{}'), port);
    } catch { /* serve not configured, or an older CLI */ }
    tailscaleStatus = {
      dnsName: self.DNSName ? self.DNSName.replace(/\.$/, '').toLowerCase() : null,
      user: self.UserID != null ? (data?.User?.[String(self.UserID)]?.LoginName ?? null) : null,
      online: self.Online ?? false,
      serving,
    };
  } catch {
    tailscaleStatus = null;
  }
}

async function refreshBonjourName() {
  if (process.platform !== 'darwin') return;
  try {
    const name = (await run('/usr/sbin/scutil', ['--get', 'LocalHostName'])).trim();
    if (name) bonjourName = `${name.toLowerCase()}.local`;
  } catch { /* keep the previous value */ }
}

let identityPort = 7878;
let refreshing = null;
let lastRefresh = 0;
const REFRESH_THROTTLE_MS = 30_000;

// Re-reads Tailscale and Bonjour identity and rebuilds the allowlist.
// Concurrent callers share one refresh; `force` bypasses the throttle.
export function refreshNetworkIdentity({ port = identityPort, force = false } = {}) {
  identityPort = port;
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefresh < REFRESH_THROTTLE_MS) return Promise.resolve();
  lastRefresh = Date.now();
  refreshing = Promise.all([refreshTailscale(port), refreshBonjourName()])
    .then(() => { _hostSet = buildHostSet(_hostSetExtra); })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export function getTailscaleStatus() {
  return tailscaleStatus;
}

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// The set of host names (no port) this server answers to. A DNS-rebinding page
// reaches us with its own domain in Host, which the browser will not let script
// override — so refusing unknown Host values stops it before any route runs.
function buildHostSet(extraHosts) {
  const hosts = new Set(LOOPBACK_HOSTS);

  const hn = os.hostname().toLowerCase();
  hosts.add(hn);
  hosts.add(hn.replace(/\.local$/, ''));
  if (!hn.endsWith('.local')) hosts.add(`${hn.split('.')[0]}.local`);
  if (bonjourName) {
    hosts.add(bonjourName);
    hosts.add(bonjourName.replace(/\.local$/, ''));
  }

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const addr = a.address.toLowerCase();
      hosts.add(addr);
      if (a.family === 'IPv6' || a.family === 6) hosts.add(`[${addr}]`);
    }
  }

  if (tailscaleStatus?.dnsName) {
    hosts.add(tailscaleStatus.dnsName);
    hosts.add(tailscaleStatus.dnsName.split('.')[0]);
  }

  for (const h of extraHosts) hosts.add(h);
  return hosts;
}

let _hostSet = null;
let _hostSetExtra = [];
let lastRebuild = 0;

export function initAllowedHosts(extra = []) {
  _hostSetExtra = extra.filter(Boolean).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  _hostSet = buildHostSet(_hostSetExtra);
  lastRebuild = Date.now();
  return _hostSet;
}

function hostOnly(hostHeader) {
  const value = String(hostHeader ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.replace(/:\d+$/, '');
}

export function isAllowedHost(hostHeader) {
  const host = hostOnly(hostHeader);
  if (!host) return false;
  if (!_hostSet) initAllowedHosts(_hostSetExtra);
  if (_hostSet.has(host)) return true;
  // A miss may be a new interface (Wi-Fi rejoined, VPN up). Rebuilding costs a
  // networkInterfaces() call, so a stream of junk Host values cannot turn it
  // into per-request work.
  if (Date.now() - lastRebuild > 10_000) {
    lastRebuild = Date.now();
    _hostSet = buildHostSet(_hostSetExtra);
    return _hostSet.has(host);
  }
  return false;
}

// Returns { ok } or { ok: false, status, error }
export function checkHost(req) {
  const hostHeader = req.headers.host ?? '';
  if (!isAllowedHost(hostHeader)) {
    return {
      ok: false,
      status: 421,
      error: `host "${hostHeader}" is not a recognised address for this server — add it to FLEET_ALLOWED_HOSTS if it should be`,
    };
  }
  return { ok: true };
}

// checkHost, but on a miss re-reads Tailscale/Bonjour identity once before
// refusing. Covers Tailscale Serve being switched on after the daemon started:
// the first tailnet request would otherwise get a 421 for a name we simply had
// not looked up yet.
export async function ensureHostAllowed(req) {
  const first = checkHost(req);
  if (first.ok) return first;
  await refreshNetworkIdentity().catch(() => {});
  return checkHost(req);
}

// ---------------------------------------------------------------------------
// Proxy detection
// ---------------------------------------------------------------------------

function isLoopbackPeer(req) {
  return LOOPBACK_ADDRS.has(req.socket?.remoteAddress ?? '');
}

// Loopback peer carrying forwarding headers: a reverse proxy on this machine
// (Tailscale Serve, or an operator's nginx/Caddy) relaying someone else.
export function isProxied(req) {
  if (!isLoopbackPeer(req)) return false;
  return Boolean(
    req.headers['x-forwarded-for']
    || req.headers['x-forwarded-proto']
    || req.headers['x-forwarded-host']
    || req.headers['tailscale-user-login']
    || req.headers['tailscale-user-name']
  );
}

// Directly from this machine with no proxy in between. Used for the one
// token-free write (dismissing an alert).
export function isLocalRequest(req) {
  return isLoopbackPeer(req) && !isProxied(req);
}

export function clientAddress(req) {
  if (isProxied(req)) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Origin derivation
// ---------------------------------------------------------------------------

// Forwarding headers are trusted only from a loopback peer; anything on the
// LAN could set them.
export function requestOrigin(req, { port }) {
  if (isProxied(req)) {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
    const fwdHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
    return `${proto}://${fwdHost}`;
  }
  return `http://${req.headers.host ?? `localhost:${port}`}`;
}

// The Origin must be this request's own origin (or a loopback origin, which the
// dashboard itself uses when opened on this machine), and its host must be one
// we answer to.
export function sameOrigin(req, { port }) {
  const origin = req.headers.origin;
  if (!origin) return { ok: true };

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, status: 403, error: `malformed origin ${origin}` };
  }

  const derived = requestOrigin(req, { port });
  const loopbackOrigin = parsed.protocol === 'http:'
    && LOOPBACK_HOSTS.has(parsed.hostname)
    && parsed.port === String(port);
  if (origin !== derived && !loopbackOrigin) {
    return { ok: false, status: 403, error: `cross-origin request from ${origin}` };
  }
  if (!isAllowedHost(parsed.host)) {
    return { ok: false, status: 403, error: `cross-origin request from unrecognised host ${parsed.hostname}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Viewer context (for /api/access)
// ---------------------------------------------------------------------------

// 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48 are the ranges Tailscale
// assigns, so a direct connection to the tailnet IP is still "tailscale".
export function isTailnetAddress(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/, '').toLowerCase();
  if (a.startsWith('fd7a:115c:a1e0:')) return true;
  const m = a.match(/^100\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

export function viewerContext(req) {
  const proxied = isProxied(req);
  const addr = clientAddress(req);
  let via = 'lan';
  if (isLocalRequest(req)) via = 'local';
  else if ((proxied && req.headers['tailscale-user-login']) || isTailnetAddress(addr)) via = 'tailscale';
  else if (proxied) via = 'proxy';

  const tailscaleUser = proxied
    ? (req.headers['tailscale-user-login'] ?? req.headers['tailscale-user-name'] ?? null)
    : null;
  return { via, tailscaleUser, addr };
}

// ---------------------------------------------------------------------------
// Reachable URLs
// ---------------------------------------------------------------------------

function isLoopbackBind(bindHost) {
  return LOOPBACK_HOSTS.has(String(bindHost ?? '127.0.0.1').toLowerCase());
}

function isWildcardBind(bindHost) {
  return bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]';
}

// Only URLs that will actually answer given the bind address. Listing LAN
// addresses for a loopback-bound daemon sends someone to type a URL into their
// phone that can never work.
export function reachableUrls(port, { bindHost = '127.0.0.1' } = {}) {
  const urls = [];
  const seen = new Set();
  const add = (kind, label, url) => {
    if (seen.has(url)) return;
    seen.add(url);
    urls.push({ kind, label, url });
  };

  add('loopback', 'this machine', `http://localhost:${port}`);

  if (isWildcardBind(bindHost)) {
    const mdns = bonjourName ?? `${os.hostname().toLowerCase().replace(/\.local$/, '').split('.')[0]}.local`;
    add('lan', 'Bonjour', `http://${mdns}:${port}`);
    for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
        if (isTailnetAddress(a.address)) add('tailscale', `tailnet IP (${iface})`, `http://${a.address}:${port}`);
        else add('lan', `LAN (${iface})`, `http://${a.address}:${port}`);
      }
    }
  } else if (!isLoopbackBind(bindHost)) {
    add(isTailnetAddress(bindHost) ? 'tailscale' : 'lan', 'bind address', `http://${bindHost}:${port}`);
  }

  if (tailscaleStatus?.dnsName && tailscaleStatus.serving) {
    add('tailscale', 'Tailscale Serve', `https://${tailscaleStatus.dnsName}`);
  }

  return urls;
}

// The URL to put in a pairing QR code. The code is usually generated on the
// runner host itself, where the request origin is localhost — a URL a phone
// can never open — so prefer a remote-reachable one: Tailscale HTTPS (works
// away from home and gets the service worker), then Bonjour, then a LAN IP.
export function pairingUrl(req, { port, bindHost }) {
  const origin = requestOrigin(req, { port });
  let originHost = '';
  try { originHost = new URL(origin).hostname; } catch { /* fall through */ }
  const remote = reachableUrls(port, { bindHost }).filter((u) => u.kind !== 'loopback');
  const rank = (u) => (u.url.startsWith('https://') ? 0 : u.label === 'Bonjour' ? 1 : u.kind === 'lan' ? 2 : 3);
  remote.sort((a, b) => rank(a) - rank(b));

  if (originHost && !LOOPBACK_HOSTS.has(originHost)) {
    return { url: origin, alternatives: remote.map((u) => u.url).filter((u) => u !== origin), warning: null };
  }
  if (remote.length) {
    return { url: remote[0].url, alternatives: remote.slice(1).map((u) => u.url), warning: null };
  }
  return {
    url: origin,
    alternatives: [],
    warning: 'This dashboard is only reachable from this machine, so another device cannot open the link. '
      + 'Enable LAN or Tailscale access first: ./fleetctl.sh remote lan on (or remote tailscale on).',
  };
}
