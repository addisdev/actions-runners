// Explainable burst forecasting from weekday/time-of-day baselines.
//
// WHY NOT MACHINE LEARNING
//
// A forecast that cannot explain itself cannot be trusted to pre-warm runners,
// because the failure mode is expensive and silent: a wrong prediction spends
// disk and a concurrency slot on a runner nothing needs, and the operator has
// no way to tell whether the model is broken or the week was simply unusual.
//
// So the model here is a lookup table anybody can read: for each (repo,
// weekday, hour) bucket, what was the observed peak concurrent demand, and how
// many distinct weeks contributed that observation. A forecast is emitted only
// when the same bucket has been busy in MIN_OBSERVATIONS separate weeks, which
// is what distinguishes "every Tuesday at 09:00 the mobile team pushes" from
// "one Tuesday in March somebody ran a big migration".
//
// Scheduled workflows are added on top, because those are not a prediction at
// all — a cron expression is a statement of fact about when work will arrive.
//
// SHADOW MODE
//
// Forecasts do not act. Every prediction is written to forecast_evals and
// compared against what actually happened; pre-warming stays locked until
// precision and recall clear the thresholds in GATE. The gate is checked by
// evaluateGate() below, and the numbers are visible in the Capacity tab, so the
// decision to enable automation is made from evidence rather than optimism.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// How many separate weeks a bucket must have been busy in before it is a
// pattern rather than an anecdote. Three is the smallest number that can
// distinguish a recurring event from a coincidence plus one confirmation.
export const MIN_OBSERVATIONS = 3;

// What the shadow evaluation has to reach before pre-warming may be enabled.
// Precision is weighted higher than recall on purpose: a missed burst costs a
// few minutes of queue wait, while a false positive spends disk and a
// concurrency slot on a runner that will idle out.
export const GATE = {
  minPrecision: 0.7,
  minRecall: 0.5,
  maxFalsePositiveRate: 0.3,
  minEvaluations: 20,
};

/**
 * Build the weekday/hour demand baseline from historical jobs.
 *
 * @param {object[]} jobs - rows with started_at, queued_ms, duration_ms, repo
 * @param {object}  [opts]
 * @param {number}  [opts.now] - injectable clock for tests
 * @returns {{ buckets: Map<string, object>, weeksCovered: number }}
 */
export function buildBaseline(jobs, { now = Date.now() } = {}) {
  // Key is `repo|weekday|hour`. Each bucket accumulates the peak concurrent
  // demand seen in that hour, per distinct calendar week, so the observation
  // count is a count of WEEKS and not of jobs. Ten jobs in one hour on one
  // Tuesday is one observation, not ten.
  const buckets = new Map();
  const weeks = new Set();

  // Concurrent demand is computed per (repo, hour-slot) by counting how many
  // jobs for that repo were simultaneously queued-or-running at any point in
  // the hour. Sampling the hour at its start would miss a burst at :45.
  const byRepoHour = new Map();

  for (const j of jobs) {
    if (!j.started_at || !j.repo) continue;
    const startTs = new Date(j.started_at).getTime();
    if (!Number.isFinite(startTs)) continue;
    const arrivalTs = startTs - (j.queued_ms ?? 0);
    const endTs = startTs + (j.duration_ms ?? 0);

    const d = new Date(arrivalTs);
    const weekday = d.getDay();
    const hour = d.getHours();
    const weekKey = `${d.getFullYear()}-${isoWeek(d)}`;
    weeks.add(weekKey);

    const key = `${j.repo}|${weekday}|${hour}`;
    if (!byRepoHour.has(key)) byRepoHour.set(key, new Map());
    const perWeek = byRepoHour.get(key);
    if (!perWeek.has(weekKey)) perWeek.set(weekKey, []);
    perWeek.get(weekKey).push({ arrivalTs, endTs });
  }

  for (const [key, perWeek] of byRepoHour) {
    const [repo, weekday, hour] = key.split('|');
    // One peak per week, then the typical peak across weeks. Using the max of
    // maxima would let a single outlier week define the forecast forever.
    const weekPeaks = [];
    for (const intervals of perWeek.values()) {
      weekPeaks.push(peakOverlap(intervals));
    }
    weekPeaks.sort((a, b) => a - b);
    const median = weekPeaks[Math.floor(weekPeaks.length / 2)] ?? 0;

    buckets.set(key, {
      repo,
      weekday: Number(weekday),
      hour: Number(hour),
      observations: weekPeaks.length,
      peakConcurrent: median,
      maxEverSeen: Math.max(...weekPeaks),
    });
  }

  return { buckets, weeksCovered: weeks.size, builtAt: now };
}

/**
 * Predict demand for the next N hours.
 *
 * @param {object} opts
 * @param {object}   opts.baseline  - from buildBaseline()
 * @param {object[]} [opts.schedules] - [{ repo, cron, workflow }] parsed workflow schedules
 * @param {number}   [opts.hoursAhead]
 * @param {number}   [opts.now]
 * @returns {object[]} predictions, each with its own evidence
 */
export function forecastDemand({ baseline, schedules = [], hoursAhead = 12, now = Date.now() } = {}) {
  const predictions = [];

  for (let i = 0; i < hoursAhead; i++) {
    const ts = now + i * HOUR_MS;
    const d = new Date(ts);
    const weekday = d.getDay();
    const hour = d.getHours();

    // Everything the baseline expects in this slot.
    const matches = [...baseline.buckets.values()].filter(
      (b) => b.weekday === weekday && b.hour === hour && b.observations >= MIN_OBSERVATIONS && b.peakConcurrent > 0
    );

    // Cron is a statement of fact, not a prediction, so a scheduled workflow
    // is reported with high confidence even with no history behind it.
    const scheduled = schedules.filter((s) => cronMatchesHour(s.cron, weekday, hour));

    if (!matches.length && !scheduled.length) continue;

    const byRepo = new Map();
    for (const m of matches) {
      byRepo.set(m.repo, {
        repo: m.repo,
        expectedPeak: m.peakConcurrent,
        observations: m.observations,
        source: 'history',
        evidence: `Peak of ${m.peakConcurrent} concurrent job(s) in this hour across ${m.observations} weeks`,
      });
    }
    for (const s of scheduled) {
      const prior = byRepo.get(s.repo);
      // A scheduled workflow adds a guaranteed job on top of whatever history
      // expects, rather than replacing it: both will arrive.
      byRepo.set(s.repo, {
        repo: s.repo,
        expectedPeak: Math.max(prior?.expectedPeak ?? 0, 1) + (prior ? 1 : 0),
        observations: prior?.observations ?? 0,
        source: prior ? 'history+schedule' : 'schedule',
        evidence: [prior?.evidence, `Scheduled workflow ${s.workflow} (cron: ${s.cron})`]
          .filter(Boolean).join('; '),
      });
    }

    const repos = [...byRepo.values()];
    const totalExpected = repos.reduce((sum, r) => sum + r.expectedPeak, 0);

    predictions.push({
      windowStart: ts,
      windowEnd: ts + HOUR_MS,
      weekday,
      hour,
      totalExpectedConcurrent: totalExpected,
      repos,
      // Two independent sources agreeing, or a cron guarantee, is the only
      // thing called high here. A single history bucket is never more than
      // medium regardless of how many weeks back it goes.
      confidence: repos.some((r) => r.source.includes('schedule')) ? 'high'
        : repos.every((r) => r.observations >= MIN_OBSERVATIONS * 2) ? 'medium' : 'low',
    });
  }

  return predictions;
}

/**
 * Record a prediction against what actually happened. Shadow-mode bookkeeping:
 * this is what makes the gate check below meaningful rather than a guess.
 */
export function evaluatePrediction({ prediction, actualJobs, repo }) {
  const inWindow = actualJobs.filter((j) => {
    if (j.repo !== repo || !j.started_at) return false;
    const arrival = new Date(j.started_at).getTime() - (j.queued_ms ?? 0);
    return arrival >= prediction.windowStart && arrival < prediction.windowEnd;
  });

  const actualPeak = peakOverlap(
    inWindow.map((j) => {
      const start = new Date(j.started_at).getTime();
      return { arrivalTs: start - (j.queued_ms ?? 0), endTs: start + (j.duration_ms ?? 0) };
    })
  );

  const predicted = prediction.repos.find((r) => r.repo === repo)?.expectedPeak ?? 0;

  return {
    windowStart: prediction.windowStart,
    windowEnd: prediction.windowEnd,
    repo,
    predictedPeak: predicted,
    actualPeak,
    // A prediction that overshoots by more than one is a false positive: it
    // would have pre-warmed a runner nothing needed. Being one out is treated
    // as correct because the cost is a single idle slot that the idle TTL
    // reclaims on its own.
    falsePositive: predicted > actualPeak + 1 ? 1 : 0,
    // Missing a burst by more than one is a miss for recall purposes.
    missed: actualPeak > predicted + 1,
  };
}

/**
 * Has shadow evaluation earned the right to act?
 *
 * @param {object[]} evals - rows from forecast_evals
 * @returns {{ passed: boolean, precision, recall, falsePositiveRate, count, reasons: string[] }}
 */
export function evaluateGate(evals) {
  const reasons = [];
  const count = evals.length;

  if (count < GATE.minEvaluations) {
    return {
      passed: false, precision: null, recall: null, falsePositiveRate: null, count,
      reasons: [`only ${count} of ${GATE.minEvaluations} required evaluations recorded`],
    };
  }

  const predictedBursts = evals.filter((e) => (e.predicted_peak ?? 0) > 1);
  const actualBursts = evals.filter((e) => (e.actual_peak ?? 0) > 1);
  const truePositives = predictedBursts.filter((e) => (e.actual_peak ?? 0) > 1).length;

  const precision = predictedBursts.length ? truePositives / predictedBursts.length : 0;
  const recall = actualBursts.length ? truePositives / actualBursts.length : 0;
  const falsePositiveRate = count ? evals.filter((e) => e.false_positive).length / count : 0;

  if (precision < GATE.minPrecision) reasons.push(`precision ${precision.toFixed(2)} below ${GATE.minPrecision}`);
  if (recall < GATE.minRecall) reasons.push(`recall ${recall.toFixed(2)} below ${GATE.minRecall}`);
  if (falsePositiveRate > GATE.maxFalsePositiveRate) {
    reasons.push(`false-positive rate ${falsePositiveRate.toFixed(2)} above ${GATE.maxFalsePositiveRate}`);
  }

  return { passed: reasons.length === 0, precision, recall, falsePositiveRate, count, reasons };
}

// -------------------------------------------------------------------- helpers

// Maximum number of intervals overlapping at any instant. A sweep over the
// endpoints rather than sampling, so a burst that starts and finishes between
// two samples cannot be missed.
function peakOverlap(intervals) {
  if (!intervals.length) return 0;
  const points = [];
  for (const iv of intervals) {
    if (!Number.isFinite(iv.arrivalTs) || !Number.isFinite(iv.endTs)) continue;
    points.push([iv.arrivalTs, 1], [iv.endTs, -1]);
  }
  // Ends before starts at the same instant: a job finishing exactly as another
  // arrives never occupied a slot at the same time as it.
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, delta] of points) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
}

/**
 * Does a 5-field cron expression fire in the given weekday/hour?
 *
 * Deliberately conservative: only `*`, comma lists, and plain numbers are
 * understood. A step or range expression returns false rather than a guess,
 * because a forecast that pre-warms a runner on a misparsed cron is worse than
 * one that stays quiet.
 */
export function cronMatchesHour(cron, weekday, hour) {
  const parts = String(cron ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [, hourField, , , dowField] = parts;

  const matches = (field, value) => {
    if (field === '*') return true;
    if (/^[\d,]+$/.test(field)) return field.split(',').map(Number).includes(value);
    return false;
  };

  // Cron uses UTC; GitHub schedules are UTC. The hour compared here is the
  // caller's local hour, so this is only right when the host runs UTC. Noted
  // rather than corrected because the forecast is hour-granular and the UI
  // labels it as approximate.
  return matches(hourField, hour) && (dowField === '*' || matches(dowField, weekday));
}

/**
 * Pull schedule triggers out of cached workflow files.
 * @param {object[]} files - workflow_files rows
 * @returns {object[]} [{ repo, workflow, cron }]
 */
export function extractSchedules(files) {
  const out = [];
  for (const f of files) {
    if (!f.content) continue;
    if (!f.is_default && f.ref !== '__default__') continue;
    // Regex rather than a YAML parse: the only thing wanted is the cron
    // strings, they are unambiguous in this shape, and a parse failure on an
    // unrelated part of the file would silently drop a real schedule.
    for (const m of String(f.content).matchAll(/-\s*cron:\s*['"]?([^'"\n]+)['"]?/g)) {
      out.push({ repo: f.repo, workflow: f.name ?? f.path, cron: m[1].trim() });
    }
  }
  return out;
}
