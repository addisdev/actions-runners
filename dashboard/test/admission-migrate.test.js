import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { createAdmission } from '../lib/admission.js';

// admission_events is a cache of the hooks' NDJSON log, so a shape change drops
// and rebuilds it rather than migrating column by column. That is only safe if
// the read cursor is reset with it: otherwise the rows are deleted, the log is
// never re-read, and the Capacity panel goes permanently blank on upgrade.
let dir;
let log;
let dbPath;

const now = Math.floor(Date.now() / 1000);

// The pre-rename shape, as an install predating owner_kind/ran_s would have it.
const OLD_DDL = `
  CREATE TABLE admission_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL,
    mode TEXT, runner TEXT, repo TEXT, run_id TEXT, job TEXT, waited_s INTEGER,
    busy INTEGER, limit_n INTEGER, owner TEXT, reason TEXT);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'admission-migrate-'));
  log = join(dir, 'admission.ndjson');
  dbPath = join(dir, 'test.db');

  writeFileSync(log, [
    JSON.stringify({ ts: now, event: 'admitted', mode: 'enforce', runner: 'r1', limit: 3, waited_s: 0, owner: 'worker' }),
    JSON.stringify({ ts: now, event: 'admitted', mode: 'enforce', runner: 'r2', limit: 3, waited_s: 55, owner: 'fallback' }),
  ].join('\n') + '\n');

  const old = new DatabaseSync(dbPath);
  old.exec(OLD_DDL);
  old.exec(`INSERT INTO admission_events (ts, event, mode, runner, limit_n, waited_s, owner)
            VALUES (${now}, 'admitted', 'enforce', 'r1', 3, 0, 'worker')`);
  // The cursor an earlier ingest would have left behind, past the whole log.
  old.exec("INSERT INTO meta (key, value) VALUES ('admission_log_offset', '99999')");
  old.close();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('admission_events migration', () => {
  test('replaces the old shape', () => {
    const db = openDb(dbPath);
    const cols = db.prepare('PRAGMA table_info(admission_events)').all().map((c) => c.name);
    assert.equal(cols.includes('owner'), false, "'owner' held a kind, not a PID");
    assert.ok(cols.includes('owner_kind'));
    assert.ok(cols.includes('owner_pid'));
    assert.ok(cols.includes('ran_s'));
    db.close();
  });

  test('clears the stale read cursor so the log is re-read', () => {
    const db = openDb(dbPath);
    const admission = createAdmission({ db, logPath: log, warn: () => {} });
    assert.equal(admission.ingest(), 2, 'both rows must come back from the log');
    const s = admission.summary();
    assert.equal(s.mode, 'enforce');
    assert.equal(s.ownerKind, 'fallback');
    assert.equal(s.heldSeconds, 55);
    db.close();
  });

  test('is idempotent — reopening rebuilds nothing', () => {
    const db = openDb(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_events').get().n, 2);
    const admission = createAdmission({ db, logPath: log, warn: () => {} });
    assert.equal(admission.ingest(), 0, 'the cursor must survive a reopen');
    db.close();
  });
});
