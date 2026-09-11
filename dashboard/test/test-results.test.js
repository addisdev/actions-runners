import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { ingestTestOutcomes, flakyTestSummary } from '../lib/test-results.js';

// Like the admission suite, this runs against a real file and a real database.
// The two things that broke here were a call to a better-sqlite3 helper that
// node:sqlite does not have, and a byte cursor into a file another process is
// appending to. Neither survives being stubbed.

// The shape hooks/job-completed.sh emits. Overridden per case.
const line = (o) => JSON.stringify({
  ts: Date.now(),
  repo: 'testowner/app',
  head_sha: 'abc123',
  run_id: '7',
  job_id: 'e2e',
  browser: 'chromium',
  project: 'chromium',
  file: 'smoke.spec.ts',
  title: 'loads',
  attempts: 1,
  status: 'passed',
  flaky: false,
  duration_ms: 10,
  ...o,
});

const dirs = [];
function fresh(lines = null) {
  const dir = mkdtempSync(join(tmpdir(), 'test-results-'));
  dirs.push(dir);
  const spool = join(dir, 'outcomes.ndjson');
  const db = openDb(join(dir, 'test.db'));
  if (lines) writeFileSync(spool, lines.join('\n') + '\n');
  return { dir, spool, db };
}

const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM test_outcomes').get().n;

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('ingestTestOutcomes', () => {
  test('a missing spool is not an error', async () => {
    const { db, dir } = fresh();
    assert.equal(await ingestTestOutcomes(db, join(dir, 'nope.ndjson')), 0);
  });

  test('no spool path configured is not an error', async () => {
    const { db } = fresh();
    assert.equal(await ingestTestOutcomes(db, ''), 0);
  });

  // The regression this suite exists for. The ingest called db.transaction(),
  // which is a better-sqlite3 API; node:sqlite's DatabaseSync has no such
  // method, so every pass threw and not one row was ever written.
  test('writes rows rather than throwing', async () => {
    const { db, spool } = fresh([line({ title: 'a' }), line({ title: 'b' })]);
    assert.equal(await ingestTestOutcomes(db, spool), 2);
    assert.equal(count(db), 2);
  });

  test('reads every complete line exactly once', async () => {
    const { db, spool } = fresh([line({ title: 'a' }), line({ title: 'b' })]);
    await ingestTestOutcomes(db, spool);
    assert.equal(await ingestTestOutcomes(db, spool), 0, 'second pass must not re-read');
    assert.equal(count(db), 2);
  });

  test('picks up lines appended after the first pass', async () => {
    const { db, spool } = fresh([line({ title: 'a' })]);
    await ingestTestOutcomes(db, spool);
    appendFileSync(spool, line({ title: 'b' }) + '\n');
    assert.equal(await ingestTestOutcomes(db, spool), 1);
    assert.equal(count(db), 2);
  });

  // A hook appends while this runs. Consuming a half-written record would drop
  // it permanently, because the cursor would already be past it.
  test('leaves a half-written trailing line for the next pass', async () => {
    const { db, spool } = fresh([line({ title: 'a' })]);
    appendFileSync(spool, '{"repo":"testowner/app","file":"x.spec.ts","ti');
    assert.equal(await ingestTestOutcomes(db, spool), 1);

    appendFileSync(spool, 'tle":"late","status":"passed"}\n');
    assert.equal(await ingestTestOutcomes(db, spool), 1, 'completed line must arrive');
    assert.equal(count(db), 2);
  });

  // A line that cannot be parsed now will not parse on the next pass either.
  // Holding the cursor behind it re-read the whole spool on every tick.
  test('a malformed line does not stall the cursor', async () => {
    const { db, spool } = fresh(['{not json', line({ title: 'a' }), '{"also":"bad"}']);
    assert.equal(await ingestTestOutcomes(db, spool), 1);
    assert.equal(await ingestTestOutcomes(db, spool), 0, 'must not re-read the bad lines');
    assert.equal(count(db), 1);
  });

  test('records missing required fields are skipped, not fatal', async () => {
    const { db, spool } = fresh([
      JSON.stringify({ repo: 'testowner/app', status: 'passed' }), // no file/title
      line({ title: 'a' }),
    ]);
    assert.equal(await ingestTestOutcomes(db, spool), 1);
    assert.equal(count(db), 1);
  });

  // Truncation or rotation leaves the cursor past the end of the file. Reading
  // from the old offset would land mid-line and stay wrong forever.
  test('a truncated spool restarts from the beginning', async () => {
    const { db, spool } = fresh([line({ title: 'a' }), line({ title: 'b' })]);
    await ingestTestOutcomes(db, spool);

    writeFileSync(spool, line({ title: 'fresh' }) + '\n');
    assert.equal(await ingestTestOutcomes(db, spool), 1);
    assert.equal(count(db), 3);
  });

  test('an empty spool is a no-op', async () => {
    const { db, spool } = fresh();
    writeFileSync(spool, '');
    assert.equal(await ingestTestOutcomes(db, spool), 0);
  });
});

describe('flakyTestSummary', () => {
  test('counts a retry that eventually passed as a flake', async () => {
    const { db, spool } = fresh([
      line({ title: 'flaky one', attempts: 3, status: 'passed', flaky: true }),
      line({ title: 'flaky one', attempts: 2, status: 'passed', flaky: true }),
      line({ title: 'steady one', attempts: 1, status: 'passed', flaky: false }),
    ]);
    await ingestTestOutcomes(db, spool);

    const rows = flakyTestSummary(db, { days: 30, limit: 10 });
    assert.equal(rows.length, 1, 'only the flaky test is reported');
    assert.equal(rows[0].title, 'flaky one');
    assert.equal(rows[0].flakes, 2);
  });

  test('is empty rather than throwing when nothing has been ingested', () => {
    const { db } = fresh();
    assert.deepEqual(flakyTestSummary(db, { days: 30 }), []);
  });
});
