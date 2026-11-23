import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shapeJob } from '../lib/state.js';
import { openDb, correctUnrunJobs } from '../lib/db.js';

// A job's build time is the time a runner spent on it. A job cancelled while it
// still sat in GitHub's queue never had a runner, and GitHub still hands back a
// started_at (a copy of created_at) and a completed_at (the cancel), so reading
// those two as "ran from - to" turns every queue wait into build-hours.

const raw = (over = {}) => ({
  id: 1, run_id: 10, name: 'stitch', status: 'completed', conclusion: 'success',
  created_at: '2026-11-22T10:00:00Z', started_at: '2026-11-22T10:02:00Z',
  completed_at: '2026-11-22T10:05:00Z', runner_name: 'homelake-3', runner_id: 7,
  labels: ['self-hosted'], html_url: 'u', ...over,
});

describe('shapeJob — build time is runner time', () => {
  test('a normal job: queue is created→started, duration is started→completed', () => {
    const j = shapeJob('o/r', raw());
    assert.equal(j.queuedMs, 2 * 60_000);
    assert.equal(j.durationMs, 3 * 60_000);
    assert.equal(j.startedAt, '2026-11-22T10:02:00Z');
  });

  test('cancelled before a runner: zero duration, the whole wait is queue time', () => {
    // The real shape of homelake's stitch rows: runner_name "", started_at = created_at.
    const j = shapeJob('o/r', raw({
      conclusion: 'cancelled', runner_name: '', runner_id: 0,
      created_at: '2026-11-23T02:50:58Z', started_at: '2026-11-23T02:50:58Z',
      completed_at: '2026-11-23T03:13:47Z',
    }));
    assert.equal(j.runnerName, null);
    assert.equal(j.durationMs, 0);
    assert.equal(j.queuedMs, 1_369_000);
    // created + queued = started, started + duration = completed: arrival times
    // rebuilt as started - queued (forecast, simulator) still land on created_at.
    assert.equal(j.startedAt, '2026-11-23T03:13:47Z');
    assert.equal(Date.parse(j.startedAt) - j.queuedMs, Date.parse(j.createdAt));
  });

  test('a null runner_name is treated the same as an empty one', () => {
    const j = shapeJob('o/r', raw({ conclusion: 'cancelled', runner_name: null, started_at: '2026-11-22T10:00:00Z' }));
    assert.equal(j.durationMs, 0);
    assert.equal(j.queuedMs, 5 * 60_000);
  });

  test('cancelled while running keeps its runner time', () => {
    const j = shapeJob('o/r', raw({ conclusion: 'cancelled' }));
    assert.equal(j.durationMs, 3 * 60_000);
    assert.equal(j.queuedMs, 2 * 60_000);
    assert.equal(j.runnerName, 'homelake-3');
  });

  test('a job still waiting is left alone (not completed, no duration yet)', () => {
    const j = shapeJob('o/r', raw({
      status: 'queued', conclusion: null, runner_name: '', started_at: '2026-11-22T10:00:00Z', completed_at: null,
    }));
    assert.equal(j.durationMs, null);
    assert.equal(j.startedAt, '2026-11-22T10:00:00Z');
  });

  test('a skipped job stays at zero', () => {
    const t = '2026-11-22T10:00:00Z';
    const j = shapeJob('o/r', raw({ conclusion: 'skipped', runner_name: '', created_at: t, started_at: t, completed_at: t }));
    assert.equal(j.durationMs, 0);
    assert.equal(j.queuedMs, 0);
  });
});

describe('correctUnrunJobs — rows stored before the fix', () => {
  let dir;
  let db;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-dur-'));
    db = openDb(join(dir, 'fleet.db'));
    const ins = db.prepare(`INSERT INTO jobs (id, run_id, repo, name, status, conclusion, created_at,
      started_at, completed_at, runner_name, queued_ms, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Old-shape: cancelled in the queue, wait stored as duration.
    ins.run(1, 1, 'o/r', 'stitch', 'completed', 'cancelled', '2026-11-23T02:50:58Z', '2026-11-23T02:50:58Z',
      '2026-11-23T03:13:47Z', null, 0, 1_369_000);
    // Old rows from before runner_name was normalised carry "".
    ins.run(2, 1, 'o/r', 'stitch', 'completed', 'cancelled', '2026-11-22T10:00:00Z', '2026-11-22T10:00:00Z',
      '2026-11-22T10:00:12Z', '', 0, 12_000);
    // Cancelled while running: untouched.
    ins.run(3, 1, 'o/r', 'stitch', 'completed', 'cancelled', '2026-11-22T10:00:00Z', '2026-11-22T10:02:00Z',
      '2026-11-22T10:05:00Z', 'homelake-3', 120_000, 180_000);
    // Normal success: untouched.
    ins.run(4, 1, 'o/r', 'stitch', 'completed', 'success', '2026-11-22T10:00:00Z', '2026-11-22T10:01:00Z',
      '2026-11-22T10:04:00Z', 'homelake-3', 60_000, 180_000);
    // Still queued: untouched.
    ins.run(5, 1, 'o/r', 'stitch', 'queued', null, '2026-11-22T10:00:00Z', '2026-11-22T10:00:00Z',
      null, null, 0, null);
  });
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const row = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

  test('moves the wait from duration to queue and agrees with shapeJob', () => {
    const n = correctUnrunJobs(db);
    assert.equal(n, 2);
    const a = row(1);
    assert.equal(a.duration_ms, 0);
    assert.equal(a.queued_ms, 1_369_000);
    assert.equal(a.started_at, '2026-11-23T03:13:47Z');
    const b = row(2);
    assert.equal(b.runner_name, null);
    assert.equal(b.duration_ms, 0);
    assert.equal(b.queued_ms, 12_000);
  });

  test('leaves jobs that ran, and jobs still waiting, alone', () => {
    assert.deepEqual([row(3).queued_ms, row(3).duration_ms, row(3).started_at], [120_000, 180_000, '2026-11-22T10:02:00Z']);
    assert.deepEqual([row(4).queued_ms, row(4).duration_ms], [60_000, 180_000]);
    assert.equal(row(5).duration_ms, null);
    assert.equal(row(5).started_at, '2026-11-22T10:00:00Z');
  });

  test('is a no-op the second time, so it can run on every start', () => {
    assert.equal(correctUnrunJobs(db), 0);
  });
});
