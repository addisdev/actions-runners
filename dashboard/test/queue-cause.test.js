import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQueueCause, classifyQueuedRuns, queuedJobLabels, CAUSES } from '../lib/queue-cause.js';
import { makeRunner, makeRunner2, makeActiveRun, makeHost } from './fixtures/index.js';

const goodCapacity = { ok: true, reasons: [] };
const saturatedCapacity = { ok: false, reasons: ['load/core 2.8 (limit 2.0)'] };

describe('queuedJobLabels', () => {
  // Example Android case: one run, two jobs, two different runs-on.
  const mixed = {
    jobs: [
      { name: 'ci / build', status: 'queued', labels: ['ubuntu-latest'] },
      { name: 'ci / instrumentation', status: 'queued', labels: ['self-hosted', 'macOS'] },
    ],
  };

  test('never merges label sets across jobs', () => {
    const labels = queuedJobLabels(mixed);
    assert.deepEqual(labels, ['self-hosted', 'macOS']);
    assert.ok(!labels.includes('ubuntu-latest'), 'must not invent an impossible set');
  });

  test('the merged set used to read as a critical mismatch', () => {
    const runners = [makeRunner({ labels: ['self-hosted', 'macos', 'arm64'] })];
    const merged = classifyQueueCause({
      run: makeActiveRun(), runners, capacity: goodCapacity,
      runLabels: ['self-hosted', 'macOS', 'ubuntu-latest'],
    });
    assert.equal(merged.cause, CAUSES.LABEL_MISMATCH);

    const fixed = classifyQueueCause({
      run: makeActiveRun(), runners, capacity: goodCapacity,
      runLabels: queuedJobLabels(mixed),
    });
    assert.notEqual(fixed.cause, CAUSES.LABEL_MISMATCH);
  });

  test('ignores jobs that already found a runner', () => {
    assert.deepEqual(
      queuedJobLabels({
        jobs: [
          { name: 'build', status: 'completed', labels: ['ubuntu-latest'] },
          { name: 'test', status: 'queued', labels: ['self-hosted', 'macOS', 'ci'] },
        ],
      }),
      ['self-hosted', 'macOS', 'ci']
    );
  });

  test('a lone GitHub-hosted job is still reported as such', () => {
    const labels = queuedJobLabels({ jobs: [{ status: 'queued', labels: ['ubuntu-latest'] }] });
    assert.deepEqual(labels, ['ubuntu-latest']);
    const r = classifyQueueCause({
      run: makeActiveRun(), runners: [makeRunner()], capacity: goodCapacity, runLabels: labels,
    });
    assert.equal(r.cause, CAUSES.GITHUB_HOSTED);
  });

  test('falls back to all jobs when none are marked queued', () => {
    assert.deepEqual(
      queuedJobLabels({ jobs: [{ status: 'in_progress', labels: ['self-hosted', 'macOS'] }] }),
      ['self-hosted', 'macOS']
    );
  });

  test('null when there is nothing to go on', () => {
    assert.equal(queuedJobLabels({ jobs: [] }), null);
    assert.equal(queuedJobLabels({}), null);
    assert.equal(queuedJobLabels({ jobs: [{ status: 'queued', labels: [] }] }), null);
  });
});

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

  test('an unrelated repository error does not poison this run', () => {
    const r = classifyQueueCause({
      run: makeActiveRun(),
      runners: [makeRunner()],
      capacity: goodCapacity,
      collector: {
        lastError: '1 of 2 repos failed: broken',
        repoErrors: { 'testowner/broken': 'runner API returned 404' },
      },
    });
    assert.notEqual(r.cause, CAUSES.TELEMETRY_UNAVAILABLE);
    assert.doesNotMatch(r.evidence.join(' '), /404/);
  });

  test('a scoped error still marks the affected repository unavailable', () => {
    const run = makeActiveRun({ repo: 'testowner/broken' });
    const r = classifyQueueCause({
      run,
      runners: [makeRunner({ repo: run.repo })],
      capacity: goodCapacity,
      collector: {
        lastError: 'runner API returned 404',
        repoErrors: { [run.repo]: 'runner API returned 404' },
      },
    });
    assert.equal(r.cause, CAUSES.TELEMETRY_UNAVAILABLE);
    assert.match(r.evidence.join(' '), /404/);
  });
});

describe('github-hosted', () => {
  // A job that never wanted this fleet. Reported as a critical label-mismatch
  // before this existed, advising that a correct workflow be edited.
  test('a runs-on without self-hosted is not a mismatch with local runners', () => {
    const r = classifyQueueCause({
      run: makeActiveRun(),
      runners: [makeRunner({ labels: ['self-hosted', 'macos', 'arm64'] })],
      capacity: goodCapacity,
      runLabels: ['ubuntu-latest'],
    });
    assert.equal(r.cause, CAUSES.GITHUB_HOSTED);
    assert.equal(r.actionEligible, false);
  });

  // Decided before the repo's runners are counted: a repo with none is not
  // under-provisioned if its work does not want a self-hosted runner. This is
  // what stops provisioning firing for the template repos.
  test('takes precedence over unserved', () => {
    const r = classifyQueueCause({
      run: makeActiveRun(), runners: [], capacity: goodCapacity,
      runLabels: ['ubuntu-latest'],
    });
    assert.equal(r.cause, CAUSES.GITHUB_HOSTED);
  });

  test('a self-hosted job is still judged against local runners', () => {
    const r = classifyQueueCause({
      run: makeActiveRun(), runners: [], capacity: goodCapacity,
      runLabels: ['self-hosted', 'macOS', 'ci'],
    });
    assert.equal(r.cause, CAUSES.UNSERVED);
  });
});

describe('unserved', () => {
  test('no runners for repo', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [], capacity: goodCapacity });
    assert.equal(r.cause, CAUSES.UNSERVED);
  });

  // Was asserted false while nothing could register a first runner. It is the
  // one non-capacity cause where adding a runner IS the remedy rather than a way
  // to make things worse, so planScaleUp is allowed to act on it; whether it may
  // is the provisionUnserved setting's decision, not this classifier's.
  test('adding a runner is the remedy, so it is action-eligible', () => {
    const r = classifyQueueCause({ run: makeActiveRun(), runners: [], capacity: goodCapacity });
    assert.equal(r.actionEligible, true);
  });

  // The causes that stay ineligible, and the reason they differ: another runner
  // would share the mismatch, and another runner on a saturated host is what the
  // headroom gate exists to prevent.
  test('label-mismatch and host-saturation stay ineligible', () => {
    const mismatch = classifyQueueCause({
      run: makeActiveRun({ repo: 'testowner/app-ios' }),
      runners: [makeRunner({ labels: ['self-hosted', 'macos', 'arm64'] })],
      capacity: goodCapacity,
      runLabels: ['self-hosted', 'macos', 'gpu'],
    });
    assert.equal(mismatch.cause, CAUSES.LABEL_MISMATCH);
    assert.equal(mismatch.actionEligible, false);
  });
});

describe('label-mismatch', () => {
  test('a known job role with no runner is actionable as role-unserved', () => {
    const run = makeActiveRun({ repo: 'testowner/app-ios' });
    const runner = makeRunner({
      labels: ['self-hosted', 'macos', 'arm64', 'ci'],
      extraLabels: ['ci'],
    });
    const r = classifyQueueCause({
      run,
      runners: [runner],
      capacity: goodCapacity,
      runLabels: ['self-hosted', 'macos', 'arm64', 'ui-web'],
    });
    assert.equal(r.cause, CAUSES.ROLE_UNSERVED);
    assert.equal(r.actionEligible, true);
  });

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
    assert.equal(r.confidence, 'low', 'GitHub does not expose the actual hold reason');
    assert.equal(r.remediation, null, 'a routine dispatch delay must not invite cancellation');
  });

  test('offers cancellation when GitHub has created no jobs and the run is stale', () => {
    const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const staleRun = makeActiveRun({
      id: 31117856428,
      createdAt: staleAt,
      startedAt: staleAt,
      updatedAt: staleAt,
      jobs: [],
    });
    const r = classifyQueueCause({
      run: staleRun,
      runners: [makeRunner()],
      capacity: goodCapacity,
    });
    assert.equal(r.cause, CAUSES.CONCURRENCY_BLOCK);
    assert.deepEqual(r.remediation, { action: 'run.cancel', label: 'Cancel stale run' });
    assert.match(r.recommended, /Cancel it/);
    assert.match(r.evidence.join(' '), /not created any jobs/);
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

  test('scopes collector failures by repository on the API path', () => {
    const healthy = makeActiveRun({ id: 8 });
    const broken = makeActiveRun({ id: 9, repo: 'testowner/broken' });
    const snap = snapshot([healthy, broken]);
    snap.collector = {
      lastError: '1 of 2 repos failed: broken',
      repoErrors: { [broken.repo]: 'runner API returned 404' },
    };

    const out = classifyQueuedRuns(snap);
    assert.notEqual(out.get(healthy.id).cause, CAUSES.TELEMETRY_UNAVAILABLE);
    assert.equal(out.get(broken.id).cause, CAUSES.TELEMETRY_UNAVAILABLE);
  });

  test('an empty snapshot yields no classifications', () => {
    assert.equal(classifyQueuedRuns({}).size, 0);
  });
});
