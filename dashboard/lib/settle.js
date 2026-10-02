// Job rows that stopped moving.
//
// The fast loop fetches job detail only for ACTIVE runs, and the backfill only
// for runs with no job rows at all. A run's last jobs finish at the moment the
// run does, so the newest snapshot of them was always taken while they were
// still queued or in progress — and once the run read as completed nothing
// asked again. Measured on runner-host 2026-10-02: 5,966 job rows (about a
// third of the history) frozen with no conclusion, completed_at or duration
// under runs that had long since completed, which made every build-hours number
// undercount.
//
// A row is stale when its run has completed, it has no conclusion, and it was
// last seen before the run finished (plus a margin: GitHub's clock and ours are
// a few seconds apart, and a job can still read in progress just after its run
// completes). Re-fetching sets seen_at to now, so a job GitHub itself never
// concludes is asked about at most until the margin has passed, never forever.
// A re-run moves the run's updated_at forward, which makes the earlier
// attempt's unfinished rows eligible again — correctly, since they are now
// settled on GitHub's side too.

import { shapeJob } from './state.js';

const MARGIN_MS = 2 * 60 * 1000;

const STALE = `
  j.conclusion IS NULL AND j.id > 0 AND r.status = 'completed'
  AND (j.seen_at IS NULL
       OR j.seen_at < CAST(strftime('%s', r.updated_at) AS INTEGER) * 1000 + ${MARGIN_MS})`;

export class JobSettler {
  constructor({ db, gh, warn = () => {} }) {
    this.gh = gh;
    this.warn = warn;
    this.forRun = db.prepare(`
      SELECT j.id, j.repo FROM jobs j JOIN runs r ON r.id = j.run_id
      WHERE j.run_id = ? AND ${STALE}`);
    this.all = db.prepare(`
      SELECT j.id, j.repo FROM jobs j JOIN runs r ON r.id = j.run_id
      WHERE ${STALE}
      ORDER BY r.updated_at DESC
      LIMIT ?`);
    this.count = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs j JOIN runs r ON r.id = j.run_id WHERE ${STALE}`);
    // A job GitHub no longer has (its run was deleted) cannot be settled; mark
    // it seen so it stops being offered.
    this.touch = db.prepare('UPDATE jobs SET seen_at = ? WHERE id = ?');
  }

  staleForRuns(runIds) {
    return runIds.flatMap((id) => this.forRun.all(id));
  }

  stale(limit = 100) {
    return this.all.all(limit);
  }

  countStale() {
    return this.count.get().n;
  }

  // One call per job, not per run: a run-level fetch returns only the latest
  // attempt, so an earlier attempt's stale rows would never move and would be
  // offered again on every pass.
  async settle(rows, { persistJob, maxCalls = Infinity, minRemaining = 0 }) {
    let calls = 0;
    let settled = 0;
    for (const row of rows) {
      if (calls >= maxCalls) break;
      const rem = this.gh.rate.remaining;
      if (rem != null && rem <= minRemaining) break;
      try {
        calls++;
        const raw = await this.gh.job(row.repo, row.id);
        persistJob(shapeJob(row.repo, raw));
        if (raw.conclusion != null) settled++;
      } catch (err) {
        if (err?.rateLimited) break;
        if (err?.status === 404) this.touch.run(Date.now(), row.id);
        else this.warn(`settle job ${row.repo}#${row.id}: ${err.message}`);
      }
    }
    return { calls, settled };
  }
}
