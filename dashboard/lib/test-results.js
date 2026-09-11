// Ingest Playwright JSON test results from the NDJSON spool into test_outcomes.
//
// The spool is an append-only NDJSON file written by hooks/job-completed.sh.
// Each line is one result record. The spool cursor (last byte offset read) is
// persisted in the meta table so restarts do not re-ingest old records.
//
// A test that failed on its first attempt but passed on a retry is flaky:
// attempts > 1 and status === 'passed'. A test that failed on every attempt
// is a failure. A test that passed first try is success.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';

const SPOOL_CURSOR_KEY = 'test_outcomes_spool_cursor';

export async function ingestTestOutcomes(db, spoolPath) {
  if (!spoolPath) return 0;
  let size = 0;
  try { size = statSync(spoolPath).size; } catch { return 0; }
  if (size === 0) return 0;

  const cursorRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SPOOL_CURSOR_KEY);
  let cursor = cursorRow ? Number(cursorRow.value) : 0;
  // Past the end means the spool was rotated or truncated. Reading from the old
  // offset would land mid-line and stay wrong forever.
  if (!Number.isFinite(cursor) || cursor < 0 || cursor > size) cursor = 0;
  if (cursor >= size) return 0;

  const insert = db.prepare(`
    INSERT INTO test_outcomes
      (ts, repo, head_sha, run_id, job_id, browser, project, file, title, attempts, status, flaky, duration_ms)
    VALUES
      (@ts, @repo, @head_sha, @run_id, @job_id, @browser, @project, @file, @title, @attempts, @status, @flaky, @duration_ms)
  `);
  const upsertCursor = db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  );

  // Read only as far as the size measured above, so a hook appending while this
  // runs cannot move the end out from under the cursor arithmetic below.
  const stream = createReadStream(spoolPath, { start: cursor, end: size - 1, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // A hook may be mid-append, so a line is only consumed once its terminating
  // newline has been seen. Without that check half a record would be parsed,
  // dropped, and never seen again because the cursor had already moved past it.
  const pending = [];
  let offset = cursor;
  let consumed = cursor;
  for await (const line of rl) {
    offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline
    if (offset > size) break;                      // no newline yet — still being written
    consumed = offset;
    if (line.trim()) pending.push(line);
  }
  if (consumed === cursor) return 0;

  // node:sqlite's DatabaseSync has no transaction() helper, so the batch is
  // bracketed explicitly. Grouping the inserts matters: this runs on the fast
  // loop, and one commit per record would fsync thousands of times per pass.
  let ingested = 0;
  db.exec('BEGIN');
  try {
    for (const line of pending) {
      try {
        const rec = JSON.parse(line);
        if (!rec.repo || !rec.file || !rec.title) continue;
        insert.run({
          ts: rec.ts ?? Date.now(),
          repo: rec.repo,
          head_sha: rec.head_sha ?? null,
          run_id: String(rec.run_id ?? ''),
          job_id: String(rec.job_id ?? ''),
          browser: rec.browser ?? null,
          project: rec.project ?? null,
          file: rec.file,
          title: rec.title,
          attempts: rec.attempts ?? 1,
          status: rec.status ?? 'unknown',
          flaky: rec.flaky ? 1 : 0,
          duration_ms: rec.duration_ms ?? null,
        });
        ingested++;
      } catch { /* skip malformed lines */ }
    }
    // Advances past every complete line read, not just the ones that inserted.
    // A line that cannot be parsed now will not parse on the next pass either,
    // and holding the cursor behind it would re-read the rest of the spool on
    // every tick for the life of the process.
    upsertCursor.run(SPOOL_CURSOR_KEY, String(consumed));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return ingested;
}

// Flaky test summary for the analytics screen. Returns the top flaky tests
// within the window, sorted by flake count descending.
export function flakyTestSummary(db, { days = 30, limit = 20 } = {}) {
  const since = Date.now() - days * 86400000;
  try {
    const rows = db.prepare(`
      SELECT repo, browser, file, title,
             COUNT(*) AS runs,
             SUM(flaky) AS flakes,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
             ROUND(SUM(flaky) * 1.0 / COUNT(*), 3) AS flake_rate,
             MAX(ts) AS last_seen
      FROM test_outcomes
      WHERE ts >= ? AND flaky = 1
      GROUP BY repo, browser, file, title
      ORDER BY flakes DESC, last_seen DESC
      LIMIT ?
    `).all(since, limit);
    return rows;
  } catch { return []; }
}
