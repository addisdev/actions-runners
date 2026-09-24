// Unit tests for lib/devices.js
//
// Tests pairing code generation, single-use enforcement, expiry, rate limiting,
// token storage/validation, and revocation.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createPairingCode,
  exchangeCode,
  deviceTokenMatches,
  listDevices,
  revokeDevice,
  resetPairingState,
  PAIRING_CODE_TTL_MS,
} from '../lib/devices.js';

beforeEach(() => resetPairingState());

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'devices-test-'));
  const path = join(dir, '.fleet-device-tokens.json');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('createPairingCode', () => {
  test('returns a 6-digit string', () => {
    const code = createPairingCode();
    assert.match(code, /^\d{6}$/);
  });

  test('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 20 }, createPairingCode));
    assert.ok(codes.size >= 10, 'should have some variety');
  });
});

describe('exchangeCode', () => {
  test('exchanges a valid code for a token', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      const result = exchangeCode(path, code, 'my-phone', '127.0.0.1');
      assert.equal(typeof result.token, 'string');
      assert.ok(result.token.length >= 32);
      assert.equal(result.name, 'my-phone');
    } finally { cleanup(); }
  });

  test('code is single-use', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      const first = exchangeCode(path, code, 'phone', '127.0.0.1');
      assert.ok(first.token);
      const second = exchangeCode(path, code, 'phone', '127.0.0.1');
      assert.ok(second.error, 'second use should fail');
    } finally { cleanup(); }
  });

  test('rejects invalid code', () => {
    const { path, cleanup } = tmpStore();
    try {
      const result = exchangeCode(path, '000000', 'phone', '127.0.0.1');
      assert.ok(result.error);
    } finally { cleanup(); }
  });

  test('rate limits after 5 failures per IP', () => {
    const { path, cleanup } = tmpStore();
    try {
      // 5 bad attempts
      for (let i = 0; i < 5; i++) {
        exchangeCode(path, '000000', 'phone', '10.0.0.1');
      }
      // 6th attempt should be rate-limited
      const result = exchangeCode(path, '000000', 'phone', '10.0.0.1');
      assert.match(result.error, /too many/i);
    } finally { cleanup(); }
  });

  test('rate limit does not affect different IPs', () => {
    const { path, cleanup } = tmpStore();
    try {
      // Saturate IP A
      for (let i = 0; i < 5; i++) {
        exchangeCode(path, '000000', 'phone', '10.0.0.2');
      }
      // IP B should still get "invalid code", not "too many"
      const result = exchangeCode(path, '000000', 'phone', '10.0.0.3');
      assert.match(result.error, /invalid/i);
    } finally { cleanup(); }
  });

  test('flags rate-limited refusals so the route can answer 429', () => {
    const { path, cleanup } = tmpStore();
    try {
      for (let i = 0; i < 5; i++) exchangeCode(path, '000000', 'phone', '10.0.0.9');
      assert.equal(exchangeCode(path, '000000', 'phone', '10.0.0.9').rateLimited, true);
    } finally { cleanup(); }
  });

  test('guessing spread across many addresses burns every pending code', () => {
    // Behind Tailscale Serve every client shares one address, and on a LAN an
    // attacker can rotate addresses, so the per-client limit is not enough.
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      for (let i = 0; i < 20; i++) exchangeCode(path, '000000', 'phone', `10.1.0.${i}`);
      const late = exchangeCode(path, code, 'phone', '10.2.0.1');
      assert.ok(late.error, 'a code issued before the flood must not survive it');
      assert.equal(late.rateLimited, true);
    } finally { cleanup(); }
  });

  test('accepts a code typed with a space or dash', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      const result = exchangeCode(path, `${code.slice(0, 3)} ${code.slice(3)}`, 'phone', '127.0.0.1');
      assert.ok(result.token, JSON.stringify(result));
    } finally { cleanup(); }
  });

  test('two devices with the same name both stay paired', () => {
    // Two identical phones send identical default names; the second pairing
    // must not silently revoke the first.
    const { path, cleanup } = tmpStore();
    try {
      const a = exchangeCode(path, createPairingCode(), 'iPhone · Safari', '127.0.0.1');
      const b = exchangeCode(path, createPairingCode(), 'iPhone · Safari', '127.0.0.1');
      assert.equal(deviceTokenMatches(path, a.token), true);
      assert.equal(deviceTokenMatches(path, b.token), true);
      const names = listDevices(path).map((d) => d.name).sort();
      assert.deepEqual(names, ['iPhone · Safari', 'iPhone · Safari (2)']);
    } finally { cleanup(); }
  });

  test('strips markup from device names', () => {
    const { path, cleanup } = tmpStore();
    try {
      const r = exchangeCode(path, createPairingCode(), '<img src=x onerror=alert(1)>', '127.0.0.1');
      assert.doesNotMatch(r.name, /[<>]/);
    } finally { cleanup(); }
  });

  test('the token store is written owner-only', () => {
    const { path, cleanup } = tmpStore();
    try {
      exchangeCode(path, createPairingCode(), 'phone', '127.0.0.1');
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally { cleanup(); }
  });

  test('codes live for the advertised five minutes', () => {
    assert.equal(PAIRING_CODE_TTL_MS, 5 * 60 * 1000);
  });
});

describe('deviceTokenMatches', () => {
  test('matches a just-issued token', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      const { token } = exchangeCode(path, code, 'test-device', '127.0.0.1');
      assert.equal(deviceTokenMatches(path, token), true);
    } finally { cleanup(); }
  });

  test('does not match a wrong token', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      exchangeCode(path, code, 'device', '127.0.0.1');
      assert.equal(deviceTokenMatches(path, 'x'.repeat(64)), false);
    } finally { cleanup(); }
  });

  test('returns false when store is empty', () => {
    const { path, cleanup } = tmpStore();
    try {
      assert.equal(deviceTokenMatches(path, 'a'.repeat(64)), false);
    } finally { cleanup(); }
  });
});

describe('listDevices', () => {
  test('lists paired devices', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      exchangeCode(path, code, 'iphone', '127.0.0.1');
      const devices = listDevices(path);
      assert.equal(devices.length, 1);
      assert.equal(devices[0].name, 'iphone');
      assert.ok(devices[0].key);
      assert.ok(devices[0].createdAt);
    } finally { cleanup(); }
  });

  test('returns empty array when no devices', () => {
    const { path, cleanup } = tmpStore();
    try {
      assert.deepEqual(listDevices(path), []);
    } finally { cleanup(); }
  });
});

describe('revokeDevice', () => {
  test('revokes an existing device', () => {
    const { path, cleanup } = tmpStore();
    try {
      const code = createPairingCode();
      const { token } = exchangeCode(path, code, 'laptop', '127.0.0.1');
      const [device] = listDevices(path);
      assert.equal(revokeDevice(path, device.key), true);
      // Token should no longer match
      assert.equal(deviceTokenMatches(path, token), false);
    } finally { cleanup(); }
  });

  test('returns false for unknown key', () => {
    const { path, cleanup } = tmpStore();
    try {
      assert.equal(revokeDevice(path, 'nonexistent'), false);
    } finally { cleanup(); }
  });
});
