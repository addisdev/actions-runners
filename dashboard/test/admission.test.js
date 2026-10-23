import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { createAdmission } from '../lib/admission.js';

// createAdmission reads a real file and a real database rather than mocks: the
// two things that have actually broken here are the byte cursor into a file
// being appended to by another process, and column semantics. Neither survives
// being stubbed.
const now = Math.floor(Date.now() / 1000);

// The shape hooks/common.sh emits. Overridden per case.
const line = (o) => JSON.stringify({
  ts: now, mode: 'enforce', runner: 'r1', repo: 'testowner/app', run: '7',
  job: 'build', waited_s: 0, ran_s: 0, busy: 0, limit: 3,
  owner_kind: 'worker', owner_pid: '111', reason: '', ...o,
});

// One database and log per case. Sharing them let rows from one test into the
// counts of another, which is how a passing suite hid a real ordering bug.
const dirs = [];
function fresh(lines = null) {
  const dir = mkdtempSync(join(tmpdir(), 'admission-'));
  dirs.push(dir);
  const log = join(dir, 'admission.ndjson');
  const db = openDb(join(dir, 'test.db'));
  const admission = createAdmission({ db, logPath: log, warn: () => {} });
  if (lines) {
    writeFileSync(log, lines.join('\n') + '\n');
    admission.ingest();
  }
  return { dir, log, db, admission };
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('ingest', () => {
  test('a missing log is not an error', () => {
    const { admission } = fresh();
    assert.equal(admission.ingest(), 0);
    assert.equal(admission.summary().mode, null);
  });

  test('reads every complete line once', () => {
    const { admission } = fresh([
      line({ event: 'admitted', runner: 'r1', busy: 0 }),
      line({ event: 'admitted', runner: 'r2', busy: 1 }),
      line({ event: 'held', runner: 'r3', busy: 3, reason: 'at the limit of 3' }),
    ]);
    assert.equal(admission.ingest(), 0, 'second pass must not re-read');
    assert.equal(admission.summary().last24h.admitted, 2);
  });

  // A hook appends while this runs. Consuming a half-written object would drop
  // it permanently, because the cursor would already be past it.
  test('leaves a partial trailing line for the next pass', () => {
    const { log, db, admission } = fresh([line({ event: 'admitted', runner: 'r1' })]);
    appendFileSync(log, '{"ts":123,"event":"admi');
    assert.equal(admission.ingest(), 0);
    appendFileSync(log, 'tted","runner":"r9","mode":"enforce","limit":3}\n');
    assert.equal(admission.ingest(), 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM admission_events WHERE runner='r9'").get().n, 1);
  });

  test('skips a malformed line instead of retrying it forever', () => {
    const { log, admission } = fresh([line({ event: 'admitted', runner: 'r1' })]);
    appendFileSync(log, 'not json at all\n');
    appendFileSync(log, line({ event: 'admitted', runner: 'r10' }) + '\n');
    assert.equal(admission.ingest(), 1);
    assert.equal(admission.ingest(), 0, 'cursor must advance past the junk');
  });

  // Reading from the old offset after a truncation lands mid-line and stays
  // wrong for the life of the process.
  test('restarts when the log shrinks', () => {
    const { log, db, admission } = fresh([
      line({ event: 'admitted', runner: 'r1' }),
      line({ event: 'admitted', runner: 'r2' }),
      line({ event: 'admitted', runner: 'r3' }),
    ]);
    writeFileSync(log, line({ event: 'admitted', runner: 'fresh' }) + '\n');
    assert.equal(admission.ingest(), 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_events').get().n, 4);
  });
});

describe('summary', () => {
  let s;

  before(() => {
    s = fresh([
      line({ event: 'admitted', runner: 'a1', busy: 0 }),
      line({ event: 'held', runner: 'a2', busy: 3, reason: 'at the limit of 3' }),
      line({ event: 'admitted', runner: 'a2', waited_s: 42, busy: 2 }),
      line({ event: 'timeout', runner: 'a3', waited_s: 600, busy: 3, owner_kind: 'fallback', owner_pid: '9' }),
      line({ event: 'held', runner: 'a4', busy: 3, reason: 'at the limit of 3' }),
    ]).admission.summary();
  });

  test('reports mode and limit from the events, not from config', () => {
    assert.equal(s.mode, 'enforce');
    assert.equal(s.limit, 3);
  });

  test('counts each decision', () => {
    assert.equal(s.last24h.admitted, 2);
    assert.equal(s.last24h.held, 2);
    assert.equal(s.last24h.timeout, 1);
  });

  // Only a wait that ended in the job starting is time the mechanism cost. A
  // `held` row announces a wait and carries 0 by construction, so summing it
  // would double-count nothing and summing `ran_s` would add job durations.
  test('attributes only real waits', () => {
    assert.equal(s.heldSeconds, 642);
  });

  test('lists the runners whose newest event is a hold', () => {
    assert.deepEqual(s.waiting.map((w) => w.runner), ['a4']);
    assert.equal(s.waiting[0].limit, 3);
  });

  test('a runner stops waiting once admitted', () => {
    assert.equal(s.waiting.some((w) => w.runner === 'a2'), false);
  });
});

// Regressions. Each of these shipped once.
describe('fields named for what they hold', () => {
  test('a release reports occupancy as ran_s, not as a wait', () => {
    const { db, admission } = fresh([
      line({ event: 'admitted', runner: 'b1', waited_s: 10 }),
      line({ event: 'released', runner: 'b1', ran_s: 3300, owner_kind: '', owner_pid: '' }),
    ]);
    assert.equal(admission.summary().heldSeconds, 10, 'occupancy must not count as a wait');
    assert.equal(db.prepare("SELECT ran_s FROM admission_events WHERE event='released'").get().ran_s, 3300);
  });

  // job-completed.sh resolves no owner, so the newest row is usually a release
  // carrying none. Reading the owner and the mode off one row reported "no
  // owner" permanently, hiding the fallback condition the field exists for.
  test('a release does not erase the last known owner', () => {
    const { admission } = fresh([
      line({ event: 'admitted', runner: 'c1', owner_kind: 'fallback', owner_pid: '5' }),
      line({ event: 'released', runner: 'c1', owner_kind: '', owner_pid: '' }),
    ]);
    assert.equal(admission.summary().ownerKind, 'fallback');
  });

  // Taking mode from the newest row regardless would let a row written without
  // one read as "installed but switched off" mid-enforcement.
  test('a row with no mode does not read as mode off', () => {
    const { admission } = fresh([
      line({ event: 'admitted', runner: 'd1' }),
      JSON.stringify({ ts: now, event: 'admitted', runner: 'd2', waited_s: 0 }),
    ]);
    assert.equal(admission.summary().mode, 'enforce');
  });

  // The hooks emitted the kind under a key called `owner` before it was renamed.
  test('a log written before the rename still reads', () => {
    const { admission } = fresh([JSON.stringify({
      ts: now, event: 'admitted', mode: 'observe', runner: 'e1', limit: 2, owner: 'fallback',
    })]);
    const s = admission.summary();
    assert.equal(s.ownerKind, 'fallback');
    assert.equal(s.mode, 'observe');
  });
});

// Without this the dashboard cannot tell "installed but switched off" from
// "never installed", and those need opposite responses from an operator.
describe('countInstalled', () => {
  test('distinguishes installed, absent and unreadable', () => {
    const { dir, admission } = fresh();
    mkdirSync(join(dir, 'runner-a'), { recursive: true });
    mkdirSync(join(dir, 'runner-b'), { recursive: true });
    writeFileSync(join(dir, 'runner-a/.env'), 'PATH=/usr/bin\nACTIONS_RUNNER_HOOK_JOB_STARTED=/x/job-started.sh\n');
    writeFileSync(join(dir, 'runner-b/.env'), 'PATH=/usr/bin\n');
    const counted = admission.countInstalled([
      { dir: join(dir, 'runner-a') },
      { dir: join(dir, 'runner-b') },
      { dir: join(dir, 'runner-missing') },
    ]);
    assert.equal(counted.installed, 1);
    assert.equal(counted.total, 3);
    assert.equal(admission.summary().hooks.installed, 1);
  });

  // The UI shows "checking" until this is set, rather than claiming 0 of 0
  // means none installed — which it would say on every restart.
  test('is uncounted until it has run, not zero', () => {
    const { dir, admission } = fresh();
    assert.equal(admission.summary().hooks.checkedAt, null);
    admission.countInstalled([{ dir: join(dir, 'runner-a') }]);
    assert.ok(admission.summary().hooks.checkedAt > 0);
  });
});

describe('lanes', () => {
  const lane = (o) => line({ lanes: 'observe', lane: 'heavy', lane_source: 'pattern', heavy_busy: 1,
    light_busy: 0, heavy_limit: 4, light_limit: 12, total_limit: 16, lane_would_hold: false,
    lane_wait_s: null, lane_reason: '', ...o });

  test('a line from a hook with lanes off has no lane summary', () => {
    const { admission } = fresh([line({ event: 'admitted' })]);
    assert.equal(admission.summary().lanes, null);
  });

  test('lane fields are stored as written', () => {
    const { db } = fresh([lane({ event: 'held', runner: 'r1', lane_would_hold: true,
      lane_reason: '4 heavy job(s) already running, at the heavy limit of 4', lane_wait_s: 0 })]);
    const r = db.prepare('SELECT * FROM admission_events').get();
    assert.equal(r.lanes, 'observe');
    assert.equal(r.lane, 'heavy');
    assert.equal(r.lane_source, 'pattern');
    assert.equal(r.lane_would_hold, 1);
    assert.equal(r.lane_wait_s, 0);
    assert.equal(r.total_limit, 16);
    assert.equal(r.lane_reason, '4 heavy job(s) already running, at the heavy limit of 4');
  });

  test('the summary counts running and waiting jobs per lane, and what the lanes would have done', () => {
    const { admission } = fresh([
      lane({ event: 'admitted', runner: 'h1', lane: 'heavy' }),
      lane({ event: 'admitted', runner: 'h2', lane: 'heavy', lane_would_hold: true }),
      lane({ event: 'admitted', runner: 'l1', lane: 'light' }),
      lane({ event: 'admitted', runner: 's1', lane: 'simulator' }),
      lane({ event: 'held', runner: 'l2', lane: 'light', reason: '8 job(s) already running, at the limit of 8',
        lane_would_hold: false, lane_wait_s: 0 }),
      lane({ event: 'admitted', runner: 'l3', lane: 'light', waited_s: 40, lane_wait_s: 0 }),
      lane({ event: 'admitted', runner: 'x', lane: 'light' }),
      lane({ event: 'released', runner: 'x', lane: 'light' }),
    ]);
    const s = admission.summary();
    assert.equal(s.lanes.mode, 'observe');
    assert.deepEqual(s.lanes.limits, { heavy: 4, light: 12, total: 16 });
    assert.deepEqual(s.lanes.running, { heavy: 2, light: 2, simulator: 1 });
    assert.deepEqual(s.lanes.waiting, { heavy: 0, light: 1, simulator: 0 });
    assert.equal(s.lanes.last24h.heldLanesWouldAdmit, 1);
    assert.equal(s.lanes.last24h.admittedLanesWouldHold, 1);
    assert.equal(s.lanes.last24h.waitedS, 40);
    assert.equal(s.lanes.last24h.laneWaitS, 0);
    assert.equal(s.waiting[0].lane, 'light');
    assert.equal(s.waiting[0].laneWouldHold, false);
  });
});
