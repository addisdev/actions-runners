// Backtested against the real 2026-09-28 run-up to the disk-floor freeze.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitDisk, forecastDisk } from '../lib/disk-forecast.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'snapshots', 'disk-2026-09-26.json'), 'utf8'));
const S = REC.samples;
const HOUR = 3600 * 1000;
const breach = S.find(([, g]) => g < REC.floorGb)[0];

describe('disk floor forecast, backtested', () => {
  test('warns (floor within 12 h) at least 6 h before the real breach', () => {
    const firstWarning = S.map(([t]) => t).find((t) => {
      const f = forecastDisk(S, { now: t, floorGb: REC.floorGb });
      return f.etaMs != null && f.etaMs < 12 * HOUR;
    });
    assert.ok(firstWarning, 'never warned');
    const leadH = (breach - firstWarning) / HOUR;
    assert.ok(leadH >= 6, `warned only ${leadH.toFixed(1)} h ahead`);
  });

  test('eight hours out, the estimate is in the right range', () => {
    const now = S.map(([t]) => t).filter((t) => t <= breach - 8 * HOUR).at(-1);
    const f = forecastDisk(S, { now, floorGb: REC.floorGb });
    assert.ok(f.etaMs > 3 * HOUR && f.etaMs < 16 * HOUR, `${(f.etaMs / HOUR).toFixed(1)} h`);
  });

  test('no false alarm through the two quiet days before the run-up', () => {
    const quiet = S.filter(([t]) => t < S[0][0] + 48 * HOUR);
    for (const [t] of quiet) {
      const f = forecastDisk(S, { now: t, floorGb: REC.floorGb });
      assert.ok(f.etaMs == null || f.etaMs > 24 * HOUR, `false alarm at ${new Date(t).toISOString()}: ${(f.etaMs / HOUR).toFixed(1)} h`);
    }
  });
});

describe('fitDisk edges', () => {
  const line = (n, start, perHour) => Array.from({ length: n }, (_, i) => [i * HOUR / 6, start + (perHour * i) / 6]);
  test('a steady 2 GB/h fall from 60 GB meets a 40 GB floor in 10 h', () => {
    const s = line(37, 72, -2);
    const f = fitDisk(s, { now: s.at(-1)[0], windowMs: 6 * HOUR, floorGb: 40 });
    assert.equal(f.rateGbPerHour, -2);
    assert.equal(Math.round(f.etaMs / HOUR), 10);
  });
  test('rising, flat, sparse, or already under the floor: no date', () => {
    const up = line(37, 60, 1);
    assert.equal(fitDisk(up, { now: up.at(-1)[0], windowMs: 6 * HOUR, floorGb: 40 }).etaMs, null);
    const sparse = line(3, 60, -5);
    assert.equal(fitDisk(sparse, { now: sparse.at(-1)[0], windowMs: 6 * HOUR, floorGb: 40 }).etaMs, null);
    const under = line(37, 45, -2);
    assert.equal(fitDisk(under, { now: under.at(-1)[0], windowMs: 6 * HOUR, floorGb: 40 }).etaMs, null);
  });
});
