// Web push — alerts on a phone's lock screen without a native app or a relay.
//
// The browser vendors run the push services (Apple, Google, Mozilla, Microsoft)
// and accept messages from anyone who signs them with a key the subscription
// was created against. So each daemon mints its own VAPID key pair and sends
// directly; there is no server of ours in the path and nothing to pay for.
//
// Everything here is node:crypto and fetch, to keep the daemon dependency-free:
//
//   RFC 8291  message encryption (aes128gcm). The push service relays the
//             ciphertext and cannot read the alert.
//   RFC 8292  VAPID. A short ES256 JWT that proves the sender holds the key the
//             subscription was bound to.
//
// The daemon POSTs to a URL a client handed it, which is a request-forgery
// primitive if taken at face value. Endpoints are therefore restricted to the
// known push services; see pushEndpointError().

import {
  createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  hkdfSync, randomBytes, createCipheriv, sign,
} from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, chmodSync, renameSync,
} from 'node:fs';

export const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
export const MIN_SEVERITIES = Object.keys(SEVERITY_RANK);
export const DEFAULT_MIN_SEVERITY = 'warning';

// Apple validates `sub` and rejects anything at localhost with BadJwtToken, so a
// hostname-derived default would silently fail on every iPhone. Apple checks the
// syntax, not reachability, which makes the project URL a safe default.
export const DEFAULT_CONTACT = 'https://github.com/addisdev/actions-runners';

const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

// The whole encrypted record must fit in 4096 bytes. The header takes 86 and the
// tag 16; the rest of the margin keeps a long alert body from being refused.
const MAX_PLAINTEXT = 3000;
const RECORD_SIZE = 4096;

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(String(s), 'base64url');

// ---- contact ---------------------------------------------------------------

export function contactError(contact) {
  let u;
  try { u = new URL(contact); } catch { return `not a URL: ${contact}`; }
  if (u.protocol === 'https:') {
    return /(^|\.)localhost$/i.test(u.hostname) ? 'a localhost contact is rejected by Apple' : null;
  }
  if (u.protocol === 'mailto:') {
    const domain = u.pathname.split('@')[1] ?? '';
    if (!domain.includes('.') || /(^|\.)(localhost|local)$/i.test(domain)) {
      return 'a mailto: contact needs a real domain — Apple rejects localhost and .local';
    }
    return null;
  }
  return 'must be an https: or mailto: URL';
}

// ---- endpoint allowlist ----------------------------------------------------

export function allowedPushHosts(extra = '') {
  return [
    ...DEFAULT_PUSH_HOSTS,
    ...String(extra).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ];
}

function hostMatches(host, pattern) {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

// Returns null when the endpoint is acceptable, otherwise the reason it is not.
export function pushEndpointError(endpoint, hosts = allowedPushHosts()) {
  let u;
  try { u = new URL(endpoint); } catch { return 'endpoint is not a URL'; }
  if (u.protocol !== 'https:') return 'endpoint must be https';
  if (u.username || u.password) return 'endpoint must not carry credentials';
  if (u.port && u.port !== '443') return 'endpoint must use the default port';
  const host = u.hostname.toLowerCase();
  if (!hosts.some((p) => hostMatches(host, p))) return `${host} is not a known push service`;
  return null;
}

// Validates and normalises what PushManager.subscribe() produced, as posted by
// the page. Returns { sub } or { error }.
export function parseSubscription(input, hosts) {
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint : '';
  const endpointErr = pushEndpointError(endpoint, hosts);
  if (endpointErr) return { error: endpointErr };
  if (endpoint.length > 1024) return { error: 'endpoint is too long' };
  const p256dh = fromB64url(input?.keys?.p256dh ?? '');
  const auth = fromB64url(input?.keys?.auth ?? '');
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) return { error: 'keys.p256dh must be an uncompressed P-256 point' };
  if (auth.length !== 16) return { error: 'keys.auth must be 16 bytes' };
  return { sub: { endpoint, p256dh: b64url(p256dh), auth: b64url(auth) } };
}

// ---- VAPID keys ------------------------------------------------------------

export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return vapidFromJwk(privateKey.export({ format: 'jwk' }));
}

function vapidFromJwk(jwk) {
  const publicKey = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  return { jwk, publicKey: b64url(publicKey) };
}

function writePrivate(path, data) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

// Single host: a 0600 file beside .fleet-token. Rotating it (deleting the file)
// invalidates every subscription; the page notices through /api/push/status and
// re-subscribes on its next load.
export function loadOrCreateVapidFile(path, log = () => {}) {
  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved?.jwk?.d) return vapidFromJwk(saved.jwk);
    } catch { /* fall through and regenerate */ }
    log(`push: ${path} is unreadable — generating a new VAPID key; phones will re-subscribe`);
  }
  const keys = generateVapidKeys();
  writePrivate(path, { jwk: keys.jwk, createdAt: Date.now() });
  log(`push: created VAPID key at ${path}`);
  return keys;
}

// HA: both replicas must sign with the same key, or a failover strands every
// subscription made against the old leader. Only the leader creates one.
export async function loadSharedVapid(ha, { create }) {
  const saved = await ha.getMeta('push.vapid');
  if (saved?.jwk?.d) return vapidFromJwk(saved.jwk);
  if (!create) return null;
  const keys = generateVapidKeys();
  await ha.setMeta('push.vapid', { jwk: keys.jwk, createdAt: Date.now() });
  return keys;
}

// ---- RFC 8292: VAPID -------------------------------------------------------

export function vapidAuthorization(endpoint, keys, contact, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  // Apple refuses anything more than 24 hours out; 12 leaves room for clock drift.
  const exp = Math.floor(now / 1000) + 12 * 3600;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp, sub: contact }));
  const input = `${header}.${claims}`;
  const key = createPrivateKey({ key: keys.jwk, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64url(signature)}, k=${keys.publicKey}`;
}

export function vapidPublicKeyObject(keys) {
  const { d, ...pub } = keys.jwk;
  return createPublicKey({ key: pub, format: 'jwk' });
}

// ---- RFC 8291: message encryption ------------------------------------------

// `salt` and `senderPrivateKey` exist for the RFC's worked example; in normal
// use both are fresh random values for every message.
export function encryptPayload(plaintext, { p256dh, auth }, { salt, senderPrivateKey } = {}) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const sender = createECDH('prime256v1');
  if (senderPrivateKey) sender.setPrivateKey(fromB64url(senderPrivateKey));
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const salt16 = salt ? fromB64url(salt) : randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt16, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt16, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record, with no padding after it.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt16, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---- message shaping -------------------------------------------------------

// A resolution reuses the opening message's tag, so the phone replaces the
// "runner is dead" notification rather than stacking a second one beside it.
export function tagFor(message) {
  if (message.scope) return `alert:${message.scope}`;
  return message.storm ? 'fleet:storm' : `fleet:${message.title}`;
}

// Topic lets the push service drop an undelivered message when a newer one
// with the same topic arrives — a phone that was offline for the whole outage
// gets "Resolved", not both. At most 32 characters of the base64url alphabet.
export function topicFor(tag) {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

// Which severity decides whether a subscriber hears this. A resolution is
// judged by what it resolves: someone who only wanted criticals still wants to
// know the critical went away.
export function effectiveSeverity(message) {
  return message.resolves ? (message.was ?? message.severity) : message.severity;
}

export function wants(sub, message) {
  const min = SEVERITY_RANK[sub.minSeverity] ?? SEVERITY_RANK[DEFAULT_MIN_SEVERITY];
  return (SEVERITY_RANK[effectiveSeverity(message)] ?? 0) >= min;
}

export function buildPayload(message, { openCount } = {}) {
  const payload = {
    title: String(message.title ?? 'Fleet').slice(0, 200),
    body: String(message.body ?? ''),
    severity: message.severity,
    tag: tagFor(message),
    url: '/#/alerts',
    resolved: Boolean(message.resolves),
    ...(Number.isFinite(openCount) ? { open: openCount } : {}),
  };
  let json = JSON.stringify(payload);
  while (Buffer.byteLength(json) > MAX_PLAINTEXT && payload.body.length) {
    payload.body = `${payload.body.slice(0, Math.max(0, payload.body.length - 200))}…`;
    json = JSON.stringify(payload);
  }
  return json;
}

function urgencyFor(message) {
  if (message.resolves) return 'low';
  return { critical: 'high', warning: 'normal' }[message.severity] ?? 'low';
}

// ---- subscription stores ---------------------------------------------------
//
// Same async interface either way; which one is used depends on whether the
// daemon runs alone (SQLite) or as an HA pair (shared PostgreSQL meta), because
// alerts are sent by whichever replica currently leads.

const rowToSub = (r) => ({
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  deviceKey: r.device_key,
  minSeverity: r.min_severity,
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at,
  failures: r.failures,
});

export class SqlitePushStore {
  constructor(db) {
    this.db = db;
    this.q = {
      list: db.prepare('SELECT * FROM push_subscriptions'),
      get: db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?'),
      upsert: db.prepare(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_key, min_severity, created_at, failures)
        VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh = excluded.p256dh, auth = excluded.auth, device_key = excluded.device_key,
          min_severity = excluded.min_severity, failures = 0`),
      remove: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
      removeDevice: db.prepare('DELETE FROM push_subscriptions WHERE device_key = ?'),
      ok: db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?'),
      fail: db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?'),
    };
  }

  async list() { return this.q.list.all().map(rowToSub); }

  async get(endpoint) {
    const r = this.q.get.get(endpoint);
    return r ? rowToSub(r) : null;
  }

  async upsert({ endpoint, p256dh, auth, deviceKey, minSeverity }) {
    this.q.upsert.run(endpoint, p256dh, auth, deviceKey, minSeverity, Date.now());
  }

  async remove(endpoint) { return this.q.remove.run(endpoint).changes > 0; }

  async removeForDevice(deviceKey) { return Number(this.q.removeDevice.run(deviceKey).changes); }

  async markOk(endpoint, now = Date.now()) { this.q.ok.run(now, endpoint); }

  async markFailed(endpoint) {
    this.q.fail.run(endpoint);
    return (await this.get(endpoint))?.failures ?? 0;
  }
}

const PREFIX = 'push.sub.';
const metaKey = (endpoint) => `${PREFIX}${createHash('sha256').update(endpoint).digest('hex').slice(0, 32)}`;

export class SharedPushStore {
  constructor(ha) { this.ha = ha; }

  async list() { return Object.values(await this.ha.listMeta(PREFIX)); }

  async get(endpoint) { return this.ha.getMeta(metaKey(endpoint), null); }

  async upsert({ endpoint, p256dh, auth, deviceKey, minSeverity }) {
    const prior = await this.get(endpoint);
    await this.ha.setMeta(metaKey(endpoint), {
      endpoint, p256dh, auth, deviceKey, minSeverity,
      createdAt: prior?.createdAt ?? Date.now(), lastOkAt: prior?.lastOkAt ?? null, failures: 0,
    });
  }

  async remove(endpoint) {
    const had = Boolean(await this.get(endpoint));
    await this.ha.deleteMeta(metaKey(endpoint));
    return had;
  }

  async removeForDevice(deviceKey) {
    let n = 0;
    for (const s of await this.list()) {
      if (s.deviceKey === deviceKey) { await this.ha.deleteMeta(metaKey(s.endpoint)); n++; }
    }
    return n;
  }

  async markOk(endpoint, now = Date.now()) {
    const s = await this.get(endpoint);
    if (s) await this.ha.setMeta(metaKey(endpoint), { ...s, lastOkAt: now, failures: 0 });
  }

  async markFailed(endpoint) {
    const s = await this.get(endpoint);
    if (!s) return 0;
    const failures = (s.failures ?? 0) + 1;
    await this.ha.setMeta(metaKey(endpoint), { ...s, failures });
    return failures;
  }
}

// ---- the channel -----------------------------------------------------------

export class PushChannel {
  constructor({
    store, getKeys, contact = DEFAULT_CONTACT, log = () => {}, warn = () => {},
    fetchImpl = (...a) => fetch(...a), timeoutMs = 10000, maxFailures = 5,
  }) {
    this.store = store;
    this.getKeys = getKeys;
    this.contact = contact;
    this.log = log;
    this.warn = warn;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxFailures = maxFailures;
  }

  async count() { return (await this.store.list()).length; }

  // Sends one alert message to every subscription that wants it. Never throws
  // for a delivery failure: this runs inside the alert loop, and one dead phone
  // must not stop the others — or the next tick — from hearing anything.
  async send(message, { openCount, only } = {}) {
    // Subscriptions first: with nobody subscribed, the key is never loaded, so a
    // daemon that never uses push never writes a key file.
    let subs = await this.store.list();
    if (only) subs = subs.filter(only);
    else subs = subs.filter((s) => wants(s, message));
    if (!subs.length) return { sent: 0, failed: 0, removed: 0 };
    const keys = await this.getKeys();
    if (!keys) return { sent: 0, failed: 0, removed: 0, skipped: 'no VAPID key yet' };

    const payload = buildPayload(message, { openCount });
    const tag = JSON.parse(payload).tag;
    const results = await Promise.allSettled(subs.map((s) => this.deliver(s, payload, {
      keys, urgency: urgencyFor(message), topic: topicFor(tag), ttl: message.resolves ? 6 * 3600 : 24 * 3600,
    })));

    const out = { sent: 0, failed: 0, removed: 0 };
    for (const [i, r] of results.entries()) {
      const outcome = r.status === 'fulfilled' ? r.value : { kind: 'error', detail: r.reason?.message };
      const sub = subs[i];
      if (outcome.kind === 'ok') {
        out.sent++;
        await this.store.markOk(sub.endpoint).catch(() => {});
        continue;
      }
      out.failed++;
      if (outcome.kind === 'gone') {
        await this.store.remove(sub.endpoint).catch(() => {});
        out.removed++;
        this.log(`push: removed expired subscription (${new URL(sub.endpoint).host})`);
        continue;
      }
      const failures = await this.store.markFailed(sub.endpoint).catch(() => 0);
      this.warn(`push to ${new URL(sub.endpoint).host}: ${outcome.detail}`);
      if (failures >= this.maxFailures) {
        await this.store.remove(sub.endpoint).catch(() => {});
        out.removed++;
        this.log(`push: removed subscription after ${failures} consecutive failures`);
      }
    }
    return out;
  }

  async deliver(sub, payload, { keys, urgency, topic, ttl }) {
    const body = encryptPayload(payload, sub);
    try {
      const res = await this.fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(sub.endpoint, keys, this.contact),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(ttl),
          urgency,
          topic,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404 || res.status === 410) return { kind: 'gone' };
      if (res.ok) return { kind: 'ok' };
      const text = await res.text().catch(() => '');
      return { kind: 'error', detail: `${res.status} ${text.slice(0, 160)}`.trim() };
    } catch (err) {
      return { kind: 'error', detail: err.name === 'TimeoutError' ? `no answer within ${this.timeoutMs}ms` : err.message };
    }
  }
}
