// History backfill.
//
// The fast loop only ever sees the newest dozen runs per repo, which is the
// right shape for "what is happening now" and useless for "where does CI time
// go". This walks back through everything GitHub still has and stores it.
//
// It matters more than it sounds. A busy repo only holds a few weeks of runs
// before GitHub ages them out — on the fleet this was written for, page 3 of
// the busiest repo's history was already a week old. Whatever is not captured
// now is gone, and no later analysis can recover it.
//
// Job detail is one call per run, and there are ~1,100 runs. So this is
// throttled and resumable rather than a single heroic pass: it takes a bounded
// number of calls, leaves a floor of rate limit for the fast loop, and picks up
// where it left off next time.

import { shapeRun, shapeJob } from './state.js';
import { classifyAnnotations } from './failures.js';

export class Backfill {
  constructor({ db, gh, log, warn }) {
    this.db = db;
    this.gh = gh;
    this.log = log;
    this.warn = warn;
    this.running = false;
    this.progress = {
      phase: 'idle', calls: 0, runs: 0, jobs: 0, pending: null, unclassified: null, done: false,
    };

    this.hasJobs = db.prepare('SELECT 1 FROM jobs WHERE run_id = ? LIMIT 1');
    this.insertStep = db.prepare(`
      INSERT INTO steps (job_id, number, name, status, conclusion, started_at, completed_at, duration_ms)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id, number) DO UPDATE SET
        status=excluded.status, conclusion=excluded.conclusion,
        completed_at=excluded.completed_at, duration_ms=excluded.duration_ms`);
    // Runs whose jobs were never fetched. Completed only: an in-progress run's
    // jobs are still moving, and the fast loop is already watching those.
    this.pendingRuns = db.prepare(`
      SELECT r.id, r.repo FROM runs r
      WHERE r.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = r.id)
      ORDER BY r.run_started_at DESC
      LIMIT ?`);
    this.countPending = db.prepare(`
      SELECT COUNT(*) AS n FROM runs r
      WHERE r.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = r.id)`);

    // Failed jobs whose cause has not been looked up yet. NULL means "not
    // asked"; every fetch writes something back — 'unknown' when GitHub has
    // already expired the annotations — so a job is never asked about twice.
    // Positive ids only: negative ones are the "(detail unavailable)" markers.
    this.unclassified = db.prepare(`
      SELECT id, repo FROM jobs
      WHERE conclusion = 'failure' AND failure_class IS NULL AND id > 0
      ORDER BY started_at DESC
      LIMIT ?`);
    this.countUnclassified = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE conclusion = 'failure' AND failure_class IS NULL AND id > 0`);
    this.setFailureClass = db.prepare(
      'UPDATE jobs SET failure_class = ?, failure_detail = ? WHERE id = ?'
    );
  }

  // Is there anything left to do? Three local COUNTs, no API calls.
  //
  // The scheduler asks this instead of trusting a `done` flag, because `done`
  // was a latch: it is only recomputed inside pass(), and the scheduler used it
  // to decide whether to call pass() at all. Once it went true it could never go
  // back, so job and step detail stopped accumulating for good — measured on
  // this host, 17 completed runs had no job detail while the daemon reported
  // "complete, 0 pending". Asking the database is both correct and cheaper than
  // being wrong.
  hasWork() {
    return this.countPending.get().n > 0 || this.countUnclassified.get().n > 0;
  }

  budgetLeft(minRemaining) {
    const rem = this.gh.rate.remaining;
    return rem == null || rem > minRemaining;
  }

  // Walk every page of a repo's run list once. Cheap — 100 runs per call — and
  // it is what makes the per-run job fetches discoverable at all.
  async runsFor(repo, { persistRun, maxPages = 20, minRemaining }) {
    let stored = 0;
    for (let page = 1; page <= maxPages; page++) {
      if (!this.budgetLeft(minRemaining)) break;
      const { data } = await this.gh.get(
        `repos/${repo}/actions/runs?per_page=100&page=${page}`,
        { etag: false }
      );
      this.progress.calls++;
      const list = data?.workflow_runs ?? [];
      for (const raw of list) {
        persistRun(shapeRun(repo, raw));
        stored++;
      }
      if (list.length < 100) break;
    }
    return stored;
  }

  async jobsFor(repo, runId, persistJob) {
    // No ETag: these are one-shot historical fetches, and caching 1,100 full job
    // payloads in memory to serve 304s nobody will ask for is pure waste.
    const { data } = await this.gh.get(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, {
      etag: false,
    });
    this.progress.calls++;
    const jobs = data?.jobs ?? [];
    for (const raw of jobs) {
      const job = shapeJob(repo, raw);
      persistJob(job);
      for (const s of raw.steps ?? []) {
        const ms =
          s.started_at && s.completed_at
            ? Math.max(0, new Date(s.completed_at) - new Date(s.started_at))
            : null;
        this.insertStep.run(job.id, s.number, s.name ?? null, s.status ?? null,
          s.conclusion ?? null, s.started_at ?? null, s.completed_at ?? null, ms);
      }
    }
    return jobs.length;
  }

  async pass(repos, { persistRun, persistJob, maxCalls = 350, minRemaining = 1500 } = {}) {
    if (this.running) return this.progress;
    this.running = true;
    const startedCalls = this.progress.calls;
    const spent = () => this.progress.calls - startedCalls;

    try {
      // Phase 1 — the run lists. Only done once per repo; after that the fast
      // loop keeps the head of the list current on its own.
      //
      // It gets its own slice of the budget rather than sharing one pool: the
      // list phase runs first, and with enough repos it would otherwise spend
      // every call and leave the job phase — the one that produces the step
      // timings — with nothing on the first pass.
      const listBudget = Math.max(4, Math.ceil(maxCalls * 0.4));
      this.progress.phase = 'runs';
      for (const repo of repos) {
        const key = `backfill_runs:${repo}`;
        const done = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        if (done) continue;
        if (spent() >= listBudget || !this.budgetLeft(minRemaining)) break;
        try {
          const n = await this.runsFor(repo, { persistRun, minRemaining });
          this.progress.runs += n;
          this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
            .run(key, String(Date.now()));
          this.log(`backfill: ${repo} run list — ${n} runs`);
        } catch (err) {
          this.warn(`backfill runs ${repo}: ${err.message}`);
        }
      }

      // Phase 2 — job and step detail, newest first so the most useful history
      // lands before the budget runs out.
      this.progress.phase = 'jobs';
      while (spent() < maxCalls && this.budgetLeft(minRemaining)) {
        const batch = this.pendingRuns.all(25);
        if (!batch.length) break;
        let advanced = false;
        for (const row of batch) {
          if (spent() >= maxCalls || !this.budgetLeft(minRemaining)) break;
          try {
            const n = await this.jobsFor(row.repo, row.id, persistJob);
            this.progress.jobs += n;
            advanced = true;
          } catch (err) {
            // A run whose jobs 404 (deleted, or expired detail) would otherwise
            // be retried forever, blocking every pass behind it. Record an empty
            // marker job so the pending query stops returning it.
            this.warn(`backfill jobs ${row.repo}#${row.id}: ${err.message}`);
            persistJob({
              id: -row.id, runId: row.id, repo: row.repo, name: '(detail unavailable)',
              status: 'completed', conclusion: 'skipped', createdAt: null, startedAt: null,
              completedAt: null, runnerName: null, runnerId: null, labels: [],
              queuedMs: null, durationMs: null, url: null,
            });
            advanced = true;
          }
        }
        if (!advanced) break;
      }

      // Phase 3 — why the failures failed. One call per failed job, and the
      // answer is only available here: `conclusion = 'failure'` covers a broken
      // test and an account-level billing block equally, and those need
      // different people. See lib/failures.js.
      //
      // Last on purpose. Run and job detail is the record that GitHub deletes
      // and cannot be recovered; a cause is a nicety by comparison, so it gets
      // whatever budget the other two phases left rather than competing for it.
      this.progress.phase = 'causes';
      let classified = 0;
      while (spent() < maxCalls && this.budgetLeft(minRemaining)) {
        const batch = this.unclassified.all(25);
        if (!batch.length) break;
        for (const row of batch) {
          if (spent() >= maxCalls || !this.budgetLeft(minRemaining)) break;
          const msgs = await this.gh.failureAnnotations(row.repo, row.id);
          this.progress.calls++;
          const cls = classifyAnnotations(msgs);
          this.setFailureClass.run(cls, msgs[0]?.slice(0, 2000) ?? null, row.id);
          classified++;
        }
      }

      const pending = this.countPending.get().n;
      const unclassified = this.countUnclassified.get().n;
      this.progress.pending = pending;
      this.progress.unclassified = unclassified;
      this.progress.done = pending === 0 && unclassified === 0;
      this.progress.phase = this.progress.done ? 'complete' : 'paused';
      this.log(
        `backfill pass: ${spent()} calls, ${this.progress.jobs} jobs total, `
        + `${classified} causes classified, ${pending} runs and ${unclassified} failures still pending`
      );
    } finally {
      this.running = false;
    }
    return this.progress;
  }
}
