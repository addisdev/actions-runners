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
  const cursor = cursorRow ? Number(cursorRow.value) : 0;
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

  let ingested = 0;
  let lastOffset = cursor;
  const stream = createReadStream(spoolPath, { start: cursor, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const ingestAll = db.transaction((lines) => {
    for (const { line, offset } of lines) {
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
        lastOffset = offset;
      } catch { /* skip malformed lines */ }
    }
    upsertCursor.run(SPOOL_CURSOR_KEY, String(lastOffset));
  });

  // Collect lines with their byte offsets before transacting.
  const pending = [];
  let byteOffset = cursor;
  for await (const line of rl) {
    byteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    if (line.trim()) pending.push({ line, offset: byteOffset });
  }
  if (pending.length) ingestAll(pending);

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
