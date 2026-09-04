import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planScaleUp, planScaleDown } from '../lib/autoscale.js';
import { makeRunner, makeRunner2 } from './fixtures/index.js';

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const REPO = 'testowner/app-ios';

const okCapacity = { ok: true, reasons: [] };

// A repo that genuinely wants another runner, queued long enough to justify it.
const wantsMore = [{ repo: REPO, have: 1, want: 2, delta: 1, reason: 'p90 concurrent demand is 2' }];

const queuedLongEnough = [{
  repo: REPO,
  status: 'queued',
  createdAt: new Date(NOW - 20 * 60_000).toISOString(),
  startedAt: new Date(NOW - 20 * 60_000).toISOString(),
}];

function cause(overrides = {}) {
  return new Map([[1, { repo: REPO, cause: 'repo-capacity', confidence: 'high', actionEligible: true, ...overrides }]]);
}

describe('planScaleUp — the cause gate', () => {
  test('acts on a high-confidence capacity diagnosis', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, true);
    assert.equal(plan.repo, REPO);
  });

  test('refuses a label mismatch, which cloning would only duplicate', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW,
      queueCauses: cause({ cause: 'label-mismatch', actionEligible: false }),
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /label-mismatch/);
  });

  test('refuses when telemetry was unavailable', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW,
      queueCauses: cause({ cause: 'telemetry-unavailable', confidence: 'low', actionEligible: false }),
    });
    assert.equal(plan.act, false);
  });

  test('refuses a workflow concurrency block', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW,
      queueCauses: cause({ cause: 'concurrency-block', confidence: 'medium', actionEligible: false }),
    });
    assert.equal(plan.act, false);
  });

  test('refuses a downed runner — repair is the remedy, not more runners', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW,
      queueCauses: cause({ cause: 'runner-down', actionEligible: false }),
    });
    assert.equal(plan.act, false);
  });

  test('refuses a capacity diagnosis that is only medium confidence', () => {
    // actionEligible is set, but the evidence was circumstantial. An unattended
    // process must not spend a concurrency slot on a maybe.
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW,
      queueCauses: cause({ confidence: 'medium' }),
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /confidence/);
  });

  test('with no classifier supplied, the older heuristics still work', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW,
    });
    assert.equal(plan.act, true);
  });
});

describe('planScaleUp — pre-existing guards still hold', () => {
  test('no headroom means no action, whatever the cause says', () => {
    const plan = planScaleUp({
      sizing: wantsMore,
      capacity: { ok: false, reasons: ['load/core 2.9 (limit 2.0)'] },
      runners: [makeRunner()], active: queuedLongEnough, now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /headroom/);
  });

  test('a short queue is not evidence yet', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: [{ ...queuedLongEnough[0], startedAt: new Date(NOW - 60_000).toISOString() }],
      now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, false);
  });

  test('the cooldown blocks a second addition', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()],
      active: queuedLongEnough, now: NOW, queueCauses: cause(),
      lastUpByRepo: { [REPO]: NOW - 60_000 },
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /ago/);
  });

  test('nothing queued means nothing to justify a runner', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity, runners: [makeRunner()], active: [], now: NOW,
    });
    assert.equal(plan.act, false);
  });

  test('a draining runner is not used as a clone source', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: okCapacity,
      runners: [makeRunner({ drainState: 'draining' })],
      active: queuedLongEnough, now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /copy labels from/);
  });
});

describe('planScaleDown', () => {
  const idleLongEnough = (name) => new Map([[name, { lastJobAt: NOW - 10 * 3600_000, ageMs: 12 * 3600_000 }]]);

  test('removes a long-idle duplicate', () => {
    const dup = makeRunner2();
    const plan = planScaleDown({
      runners: [makeRunner(), dup], active: [], idle: idleLongEnough(dup.name), now: NOW,
    });
    assert.equal(plan.act, true);
    assert.equal(plan.name, dup.name);
  });

  test('never removes instance 1', () => {
    const first = makeRunner();
    const plan = planScaleDown({
      runners: [first], active: [], idle: idleLongEnough(first.name), now: NOW,
    });
    assert.equal(plan.act, false);
  });

  test('leaves a drained duplicate to the operator who drained it', () => {
    const dup = makeRunner2({ drainState: 'drained' });
    const plan = planScaleDown({
      runners: [makeRunner(), dup], active: [], idle: idleLongEnough(dup.name), now: NOW,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /drained/);
  });

  test('a repo with active work keeps all of its runners', () => {
    const dup = makeRunner2();
    const plan = planScaleDown({
      runners: [makeRunner(), dup],
      active: [{ repo: REPO, status: 'in_progress' }],
      idle: idleLongEnough(dup.name), now: NOW,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /active work/);
  });

  test('a freshly created duplicate is not removed before it can run anything', () => {
    const dup = makeRunner2();
    const plan = planScaleDown({
      runners: [makeRunner(), dup], active: [],
      idle: new Map([[dup.name, { lastJobAt: null, ageMs: 2 * 60_000 }]]),
      now: NOW,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /old/);
  });

  test('a busy duplicate is never removed', () => {
    const dup = makeRunner2({ ghBusy: true });
    const plan = planScaleDown({
      runners: [makeRunner(), dup], active: [], idle: idleLongEnough(dup.name), now: NOW,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /busy/);
  });
});
