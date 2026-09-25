import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dirs = [];
let statePath;
let bridge;
const originalFetch = globalThis.fetch;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  dirs.push(dir);
  statePath = join(dir, 'state.json');
  process.env.AUTOFIX_STATE = statePath;
  bridge = await import('../autofix/bridge.js');
});

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  delete process.env.AUTOFIX_STATE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fleetActionable', () => {
  test('allows action when health is ok and fresh', () => {
    assert.equal(bridge.fleetActionable({ ok: true, stale: false }), true);
  });

  test('blocks action when collector is stale', () => {
    assert.equal(bridge.fleetActionable({ ok: false, stale: true }), false);
    assert.equal(bridge.fleetActionable({ ok: true, stale: true }), false);
  });

  test('blocks action when health reports not ok', () => {
    assert.equal(bridge.fleetActionable({ ok: false, stale: false }), false);
  });
});

describe('recordFleetStale', () => {
  test('records a durable skip state with since preserved across checks', () => {
    const state = {};
    bridge.recordFleetStale(state, { ok: false, stale: true, ageMs: 120_000, lastError: 'collector stalled' }, 1000);
    bridge.recordFleetStale(state, { ok: false, stale: true, ageMs: 180_000, lastError: 'collector stalled' }, 2000);

    assert.equal(state.__fleetStale.since, 1000);
    assert.equal(state.__fleetStale.lastChecked, 2000);
    assert.equal(state.__fleetStale.stale, true);
    assert.equal(state.__fleetStale.lastError, 'collector stalled');
  });
});

describe('saveState', () => {
  test('writes parseable JSON and leaves no temp files behind', () => {
    bridge.saveState({ tracked: 'value' });
    assert.deepEqual(bridge.loadState(), { tracked: 'value' });
    const files = readdirSync(join(statePath, '..'));
    assert.ok(!files.some((f) => f.includes('.tmp')), 'no temp files left behind');
  });
});

describe('reconcile — fleet health gate', () => {
  beforeEach(() => {
    bridge.replaceState({});
    bridge.saveState({});
  });

  test('skips remediation actions when fleet health is stale', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/health')) {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            stale: true,
            ageMs: 390_000,
            lastError: 'collector stalled — no completed tick for 390s',
          }),
        };
      }
      throw new Error(`unexpected fetch during stale skip: ${url}`);
    };

    await bridge.reconcile('test-stale');

    assert.equal(calls.length, 1, 'only health is fetched');
    assert.ok(calls[0].includes('/api/health'));
    const saved = bridge.loadState();
    assert.ok(saved.__fleetStale, 'stale skip state is recorded');
    assert.equal(saved.__fleetStale.stale, true);
    assert.match(saved.__fleetStale.lastError, /collector stalled/);
  });

  test('clears stale skip state once health is actionable again', async () => {
    bridge.replaceState({
      __fleetStale: {
        since: Date.now() - 60_000,
        lastChecked: Date.now() - 60_000,
        ok: false,
        stale: true,
        lastError: 'collector stalled',
      },
    });

    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ ok: true, stale: false, ageMs: 1000 }) };
      }
      if (String(url).includes('/api/alerts')) {
        return { ok: true, json: async () => ({ open: [] }) };
      }
      if (String(url).includes('/api/remediation-candidates')) {
        return { ok: true, json: async () => ([]) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await bridge.reconcile('test-recovered');

    const saved = bridge.loadState();
    assert.equal(saved.__fleetStale, undefined, 'stale marker cleared after recovery');
  });
});
