// When will free disk reach the admission floor?
//
// The floor freezes every runner at once (2026-09-29: jobs held at "Set up
// runner" with no error anywhere). The disk-low alert says the disk IS low;
// by then the fleet is minutes from stopping. What is worth knowing is the
// trend: on 09-28 free space fell from 92 GB to 37 GB in fifteen hours, and a
// straight line through the previous six hours called the breach eight hours
// before it happened.
//
// Two windows, because they answer different questions: six hours sees a
// burst (a matrix of simulator builds eating DerivedData), seventy-two hours
// sees the slow creep of caches and simulator devices. The nearer estimate is
// the one reported. Both abstain when there are too few samples, when the line
// is flat or rising, or when the disk is already under the floor.

const HOUR = 60 * 60 * 1000;

/**
 * Least-squares line through (ts, gb) samples inside the window ending at `now`.
 * @param {Array<[number, number]>} samples  sorted by ts
 * @returns {{rateGbPerHour: number|null, etaMs: number|null, n: number}}
 */
export function fitDisk(samples, { now, windowMs, floorGb, minSamples = 6 }) {
  const pts = samples.filter(([t, g]) => t <= now && t >= now - windowMs && Number.isFinite(g));
  const out = { rateGbPerHour: null, etaMs: null, n: pts.length };
  if (pts.length < minSamples) return out;
  const span = pts[pts.length - 1][0] - pts[0][0];
  if (span < windowMs / 2) return out;

  const xs = pts.map(([t]) => (t - pts[0][0]) / HOUR);
  const ys = pts.map(([, g]) => g);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return out;
  const slope = sxy / sxx;
  out.rateGbPerHour = Math.round(slope * 100) / 100;
  const current = ys[ys.length - 1];
  // Falling at least 50 MB an hour, and still above the floor: anything less is
  // noise from a build writing and deleting its own output.
  if (floorGb != null && slope < -0.05 && current > floorGb) {
    out.etaMs = Math.round(((current - floorGb) / -slope) * HOUR);
  }
  return out;
}

export function forecastDisk(samples, { now, floorGb }) {
  const short = fitDisk(samples, { now, windowMs: 6 * HOUR, floorGb });
  const long = fitDisk(samples, { now, windowMs: 72 * HOUR, floorGb, minSamples: 24 });
  const etas = [short.etaMs, long.etaMs].filter((x) => x != null);
  return {
    rate6hGbPerHour: short.rateGbPerHour,
    eta6hMs: short.etaMs,
    rate72hGbPerHour: long.rateGbPerHour,
    eta72hMs: long.etaMs,
    etaMs: etas.length ? Math.min(...etas) : null,
  };
}

/** Reads the last 72 hours of disk samples; cached for a minute. */
export function createDiskForecaster(db, { ttlMs = 60 * 1000 } = {}) {
  let cache = null;
  const stmt = db.prepare('SELECT ts, disk_free_gb FROM host_samples WHERE ts >= ? ORDER BY ts');
  return (now, floorGb) => {
    if (cache && now - cache.at < ttlMs && cache.floorGb === floorGb) return cache.value;
    let value = null;
    try {
      const rows = stmt.all(now - 72 * HOUR).map((r) => [r.ts, r.disk_free_gb]);
      value = forecastDisk(rows, { now, floorGb });
    } catch { /* no samples table yet */ }
    cache = { at: now, floorGb, value };
    return value;
  };
}
