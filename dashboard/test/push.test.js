// Web push is the one alert channel whose failures happen on somebody else's
// server, out of sight: a wrong byte in the encryption and every phone silently
// drops the message; a bad VAPID claim and Apple answers 403 to every push. So
// the crypto is pinned to the RFC's own worked example rather than to itself.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createECDH, createDecipheriv, hkdfSync, randomBytes, verify,
} from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { Alerts } from '../lib/alerts.js';
import {
  encryptPayload, vapidAuthorization, vapidPublicKeyObject, generateVapidKeys, loadOrCreateVapidFile,
  pushEndpointError, allowedPushHosts, parseSubscription, contactError, PushChannel, SqlitePushStore,
  buildPayload, wants, topicFor, tagFor, b64url, fromB64url, DEFAULT_CONTACT,
} from '../lib/push.js';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'fleet-push-'));
  dirs.push(d);
  return d;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// A browser's side of a subscription: its key pair and auth secret, plus the
// decryption it would perform on receipt.
function fakeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint,
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const idlen = body[20];
      const asPublic = body.subarray(21, 21 + idlen);
      const ciphertext = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ciphertext.subarray(-16));
      const plain = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
      assert.equal(plain.at(-1), 0x02, 'the only record must carry the last-record delimiter');
      return plain.subarray(0, -1).toString();
    },
  };
}

describe('RFC 8291 message encryption', () => {
  test('reproduces the RFC 8291 section 5 worked example byte for byte', () => {
    const out = encryptPayload('When I grow up, I want to be a watermelon', {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    }, {
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    });
    assert.equal(b64url(out),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_'
      + 'yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  test('a fresh message round-trips through the receiving side', () => {
    const browser = fakeBrowser();
    const text = JSON.stringify({ title: 'Runner service is dead', body: 'example-ios · exit 1' });
    assert.equal(browser.decrypt(encryptPayload(text, browser.keys)), text);
  });

  test('every message uses a new salt and sender key', () => {
    const { keys } = fakeBrowser();
    const a = encryptPayload('same', keys);
    const b = encryptPayload('same', keys);
    assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
    assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86));
  });
});

describe('RFC 8292 VAPID', () => {
  const keys = generateVapidKeys();
  const endpoint = 'https://web.push.apple.com/QHl8abc/def?x=1';
  const header = vapidAuthorization(endpoint, keys, DEFAULT_CONTACT, Date.UTC(2026, 8, 24));
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, c, s] = jwt.split('.');

  test('the JWT verifies against the advertised public key', () => {
    assert.equal(k, keys.publicKey);
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), {
      key: vapidPublicKeyObject(keys), dsaEncoding: 'ieee-p1363',
    }, fromB64url(s)));
  });

  // These three claims are what Apple rejects with BadJwtToken.
  test('aud is the endpoint origin only, exp is within 24 hours, sub is the contact', () => {
    const claims = JSON.parse(fromB64url(c).toString());
    assert.equal(claims.aud, 'https://web.push.apple.com');
    const ttl = claims.exp - Date.UTC(2026, 8, 24) / 1000;
    assert.ok(ttl > 0 && ttl <= 24 * 3600, `exp is ${ttl}s out`);
    assert.equal(claims.sub, DEFAULT_CONTACT);
    assert.deepEqual(JSON.parse(fromB64url(h).toString()), { typ: 'JWT', alg: 'ES256' });
  });

  test('the public key is an uncompressed P-256 point', () => {
    const raw = fromB64url(keys.publicKey);
    assert.equal(raw.length, 65);
    assert.equal(raw[0], 0x04);
  });

  test('contacts Apple would reject are refused', () => {
    assert.equal(contactError(DEFAULT_CONTACT), null);
    assert.equal(contactError('mailto:ops@example.com'), null);
    assert.match(contactError('mailto:fleet@localhost'), /real domain/);
    assert.match(contactError('mailto:fleet@my-mac.local'), /real domain/);
    assert.match(contactError('https://localhost/x'), /localhost/);
    assert.match(contactError('ops@example.com'), /URL/);
  });
});

describe('VAPID key file', () => {
  test('is created 0600 and reused on the next start', () => {
    const path = join(tempDir(), '.fleet-vapid.json');
    const first = loadOrCreateVapidFile(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadOrCreateVapidFile(path).publicKey, first.publicKey);
    assert.ok(JSON.parse(readFileSync(path, 'utf8')).jwk.d);
  });
});

describe('endpoint allowlist', () => {
  const hosts = allowedPushHosts();

  test('accepts the real push services', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QH/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-by3p.notify.windows.com/w/?token=abc',
    ]) assert.equal(pushEndpointError(e, hosts), null, e);
  });

  // The daemon POSTs to whatever it is given. Without this, a paired device
  // could point it at the LAN or at the metadata service.
  test('refuses anything that is not a known push service over https', () => {
    for (const [e, why] of [
      ['http://fcm.googleapis.com/fcm/send/abc', /https/],
      ['https://127.0.0.1/abc', /not a known push service/],
      ['https://169.254.169.254/latest', /not a known push service/],
      ['https://evil.example/abc', /not a known push service/],
      ['https://notify.windows.com.evil.example/abc', /not a known push service/],
      ['https://fcm.googleapis.com:8443/abc', /default port/],
      ['https://user:pw@fcm.googleapis.com/abc', /credentials/],
      ['not a url', /not a URL/],
    ]) assert.match(pushEndpointError(e, hosts), why, e);
  });

  test('FLEET_PUSH_ALLOWED_HOSTS extends the list', () => {
    assert.equal(pushEndpointError('https://push.example.org/x', allowedPushHosts('push.example.org')), null);
  });

  test('subscription keys are validated', () => {
    const { endpoint, keys } = fakeBrowser();
    assert.ok(parseSubscription({ endpoint, keys }, hosts).sub);
    assert.match(parseSubscription({ endpoint, keys: { ...keys, auth: 'AAAA' } }, hosts).error, /16 bytes/);
    assert.match(parseSubscription({ endpoint, keys: { ...keys, p256dh: 'AAAA' } }, hosts).error, /P-256/);
  });
});

describe('message shaping', () => {
  test('a resolution shares its alert tag, so it replaces that notification', () => {
    const opened = { severity: 'critical', title: 'Runner service is dead: a', scope: 'drift:launchd-dead:a' };
    const resolved = { severity: 'info', title: 'Resolved: …', scope: 'drift:launchd-dead:a', resolves: true, was: 'critical' };
    assert.equal(tagFor(opened), tagFor(resolved));
    assert.ok(topicFor(tagFor(opened)).length <= 32);
    assert.match(topicFor(tagFor(opened)), /^[A-Za-z0-9_-]+$/);
  });

  test('severity filtering judges a resolution by what it resolved', () => {
    const criticalOnly = { minSeverity: 'critical' };
    assert.equal(wants(criticalOnly, { severity: 'warning' }), false);
    assert.equal(wants(criticalOnly, { severity: 'critical' }), true);
    assert.equal(wants(criticalOnly, { severity: 'info', resolves: true, was: 'critical' }), true);
    assert.equal(wants(criticalOnly, { severity: 'info', resolves: true, was: 'warning' }), false);
  });

  test('a long body is trimmed to fit one 4 KB record', () => {
    const json = buildPayload({ severity: 'warning', title: 't', body: 'x'.repeat(20000) }, { openCount: 3 });
    assert.ok(Buffer.byteLength(json) <= 3000);
    assert.equal(JSON.parse(json).open, 3);
  });
});

describe('PushChannel delivery', () => {
  let db;
  let store;
  let calls;
  const keys = generateVapidKeys();

  beforeEach(() => {
    db = openDb(join(tempDir(), 'test.db'));
    store = new SqlitePushStore(db);
    calls = [];
  });

  const channel = (respond, extra = {}) => new PushChannel({
    store,
    getKeys: async () => keys,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
    ...extra,
  });
  const reply = (status, text = '') => ({ status, ok: status >= 200 && status < 300, text: async () => text });

  async function subscribe(minSeverity = 'warning', deviceKey = 'dev1') {
    const b = fakeBrowser();
    await store.upsert({ endpoint: b.endpoint, ...b.keys, deviceKey, minSeverity });
    return b;
  }

  test('sends an encrypted, signed message the browser can read', async () => {
    const b = await subscribe();
    const out = await channel(() => reply(201)).send(
      { severity: 'critical', title: 'Runner service is dead: a', body: 'exit 1', scope: 'drift:launchd-dead:a' },
      { openCount: 2 });
    assert.deepEqual(out, { sent: 1, failed: 0, removed: 0 });
    const { init } = calls[0];
    assert.equal(init.headers['content-encoding'], 'aes128gcm');
    assert.equal(init.headers.urgency, 'high');
    assert.match(init.headers.authorization, /^vapid t=.+, k=/);
    const payload = JSON.parse(b.decrypt(init.body));
    assert.equal(payload.title, 'Runner service is dead: a');
    assert.equal(payload.open, 2);
    assert.equal(payload.tag, 'alert:drift:launchd-dead:a');
    assert.ok((await store.get(b.endpoint)).lastOkAt);
  });

  test('only subscriptions that want the severity are contacted', async () => {
    await subscribe('critical');
    await subscribe('info');
    await channel(() => reply(201)).send({ severity: 'warning', title: 'w', body: '' });
    assert.equal(calls.length, 1);
  });

  test('410 Gone removes the subscription immediately', async () => {
    const b = await subscribe();
    const out = await channel(() => reply(410)).send({ severity: 'critical', title: 'c', body: '' });
    assert.equal(out.removed, 1);
    assert.equal(await store.get(b.endpoint), null);
  });

  test('other failures are counted, and five in a row remove it', async () => {
    const b = await subscribe();
    const ch = channel(() => reply(500, 'boom'));
    for (let i = 1; i <= 4; i++) {
      await ch.send({ severity: 'critical', title: 'c', body: '' });
      assert.equal((await store.get(b.endpoint)).failures, i);
    }
    await ch.send({ severity: 'critical', title: 'c', body: '' });
    assert.equal(await store.get(b.endpoint), null);
  });

  test('a success resets the failure count', async () => {
    const b = await subscribe();
    let status = 500;
    const ch = channel(() => reply(status));
    await ch.send({ severity: 'critical', title: 'c', body: '' });
    status = 201;
    await ch.send({ severity: 'critical', title: 'c', body: '' });
    assert.equal((await store.get(b.endpoint)).failures, 0);
  });

  // notify() is awaited from the alert loop. A push service that accepts the
  // connection and never answers must cost one timeout, not the loop.
  test('a hung push service cannot stall delivery past the timeout', async () => {
    await subscribe();
    await subscribe();
    const hang = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    });
    // AbortSignal.timeout's timer is unref'd; in the daemon the server holds the
    // event loop open, here nothing would.
    const holdOpen = setTimeout(() => {}, 5000);
    const started = Date.now();
    const out = await channel(hang, { timeoutMs: 150 }).send({ severity: 'critical', title: 'c', body: '' });
    clearTimeout(holdOpen);
    assert.ok(Date.now() - started < 1500, 'both deliveries time out in parallel');
    assert.equal(out.failed, 2);
  });

  test('with nobody subscribed the key is never loaded', async () => {
    let loaded = false;
    const ch = new PushChannel({ store, getKeys: async () => { loaded = true; return keys; } });
    await ch.send({ severity: 'critical', title: 'c', body: '' });
    assert.equal(loaded, false);
  });

  test('revoking a device removes only its subscriptions', async () => {
    await subscribe('warning', 'phone');
    await subscribe('warning', 'phone');
    const other = await subscribe('warning', 'laptop');
    assert.equal(await store.removeForDevice('phone'), 2);
    assert.deepEqual((await store.list()).map((s) => s.endpoint), [other.endpoint]);
  });
});

describe('Alerts → push', () => {
  test('opened and resolved alerts reach the push channel with a shared scope', async () => {
    const db = openDb(join(tempDir(), 'test.db'));
    const sent = [];
    const push = { send: async (m, opts) => { sent.push({ m, opts }); }, count: async () => 1 };
    const alerts = new Alerts({ db, config: { macos: false, webhook: null, stormThreshold: 5 }, log: () => {}, warn: () => {}, push });

    await alerts.run({ drift: [{ kind: 'launchd-dead', subject: 'runner-a', detail: 'dead' }] });
    await alerts.run({ drift: [] });

    assert.equal(sent.length, 2);
    const [opened, resolved] = sent.map((s) => s.m);
    assert.equal(opened.severity, 'critical');
    assert.equal(resolved.resolves, true);
    assert.equal(resolved.was, 'critical');
    assert.equal(opened.scope, resolved.scope);
    assert.equal(sent[0].opts.openCount, 1);
    assert.equal(alerts.snapshot().channels.push, 1);
  });

  test('"push": false in the config turns the channel off', () => {
    const db = openDb(join(tempDir(), 'test.db'));
    const alerts = new Alerts({
      db, config: { macos: false, webhook: null, push: false }, log: () => {}, warn: () => {},
      push: { send: async () => { throw new Error('must not send'); }, count: async () => 0 },
    });
    assert.equal(alerts.push, null);
    assert.equal(alerts.snapshot().channels.push, false);
  });
});
