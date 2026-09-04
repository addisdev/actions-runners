import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { replayScenario, compareScenarios } from '../lib/simulator.js';

// A hand-worked timeline, so the assertions below are checkable by reading
// rather than by trusting the implementation that produced them.
//
// Base time is arbitrary but fixed. Three jobs for one repo, each 10 minutes
// long, all arriving at the same instant:
//
//   one runner:  job A runs 0–10, B waits 10 and runs 10–20, C waits 20.
//   two runners: A and B both run 0–10, C waits 10.
//   three:       all three run 0–10, nobody waits.
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const TEN_MIN = 10 * 60_000;

function job(id, repo, arrivalTs, waitMs, durationMs) {
  return {
    id,
    repo,
    started_at: new Date(arrivalTs + waitMs).toISOString(),
    queued_ms: waitMs,
    duration_ms: durationMs,
  };
}

// Three simultaneous arrivals, ten minutes each. Recorded waits are zero
// because the replay recomputes them from the hypothetical runner count — the
// historical wait is deliberately not an input to the answer.
const SIMULTANEOUS = [
  job(1, 'o/r', T0, 0, TEN_MIN),
  job(2, 'o/r', T0, 0, TEN_MIN),
  job(3, 'o/r', T0, 0, TEN_MIN),
];

describe('replayScenario — hand-worked timelines', () => {
  test('one runner serializes three simultaneous jobs', () => {
    const { scenario } = replayScenario(SIMULTANEOUS, new Map([['o/r', 1]]));
    assert.equal(scenario.replayedCount, 3);
    // Waits are 0, 10min, 20min. p50 of [0, 600000, 1200000] is the middle.
    assert.equal(scenario.p50WaitMs, TEN_MIN);
    assert.equal(scenario.peakSimultaneous, 1);
    // 30 minutes of work total.
    assert.equal(scenario.totalRunnerHours, 0.5);
  });

  test('two runners halve the worst wait', () => {
    const { scenario } = replayScenario(SIMULTANEOUS, new Map([['o/r', 2]]));
    // Waits are 0, 0, 10min.
    assert.equal(scenario.p50WaitMs, 0);
    assert.equal(scenario.peakSimultaneous, 2);
  });

  test('three runners eliminate the queue', () => {
    const { scenario } = replayScenario(SIMULTANEOUS, new Map([['o/r', 3]]));
    assert.equal(scenario.p50WaitMs, 0);
    assert.equal(scenario.p90WaitMs, 0);
    assert.equal(scenario.peakSimultaneous, 3);
  });

  test('a fourth runner changes nothing', () => {
    const three = replayScenario(SIMULTANEOUS, new Map([['o/r', 3]])).scenario;
    const four = replayScenario(SIMULTANEOUS, new Map([['o/r', 4]])).scenario;
    assert.deepEqual(
      [four.p50WaitMs, four.p90WaitMs, four.peakSimultaneous],
      [three.p50WaitMs, three.p90WaitMs, three.peakSimultaneous]
    );
  });

  test('staggered arrivals never queue on one runner', () => {
    // Each job arrives after the previous one finished.
    const staggered = [
      job(1, 'o/r', T0, 0, TEN_MIN),
      job(2, 'o/r', T0 + TEN_MIN, 0, TEN_MIN),
      job(3, 'o/r', T0 + 2 * TEN_MIN, 0, TEN_MIN),
    ];
    const { scenario } = replayScenario(staggered, new Map([['o/r', 1]]));
    assert.equal(scenario.p90WaitMs, 0);
    assert.equal(scenario.peakSimultaneous, 1);
  });

  test('a repo with no runner configured is reported unserved, not zero-wait', () => {
    const { scenario } = replayScenario(SIMULTANEOUS, new Map([['other/repo', 2]]));
    assert.equal(scenario.unservedCount, 3);
    assert.equal(scenario.replayedCount, 0);
  });

  test('unserved jobs are not counted as SLO breaches', () => {
    // A narrow scenario is a coverage gap, not a performance disaster. Counting
    // unreplayed jobs against the SLO reported "100% over SLO" for a fleet whose
    // repos simply were not in the scenario.
    const { scenario } = replayScenario(SIMULTANEOUS, new Map([['other/repo', 2]]));
    assert.equal(scenario.overSloCount, 0);
    assert.equal(scenario.overSloPct, 0);
  });

  test('the SLO percentage is out of replayed jobs, not all jobs seen', () => {
    // Three jobs for o/r on one runner (waits 0, 10m, 20m — two breach a 5m SLO)
    // plus three jobs for a repo the scenario says nothing about.
    const mixed = [
      ...SIMULTANEOUS,
      job(4, 'other/repo', T0, 0, TEN_MIN),
      job(5, 'other/repo', T0, 0, TEN_MIN),
      job(6, 'other/repo', T0, 0, TEN_MIN),
    ];
    const { scenario } = replayScenario(mixed, new Map([['o/r', 1]]), { sloMs: 5 * 60_000 });
    assert.equal(scenario.replayedCount, 3);
    assert.equal(scenario.unservedCount, 3);
    assert.equal(scenario.overSloCount, 2);
    // 2 of the 3 replayed, not 2 of 6.
    assert.equal(scenario.overSloPct, 67);
  });

  test('jobs missing the fields needed to replay are excluded', () => {
    const incomplete = [
      job(1, 'o/r', T0, 0, TEN_MIN),
      { id: 2, repo: 'o/r', started_at: null, queued_ms: 0, duration_ms: TEN_MIN },
      { id: 3, repo: 'o/r', started_at: new Date(T0).toISOString(), queued_ms: null, duration_ms: null },
    ];
    const { scenario } = replayScenario(incomplete, new Map([['o/r', 1]]));
    assert.equal(scenario.jobCount, 1);
  });

  test('an empty window reports an error rather than fabricating zeros', () => {
    const out = replayScenario([], new Map([['o/r', 1]]));
    assert.ok(out.error);
    assert.equal(out.scenarios, null);
  });

  test('SLO breaches are counted against the configured threshold', () => {
    // One runner, three 10-minute jobs: waits of 0, 10min, 20min. With a
    // 5-minute SLO, two of the three breach it.
    const { scenario } = replayScenario(SIMULTANEOUS, new Map([['o/r', 1]]), { sloMs: 5 * 60_000 });
    assert.equal(scenario.overSloCount, 2);
    assert.equal(scenario.overSloPct, 67);
  });

  test('replay is deterministic across runs', () => {
    const a = replayScenario(SIMULTANEOUS, new Map([['o/r', 2]])).scenario;
    const b = replayScenario(SIMULTANEOUS, new Map([['o/r', 2]])).scenario;
    assert.deepEqual(a, b);
  });
});

describe('compareScenarios', () => {
  test('reports the improvement from adding a runner', () => {
    const { current, proposed, delta } = compareScenarios(
      SIMULTANEOUS,
      new Map([['o/r', 1]]),
      new Map([['o/r', 3]])
    );
    assert.equal(current.p50WaitMs, TEN_MIN);
    assert.equal(proposed.p50WaitMs, 0);
    // Negative delta means the proposal is better, which is the direction the
    // UI relies on to colour the number.
    assert.ok(delta.p50WaitMs < 0);
    // Same jobs, same durations — total work does not change when runners do.
    assert.equal(delta.totalRunnerHours, 0);
  });

  test('reports no change when the proposal is already the current shape', () => {
    const { delta } = compareScenarios(SIMULTANEOUS, new Map([['o/r', 2]]), new Map([['o/r', 2]]));
    for (const v of Object.values(delta)) assert.equal(v, 0);
  });
});
