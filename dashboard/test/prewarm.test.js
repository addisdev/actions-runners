import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planPrewarm } from '../lib/prewarm.js';
import { evaluateGate, GATE } from '../lib/forecast.js';
import { createSettings } from '../lib/settings.js';
import { makeRunner, makeRunner2 } from './fixtures/index.js';

const NOW = Date.UTC(2026, 0, 5, 8, 0, 0);
const REPO = 'testowner/app-ios';
const HOUR = 3_600_000;

const passingGate = evaluateGate(
  Array.from({ length: GATE.minEvaluations + 5 }, () => ({
    predicted_peak: 3, actual_peak: 3, false_positive: 0,
  }))
);

function prediction(overrides = {}) {
  return {
    windowStart: NOW + 30 * 60_000,
    windowEnd: NOW + 90 * 60_000,
    confidence: 'high',
    repos: [{ repo: REPO, expectedPeak: 2, source: 'schedule', evidence: 'Scheduled workflow Nightly' }],
    ...overrides,
  };
}

function baseOpts(overrides = {}) {
  return {
    enabled: true,
    predictions: [prediction()],
    gate: passingGate,
    runners: [makeRunner()],
    active: [],
    lastPrewarmByRepo: {},
    now: NOW,
    leadMs: HOUR,
    cooldownMs: HOUR,
    minConfidence: 'medium',
    cap: 4,
    ...overrides,
  };
}

describe('planPrewarm — master switches', () => {
  test('refuses when disabled', () => {
    const plan = planPrewarm(baseOpts({ enabled: false }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /disabled/);
  });

  test('refuses when the forecast gate has not passed', () => {
    const plan = planPrewarm(baseOpts({ gate: { passed: false, reasons: ['precision 0.40 below 0.70'] } }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /forecast gate/);
    assert.match(plan.reason, /precision/);
  });
});

describe('planPrewarm — forecast window and confidence', () => {
  test('acts when the burst window is within the lead time', () => {
    const plan = planPrewarm(baseOpts());
    assert.equal(plan.act, true);
    assert.equal(plan.repo, REPO);
    assert.equal(plan.name, makeRunner().name);
    assert.equal(plan.mode, 'prewarm');
    assert.equal(plan.deficit, 0);
  });

  test('refuses when the window is beyond the lead time', () => {
    const plan = planPrewarm(baseOpts({
      predictions: [prediction({ windowStart: NOW + 2 * HOUR })],
      leadMs: HOUR,
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /outside.*lead/);
  });

  test('refuses when the window has already started', () => {
    const plan = planPrewarm(baseOpts({
      predictions: [prediction({ windowStart: NOW - 60_000 })],
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /already started/);
  });

  test('refuses low confidence when minimum is medium', () => {
    const plan = planPrewarm(baseOpts({
      predictions: [prediction({ confidence: 'low' })],
      minConfidence: 'medium',
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /no repos within prewarm lead window|does not exceed/);
  });

  test('accepts medium confidence when minimum is medium', () => {
    const plan = planPrewarm(baseOpts({
      predictions: [prediction({ confidence: 'medium' })],
      minConfidence: 'medium',
    }));
    assert.equal(plan.act, true);
  });

  test('refuses medium confidence when minimum is high', () => {
    const plan = planPrewarm(baseOpts({
      predictions: [prediction({ confidence: 'medium' })],
      minConfidence: 'high',
    }));
    assert.equal(plan.act, false);
  });
});

describe('planPrewarm — repo guards', () => {
  test('refuses when expected peak does not exceed registered runners', () => {
    const plan = planPrewarm(baseOpts({
      runners: [makeRunner(), makeRunner2()],
      predictions: [prediction({ repos: [{ repo: REPO, expectedPeak: 2 }] })],
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /does not exceed 2 registered/);
  });

  test('refuses when the repo is already at the per-repo cap', () => {
    const plan = planPrewarm(baseOpts({
      runners: [makeRunner(), makeRunner2(), makeRunner({ instance: 3, name: 'r3' }), makeRunner({ instance: 4, name: 'r4' })],
      cap: 4,
      predictions: [prediction({ repos: [{ repo: REPO, expectedPeak: 5 }] })],
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /per-repo cap/);
  });

  test('refuses when every runner is draining', () => {
    const plan = planPrewarm(baseOpts({
      runners: [makeRunner({ drainState: 'draining' })],
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /no non-draining runner/);
  });

  test('refuses when queued work would drive reactive autoscale', () => {
    const plan = planPrewarm(baseOpts({
      active: [{ id: 1, repo: REPO, status: 'queued', createdAt: new Date(NOW).toISOString() }],
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /reactive autoscale/);
  });

  test('refuses when in-progress work would drive reactive autoscale', () => {
    const plan = planPrewarm(baseOpts({
      active: [{ id: 1, repo: REPO, status: 'in_progress', startedAt: new Date(NOW).toISOString() }],
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /reactive autoscale/);
  });

  test('refuses during the per-repo cooldown', () => {
    const plan = planPrewarm(baseOpts({
      lastPrewarmByRepo: { [REPO]: NOW - 30 * 60_000 },
      cooldownMs: HOUR,
    }));
    assert.equal(plan.act, false);
    assert.match(plan.reason, /cooldown/);
  });
});

describe('planPrewarm — conservative action shape', () => {
  test('returns one duplicate with deficit for a larger expected peak', () => {
    const plan = planPrewarm(baseOpts({
      predictions: [prediction({ repos: [{ repo: REPO, expectedPeak: 4, evidence: 'Peak of 4' }] })],
    }));
    assert.equal(plan.act, true);
    assert.equal(plan.deficit, 2);
    assert.match(plan.reason, /peak 4/);
    assert.match(plan.reason, /2 more runner/);
  });

  test('picks the highest deficit when several repos qualify', () => {
    const other = 'testowner/other-app';
    const plan = planPrewarm(baseOpts({
      runners: [makeRunner(), makeRunner({ repo: other, name: 'other-host' })],
      predictions: [{
        windowStart: NOW + 20 * 60_000,
        confidence: 'high',
        repos: [
          { repo: REPO, expectedPeak: 2, evidence: 'small burst' },
          { repo: other, expectedPeak: 3, evidence: 'big burst' },
        ],
      }],
    }));
    assert.equal(plan.act, true);
    assert.equal(plan.repo, other);
    assert.equal(plan.deficit, 1);
  });
});

describe('settings — prewarm defaults and validation', () => {
  test('prewarm defaults off with conservative lead and cooldown', () => {
    const db = { prepare: () => ({ all: () => [], run: () => {} }) };
    const s = createSettings(db);
    assert.equal(s.get('prewarm'), false);
    assert.equal(s.get('prewarmLeadMs'), 3_600_000);
    assert.equal(s.get('prewarmCooldownMs'), 3_600_000);
    assert.equal(s.get('prewarmMinConfidence'), 'medium');
  });

  test('prewarmMinConfidence rejects unknown values', () => {
    const db = {
      prepare: () => ({
        all: () => [],
        run: () => {},
      }),
    };
    const s = createSettings(db);
    assert.throws(() => s.set('prewarmMinConfidence', 'low'), /medium or high/);
  });

  test('prewarmLimits exposes the planner inputs', () => {
    const db = { prepare: () => ({ all: () => [], run: () => {} }) };
    const s = createSettings(db);
    const limits = s.prewarmLimits();
    assert.equal(limits.prewarm, false);
    assert.equal(limits.prewarmLeadMs, 3_600_000);
    assert.equal(limits.maxInstancesPerRepo, 4);
  });
});
