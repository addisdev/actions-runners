import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQueueCause, CAUSES, RECOMMENDED } from '../lib/queue-cause.js';
import { makeRunner, makeActiveRun } from './fixtures/index.js';

// A run whose job is genuinely queued and carries labels this fleet's runners
// serve, so classification reaches the headroom branch instead of exiting early
// at "GitHub has not created any jobs yet".
function queuedRun() {
  return makeActiveRun({
    jobs: [{ name: 'ci / build', status: 'queued', labels: ['self-hosted', 'macos', 'arm64'] }],
  });
}

// The observed misdiagnosis, pinned.
//
// Five queued jobs for one repo were reported as SERIOUS "host
// saturation" with high confidence, and the recommendation read "Do not add
// another runner on this host." At that moment 42 of the host's 43 runners were
// idle, one job was executing, and load was 1.1x per core. The only thing
// refusing was the runner-count limit — 43 against a maxTotalRunners of 32 that
// was still on its default while scaleDown was off.
//
// Counting refusals and busy refusals need opposite advice, so they are now
// separate causes. These tests fail if they are ever collapsed back together.

// Shaped like a real headroom() result: busy and ceiling are host-wide.
const COUNT_REFUSAL = {
  ok: false, busy: 1, ceiling: 3, maxTotalRunners: 32,
  reasons: ['43 runners already exist, the fleet limit of 32 (a disk and memory bound on how many runners may exist — concurrent jobs are capped separately by admission control)'],
};
const BUSY_COUNT_REFUSAL = {
  ok: false, busy: 3, ceiling: 3, maxTotalRunners: 32,
  reasons: ['43 runners already exist, the fleet limit of 32', '3 job(s) already running, at the limit of 3 for adding more'],
};
const LOAD_REFUSAL = {
  ok: false, busy: 0, ceiling: 3, maxTotalRunners: 64,
  reasons: ['load 321 on 12 cores is 26.7x per core (limit 25x)'],
};

// The runners serving the queued repo. In the real incident this was a single
// runner, busy — which is exactly why host busyness must not be read from here.
function repoRunners({ total = 1, busy = 1 } = {}) {
  return Array.from({ length: total }, (_, i) =>
    makeRunner({
      name: `test-host-app-ios-${i + 1}`,
      instance: i + 1,
      ghBusy: i < busy,
      workingLocally: i < busy,
    })
  );
}

describe('a counting limit is not saturation', () => {
  test('mostly-idle host refused on runner count is reported as a fleet limit', () => {
    const r = classifyQueueCause({
      run: queuedRun(),
      runners: repoRunners(),
      capacity: COUNT_REFUSAL,
    });
    assert.equal(r.cause, CAUSES.FLEET_LIMIT);
    assert.notEqual(r.cause, CAUSES.HOST_SATURATION);
  });

  test('its advice does not tell the operator to stop adding runners', () => {
    const advice = RECOMMENDED[CAUSES.FLEET_LIMIT];
    assert.doesNotMatch(advice, /Do not add another runner/i);
    assert.match(advice, /maxTotalRunners|idle/i);
  });

  test('the evidence states how much of the fleet is actually working', () => {
    const r = classifyQueueCause({
      run: queuedRun(),
      runners: repoRunners(),
      capacity: COUNT_REFUSAL,
    });
    assert.ok(
      r.evidence.some((e) => /1 job\(s\) executing host-wide, below the ceiling of 3/.test(e)),
      `expected a busy/total line, got: ${JSON.stringify(r.evidence)}`
    );
  });

  test('a host at its busy ceiling is still host-saturation', () => {
    const r = classifyQueueCause({
      run: queuedRun(),
      runners: repoRunners(),
      capacity: BUSY_COUNT_REFUSAL,
    });
    assert.equal(r.cause, CAUSES.HOST_SATURATION);
  });

  test('a load refusal is saturation even on an idle-looking fleet', () => {
    // Load is the one signal that can be high while this fleet's own runners
    // are idle — the operator's Xcode build competes for the same cores. A
    // non-count reason must never be downgraded to a configured limit.
    const r = classifyQueueCause({
      run: queuedRun(),
      runners: repoRunners(),
      capacity: LOAD_REFUSAL,
    });
    assert.equal(r.cause, CAUSES.HOST_SATURATION);
  });
});
