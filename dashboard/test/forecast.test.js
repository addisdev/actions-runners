import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBaseline, forecastDemand, evaluatePrediction, evaluateGate,
  cronMatchesHour, extractSchedules, MIN_OBSERVATIONS, GATE,
} from '../lib/forecast.js';

const TEN_MIN = 10 * 60_000;

// A Monday at 09:00 local, and the same slot in preceding weeks.
function mondayAt9(weeksAgo) {
  const d = new Date(2026, 0, 5, 9, 0, 0); // Mon 5 Jan 2026
  d.setDate(d.getDate() - weeksAgo * 7);
  return d.getTime();
}

function job(id, repo, arrivalTs, durationMs = TEN_MIN) {
  return {
    id, repo,
    started_at: new Date(arrivalTs).toISOString(),
    queued_ms: 0,
    duration_ms: durationMs,
  };
}

describe('buildBaseline', () => {
  test('counts weeks, not jobs', () => {
    // Ten jobs, all in one hour on one Monday. That is ONE observation of the
    // bucket, not ten — otherwise a single busy morning clears the threshold.
    const jobs = Array.from({ length: 10 }, (_, i) => job(i, 'o/r', mondayAt9(0) + i * 1000));
    const { buckets } = buildBaseline(jobs);
    const bucket = buckets.get('o/r|1|9');
    assert.equal(bucket.observations, 1);
  });

  test('accumulates an observation per distinct week', () => {
    const jobs = [0, 1, 2, 3].flatMap((w) => [
      job(w * 10, 'o/r', mondayAt9(w)),
      job(w * 10 + 1, 'o/r', mondayAt9(w) + 1000),
    ]);
    const { buckets } = buildBaseline(jobs);
    assert.equal(buckets.get('o/r|1|9').observations, 4);
  });

  test('peak is the median week, so one outlier week cannot define it', () => {
    // Three quiet weeks with one job each, one week with six overlapping jobs.
    const quiet = [1, 2, 3].map((w) => job(w * 10, 'o/r', mondayAt9(w)));
    const spike = Array.from({ length: 6 }, (_, i) => job(100 + i, 'o/r', mondayAt9(0) + i * 1000));
    const { buckets } = buildBaseline([...quiet, ...spike]);
    const bucket = buckets.get('o/r|1|9');
    assert.equal(bucket.maxEverSeen, 6);
    // The median of [1, 1, 1, 6] must not be the spike.
    assert.ok(bucket.peakConcurrent <= 1, `median peak was ${bucket.peakConcurrent}`);
  });

  test('overlapping jobs raise the peak, sequential ones do not', () => {
    const overlapping = buildBaseline([
      job(1, 'o/r', mondayAt9(0), TEN_MIN),
      job(2, 'o/r', mondayAt9(0) + 60_000, TEN_MIN),
    ]).buckets.get('o/r|1|9');
    const sequential = buildBaseline([
      job(1, 'o/r', mondayAt9(0), TEN_MIN),
      job(2, 'o/r', mondayAt9(0) + TEN_MIN + 1000, TEN_MIN),
    ]).buckets.get('o/r|1|9');
    assert.equal(overlapping.peakConcurrent, 2);
    assert.equal(sequential.peakConcurrent, 1);
  });

  test('jobs with no usable timestamp are skipped', () => {
    const { buckets } = buildBaseline([
      job(1, 'o/r', mondayAt9(0)),
      { id: 2, repo: 'o/r', started_at: null },
      { id: 3, repo: null, started_at: new Date(mondayAt9(0)).toISOString() },
    ]);
    assert.equal(buckets.get('o/r|1|9').observations, 1);
  });
});

describe('forecastDemand', () => {
  // Enough weeks of two overlapping jobs every Monday at 09:00 to be a pattern.
  const recurring = Array.from({ length: MIN_OBSERVATIONS + 1 }, (_, w) => [
    job(w * 10, 'o/r', mondayAt9(w), TEN_MIN),
    job(w * 10 + 1, 'o/r', mondayAt9(w) + 60_000, TEN_MIN),
  ]).flat();

  test('emits nothing below the observation threshold', () => {
    // Two weeks only, where three are required.
    const thin = [0, 1].flatMap((w) => [
      job(w * 10, 'o/r', mondayAt9(w)),
      job(w * 10 + 1, 'o/r', mondayAt9(w) + 60_000),
    ]);
    const baseline = buildBaseline(thin);
    const out = forecastDemand({ baseline, now: mondayAt9(-1), hoursAhead: 2 });
    assert.equal(out.length, 0);
  });

  test('emits a prediction once the pattern recurs often enough', () => {
    const baseline = buildBaseline(recurring);
    // Forecast from 08:00 next Monday, so the 09:00 slot is in range.
    const out = forecastDemand({ baseline, now: mondayAt9(-1) - 3600_000, hoursAhead: 3 });
    assert.ok(out.length > 0, 'expected at least one prediction');
    const nine = out.find((p) => p.hour === 9);
    assert.ok(nine, 'expected a prediction for the 09:00 slot');
    assert.equal(nine.repos[0].repo, 'o/r');
    assert.equal(nine.repos[0].source, 'history');
  });

  test('history alone is never high confidence', () => {
    const baseline = buildBaseline(recurring);
    const out = forecastDemand({ baseline, now: mondayAt9(-1) - 3600_000, hoursAhead: 3 });
    for (const p of out) assert.notEqual(p.confidence, 'high');
  });

  test('a cron schedule is high confidence with no history at all', () => {
    const baseline = { buckets: new Map(), weeksCovered: 0 };
    const now = mondayAt9(-1) - 3600_000;
    const hour = new Date(mondayAt9(-1)).getHours();
    const out = forecastDemand({
      baseline,
      schedules: [{ repo: 'o/r', workflow: 'Nightly', cron: `0 ${hour} * * *` }],
      now, hoursAhead: 3,
    });
    const hit = out.find((p) => p.hour === hour);
    assert.ok(hit, 'expected a prediction from the schedule');
    assert.equal(hit.confidence, 'high');
    assert.equal(hit.repos[0].source, 'schedule');
  });

  test('a schedule adds to history rather than replacing it', () => {
    const baseline = buildBaseline(recurring);
    const now = mondayAt9(-1) - 3600_000;
    const hour = new Date(mondayAt9(-1)).getHours();
    const withSchedule = forecastDemand({
      baseline,
      schedules: [{ repo: 'o/r', workflow: 'Nightly', cron: `0 ${hour} * * *` }],
      now, hoursAhead: 3,
    }).find((p) => p.hour === hour);
    const historyOnly = forecastDemand({ baseline, now, hoursAhead: 3 }).find((p) => p.hour === hour);
    assert.ok(withSchedule.repos[0].expectedPeak > historyOnly.repos[0].expectedPeak);
    assert.equal(withSchedule.repos[0].source, 'history+schedule');
  });
});

describe('cronMatchesHour', () => {
  test('matches a plain hour and wildcard weekday', () => {
    assert.equal(cronMatchesHour('0 2 * * *', 3, 2), true);
    assert.equal(cronMatchesHour('0 2 * * *', 3, 3), false);
  });

  test('matches a comma list', () => {
    assert.equal(cronMatchesHour('0 2,14 * * *', 1, 14), true);
    assert.equal(cronMatchesHour('0 2,14 * * *', 1, 15), false);
  });

  test('honours a weekday restriction', () => {
    assert.equal(cronMatchesHour('0 9 * * 1', 1, 9), true);
    assert.equal(cronMatchesHour('0 9 * * 1', 2, 9), false);
  });

  test('refuses to guess at step and range expressions', () => {
    // Both of these genuinely fire at hour 6, but the parser does not read them
    // and must say no rather than guess.
    assert.equal(cronMatchesHour('0 */6 * * *', 1, 6), false);
    assert.equal(cronMatchesHour('0 5-8 * * *', 1, 6), false);
  });

  test('rejects malformed input', () => {
    assert.equal(cronMatchesHour('', 1, 9), false);
    assert.equal(cronMatchesHour('0 9 *', 1, 9), false);
    assert.equal(cronMatchesHour(null, 1, 9), false);
  });
});

describe('extractSchedules', () => {
  test('pulls cron strings from default-branch files only', () => {
    const out = extractSchedules([
      { repo: 'o/r', path: '.github/workflows/n.yml', name: 'Nightly', is_default: 1,
        content: "on:\n  schedule:\n    - cron: '0 2 * * *'\n" },
      { repo: 'o/r', path: '.github/workflows/x.yml', name: 'Branch', is_default: 0, ref: 'feature',
        content: "on:\n  schedule:\n    - cron: '0 3 * * *'\n" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].cron, '0 2 * * *');
  });

  test('handles several schedules in one file', () => {
    const out = extractSchedules([
      { repo: 'o/r', path: 'w.yml', name: 'W', is_default: 1,
        content: "on:\n  schedule:\n    - cron: '0 2 * * *'\n    - cron: '0 14 * * *'\n" },
    ]);
    assert.equal(out.length, 2);
  });

  test('ignores files with no content', () => {
    assert.equal(extractSchedules([{ repo: 'o/r', path: 'w.yml', is_default: 1, content: null }]).length, 0);
  });
});

describe('evaluatePrediction', () => {
  const prediction = {
    windowStart: mondayAt9(0),
    windowEnd: mondayAt9(0) + 3600_000,
    repos: [{ repo: 'o/r', expectedPeak: 3 }],
  };

  test('a correct prediction is neither a false positive nor a miss', () => {
    const actual = Array.from({ length: 3 }, (_, i) => job(i, 'o/r', mondayAt9(0) + i * 1000));
    const out = evaluatePrediction({ prediction, actualJobs: actual, repo: 'o/r' });
    assert.equal(out.actualPeak, 3);
    assert.equal(out.falsePositive, 0);
    assert.equal(out.missed, false);
  });

  test('overshooting by more than one is a false positive', () => {
    const actual = [job(1, 'o/r', mondayAt9(0))];
    const out = evaluatePrediction({ prediction, actualJobs: actual, repo: 'o/r' });
    assert.equal(out.falsePositive, 1);
  });

  test('being one out is forgiven, because the idle TTL reclaims one slot', () => {
    const actual = [job(1, 'o/r', mondayAt9(0)), job(2, 'o/r', mondayAt9(0) + 1000)];
    const out = evaluatePrediction({ prediction, actualJobs: actual, repo: 'o/r' });
    assert.equal(out.actualPeak, 2);
    assert.equal(out.falsePositive, 0);
  });

  test('undershooting a real burst is a miss', () => {
    const low = { ...prediction, repos: [{ repo: 'o/r', expectedPeak: 1 }] };
    const actual = Array.from({ length: 5 }, (_, i) => job(i, 'o/r', mondayAt9(0) + i * 1000));
    const out = evaluatePrediction({ prediction: low, actualJobs: actual, repo: 'o/r' });
    assert.equal(out.missed, true);
  });

  test('jobs outside the window are not counted', () => {
    const actual = [job(1, 'o/r', mondayAt9(0) + 2 * 3600_000)];
    const out = evaluatePrediction({ prediction, actualJobs: actual, repo: 'o/r' });
    assert.equal(out.actualPeak, 0);
  });

  test('another repo\'s jobs are not counted', () => {
    const actual = Array.from({ length: 3 }, (_, i) => job(i, 'other/repo', mondayAt9(0) + i * 1000));
    const out = evaluatePrediction({ prediction, actualJobs: actual, repo: 'o/r' });
    assert.equal(out.actualPeak, 0);
  });
});

describe('evaluateGate — automation stays locked until evidence allows it', () => {
  const evalRow = (predicted, actual, fp = 0) =>
    ({ predicted_peak: predicted, actual_peak: actual, false_positive: fp });

  test('too few evaluations does not pass, whatever the accuracy', () => {
    const perfect = Array.from({ length: GATE.minEvaluations - 1 }, () => evalRow(3, 3));
    const gate = evaluateGate(perfect);
    assert.equal(gate.passed, false);
    assert.match(gate.reasons[0], /evaluations/);
  });

  test('an empty history does not pass', () => {
    assert.equal(evaluateGate([]).passed, false);
  });

  test('accurate predictions over enough evaluations pass', () => {
    const good = Array.from({ length: GATE.minEvaluations + 5 }, () => evalRow(3, 3));
    const gate = evaluateGate(good);
    assert.equal(gate.passed, true, gate.reasons.join('; '));
    assert.equal(gate.precision, 1);
    assert.equal(gate.recall, 1);
  });

  test('predicting bursts that never happen fails on precision', () => {
    const bad = Array.from({ length: GATE.minEvaluations + 5 }, () => evalRow(4, 1, 1));
    const gate = evaluateGate(bad);
    assert.equal(gate.passed, false);
    assert.ok(gate.reasons.some((r) => /precision/.test(r)));
  });

  test('missing most real bursts fails on recall', () => {
    // Predicts no burst; bursts happen anyway.
    const missed = Array.from({ length: GATE.minEvaluations + 5 }, () => evalRow(1, 4));
    const gate = evaluateGate(missed);
    assert.equal(gate.passed, false);
    assert.ok(gate.reasons.some((r) => /recall/.test(r)));
  });
});
