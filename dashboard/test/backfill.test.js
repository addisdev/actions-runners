import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { Backfill } from '../lib/backfill.js';

// The failure this suite was written for is a livelock, not a wrong value: the
// job phase handed itself the same batch of runs forever and spent the entire
// call budget on it, so the cause phase never ran. Only a fake that counts
// calls and returns what GitHub really returns for these runs shows it.

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A completed run that produced no job detail. GitHub answers the jobs endpoint
// for these with an empty list, not a 404 — a run cancelled before dispatch, or
// one that failed at startup.
function fresh({ emptyRuns = 0, normalRuns = 0, failedJobs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));

  const insertRun = db.prepare(
    `INSERT INTO runs (id, repo, status, conclusion, run_started_at) VALUES (?,?,?,?,?)`
  );
  const insertJob = db.prepare(
    `INSERT INTO jobs (id, run_id, repo, conclusion, started_at) VALUES (?,?,?,?,?)`
  );

  const empties = new Set();
  let id = 1000;
  for (let i = 0; i < emptyRuns; i++) {
    empties.add(++id);
    insertRun.run(id, 'testowner/app', 'completed', 'startup_failure', '2026-01-01T00:00:00Z');
  }
  for (let i = 0; i < normalRuns; i++) {
    insertRun.run(++id, 'testowner/app', 'completed', 'success', '2026-01-01T00:00:00Z');
  }
  // Failed jobs awaiting cause classification in phase 3.
  for (let i = 0; i < failedJobs; i++) {
    insertJob.run(++id, 1, 'testowner/app', 'failure', '2026-01-01T00:00:00Z');
  }

  const calls = { jobs: 0, annotations: 0 };
  const gh = {
    rate: { remaining: 5000 },
    async get(path) {
      calls.jobs++;
      const runId = Number(path.match(/runs\/(\d+)\/jobs/)?.[1]);
      if (empties.has(runId)) return { data: { total_count: 0, jobs: [] } };
      return {
        data: {
          total_count: 1,
          jobs: [{
            id: runId * 10, run_id: runId, name: 'build', status: 'completed',
            conclusion: 'success', labels: [], steps: [],
          }],
        },
      };
    },
    async failureAnnotations() {
      calls.annotations++;
      return ['Process completed with exit code 1'];
    },
  };

  const backfill = new Backfill({ db, gh, log: () => {}, warn: () => {} });

  const persistRun = () => {};
  const persistJob = (job) => {
    insertJob.run(job.id, job.runId, job.repo, job.conclusion ?? null, job.startedAt ?? null);
  };

  // Phase 1 walks repo run lists; every case here starts with that already done.
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)')
    .run('backfill_runs:testowner/app', String(Date.now()));

  return { db, backfill, gh, calls, persistRun, persistJob };
}

const pendingCount = (db) => db.prepare(`
  SELECT COUNT(*) AS n FROM runs r WHERE r.status = 'completed'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = r.id)`).get().n;

describe('job detail phase', () => {
  test('a run with job detail is stored and stops being pending', async () => {
    const { db, backfill, persistRun, persistJob } = fresh({ normalRuns: 3 });
    await backfill.pass(['testowner/app'], { persistRun, persistJob });
    assert.equal(pendingCount(db), 0);
  });

  // The livelock. Each of these runs was fetched, stored nothing, and came
  // straight back from the pending query on the next iteration.
  test('a run GitHub returns no jobs for is fetched once, not forever', async () => {
    const { db, backfill, calls, persistRun, persistJob } = fresh({ emptyRuns: 5 });
    await backfill.pass(['testowner/app'], { persistRun, persistJob, maxCalls: 350 });

    assert.equal(calls.jobs, 5, 'each empty run is asked about exactly once');
    assert.equal(pendingCount(db), 0, 'and none is left pending');
  });

  test('a second pass over empty runs costs nothing', async () => {
    const { backfill, calls, persistRun, persistJob } = fresh({ emptyRuns: 4 });
    await backfill.pass(['testowner/app'], { persistRun, persistJob });
    const after = calls.jobs;
    await backfill.pass(['testowner/app'], { persistRun, persistJob });
    assert.equal(calls.jobs, after, 'nothing left to ask about');
    assert.equal(backfill.hasWork(), false);
  });
});

describe('cause phase', () => {
  // The symptom that made the livelock visible in the log: "0 causes
  // classified" pass after pass, while the failure backlog only grew.
  test('empty runs do not starve cause classification of budget', async () => {
    const { db, backfill, calls, persistRun, persistJob } =
      fresh({ emptyRuns: 5, failedJobs: 6 });

    await backfill.pass(['testowner/app'], { persistRun, persistJob, maxCalls: 350 });

    assert.equal(calls.annotations, 6, 'every failed job gets its cause looked up');
    const unclassified = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE conclusion = 'failure' AND failure_class IS NULL AND id > 0`).get().n;
    assert.equal(unclassified, 0);
  });

  test('the marker rows are not themselves classified', async () => {
    const { db, backfill, persistRun, persistJob } = fresh({ emptyRuns: 3 });
    await backfill.pass(['testowner/app'], { persistRun, persistJob });

    const markers = db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE id < 0 AND failure_class IS NOT NULL`
    ).get().n;
    assert.equal(markers, 0);
  });
});

describe('hasWork', () => {
  test('is false once every run and failure is accounted for', async () => {
    const { backfill, persistRun, persistJob } = fresh({ emptyRuns: 2, normalRuns: 2, failedJobs: 2 });
    assert.equal(backfill.hasWork(), true);
    await backfill.pass(['testowner/app'], { persistRun, persistJob });
    assert.equal(backfill.hasWork(), false);
  });
});
