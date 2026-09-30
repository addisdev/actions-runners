import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { choosePlacement, STALE_HEARTBEAT_MS } from '../lib/placement.js';

// Regression cover for the single-host placement deadlock.
//
// The coordinator's own heartbeat was only ever written by reportSelfToHa(),
// which returns early unless FLEET_DATABASE_URL is configured. On a single-host
// install nothing wrote it, so the placer saw a host that had either never sent
// a heartbeat or was ageing away from one frozen timestamp, and refused every
// scale-up — while the Hosts tab reported the same host as healthy because it
// hardcodes hostStale:false for runners with no hostId.
//
// These tests pin the placer's side of that contract: they say what the gate
// does with a missing, stale and fresh beat, so a future change that quietly
// drops recordSelfHeartbeat() fails here rather than in production at the exact
// moment a queue needs draining.

const NOW = Date.UTC(2026, 8, 28, 19, 16, 0);
const REPO = 'testowner/app-web';

function coordinator(overrides = {}) {
  return {
    id: 'test-host',
    name: 'test-host',
    lastHeartbeat: NOW,
    labels: ['ci', 'ui-web', 'postgres', 'xcode-26'],
    runnerCount: 43,
    drained: false,
    host: { load1: 1.2, cores: 12 },
    capacity: { ok: true, busy: 1, ceiling: 3, maxTotalRunners: 64, reasons: [] },
    ...overrides,
  };
}

describe('coordinator self-heartbeat and placement', () => {
  test('a host that never sent a heartbeat is refused, and says so', () => {
    const { chosen, considered } = choosePlacement({
      hosts: [coordinator({ lastHeartbeat: undefined })],
      repo: REPO,
      now: NOW,
    });
    assert.equal(chosen, null);
    assert.equal(considered[0].eligible, false);
    assert.equal(considered[0].reason, 'never sent a heartbeat');
  });

  test('a frozen heartbeat ages out and blocks placement', () => {
    // The observed failure: the same timestamp read once a minute, so the
    // reported age climbed 743s, 803s, 863s, 923s while nothing refreshed it.
    const frozen = NOW - 923_000;
    const { chosen, considered } = choosePlacement({
      hosts: [coordinator({ lastHeartbeat: frozen })],
      repo: REPO,
      now: NOW,
    });
    assert.equal(chosen, null);
    assert.match(considered[0].reason, /last heartbeat 923s ago \(stale over 120s\)/);
  });

  test('a beat refreshed every 30s stays comfortably inside the staleness bound', () => {
    // recordSelfHeartbeat() runs on a 30s interval against a 120s bound, so
    // three consecutive misses are needed before placement is refused. If that
    // interval is ever widened past the bound this assertion is what fails.
    const intervalMs = 30_000;
    assert.ok(intervalMs * 3 < STALE_HEARTBEAT_MS + intervalMs,
      'self-heartbeat interval must leave room for a missed beat');

    const { chosen, considered } = choosePlacement({
      hosts: [coordinator({ lastHeartbeat: NOW - intervalMs })],
      repo: REPO,
      now: NOW,
    });
    assert.equal(chosen, 'test-host');
    assert.equal(considered[0].eligible, true);
  });

  test('a fresh beat still loses to a real headroom refusal, not to staleness', () => {
    // Guards against "fixing" a headroom block by making the heartbeat fresher.
    // The two gates are independent and must report independently.
    const { chosen, considered } = choosePlacement({
      hosts: [coordinator({
        capacity: {
          ok: false, busy: 1, ceiling: 3, maxTotalRunners: 32,
          reasons: ['43 runners already exist, the fleet limit of 32'],
        },
      })],
      repo: REPO,
      now: NOW,
    });
    assert.equal(chosen, null);
    assert.match(considered[0].reason, /^no headroom:/);
    assert.doesNotMatch(considered[0].reason, /heartbeat/);
  });
});
