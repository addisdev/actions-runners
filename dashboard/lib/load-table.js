// Host load by the number of busy runners, from host_samples (one row a
// minute). This is the table the heavy-lane limit was set from (plan §1.4,
// 2026-10-22: ultra's load1 rose about 8 per concurrent job on 30 cores), kept
// as a live view so the limit can be re-tuned when the job mix changes.
//
// busy_runners counts runners GitHub shows busy, which includes jobs the
// admission hook is holding: a held job burns no CPU, so on a host that holds
// a lot the low buckets read high. Read the table with the hold count beside it.

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i] * 10) / 10;
};

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {number} [opts.days=7]
 * @param {string|null} [opts.hostId] - this host's id; rows with no host are its own
 * @param {number} [opts.now]
 * @returns {{ days: number, host: string|null, samples: number, since: number,
 *             rows: Array<{ busy: number, n: number, p50: number|null, p90: number|null }> }}
 */
export function loadByBusy(db, { days = 7, hostId = null, now = Date.now() } = {}) {
  const d = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = now - d * 86_400_000;
  const rows = db.prepare(`
    SELECT busy_runners AS busy, load1 FROM host_samples
    WHERE ts >= ? AND load1 IS NOT NULL AND busy_runners IS NOT NULL
      AND (host_id IS NULL OR host_id = ?)`).all(since, hostId ?? '');
  const by = new Map();
  for (const r of rows) {
    const b = Math.max(0, Math.round(Number(r.busy)));
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(Number(r.load1));
  }
  const out = [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([busy, loads]) => {
      loads.sort((a, b) => a - b);
      return { busy, n: loads.length, p50: pct(loads, 50), p90: pct(loads, 90) };
    });
  return { days: d, host: hostId, since, samples: rows.length, rows: out };
}
