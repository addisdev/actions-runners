import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planScaleUp, planScaleDown, resolveScaleMode, buildScaleUpPlan } from '../lib/autoscale.js';
import { makeRunner, makeRunner2 } from './fixtures/index.js';

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const REPO = 'testowner/app-ios';

const okCapacity = { ok: true, reasons: [] };

// A repo that genuinely wants another runner, queued long enough to justify it.
const wantsMore = [{ repo: REPO, have: 1, want: 2, delta: 1, reason: 'p90 concurrent demand is 2' }];

const queuedLongEnough = [{
  id: 1,
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

// A repo with no runner at all. sizeFleet only emits these rows when the
// provisionUnserved setting is on, so an unserved row reaching the planner has
// already cleared that policy question.
describe('planScaleUp — a repo with no runner', () => {
  const unserved = (role = null) => [{
    repo: REPO, role, have: 0, want: 1, delta: 1, unserved: true,
    reason: '1 job(s) queued and no runner is registered',
  }];

  const queuedAsking = (labels) => [{
    ...queuedLongEnough[0],
    jobs: [{ labels }],
  }];

  const unservedCause = new Map([[1, {
    repo: REPO, cause: 'unserved', confidence: 'high', actionEligible: true,
  }]]);

  test('registers a first runner rather than refusing for want of a sibling', () => {
    const plan = planScaleUp({
      sizing: unserved(), capacity: okCapacity, runners: [],
      active: queuedAsking(['self-hosted', 'macos', 'arm64']), now: NOW,
      queueCauses: unservedCause,
    });
    assert.equal(plan.act, true);
    assert.equal(plan.register, true);
    assert.equal(plan.repo, REPO);
    // No name to duplicate — the caller must dispatch on `register`, and a name
    // here would send it down the runner.duplicate path with an undefined runner.
    assert.equal(plan.name, null);
  });

  test('takes the new runner labels from what the waiting job asked for', () => {
    const plan = planScaleUp({
      sizing: unserved('ui-web'), capacity: okCapacity, runners: [],
      active: queuedAsking(['self-hosted', 'macos', 'arm64', 'ui-web']), now: NOW,
      queueCauses: unservedCause,
    });
    assert.deepEqual(plan.extraLabels, ['ui-web']);
  });

  test('a job asking only for platform labels yields a runner with no extra ones', () => {
    // An empty list is an answer, not a missing value: register.sh creates an
    // unroled runner and the job matches it.
    const plan = planScaleUp({
      sizing: unserved(), capacity: okCapacity, runners: [],
      active: queuedAsking(['self-hosted', 'macos', 'arm64']), now: NOW,
      queueCauses: unservedCause,
    });
    assert.equal(plan.act, true);
    assert.deepEqual(plan.extraLabels, []);
  });

  // Example Android repo: `build` on ubuntu-latest, `instrumentation` on
  // [self-hosted, macOS]. Merging the two would have registered a runner
  // advertising ubuntu-latest, which nothing asked for and nothing can serve.
  test('does not merge the labels of jobs that target different runners', () => {
    const plan = planScaleUp({
      sizing: unserved('ui-web'), capacity: okCapacity, runners: [], now: NOW,
      active: [{
        ...queuedLongEnough[0],
        jobs: [
          { status: 'queued', labels: ['ubuntu-latest'] },
          { status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ui-web'] },
        ],
      }],
      queueCauses: unservedCause,
    });
    assert.equal(plan.act, true);
    assert.deepEqual(plan.extraLabels, ['ui-web']);
  });

  // The headroom exemption, which is the whole reason this is usable on a busy
  // host. A first runner decides whether a repo can build at all; it is not the
  // added concurrency the gate exists to refuse.
  test('acts even when the host has no headroom', () => {
    const plan = planScaleUp({
      sizing: unserved(), capacity: { ok: false, reasons: ['load 62 on 12 cores'] },
      runners: [], active: queuedAsking(['self-hosted']), now: NOW,
      queueCauses: unservedCause,
    });
    assert.equal(plan.act, true);
    assert.equal(plan.register, true);
  });

  test('but a duplicate is still refused when there is no headroom', () => {
    const plan = planScaleUp({
      sizing: wantsMore, capacity: { ok: false, reasons: ['load 62 on 12 cores'] },
      runners: [makeRunner()], active: queuedLongEnough, now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /no headroom/);
  });

  test('still waits out minQueuedMs — registering takes longer than a short queue', () => {
    const justQueued = [{
      repo: REPO, status: 'queued',
      createdAt: new Date(NOW - 30_000).toISOString(),
      startedAt: new Date(NOW - 30_000).toISOString(),
      jobs: [{ labels: ['self-hosted'] }],
    }];
    const plan = planScaleUp({
      sizing: unserved(), capacity: okCapacity, runners: [],
      active: justQueued, now: NOW, queueCauses: unservedCause,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /needs \d+m/);
  });

  // The guard that keeps this from misfiring on the common case. Most repos with
  // no self-hosted runner build on GitHub-hosted ones and are meant to.
  test('ignores a repo whose queued work targets GitHub-hosted runners', () => {
    const plan = planScaleUp({
      sizing: unserved(), capacity: okCapacity, runners: [],
      active: queuedAsking(['ubuntu-latest']), now: NOW,
      queueCauses: unservedCause,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /GitHub-hosted/);
  });

  test('refuses when no job labels are available rather than guessing', () => {
    const noLabels = [{ ...queuedLongEnough[0], jobs: [] }];
    const plan = planScaleUp({
      sizing: unserved(), capacity: okCapacity, runners: [],
      active: noLabels, now: NOW, queueCauses: unservedCause,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /no job labels/);
  });

  test('still honours the per-repo cooldown, so a failing registration cannot loop', () => {
    const plan = planScaleUp({
      sizing: unserved(), capacity: okCapacity, runners: [],
      active: queuedAsking(['self-hosted']), now: NOW,
      lastUpByRepo: { [REPO]: NOW - 60_000 },
      queueCauses: unservedCause,
    });
    assert.equal(plan.act, false);
    assert.match(plan.reason, /scaled up/);
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

describe('resolveScaleMode', () => {
  test('defaults to sustained thresholds', () => {
    const mode = resolveScaleMode({ queuedCount: 5, waitedMs: 600000, limits: {} });
    assert.equal(mode.mode, 'sustained');
    assert.equal(mode.minQueuedMs, 600000);
  });

  test('uses burst thresholds when enabled and queue depth is high enough', () => {
    const mode = resolveScaleMode({
      queuedCount: 3,
      waitedMs: 150000,
      limits: { burstScale: true, burstMinQueuedJobs: 2, burstMinQueuedMs: 120000 },
    });
    assert.equal(mode.mode, 'burst');
    assert.equal(mode.minQueuedMs, 120000);
    assert.equal(mode.cooldownMs, 300000);
  });

  test('burst mode still requires the shorter wait', () => {
    const mode = resolveScaleMode({
      queuedCount: 4,
      waitedMs: 60000,
      limits: { burstScale: true },
    });
    assert.equal(mode.mode, 'sustained');
  });
});

describe('planScaleUp — per-role capacity', () => {
  const ciRunner = makeRunner({ extraLabels: ['ci'], name: 'host-app-ios-ci' });
  const uiRunner = makeRunner({
    extraLabels: ['ui-web'],
    name: 'host-app-ios-ui',
    instance: 1,
    dirName: 'app-ios-ui',
  });

  test('duplicates the sibling with the same role as the queued job', () => {
    const sizing = [{
      repo: REPO, role: 'ui-web', have: 1, want: 2, delta: 1,
      reason: '1 ui-web job(s) queued', concurrency: { p90: 1, jobs: 10 },
    }];
    const active = [{
      id: 42,
      repo: REPO,
      status: 'queued',
      startedAt: new Date(NOW - 20 * 60_000).toISOString(),
      jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ui-web'] }],
    }];
    const plan = planScaleUp({
      sizing, capacity: okCapacity, runners: [ciRunner, uiRunner],
      active, now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, true);
    assert.equal(plan.name, uiRunner.name);
    assert.equal(plan.role, 'ui-web');
    assert.deepEqual(plan.extraLabels, ['ui-web']);
  });

  test('registers the first runner for a new role instead of cloning wrong labels', () => {
    const sizing = [{
      repo: REPO, role: 'ui-web', have: 0, want: 1, delta: 1,
      reason: '1 ui-web job queued', concurrency: { p90: 1, jobs: 10 },
    }];
    const active = [{
      id: 43,
      repo: REPO,
      status: 'queued',
      startedAt: new Date(NOW - 20 * 60_000).toISOString(),
      jobs: [{
        status: 'queued',
        labels: ['self-hosted', 'macos', 'arm64', 'ui-web', 'xcode-16'],
      }],
    }];
    const plan = planScaleUp({
      sizing, capacity: okCapacity, runners: [ciRunner],
      active, now: NOW, queueCauses: cause(),
    });
    assert.equal(plan.act, true);
    assert.equal(plan.register, true);
    assert.equal(plan.firstRunner, false);
    assert.equal(plan.name, null);
    assert.deepEqual(plan.extraLabels, ['ui-web', 'xcode-16']);
  });

  test('mixed causes: scales the eligible role and blocks the other', () => {
    const sizing = [
      {
        repo: REPO, role: 'ci', have: 1, want: 2, delta: 1,
        reason: '1 ci job(s) queued', concurrency: { p90: 2, jobs: 10 },
      },
      {
        repo: REPO, role: 'ui-web', have: 1, want: 2, delta: 1,
        reason: '1 ui-web job(s) queued', concurrency: { p90: 2, jobs: 10 },
      },
    ];
    const active = [
      {
        id: 1, repo: REPO, status: 'queued',
        startedAt: new Date(NOW - 20 * 60_000).toISOString(),
        jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ci'] }],
      },
      {
        id: 2, repo: REPO, status: 'queued',
        startedAt: new Date(NOW - 20 * 60_000).toISOString(),
        jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ui-web'] }],
      },
    ];
    const queueCauses = new Map([
      [1, { repo: REPO, cause: 'repo-capacity', confidence: 'high', actionEligible: true }],
      [2, { repo: REPO, cause: 'label-mismatch', confidence: 'high', actionEligible: false }],
    ]);
    const plan = planScaleUp({
      sizing, capacity: okCapacity, runners: [ciRunner, uiRunner],
      active, now: NOW, queueCauses,
    });
    assert.equal(plan.act, true);
    assert.equal(plan.role, 'ci');
    assert.equal(plan.name, ciRunner.name);
  });
});

describe('planScaleUp — burst mode and deficit', () => {
  test('acts in burst mode after the shorter queue wait', () => {
    const sizing = [{
      repo: REPO, role: null, have: 1, want: 4, delta: 3,
      reason: '3 job(s) queued', concurrency: { p90: 2, jobs: 10 },
    }];
    const active = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      repo: REPO,
      status: 'queued',
      startedAt: new Date(NOW - 3 * 60_000).toISOString(),
      jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64'] }],
    }));
    const plan = planScaleUp({
      sizing, capacity: okCapacity, runners: [makeRunner()],
      active, now: NOW, queueCauses: cause(),
      limits: { burstScale: true, burstMinQueuedJobs: 2, burstMinQueuedMs: 120000 },
    });
    assert.equal(plan.act, true);
    assert.equal(plan.mode, 'burst');
    assert.equal(plan.deficit, 2);
  });

  test('revalidate batch returns a bounded list and remaining deficit', () => {
    const sizing = [
      {
        repo: REPO, role: null, have: 1, want: 3, delta: 2,
        reason: '2 job(s) queued', concurrency: { p90: 2, jobs: 10 },
      },
      {
        repo: 'testowner/other', role: null, have: 1, want: 2, delta: 1,
        reason: '1 job(s) queued', concurrency: { p90: 2, jobs: 10 },
      },
    ];
    const active = [
      {
        id: 1, repo: REPO, status: 'queued',
        startedAt: new Date(NOW - 3 * 60_000).toISOString(),
        jobs: [{ status: 'queued', labels: ['self-hosted'] }],
      },
      {
        id: 2, repo: REPO, status: 'queued',
        startedAt: new Date(NOW - 3 * 60_000).toISOString(),
        jobs: [{ status: 'queued', labels: ['self-hosted'] }],
      },
      {
        id: 3, repo: 'testowner/other', status: 'queued',
        startedAt: new Date(NOW - 3 * 60_000).toISOString(),
        jobs: [{ status: 'queued', labels: ['self-hosted'] }],
      },
      {
        id: 4, repo: 'testowner/other', status: 'queued',
        startedAt: new Date(NOW - 3 * 60_000).toISOString(),
        jobs: [{ status: 'queued', labels: ['self-hosted'] }],
      },
    ];
    const plan = buildScaleUpPlan({
      sizing, capacity: okCapacity,
      runners: [makeRunner(), makeRunner({ repo: 'testowner/other', name: 'host-other' })],
      active, now: NOW, revalidate: true,
      limits: { burstScale: true, burstMinQueuedJobs: 2, burstMaxAdditionsPerRepo: 2 },
    });
    assert.equal(plan.act, true);
    assert.equal(plan.revalidate, true);
    assert.equal(plan.actions.length, 2);
    assert.equal(plan.deficit, 1);
  });
});
