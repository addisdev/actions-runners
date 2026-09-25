// Unit tests for lib/remote.js
//
// Tests the host allowlist, proxy detection, origin derivation, and the
// isLocalRequest behaviour that determines whether alert-dismiss needs a token.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

// We test the module directly.  Some functions read live network state (hostname,
// interfaces), so the tests are written to be tolerant of the actual machine.
import {
  initAllowedHosts,
  isAllowedHost,
  checkHost,
  isProxied,
  isLocalRequest,
  requestOrigin,
  sameOrigin,
  serveTargetsPort,
  isTailnetAddress,
  viewerContext,
  reachableUrls,
  pairingUrl,
} from '../lib/remote.js';

before(() => {
  initAllowedHosts([]);
});

// Helper: build a minimal fake request
function fakeReq({ host, remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    headers: { host, ...headers },
    socket: { remoteAddress },
  };
}

describe('isAllowedHost', () => {
  test('allows localhost', () => {
    assert.equal(isAllowedHost('localhost'), true);
  });

  test('allows 127.0.0.1', () => {
    assert.equal(isAllowedHost('127.0.0.1'), true);
  });

  test('allows machine hostname', () => {
    const hn = os.hostname().replace(/\.local$/, '');
    assert.equal(isAllowedHost(hn), true);
  });

  test('allows .local form of hostname', () => {
    const hn = os.hostname();
    const local = hn.endsWith('.local') ? hn : `${hn}.local`;
    assert.equal(isAllowedHost(local), true);
  });

  test('strips port before checking', () => {
    assert.equal(isAllowedHost('localhost:7878'), true);
  });

  test('rejects arbitrary external host', () => {
    assert.equal(isAllowedHost('evil.example.com'), false);
  });

  test('allows extra hosts passed to initAllowedHosts', () => {
    initAllowedHosts(['custom-host.example.com']);
    assert.equal(isAllowedHost('custom-host.example.com'), true);
    // reset
    initAllowedHosts([]);
  });
});

describe('checkHost', () => {
  test('returns ok for localhost', () => {
    const req = fakeReq({ host: 'localhost:7878' });
    assert.deepEqual(checkHost(req), { ok: true });
  });

  test('returns 421 for unknown host', () => {
    const req = fakeReq({ host: 'attacker.example.com' });
    const result = checkHost(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 421);
  });

  test('returns 421 when Host header is missing', () => {
    const req = fakeReq({ host: undefined });
    const result = checkHost(req);
    assert.equal(result.ok, false);
  });
});

describe('isProxied', () => {
  test('not proxied: direct loopback without forwarding headers', () => {
    const req = fakeReq({ host: 'localhost', remoteAddress: '127.0.0.1' });
    assert.equal(isProxied(req), false);
  });

  test('proxied: loopback with X-Forwarded-For', () => {
    const req = fakeReq({
      host: 'localhost',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '100.64.0.1' },
    });
    assert.equal(isProxied(req), true);
  });

  test('proxied: loopback with Tailscale header', () => {
    const req = fakeReq({
      host: 'mac.tail1234.ts.net',
      remoteAddress: '127.0.0.1',
      headers: { 'tailscale-user-login': 'user@example.com' },
    });
    assert.equal(isProxied(req), true);
  });

  test('not proxied: LAN address without forwarding headers', () => {
    const req = fakeReq({ host: '192.168.1.5', remoteAddress: '192.168.1.99' });
    assert.equal(isProxied(req), false);
  });
});

describe('isLocalRequest', () => {
  test('local: direct loopback without proxy headers', () => {
    const req = fakeReq({ host: 'localhost', remoteAddress: '127.0.0.1' });
    assert.equal(isLocalRequest(req), true);
  });

  test('not local: proxied loopback (Tailscale)', () => {
    const req = fakeReq({
      host: 'mac.tail1234.ts.net',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '100.64.0.1' },
    });
    assert.equal(isLocalRequest(req), false);
  });

  test('not local: LAN address', () => {
    const req = fakeReq({ host: '192.168.1.5', remoteAddress: '192.168.1.99' });
    assert.equal(isLocalRequest(req), false);
  });

  test('not local: ::1 with proxy header', () => {
    const req = fakeReq({
      host: 'localhost',
      remoteAddress: '::1',
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(isLocalRequest(req), false);
  });
});

describe('requestOrigin', () => {
  test('returns http://host:port for direct LAN request', () => {
    const req = fakeReq({ host: 'mac.local:7878', remoteAddress: '192.168.1.99' });
    assert.equal(requestOrigin(req, { port: 7878 }), 'http://mac.local:7878');
  });

  test('returns https origin for proxied request', () => {
    const req = fakeReq({
      host: 'mac.tail1234.ts.net',
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-for': '100.64.0.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'mac.tail1234.ts.net',
      },
    });
    assert.equal(requestOrigin(req, { port: 7878 }), 'https://mac.tail1234.ts.net');
  });

  test('falls back to http for loopback without proxy headers', () => {
    const req = fakeReq({ host: 'localhost:7878', remoteAddress: '127.0.0.1' });
    assert.equal(requestOrigin(req, { port: 7878 }), 'http://localhost:7878');
  });
});

describe('sameOrigin', () => {
  test('passes when no Origin header is set', () => {
    const req = fakeReq({ host: 'localhost:7878', remoteAddress: '127.0.0.1' });
    assert.deepEqual(sameOrigin(req, { port: 7878, host: '127.0.0.1' }), { ok: true });
  });

  test('passes when Origin matches derived origin', () => {
    const req = fakeReq({
      host: 'localhost:7878',
      remoteAddress: '192.168.1.99',
      headers: { origin: 'http://localhost:7878' },
    });
    const result = sameOrigin(req, { port: 7878, host: '0.0.0.0' });
    assert.equal(result.ok, true);
  });

  test('rejects unknown Origin', () => {
    const req = fakeReq({
      host: 'localhost:7878',
      remoteAddress: '192.168.1.99',
      headers: { origin: 'http://evil.example.com:7878' },
    });
    const result = sameOrigin(req, { port: 7878, host: '0.0.0.0' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });

  test('accepts the https origin of a Tailscale Serve request', () => {
    initAllowedHosts(['mac.tail1234.ts.net']);
    try {
      const req = fakeReq({
        host: 'mac.tail1234.ts.net',
        remoteAddress: '127.0.0.1',
        headers: {
          'x-forwarded-for': '100.101.102.103',
          'x-forwarded-proto': 'https',
          origin: 'https://mac.tail1234.ts.net',
        },
      });
      assert.equal(sameOrigin(req, { port: 7878 }).ok, true);
    } finally { initAllowedHosts([]); }
  });

  test('ignores forwarding headers from a non-loopback peer', () => {
    // A LAN client claiming to be behind an https proxy must not get its
    // spoofed https origin accepted.
    const req = fakeReq({
      host: 'localhost:7878',
      remoteAddress: '192.168.1.99',
      headers: { 'x-forwarded-proto': 'https', origin: 'https://localhost' },
    });
    assert.equal(sameOrigin(req, { port: 7878 }).ok, false);
  });
});

describe('serveTargetsPort', () => {
  const serve = (proxy) => ({ Web: { 'mac.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } });

  test('detects a Serve handler proxying to our port', () => {
    assert.equal(serveTargetsPort(serve('http://127.0.0.1:7878'), 7878), true);
    assert.equal(serveTargetsPort(serve('http://localhost:7878/'), 7878), true);
  });

  test('ignores handlers for other ports and empty config', () => {
    assert.equal(serveTargetsPort(serve('http://127.0.0.1:3000'), 7878), false);
    assert.equal(serveTargetsPort(serve('http://127.0.0.1:78780'), 7878), false);
    assert.equal(serveTargetsPort({}, 7878), false);
    assert.equal(serveTargetsPort(null, 7878), false);
  });
});

describe('isTailnetAddress', () => {
  test('recognises the CGNAT range Tailscale uses', () => {
    assert.equal(isTailnetAddress('100.64.0.1'), true);
    assert.equal(isTailnetAddress('100.127.255.254'), true);
    assert.equal(isTailnetAddress('::ffff:100.100.1.2'), true);
    assert.equal(isTailnetAddress('fd7a:115c:a1e0::1'), true);
  });

  test('rejects neighbours of the range and ordinary LAN addresses', () => {
    assert.equal(isTailnetAddress('100.63.255.255'), false);
    assert.equal(isTailnetAddress('100.128.0.1'), false);
    assert.equal(isTailnetAddress('192.168.1.10'), false);
    assert.equal(isTailnetAddress(''), false);
    assert.equal(isTailnetAddress(undefined), false);
  });
});

describe('viewerContext', () => {
  test('local for a direct loopback request', () => {
    assert.equal(viewerContext(fakeReq({ host: 'localhost' })).via, 'local');
  });

  test('tailscale for a Serve-proxied request, with the user', () => {
    const ctx = viewerContext(fakeReq({
      host: 'mac.tail1234.ts.net',
      headers: { 'x-forwarded-for': '100.64.1.2', 'tailscale-user-login': 'me@example.com' },
    }));
    assert.equal(ctx.via, 'tailscale');
    assert.equal(ctx.tailscaleUser, 'me@example.com');
  });

  test('a LAN client cannot claim a Tailscale identity by header', () => {
    const ctx = viewerContext(fakeReq({
      host: '192.168.1.5',
      remoteAddress: '192.168.1.99',
      headers: { 'tailscale-user-login': 'boss@example.com' },
    }));
    assert.equal(ctx.via, 'lan');
    assert.equal(ctx.tailscaleUser, null);
  });
});

describe('reachableUrls', () => {
  test('a loopback bind lists no LAN addresses', () => {
    const urls = reachableUrls(7878, { bindHost: '127.0.0.1' });
    assert.ok(urls.every((u) => u.kind !== 'lan'), JSON.stringify(urls));
  });

  test('entries carry kind, label and url', () => {
    for (const u of reachableUrls(7878, { bindHost: '0.0.0.0' })) {
      assert.equal(typeof u.kind, 'string');
      assert.equal(typeof u.label, 'string');
      assert.match(u.url, /^https?:\/\//);
    }
  });
});

describe('pairingUrl', () => {
  test('uses the address the requester is already on when it is remote-reachable', () => {
    initAllowedHosts(['mac.tail1234.ts.net']);
    try {
      const req = fakeReq({
        host: 'mac.tail1234.ts.net',
        headers: { 'x-forwarded-for': '100.64.1.2', 'x-forwarded-proto': 'https' },
      });
      const out = pairingUrl(req, { port: 7878, bindHost: '127.0.0.1' });
      assert.equal(out.url, 'https://mac.tail1234.ts.net');
      assert.equal(out.warning, null);
    } finally { initAllowedHosts([]); }
  });

  test('warns instead of offering a localhost link another device cannot open', () => {
    const out = pairingUrl(fakeReq({ host: 'localhost:7878' }), { port: 7878, bindHost: '127.0.0.1' });
    // Tailscale Serve may genuinely be configured on the test machine; only a
    // localhost-only answer must carry the warning.
    if (/localhost|127\.0\.0\.1/.test(out.url)) assert.match(out.warning, /only reachable from this machine/);
    else assert.equal(out.warning, null);
  });
});
