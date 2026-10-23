import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { createJobClass } from '../lib/job-class.js';
import { loadByBusy } from '../lib/load-table.js';

const NOW = Date.parse('2026-10-22T20:00:00Z');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'job-class-'));
  dirs.push(dir);
  return openDb(join(dir, 'test.db'));
}

// The admission log's release lines, which carry the job id and ran_s.
function releases(db, repo, job, secs, { ageMs = 3600_000 } = {}) {
  const ins = db.prepare(`INSERT INTO admission_events (ts, event, repo, job, ran_s, host_id)
                          VALUES (?, 'released', ?, ?, ?, 'ultra')`);
  secs.forEach((s, i) => ins.run(NOW - ageMs - i * 1000, repo, job, s));
}
let jobId = 1;
function jobRows(db, repo, name, secs, { conclusion = 'success' } = {}) {
  const ins = db.prepare(`INSERT INTO jobs (id, run_id, repo, name, conclusion, started_at, duration_ms)
                          VALUES (?, 1, ?, ?, ?, ?, ?)`);
  secs.forEach((s, i) => ins.run(jobId++, repo, name, conclusion,
    new Date(NOW - 3600_000 - i * 1000).toISOString(), s * 1000));
}

describe('job class', () => {
  test('a job whose recent median run is under the threshold is light', () => {
    const db = fresh();
    releases(db, 'acme/site', 'words', [10, 12, 14, 11, 13, 200]);
    const c = createJobClass({ db, now: () => NOW });
    const r = c.lookup({ repo: 'acme/site', job: 'words' });
    assert.equal(r.class, 'light');
    assert.equal(r.n, 6);
    assert.equal(r.p50Ms, 12500);
    assert.equal(r.source, 'admission');
  });

  test('a long job is heavy, and the hook can send its own threshold', () => {
    const db = fresh();
    releases(db, 'acme/mobile', 'test', [500, 533, 610, 480, 520]);
    const c = createJobClass({ db, now: () => NOW });
    assert.equal(c.lookup({ repo: 'acme/mobile', job: 'test' }).class, 'heavy');
    assert.equal(c.lookup({ repo: 'acme/mobile', job: 'test', shortS: '900' }).class, 'light');
    assert.equal(c.lookup({ repo: 'acme/mobile', job: 'test', shortS: 'banana' }).shortJobS, 90);
  });

  test('too few runs is unknown, which the hook treats as heavy', () => {
    const db = fresh();
    releases(db, 'acme/mobile', 'new', [3, 4]);
    const r = createJobClass({ db, now: () => NOW }).lookup({ repo: 'acme/mobile', job: 'new' });
    assert.equal(r.class, 'unknown');
    assert.equal(r.n, 2);
  });

  test('a job never seen has no samples at all', () => {
    const r = createJobClass({ db: fresh(), now: () => NOW }).lookup({ repo: 'a/b', job: 'x' });
    assert.deepEqual([r.class, r.n, r.p50Ms, r.source], ['unknown', 0, null, 'none']);
  });

  test('releases older than the window do not count', () => {
    const db = fresh();
    releases(db, 'a/b', 'old', [5, 5, 5, 5, 5], { ageMs: 30 * 86_400_000 });
    assert.equal(createJobClass({ db, now: () => NOW }).lookup({ repo: 'a/b', job: 'old' }).class, 'unknown');
  });

  test('a display name falls back to GitHub job rows, by its last part too', () => {
    const db = fresh();
    jobRows(db, 'acme/mobile', 'ios / test', [540, 600, 580, 560, 610]);
    const c = createJobClass({ db, now: () => NOW });
    const r = c.lookup({ repo: 'acme/mobile', job: 'ios / test' });
    assert.deepEqual([r.class, r.source, r.n], ['heavy', 'jobs', 5]);
    // The id alone finds the same rows through "% / test".
    assert.equal(c.lookup({ repo: 'acme/mobile', job: 'test' }).source, 'jobs');
  });

  test('only successful job rows count, and LIKE wildcards in a name are literal', () => {
    const db = fresh();
    jobRows(db, 'a/b', 'ci / a_b', [5, 5, 5, 5, 5], { conclusion: 'failure' });
    jobRows(db, 'a/b', 'ci / axb', [5, 5, 5, 5, 5]);
    assert.equal(createJobClass({ db, now: () => NOW }).lookup({ repo: 'a/b', job: 'a_b' }).n, 0);
  });

  test('a malformed query is a 400', () => {
    const c = createJobClass({ db: fresh(), now: () => NOW });
    assert.throws(() => c.lookup({ repo: 'nope', job: 'x' }), (e) => e.status === 400);
    assert.throws(() => c.lookup({ repo: 'a/b', job: '' }), (e) => e.status === 400);
  });

  test('answers are cached for a minute', () => {
    const db = fresh();
    let t = NOW;
    const c = createJobClass({ db, now: () => t });
    assert.equal(c.lookup({ repo: 'a/b', job: 'j' }).class, 'unknown');
    releases(db, 'a/b', 'j', [1, 1, 1, 1, 1]);
    assert.equal(c.lookup({ repo: 'a/b', job: 'j' }).class, 'unknown');
    t += 61_000;
    assert.equal(c.lookup({ repo: 'a/b', job: 'j' }).class, 'light');
  });
});

describe('load by busy runners', () => {
  test('p50 and p90 of load1 per busy-runner count, this host only', () => {
    const db = fresh();
    const ins = db.prepare('INSERT INTO host_samples (ts, load1, busy_runners, host_id) VALUES (?,?,?,?)');
    let ts = NOW - 3600_000;
    for (const l of [10, 12, 14, 30]) ins.run(ts++, l, 2, 'ultra');
    for (const l of [3, 4]) ins.run(ts++, l, 0, null);
    ins.run(ts++, 99, 2, 'other-host');
    ins.run(NOW - 30 * 86_400_000, 500, 2, 'ultra');
    const t = loadByBusy(db, { days: 7, hostId: 'ultra', now: NOW });
    assert.equal(t.samples, 6);
    assert.deepEqual(t.rows, [
      { busy: 0, n: 2, p50: 3, p90: 4 },
      { busy: 2, n: 4, p50: 12, p90: 30 },
    ]);
  });
});
