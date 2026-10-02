import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, UPSERT_JOB } from '../lib/db.js';
import { JobSettler } from '../lib/settle.js';
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
