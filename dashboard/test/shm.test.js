// The shared memory table as the dashboard reads it (lib/shm.js), and the
// shm-low rung it feeds. Until this, a host whose table was full failed every
// Postgres suite with a step-log error the verdict never saw.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIpcs, countOrphans, summarizeShmLog, createShmSampler, shmPressure, lowFreeFromEnv, readTail, SHM_DEFAULTS,
} from '../lib/shm.js';
import { computeVerdict, buildGlance, LADDER } from '../lib/verdict.js';
import { SCENARIOS, LIVE_TS } from './fixtures/scenarios.js';

const MIN = 60 * 1000;
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmpLog = () => {
  const d = mkdtempSync(join(tmpdir(), 'shm-'));
  dirs.push(d);
  return join(d, 'shm.ndjson');
};

// The layout macOS prints for `ipcs -m -o -p` (captured 2026-10-13).
const IPCS = (rows) => [
  'IPC status from <running system> as of Tue Oct 13 09:06:55 EDT 2026',
  'T     ID     KEY        MODE       OWNER    GROUP NATTCH  CPID  LPID',
  'Shared Memory:',
  ...rows.map(([id, owner, nattch, cpid]) => `m ${id} 0x0592affc --rw------- ${owner}    staff      ${nattch}  ${cpid}  ${cpid}`),
  '',
].join('\n');

const line = (o) => JSON.stringify({
  ts: Math.floor(LIVE_TS / 1000), event: 'reaped', phase: 'started', runner: 'build-host-delta-web',
  repo: 'acme/delta-web', run: '7', reaped: 1, failed: 0, used: 10, limit: 32, ids: '131072', ...o,
});

describe('parseIpcs', () => {
  test('finds columns by header name', () => {
    const segs = parseIpcs(IPCS([[131072, 'ci', 6, 48163], [124518401, 'ci', 0, 32618]]));
    assert.deepEqual(segs, [
      { id: '131072', owner: 'ci', nattch: 6, cpid: 48163 },
      { id: '124518401', owner: 'ci', nattch: 0, cpid: 32618 },
    ]);
  });

  test('an empty table is zero segments, not unknown', () => {
    assert.deepEqual(parseIpcs(IPCS([])), []);
  });

  test('a header without the columns is unknown, never a guess', () => {
    assert.equal(parseIpcs('T ID KEY MODE OWNER GROUP\nm 1 0x1 --rw------- ci staff\n'), null);
    assert.equal(parseIpcs(''), null);
  });
});

describe('countOrphans', () => {
  // The hook's three rules: ours, unattached, creator gone.
  test('counts only what the next job hook would remove', () => {
    const segs = parseIpcs(IPCS([
      [1, 'ci', 0, 100], // orphan
      [2, 'ci', 0, 200], // creator alive: a cluster between shmget and shmat
      [3, 'ci', 3, 100], // attached
      [4, 'postgres', 0, 100], // not ours to judge
    ]));
    assert.equal(countOrphans(segs, { user: 'ci', alive: (pid) => pid === 200 }), 1);
  });
});

describe('summarizeShmLog', () => {
  test('sums the last day of reaping and keeps the newest low event', () => {
    const now = LIVE_TS;
    const s = (m) => Math.floor((now - m * MIN) / 1000);
    const text = [
      line({ ts: s(25 * 60), reaped: 9 }), // older than a day
      line({ ts: s(60), reaped: 2 }),
      line({ ts: s(20), event: 'low', reaped: 1, used: 30 }),
      line({ ts: s(5), event: 'low', reaped: 0, used: 29, runner: 'build-host-comet-web', repo: 'acme/comet-web' }),
    ].join('\n');
    const out = summarizeShmLog(text, now);
    assert.equal(out.reaped, 3);
    assert.equal(out.reapEvents, 2);
    assert.equal(out.lastReapedAt, s(20) * 1000);
    assert.deepEqual(out.lastLow, {
      at: s(5) * 1000, used: 29, limit: 32, free: 3, runner: 'build-host-comet-web', repo: 'acme/comet-web',
    });
  });

  test('a line cut by the tail read is skipped, not fatal', () => {
    const out = summarizeShmLog(`3,"limit":32,"ids":""}\n${line({})}\n`, LIVE_TS);
    assert.equal(out.reaped, 1);
  });
});

describe('readTail', () => {
  test('reads only the last bytes of a long log', () => {
    const log = tmpLog();
    writeFileSync(log, `${line({ reaped: 5 })}\n`.repeat(100));
    const text = readTail(log, 1000);
    assert.ok(text.length <= 1000);
    assert.ok(summarizeShmLog(text, LIVE_TS).reapEvents < 100);
  });

  test('a missing log is no history', () => {
    assert.equal(readTail(join(tmpdir(), 'no-such-shm-log.ndjson')), '');
  });
});

describe('lowFreeFromEnv', () => {
  test('reads FLEET_SHM_LOW_FREE the way the hook does', () => {
    assert.equal(lowFreeFromEnv({}), SHM_DEFAULTS.lowFree);
    assert.equal(lowFreeFromEnv({ FLEET_SHM_LOW_FREE: '6' }), 6);
    assert.equal(lowFreeFromEnv({ FLEET_SHM_LOW_FREE: '0' }), 0);
    assert.equal(lowFreeFromEnv({ FLEET_SHM_LOW_FREE: 'four' }), SHM_DEFAULTS.lowFree);
    assert.equal(lowFreeFromEnv({ FLEET_SHM_LOW_FREE: '-1' }), SHM_DEFAULTS.lowFree);
  });
});

describe('createShmSampler', () => {
  const fakeRun = (table, calls = []) => async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'sysctl') return '32\n';
    if (cmd === 'ipcs') return table;
    return '';
  };

  test('samples the table and summarises the log', async () => {
    const log = tmpLog();
    writeFileSync(log, `${line({ reaped: 2 })}\n`);
    const sample = createShmSampler({
      logPath: log, user: 'ci', alive: () => false,
      run: fakeRun(IPCS([[1, 'ci', 0, 100], [2, 'ci', 4, 100], [3, 'ci', 1, 100]])),
    });
    const shm = await sample(LIVE_TS);
    assert.equal(shm.limit, 32);
    assert.equal(shm.used, 3);
    assert.equal(shm.orphaned, 1);
    assert.equal(shm.reaped24h, 2);
    assert.equal(shm.lowFree, 4);
  });

  test('reads the fixed limit once and the log only when it grew', async () => {
    const log = tmpLog();
    writeFileSync(log, `${line({ reaped: 1 })}\n`);
    const calls = [];
    const sample = createShmSampler({ logPath: log, user: 'ci', alive: () => false, run: fakeRun(IPCS([]), calls) });
    assert.equal((await sample(LIVE_TS)).reaped24h, 1);
    appendFileSync(log, `${line({ reaped: 3 })}\n`);
    assert.equal((await sample(LIVE_TS)).reaped24h, 4);
    assert.equal(calls.filter((c) => c === 'sysctl').length, 1);
  });

  test('nothing readable at all is null, not an empty table', async () => {
    const sample = createShmSampler({ logPath: tmpLog(), run: async () => '' });
    assert.equal(await sample(LIVE_TS), null);
  });
});

describe('shmPressure', () => {
  const base = { limit: 32, used: 10, orphaned: 0, lowFree: 4, reaped24h: 0, lastLow: null };

  test('orphans count as free: the next hook removes them first', () => {
    const p = shmPressure({ ...base, used: 31, orphaned: 6 }, LIVE_TS);
    assert.equal(p.free, 7);
    assert.equal(p.low, false);
  });

  test('live clusters under the threshold are low; none free is full', () => {
    assert.equal(shmPressure({ ...base, used: 29 }, LIVE_TS).low, true);
    assert.equal(shmPressure({ ...base, used: 29 }, LIVE_TS).full, false);
    assert.equal(shmPressure({ ...base, used: 32 }, LIVE_TS).full, true);
  });

  test('a recent low event is low even after the burst drained', () => {
    // Live clusters that filled the table are gone by the next tick; the event
    // the hook wrote is the only trace of the jobs that failed.
    const lastLow = { at: LIVE_TS - 10 * MIN, used: 30, limit: 32, free: 2 };
    assert.equal(shmPressure({ ...base, lastLow }, LIVE_TS).low, true);
    assert.equal(shmPressure({ ...base, lastLow }, LIVE_TS + 25 * MIN).low, false);
  });

  test('without a live sample the event alone decides', () => {
    const lastLow = { at: LIVE_TS - MIN, used: 30, limit: 32, free: 2 };
    const p = shmPressure({ limit: null, used: null, orphaned: null, lastLow }, LIVE_TS);
    assert.equal(p.low, true);
    assert.equal(p.free, null);
  });

  test('no table is no finding', () => {
    assert.equal(shmPressure(null, LIVE_TS), null);
    assert.equal(shmPressure(undefined, LIVE_TS), null);
  });
});

describe('the shm-low rung', () => {
  const verdict = (s) => computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 }).verdict;
  const setShm = (s, patch) => {
    s.snapshot.host.shm = { ...s.snapshot.host.shm, ...patch };
    s.snapshot.hosts[0].host.shm = { ...s.snapshot.hosts[0].host.shm, ...patch };
    return s;
  };

  test('says what the table holds and how fast it leaks', () => {
    const v = verdict(SCENARIOS.shmLow());
    assert.equal(v.id, 'shm-low');
    assert.equal(v.tone, 'warning');
    assert.match(v.evidence.join('\n'), /3 of 32 System V segments free/);
    assert.match(v.evidence.join('\n'), /4 orphaned segments reaped in the last 24 h/);
    assert.equal(v.next.command, 'ipcs -m -o -p');
  });

  test('a full table is critical', () => {
    const v = verdict(setShm(SCENARIOS.shmLow(), { used: 32 }));
    assert.equal(v.tone, 'critical');
    assert.equal(v.title, 'Shared memory table is full');
  });

  test('a drained table with no recent event closes the rung', () => {
    const s = setShm(SCENARIOS.shmLow(), { used: 3, lastLow: { ...SCENARIOS.shmLow().snapshot.host.shm.lastLow, at: LIVE_TS - 2 * 60 * MIN } });
    assert.equal(verdict(s).id, 'clear');
  });

  test('sits under dead-service and over saturated', () => {
    const ids = LADDER.map((l) => l.id);
    assert.ok(ids.indexOf('dead-service') < ids.indexOf('shm-low'));
    assert.ok(ids.indexOf('shm-low') < ids.indexOf('saturated'));

    const dead = SCENARIOS.dead();
    dead.snapshot.host.shm = SCENARIOS.shmLow().snapshot.host.shm;
    dead.snapshot.hosts[0].host.shm = dead.snapshot.host.shm;
    assert.deepEqual(verdict(dead).open.map((o) => o.id).slice(0, 2), ['dead-service', 'shm-low']);

    const sat = SCENARIOS.saturated();
    sat.snapshot.host.shm = dead.snapshot.host.shm;
    sat.snapshot.hosts[0].host.shm = dead.snapshot.host.shm;
    assert.equal(verdict(sat).id, 'shm-low');
    assert.ok(verdict(sat).open.some((o) => o.id === 'saturated'));
  });

  test('an agent host\'s table is read from its heartbeat, named in the evidence', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.hosts.push({
      id: 'studio', name: 'studio', stale: false, local: false, runnerCount: 1, busyCount: 0,
      host: { shm: { limit: 32, used: 30, orphaned: 0, lowFree: 4, reaped24h: 7, lastLow: null } },
    });
    const v = verdict({ ...s, facts: s.facts });
    assert.equal(v.id, 'shm-low');
    assert.match(v.evidence[0], /^studio: 2 of 32/);
  });

  test('a stale host\'s last report is host-down\'s business, not this rung\'s', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.hosts.push({
      id: 'studio', name: 'studio', stale: true, staleForMs: 9 * MIN, local: false,
      host: { shm: { limit: 32, used: 32, orphaned: 0, lowFree: 4, reaped24h: 0, lastLow: null } },
    });
    assert.ok(!verdict(s).open.some((o) => o.id === 'shm-low'));
  });

  test('the glance carries the table in the host vitals', () => {
    const s = SCENARIOS.shmLow();
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 });
    const g = buildGlance(s.snapshot, r, { now: s.now, floorGb: 40, localHostId: 'build-host' });
    const local = g.hosts.find((h) => h.local);
    assert.equal(local.vitals.shmLimit, 32);
    assert.equal(local.vitals.shmUsed, 29);
    assert.equal(local.vitals.shmOrphaned, 0);
    assert.equal(local.vitals.shmReaped24h, 4);
  });
});
