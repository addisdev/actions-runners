// Queue ETAs: ranges, never a promise the queue cannot keep.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateQueue, NEVER_STARTS } from '../lib/eta.js';

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 8, 30, 15, 0, 0);
// A hand-built baseline pair in the shape buildDurationBaselines returns.
const wf = (repo, workflow) => `${repo}\u0000${workflow}`;
const bl = (entries) => ({
  byWorkflow: new Map(entries.map(([r, w, ms]) => [wf(r, w), { expectedMs: ms, n: 10, scope: 'workflow' }])),
  byRepo: new Map(),
  fleet: { expectedMs: null, n: 0 },
});
const baselines = {
  p50: bl([['o/web', 'ci', 10 * MIN], ['o/web', 'e2e', 30 * MIN], ['o/ios', 'ios', 20 * MIN]]),
  p90: bl([['o/web', 'ci', 14 * MIN], ['o/web', 'e2e', 45 * MIN], ['o/ios', 'ios', 28 * MIN]]),
};
const running = (repo, workflowName, startedMinAgo) => ({
  status: 'in_progress', repo, workflowName, startedAt: new Date(NOW - startedMinAgo * MIN).toISOString(),
});
const queued = (id, repo, workflowName, cause, queuedMin = 1) => ({ id, repo, workflowName, cause, queuedSinceMs: queuedMin * MIN });

describe('estimateQueue', () => {
  test('behind a busy runner: the rest of its job, then this workflow', () => {
    const eta = estimateQueue({
      queue: [queued(1, 'o/web', 'ci', 'repo-capacity')],
      active: [running('o/web', 'e2e', 20)],
      baselines,
      now: NOW,
    }).get(1);
    assert.deepEqual(eta.etaStartMs, [10 * MIN, 25 * MIN]);
    assert.deepEqual(eta.etaDoneMs, [20 * MIN, 39 * MIN]);
    assert.match(eta.basis, /job ahead/);
  });

  test('second in line adds one run of its own workflow', () => {
    const m = estimateQueue({
      queue: [queued(1, 'o/web', 'ci', 'repo-capacity', 5), queued(2, 'o/web', 'ci', 'repo-capacity', 1)],
      active: [running('o/web', 'e2e', 20)],
      baselines,
      now: NOW,
    });
    assert.deepEqual(m.get(1).etaStartMs, [10 * MIN, 25 * MIN]);
    assert.deepEqual(m.get(2).etaStartMs, [20 * MIN, 39 * MIN]);
  });

  test('a job running past its p90 means "any moment", not negative time', () => {
    const eta = estimateQueue({
      queue: [queued(1, 'o/web', 'ci', 'repo-capacity')],
      active: [running('o/web', 'e2e', 90)],
      baselines,
      now: NOW,
    }).get(1);
    assert.deepEqual(eta.etaStartMs, [0, 0]);
  });

  test('host saturation waits for the next job anywhere on the host', () => {
    const eta = estimateQueue({
      queue: [queued(1, 'o/web', 'ci', 'host-saturation')],
      active: [running('o/web', 'e2e', 5), running('o/ios', 'ios', 18)],
      baselines,
      now: NOW,
    }).get(1);
    assert.deepEqual(eta.etaStartMs, [2 * MIN, 10 * MIN]);
  });

  test('dispatch delay is under a minute', () => {
    const eta = estimateQueue({ queue: [queued(1, 'o/web', 'ci', 'github-delay')], active: [], baselines, now: NOW }).get(1);
    assert.deepEqual(eta.etaStartMs, [0, MIN]);
  });

  test('structural causes get no estimate at all', () => {
    for (const cause of NEVER_STARTS) {
      const eta = estimateQueue({ queue: [queued(1, 'o/web', 'ci', cause)], active: [], baselines, now: NOW }).get(1);
      assert.equal(eta.etaStartMs, null, cause);
      assert.equal(eta.etaDoneMs, null, cause);
    }
  });

  test('no history for the workflow: a start range, no finish', () => {
    const eta = estimateQueue({ queue: [queued(1, 'o/new', 'x', 'repo-capacity')], active: [], baselines, now: NOW }).get(1);
    assert.deepEqual(eta.etaStartMs, [0, 2 * MIN]);
    assert.equal(eta.etaDoneMs, null);
  });
});
