import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, UPSERT_JOB } from '../lib/db.js';
import { JobSettler, RunSettler, STRANDED_MS } from '../lib/settle.js';
import { Backfill } from '../lib/backfill.js';

// The bug: the fast loop's last look at a run's jobs is always from while the
// run was active, and nothing looked again once it completed. On runner-host a
// third of the job history sat in_progress/queued forever with no duration.

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'settle-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  const upsert = db.prepare(UPSERT_JOB);
  // Same column mapping as fleetd.js persistJob.
  const persistJob = (job) => upsert.run(job.id, job.runId, job.repo, job.name ?? null,
    job.status ?? null, job.conclusion ?? null, job.createdAt ?? null, job.startedAt ?? null,
    job.completedAt ?? null, job.runnerName, job.runnerId, JSON.stringify(job.labels ?? []),
    job.queuedMs, job.durationMs, job.url ?? null, Date.now());

  const insertRun = db.prepare(
    'INSERT INTO runs (id, repo, status, conclusion, run_started_at, updated_at) VALUES (?,?,?,?,?,?)'
  );
  const insertJob = db.prepare(`
    INSERT INTO jobs (id, run_id, repo, name, status, conclusion, created_at, started_at, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  // What GitHub answers now, by job id. Absent = 404.
  const remote = new Map();
  const calls = [];
  const gh = {
    rate: { remaining: 5000 },
    async job(repo, id) {
      calls.push(id);
      if (!remote.has(id)) throw Object.assign(new Error(`jobs/${id}: 404`), { status: 404 });
      const j = remote.get(id);
      if (j instanceof Error) throw j;
      return j;
    },
    async get() { return { data: { jobs: [] } }; },
    async failureAnnotations() { return ['Process completed with exit code 1']; },
  };

  const t0 = Date.now() - 2 * HOUR;
  // A run that completed an hour ago, whose job was last seen 30 s before that.
  const frozen = ({ runId, jobId, status = 'in_progress', runStatus = 'completed',
                    conclusion = 'success', seenAt = t0 + HOUR - 30_000 }) => {
    insertRun.run(runId, 'o/app', runStatus, runStatus === 'completed' ? conclusion : null,
      iso(t0), iso(t0 + HOUR));
    insertJob.run(jobId, runId, 'o/app', 'build', status, null, iso(t0),
      status === 'queued' ? null : iso(t0 + 60_000), seenAt);
  };
  const finished = (id, runId, conclusion = 'success') => ({
    id, run_id: runId, name: 'build', status: 'completed', conclusion,
    created_at: iso(t0), started_at: iso(t0 + 60_000), completed_at: iso(t0 + 60_000 + 25 * 60_000),
    runner_name: 'app-ci-1', runner_id: 7, labels: ['self-hosted'], html_url: 'https://x',
  });

  const settler = new JobSettler({ db, gh });
  const row = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return { db, gh, calls, remote, settler, persistJob, frozen, finished, row };
}

describe('JobSettler', () => {
  test('a job frozen in progress under a completed run is re-fetched and gets its duration', async () => {
    const { calls, remote, settler, persistJob, frozen, finished, row } = fresh();
    frozen({ runId: 1, jobId: 10 });
    remote.set(10, finished(10, 1));

    assert.deepEqual(settler.stale().map((r) => r.id), [10]);
    const out = await settler.settle(settler.stale(), { persistJob });
    assert.deepEqual(out, { calls: 1, settled: 1 });
    assert.deepEqual(calls, [10]);

    const j = row(10);
    assert.equal(j.status, 'completed');
    assert.equal(j.conclusion, 'success');
    assert.ok(j.completed_at);
    assert.equal(j.duration_ms, 25 * 60_000);
    assert.equal(settler.countStale(), 0);
  });

  test('a job first seen queued gets its started_at, runner and queue time', async () => {
    const { remote, settler, persistJob, frozen, finished, row } = fresh();
    frozen({ runId: 1, jobId: 10, status: 'queued' });
    remote.set(10, finished(10, 1));
    await settler.settle(settler.stale(), { persistJob });
    const j = row(10);
    assert.ok(j.started_at, 'started_at was left NULL by the upsert');
    assert.equal(j.runner_id, 7);
    assert.equal(j.queued_ms, 60_000);
    assert.equal(j.duration_ms, 25 * 60_000);
  });

  test('jobs of a run that is still active are left to the fast loop', () => {
    const { settler, frozen } = fresh();
    frozen({ runId: 1, jobId: 10, runStatus: 'in_progress' });
    assert.equal(settler.countStale(), 0);
  });

  test('a job seen well after its run completed is not stale, even with no conclusion', () => {
    const { settler, frozen } = fresh();
    frozen({ runId: 1, jobId: 10, seenAt: Date.now() });
    assert.equal(settler.countStale(), 0);
  });

  test('a job GitHub never concludes is asked about once, not forever', async () => {
    const { calls, remote, settler, persistJob, frozen, finished } = fresh();
    frozen({ runId: 1, jobId: 10 });
    remote.set(10, { ...finished(10, 1), status: 'in_progress', conclusion: null, completed_at: null });
    await settler.settle(settler.stale(), { persistJob });
    await settler.settle(settler.stale(), { persistJob });
    assert.deepEqual(calls, [10]);
  });

  test('a job GitHub no longer has (404) stops being offered', async () => {
    const { calls, settler, persistJob, frozen } = fresh();
    frozen({ runId: 1, jobId: 10 });
    await settler.settle(settler.stale(), { persistJob });
    assert.equal(settler.countStale(), 0);
    assert.deepEqual(calls, [10]);
  });

  test('staleForRuns only looks at the runs it is given', () => {
    const { settler, frozen } = fresh();
    frozen({ runId: 1, jobId: 10 });
    frozen({ runId: 2, jobId: 20 });
    assert.deepEqual(settler.staleForRuns([2]).map((r) => r.id), [20]);
  });

  test('respects the call budget and the rate floor', async () => {
    const { calls, gh, remote, settler, persistJob, frozen, finished } = fresh();
    for (let i = 1; i <= 5; i++) {
      frozen({ runId: i, jobId: i * 10 });
      remote.set(i * 10, finished(i * 10, i));
    }
    await settler.settle(settler.stale(), { persistJob, maxCalls: 2 });
    assert.equal(calls.length, 2);
    gh.rate.remaining = 1000;
    await settler.settle(settler.stale(), { persistJob, minRemaining: 1500 });
    assert.equal(calls.length, 2);
  });
});

describe('backfill settle phase', () => {
  test('settles stale history, classifies the newly failed, and then has no work', async () => {
    const { db, gh, remote, persistJob, frozen, finished, row } = fresh();
    frozen({ runId: 1, jobId: 10 });
    frozen({ runId: 2, jobId: 20, conclusion: 'failure' });
    remote.set(10, finished(10, 1));
    remote.set(20, finished(20, 2, 'failure'));
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('backfill_runs:o/app', '1');

    const backfill = new Backfill({ db, gh, log: () => {}, warn: () => {} });
    assert.equal(backfill.hasWork(), true);
    const progress = await backfill.pass(['o/app'], { persistRun: () => {}, persistJob });
    assert.equal(progress.settled, 2);
    assert.equal(progress.stale, 0);
    assert.equal(row(20).conclusion, 'failure');
    assert.equal(row(20).failure_class, 'job-failed');
    assert.equal(backfill.hasWork(), false);
  });

  test('a job that keeps erroring costs one call per pass, not the whole budget', async () => {
    const { db, gh, calls, remote, persistJob, frozen } = fresh();
    frozen({ runId: 1, jobId: 10 });
    remote.set(10, Object.assign(new Error('jobs/10: 502'), { status: 502 }));
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('backfill_runs:o/app', '1');
    const backfill = new Backfill({ db, gh, log: () => {}, warn: () => {} });
    await backfill.pass(['o/app'], { persistRun: () => {}, persistJob, maxCalls: 350 });
    assert.deepEqual(calls, [10]);
  });
});

// The same freeze one level up: a run that finished after it fell off GitHub's
// active lists and its repo's newest page kept its last active status, so its
// jobs never counted as stale. 23 of them on runner-host, back to 2026-08-06.
describe('RunSettler', () => {
  function stranded() {
    const f = fresh();
    const { db, gh } = f;
    const remoteRuns = new Map();
    const runCalls = [];
    gh.run = async (repo, id) => {
      runCalls.push(id);
      if (!remoteRuns.has(id)) throw Object.assign(new Error(`runs/${id}: 404`), { status: 404 });
      return remoteRuns.get(id);
    };
    const runs = new RunSettler({ db, gh });
    const setRun = db.prepare(`
      INSERT INTO runs (id, repo, status, run_started_at, updated_at, seen_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, conclusion=excluded.conclusion,
        updated_at=excluded.updated_at, seen_at=excluded.seen_at`);
    // Same columns the daemon's upsert writes for this question.
    const persistRun = (repo, raw) => {
      setRun.run(raw.id, repo, raw.status, raw.run_started_at ?? null, raw.updated_at, Date.now());
      if (raw.conclusion) db.prepare('UPDATE runs SET conclusion = ? WHERE id = ?').run(raw.conclusion, raw.id);
    };
    const insertJob = db.prepare(`
      INSERT INTO jobs (id, run_id, repo, name, status, conclusion, created_at, started_at, seen_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    return { ...f, runs, remoteRuns, runCalls, setRun, persistRun, insertJob };
  }

  test('a run stuck in progress is refreshed, and then its jobs settle', async () => {
    const { db, runs, remoteRuns, setRun, persistRun, insertJob, settler, persistJob,
            remote, finished, row } = stranded();
    const seen = Date.now() - 3 * 3600_000;
    setRun.run(1, 'o/app', 'in_progress', iso(seen - 600_000), iso(seen), seen);
    insertJob.run(10, 1, 'o/app', 'build', 'in_progress', null, iso(seen - 600_000), iso(seen - 590_000), seen);
    // Its job is not stale while the run reads active.
    assert.equal(settler.countStale(), 0);

    remoteRuns.set(1, { id: 1, status: 'completed', conclusion: 'success', updated_at: iso(seen + 1800_000) });
    remote.set(10, finished(10, 1));
    const out = await runs.settle(runs.find(), { persistRun });
    assert.deepEqual(out, { calls: 1, completed: [1] });
    assert.equal(db.prepare('SELECT status FROM runs WHERE id = 1').get().status, 'completed');

    await settler.settle(settler.staleForRuns(out.completed), { persistJob });
    assert.equal(row(10).conclusion, 'success');
  });

  test('a run seen recently is left to the fast loop', () => {
    const { runs, setRun } = stranded();
    setRun.run(1, 'o/app', 'in_progress', iso(Date.now()), iso(Date.now()), Date.now() - 60_000);
    assert.deepEqual(runs.find(), []);
  });

  test('a run GitHub no longer has is asked about once per window, not every tick', async () => {
    const { runs, setRun, persistRun, runCalls } = stranded();
    setRun.run(1, 'o/app', 'queued', iso(0), iso(0), Date.now() - 2 * STRANDED_MS);
    await runs.settle(runs.find(), { persistRun });
    await runs.settle(runs.find(), { persistRun });
    assert.deepEqual(runCalls, [1]);
    assert.equal(runs.find(Date.now() + STRANDED_MS + 1000).length, 1);
  });

  test('a run GitHub still reports active is not reported completed', async () => {
    const { runs, remoteRuns, setRun, persistRun } = stranded();
    setRun.run(1, 'o/app', 'pending', iso(0), iso(0), Date.now() - 2 * STRANDED_MS);
    remoteRuns.set(1, { id: 1, status: 'pending', conclusion: null, updated_at: iso(Date.now()) });
    const out = await runs.settle(runs.find(), { persistRun });
    assert.deepEqual(out.completed, []);
    assert.deepEqual(runs.find(), []);
  });
});
