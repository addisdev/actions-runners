import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autonomyStep, AUTONOMY_DEFAULT_MS } from '../lib/agent-autonomy.js';

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const runners = [
  { dirName: 'app-web', drainState: 'drained', drainBy: 'tiers' },
  { dirName: 'app-web-2', drainState: 'draining', drainBy: 'tiers' },
  { dirName: 'app-api', drainState: 'drained', drainBy: null },
  { dirName: 'app-ios', drainState: null, drainBy: null },
];

describe('agent autonomy rule', () => {
  test('defaults to three minutes', () => {
    assert.equal(AUTONOMY_DEFAULT_MS, 180_000);
  });

  test('does nothing while heartbeats are recent', () => {
    const s = autonomyStep({ now: NOW, lastOkAt: NOW - 179_000, runners });
    assert.equal(s.autonomous, false);
    assert.deepEqual(s.release, []);
  });

  test('after three minutes of silence resumes only the controller\'s drains', () => {
    const s = autonomyStep({ now: NOW, lastOkAt: NOW - 180_000, runners });
    assert.equal(s.autonomous, true);
    assert.equal(s.entered, true);
    assert.deepEqual(s.release, ['app-web', 'app-web-2']);
  });

  test('stays autonomous without re-announcing, and keeps releasing new ones', () => {
    const s = autonomyStep({ now: NOW, lastOkAt: NOW - 600_000, autonomous: true, runners: runners.slice(1) });
    assert.equal(s.entered, false);
    assert.deepEqual(s.release, ['app-web-2']);
  });

  test('a successful heartbeat hands control back to the controller', () => {
    const s = autonomyStep({ now: NOW, lastOkAt: NOW, autonomous: true, runners });
    assert.equal(s.autonomous, false);
    assert.equal(s.left, true);
    assert.deepEqual(s.release, []);
  });

  test('0 disables the rule', () => {
    const s = autonomyStep({ now: NOW, lastOkAt: NOW - 3_600_000, afterMs: 0, runners });
    assert.equal(s.autonomous, false);
    assert.deepEqual(s.release, []);
  });
});
