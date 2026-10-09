import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOffset, readPending, advance } from '../lib/admission-ship.js';
import { openDb } from '../lib/db.js';
import { createAdmission } from '../lib/admission.js';

// Before this, holds on an agent host never reached the coordinator: its hooks
// logged locally and nothing read the file. Real files, because the failure
// modes are byte offsets in a file another process appends to.
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'ship-'));
  dirs.push(d);
  return { log: join(d, 'admission.ndjson'), off: join(d, '.offset'), dir: d };
}
const ev = (o) => JSON.stringify({ ts: 1790000000, event: 'admitted', mode: 'enforce', runner: 'ultra-web',
  repo: 'o/web', run: '9', job: 'build', waited_s: 12, ran_s: 0, busy: 1, limit: 6, ...o });

describe('readPending / advance', () => {
  test('sends complete lines only; a half-written line waits', () => {
    const { log } = tmp();
    writeFileSync(log, `${ev({})}\n${ev({ event: 'held' })}\n{"ts":17900`);
    const p = readPending(log, 0);
    assert.equal(p.lines.length, 2);
    assert.equal(advance(p, 2), Buffer.byteLength(`${ev({})}\n${ev({ event: 'held' })}\n`));
  });

  test('the offset moves only by what the coordinator accepted', () => {
    const { log } = tmp();
    writeFileSync(log, `${ev({})}\n${ev({})}\n${ev({})}\n`);
    const p = readPending(log, 0);
    assert.equal(advance(p, 0), 0);
    assert.equal(advance(p, 1), Buffer.byteLength(`${ev({})}\n`));
    assert.equal(advance(p, 99), Buffer.byteLength(`${ev({})}\n`.repeat(3)));
  });

  test('a backlog is sent in bounded batches', () => {
    const { log } = tmp();
    writeFileSync(log, `${ev({})}\n`.repeat(50));
    const p = readPending(log, 0, { maxLines: 20 });
    assert.equal(p.lines.length, 20);
    const next = readPending(log, advance(p, 20), { maxLines: 20 });
    assert.equal(next.lines.length, 20);
  });

  test('a truncated log starts over instead of reading mid-line', () => {
    const { log } = tmp();
    writeFileSync(log, `${ev({})}\n`);
    const p = readPending(log, 10_000);
    assert.equal(p.offset, 0);
    assert.equal(p.lines.length, 1);
  });

  test('first start begins at the end of an existing log, not its history', () => {
    // A host that was the coordinator already has these rows in the database
    // it hands over; replaying them would duplicate every one.
    const { log, off } = tmp();
    writeFileSync(log, `${ev({})}\n${ev({})}\n`);
    const start = loadOffset(off, log);
    assert.equal(start, Buffer.byteLength(`${ev({})}\n${ev({})}\n`));
    assert.ok(existsSync(off));
    appendFileSync(log, `${ev({ event: 'released' })}\n`);
    assert.deepEqual(readPending(log, loadOffset(off, log)).lines.map((l) => JSON.parse(l).event), ['released']);
  });

  test('a seeded offset file is respected', () => {
    const { log, off } = tmp();
    writeFileSync(log, `${ev({})}\n${ev({})}\n`);
    writeFileSync(off, '0\n');
    assert.equal(readPending(log, loadOffset(off, log)).lines.length, 2);
    assert.equal(readFileSync(off, 'utf8').trim(), '0');
  });
});

describe('coordinator side', () => {
  function fresh(hostId = 'runner-host') {
    const { dir, log } = tmp();
    const db = openDb(join(dir, 'test.db'));
    return { db, log, admission: createAdmission({ db, logPath: log, hostId }) };
  }

  test('shipped lines are stored against the host that sent them', () => {
    const { db, admission } = fresh();
    assert.equal(admission.ingestLines([ev({}), '', 'not json', ev({ event: 'held', reason: 'at the limit of 6' })], 'ultra'), 2);
    const rows = db.prepare('SELECT host_id, event FROM admission_events ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.host_id, r.event]), [['ultra', 'admitted'], ['ultra', 'held']]);
  });

  test('local log rows carry this host, and old unstamped rows are claimed at startup', () => {
    const { dir, log } = tmp();
    const db = openDb(join(dir, 'test.db'));
    db.prepare("INSERT INTO admission_events (ts, event, runner) VALUES (1, 'admitted', 'old')").run();
    const admission = createAdmission({ db, logPath: log, hostId: 'runner-host' });
    writeFileSync(log, `${ev({ runner: 'RL-web', limit: 2 })}\n`);
    admission.ingest();
    const hosts = db.prepare('SELECT DISTINCT host_id FROM admission_events').all().map((r) => r.host_id);
    assert.deepEqual(hosts, ['runner-host']);
  });

  test('the headline mode and limit are this host\'s; every host is in byHost', () => {
    const { log, admission } = fresh('runner-host');
    writeFileSync(log, `${ev({ runner: 'RL-web', limit: 2 })}\n`);
    admission.ingest();
    // Newer, from the other host, with a different limit.
    admission.ingestLines([ev({ ts: 1790000100, runner: 'ultra-web', event: 'held', limit: 6 })], 'ultra');
    const s = admission.summary();
    assert.equal(s.limit, 2);
    assert.equal(s.byHost['runner-host'].limit, 2);
    assert.equal(s.byHost.ultra.limit, 6);
    assert.equal(s.byHost.ultra.waiting, 1);
    assert.deepEqual(s.waiting.map((w) => [w.host, w.runner]), [['ultra', 'ultra-web']]);
  });

  test('the same runner name on two hosts is two runners', () => {
    const { admission } = fresh('a');
    admission.ingestLines([ev({ runner: 'web', event: 'held' })], 'a');
    admission.ingestLines([ev({ runner: 'web', event: 'admitted' })], 'b');
    assert.deepEqual(admission.summary().waiting.map((w) => w.host), ['a']);
  });
});
