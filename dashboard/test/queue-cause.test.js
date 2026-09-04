import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQueueCause, classifyQueuedRuns, CAUSES } from '../lib/queue-cause.js';
import { makeRunner, makeRunner2, makeActiveRun, makeHost } from './fixtures/index.js';

const goodCapacity = { ok: true, reasons: [] };
const saturatedCapacity = { ok: false, reasons: ['load/core 2.8 (limit 2.0)'] };

describe('telemetry-unavailable', () => {
  test('gh API exhausted', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner()], capacity: goodCapacity, api: { remaining: 5 } });
    assert.equal(r.cause, CAUSES.TELEMETRY_UNAVAILABLE);
  });

  test('collector error', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner()], capacity: goodCapacity, collector: { lastError: 'timeout' } });
    assert.equal(r.cause, CAUSES.TELEMETRY_UNAVAILABLE);
  });

  test('runner ghUnknown', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ ghUnknown: true })], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.TELEMETRY_UNAVAILABLE);
  });
});

describe('unserved', () => {
  test('no runners for repo', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.UNSERVED);
    assert.equal(r.actionEligible, false);
  });
});

describe('label-mismatch', () => {
  test('job needs label that no runner carries', () => {
    const run = makeActiveRun({ repo: 'testowner/app-ios' });
    const runner = makeRunner({ labels: ['self-hosted', 'macos', 'arm64'] });
    const r = classifyQueueCause({ run, runners: [runner], capacity: goodCapacity, runLabels: ['self-hosted', 'macos', 'gpu'] });
    assert.equal(r.cause, CAUSES.LABEL_MISMATCH);
    assert.equal(r.actionEligible, false);
  });

  test('does NOT misclassify when labels match', () => {
    const run = makeActiveRun({ repo: 'testowner/app-ios' });
    const runner = makeRunner({ labels: ['self-hosted', 'macos', 'arm64'], ghBusy: true });
    const r = classifyQueueCause({ run, runners: [runner], capacity: goodCapacity, runLabels: ['self-hosted', 'macos', 'arm64'] });
    assert.notEqual(r.cause, CAUSES.LABEL_MISMATCH);
  });

  test('lint findings trigger label-mismatch', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner()], capacity: goodCapacity, hasLintFindings: true });
    assert.equal(r.cause, CAUSES.LABEL_MISMATCH);
    assert.equal(r.actionEligible, false);
  });
});

describe('runner-down', () => {
  test('all runners offline', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ ghStatus: 'offline' })], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.RUNNER_DOWN);
    assert.equal(r.actionEligible, false);
  });

  test('runner draining', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ drainState: 'drained' })], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.RUNNER_DOWN);
    assert.equal(r.actionEligible, false);
  });

  // The field is spelled drainState by buildRunners. When this read drain_state
  // instead, a drained runner counted as online and its queued jobs came back
  // as repo-capacity with actionEligible true — so draining a runner for
  // maintenance invited the autoscaler to replace it. Asserting the verdict
  // rather than the spelling keeps the consequence pinned.
  test('a drained runner is never answered by adding capacity', () => {
    for (const drainState of ['draining', 'drained']) {
      const r = classifyQueueCause({
        run: makeActiveRun(),
        runners: [makeRunner({ drainState, ghStatus: 'online', launchdState: 'running' })],
        capacity: goodCapacity,
      });
      assert.equal(r.cause, CAUSES.RUNNER_DOWN, `${drainState} should be runner-down`);
      assert.equal(r.actionEligible, false, `${drainState} must not be action-eligible`);
      assert.match(r.evidence.join(' '), new RegExp(drainState));
    }
  });

  test('runner launchd dead', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ launchdState: 'dead' })], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.RUNNER_DOWN);
    assert.equal(r.actionEligible, false);
  });
});

describe('host-saturation', () => {
  test('capacity gate refusing additions', () => {
    // All runners busy + host saturated
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ ghBusy: true, workingLocally: true })], capacity: saturatedCapacity });
    assert.equal(r.cause, CAUSES.HOST_SATURATION);
    assert.equal(r.actionEligible, false);
  });
});

describe('repo-capacity', () => {
  test('all runners busy, host has headroom', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ ghBusy: true })], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.REPO_CAPACITY);
    assert.equal(r.actionEligible, true);
  });

  test('multiple busy runners', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [makeRunner({ ghBusy: true }), makeRunner2({ ghBusy: true })], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.REPO_CAPACITY);
    assert.equal(r.actionEligible, true);
  });
});

describe('github-delay', () => {
  test('idle runner exists, short wait', () => {
    const recentRun = makeActiveRun({ createdAt: new Date(Date.now() - 30_000).toISOString() });
    recentRun.startedAt = recentRun.createdAt;
    const r = classifyQueueCause({ run: recentRun, runners: [makeRunner()], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.GITHUB_DELAY);
    assert.equal(r.actionEligible, false);
  });
});

describe('concurrency-block', () => {
  test('idle runner exists, long wait', () => {
    const oldRun = makeActiveRun({ createdAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    oldRun.startedAt = oldRun.createdAt;
    const r = classifyQueueCause({ run: oldRun, runners: [makeRunner()], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.CONCURRENCY_BLOCK);
    assert.equal(r.actionEligible, false);
  });
});

// classifyQueuedRuns is the path /api/queue-causes uses, and it had no test of
// its own — which is how it went unnoticed that it read run.labels, a field
// shapeRun never sets. Labels belong to the individual jobs, so the endpoint saw
// none at all and could not reach label-mismatch, while the daemon's own call
// site could: the same queued job was diagnosed two different ways depending on
// which caller asked.
describe('classifyQueuedRuns', () => {
  const snapshot = (runs) => ({
    active: runs,
    runners: [makeRunner()],
    capacity: goodCapacity,
    api: { ok: true },
    collector: { lastRunAt: Date.now() },
  });

  test('reads job labels from run.jobs, not run.labels', () => {
    const run = makeActiveRun({ id: 42, status: 'queued' });
    run.jobs = [{ labels: ['self-hosted', 'macos', 'xcode-99'] }];
    delete run.labels;

    const out = classifyQueuedRuns(snapshot([run]));
    const c = out.get(42);
    assert.equal(c.cause, CAUSES.LABEL_MISMATCH);
    assert.equal(c.actionEligible, false, 'a label mismatch must never invite another runner');
    assert.match(c.evidence.join(' '), /xcode-99/);
  });

  test('only queued runs are classified', () => {
    const queued = makeActiveRun({ id: 1, status: 'queued' });
    const running = makeActiveRun({ id: 2, status: 'in_progress' });
    const out = classifyQueuedRuns(snapshot([queued, running]));
    assert.deepEqual([...out.keys()], [1]);
  });

  test('a run with no jobs yet is still classified, not skipped', () => {
    // The jobs list arrives a poll behind the run on a fresh queue, and a run
    // nobody classifies is a run nobody explains.
    const run = makeActiveRun({ id: 7, status: 'queued' });
    delete run.jobs;
    const out = classifyQueuedRuns(snapshot([run]));
    assert.ok(out.get(7), 'expected a classification');
    assert.ok(out.get(7).cause, 'expected a named cause');
  });

  test('an empty snapshot yields no classifications', () => {
    assert.equal(classifyQueuedRuns({}).size, 0);
  });
});
