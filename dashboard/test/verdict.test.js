// The verdict ladder, checked against the incidents that wrote it.
//
// Each scenario in fixtures/scenarios.js reproduces a real failure on a real
// fleet. If a change makes the 09-29 disk-floor freeze read as anything but
// "disk floor", this is where it fails — before an operator reads "load" at
// 2 a.m. and waits for a queue that will never move.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeVerdict, createVerdictTracker, buildGlance, loadFailureFacts, parseDiskHold, LADDER, GLANCE_SCHEMA,
  RUNNER_STATES,
} from '../lib/verdict.js';
import { openDb } from '../lib/db.js';
import { SCENARIOS, LIVE_TS } from './fixtures/scenarios.js';

const run = (name) => {
  const s = SCENARIOS[name]();
  return { s, r: computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: s.floorGb ?? 40 }) };
};

describe('every scenario lands on its rung', () => {
  for (const name of Object.keys(SCENARIOS)) {
    test(name, () => {
      const { s, r } = run(name);
      assert.equal(r.verdict.id, s.expect, `${name}: ${r.verdict.title} — ${r.verdict.sentence}`);
      assert.equal(r.verdict.rung, LADDER.findIndex((l) => l.id === s.expect));
      assert.ok(r.verdict.sentence, 'every verdict says something in words');
      assert.ok(r.verdict.next?.label, 'every verdict names one next move');
      if (s.runner) {
        const [name2, state] = s.runner;
        assert.equal(r.runners.get(name2)?.state, state, `${name2} state`);
      }
      for (const x of r.runners.values()) assert.ok(RUNNER_STATES.includes(x.state), x.state);
    });
  }
});

describe('precedence', () => {
  test('a disk-floor hold outranks the dead service and queue it causes', () => {
    const disk = SCENARIOS.diskHold();
    const dead = SCENARIOS.dead();
    disk.snapshot.drift = dead.snapshot.drift;
    disk.snapshot.queue = dead.snapshot.queue;
    const r = computeVerdict(disk.snapshot, disk.facts, { now: disk.now, floorGb: 40 });
    assert.equal(r.verdict.id, 'disk-floor');
    assert.deepEqual(r.verdict.open.map((o) => o.id), ['disk-floor', 'dead-service']);
  });

  test('every open rung is listed in ladder order', () => {
    const s = SCENARIOS.saturated();
    s.facts.account = SCENARIOS.accountBlocked().facts.account;
    s.snapshot.drift = SCENARIOS.drift().snapshot.drift;
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now });
    const ids = r.verdict.open.map((o) => o.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => LADDER.findIndex((l) => l.id === a) - LADDER.findIndex((l) => l.id === b)));
    assert.equal(ids[0], 'saturated');
    assert.ok(ids.includes('account-blocked') && ids.includes('config-drift'));
  });

  test('a queue alongside a real fault does not soften the verdict', () => {
    const s = SCENARIOS.dead();
    s.snapshot.queue.push({ ...SCENARIOS.waiting().snapshot.queue[0], id: 99 });
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now });
    assert.equal(r.verdict.id, 'dead-service');
  });
});

describe('what does not count', () => {
  test('one lost job is a blip, not saturation', () => {
    const s = SCENARIOS.saturated();
    s.facts.runnerLost = s.facts.runnerLost.slice(0, 1);
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now });
    assert.notEqual(r.verdict.id, 'saturated');
    assert.equal(r.runners.get('build-host-comet-web').lostAt, s.facts.runnerLost[0].at);
  });

  test('a run held by the headroom gate is waiting, not saturation', () => {
    // Seen live: memory pressure "warning" is this host's normal, so the gate
    // refuses additions most of the day and a queued run reads host-saturation.
    const s = SCENARIOS.quiet();
    s.snapshot.queue = [{ ...SCENARIOS.waiting().snapshot.queue[0], cause: 'host-saturation', confidence: 'high' }];
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now }).verdict.id, 'waiting');
  });

  test('warning memory pressure alone is not saturation', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.host.memPressure = 'warning';
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now }).verdict.id, 'clear');
  });

  test('an account block older than the window has left the glance', () => {
    const s = SCENARIOS.accountBlocked();
    s.facts.account.lastAt = s.now - 7 * 60 * 60 * 1000;
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now }).verdict.id, 'clear');
  });

  test('disk under the floor with admission off holds nothing', () => {
    const s = SCENARIOS.diskBelowIdle();
    s.snapshot.admission.mode = 'observe';
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 }).verdict.id, 'clear');
  });

  test('a slot hold is waiting, not a fault', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.admission.waiting = [{
      runner: 'build-host-comet-web', repo: 'acme/comet-web', since: Math.floor(s.now / 1000) - 60,
      reason: '2 job(s) already running, at the limit of 2', busy: 2, limit: 2,
    }];
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 });
    assert.equal(r.verdict.id, 'waiting');
    assert.equal(r.runners.get('build-host-comet-web').state, 'held-slot');
  });

  test('once disk is freed, a job held at 38 GB is waiting for a slot, not disk-held', () => {
    // Seen live 2026-09-30: after cleanup took the host to 46.8 GB, two jobs
    // still carried "38 GB disk free, below the 40 GB floor" from when their
    // hold began, and the verdict stayed on disk-floor.
    const s = SCENARIOS.diskHold();
    s.snapshot.host.diskFreeGb = 46.8;
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 });
    assert.equal(r.verdict.id, 'waiting');
    assert.equal(r.runners.get('build-host-comet-web').state, 'held-slot');
  });

  test('a public repo queued for GitHub-hosted runners is waiting, not drift; a private one is drift', () => {
    const s = SCENARIOS.quiet();
    const q = { ...SCENARIOS.waiting().snapshot.queue[0], repo: 'acme/public-tool', cause: 'github-hosted', confidence: 'high' };
    s.snapshot.queue = [q];
    s.snapshot.repos = [...s.snapshot.repos, { fullName: 'acme/public-tool', private: false, hasRunner: false, workflows: 2 }];
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now }).verdict.id, 'waiting');
    s.snapshot.repos.at(-1).private = true;
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now }).verdict.id, 'config-drift');
  });

  test('a held job is not counted as running, even though GitHub calls it in progress', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.active = [{
      id: 7, repo: 'acme/ember-ios', workflowName: 'ios-ci', status: 'in_progress',
      jobs: [{ status: 'in_progress', runnerName: 'build-host-ember-ios', name: 'test', startedAt: new Date(s.now - 60000).toISOString() }],
    }];
    s.snapshot.admission.waiting = [{
      runner: 'build-host-ember-ios', repo: 'acme/ember-ios', since: Math.floor(s.now / 1000) - 60,
      reason: '2 job(s) already running, at the limit of 2', busy: 2, limit: 2,
    }];
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 });
    assert.equal(r.runners.get('build-host-ember-ios').state, 'held-slot');
    assert.equal(r.counts.running, 0);
    assert.equal(r.counts.held, 1);
    assert.match(r.verdict.sentence, /^0 running, 1 waiting for an admission slot/);
  });

  test('a held row older than the slot TTL is a dead hook, not a wait', () => {
    const s = SCENARIOS.diskHold();
    for (const w of s.snapshot.admission.waiting) w.since -= 7 * 3600;
    s.snapshot.host.diskFreeGb = 80;
    s.snapshot.hosts[0].host.diskFreeGb = 80;
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb: 40 }).verdict.id, 'clear');
  });

  test('a partial collector failure is noted, not promoted to unknown', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.collector.lastError = 'acme/ion: 502';
    s.snapshot.collector.failedRepos = 1;
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now });
    assert.equal(r.verdict.id, 'clear');
    assert.match(r.verdict.evidence.join(' '), /1 repo could not be read/);
  });
});

describe('a coordinator listed twice', () => {
  test('its own stale self-record is not a host that went down', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.hosts.push({ ...s.snapshot.hosts[0], local: false, stale: true, staleForMs: 6 * 60 * 1000 });
    const r = computeVerdict(s.snapshot, s.facts, { now: s.now });
    assert.equal(r.verdict.id, 'clear');
    const g = buildGlance(s.snapshot, r, { now: s.now, localHostId: 'build-host' });
    assert.equal(g.hosts.filter((h) => h.id === s.snapshot.hosts[0].id).length, 1);
  });
});

describe('the offline tracker', () => {
  test('offline under five minutes is settling, then becomes a dead service', () => {
    const s = SCENARIOS.quiet();
    const snap = s.snapshot;
    for (const list of [snap.runners, snap.fleetRunners]) {
      Object.assign(list.find((r) => r.name === 'build-host-ember-web'), { ghStatus: 'offline' });
    }
    const tracker = createVerdictTracker();
    const first = tracker.observe(snap, s.facts, s.now);
    assert.equal(first.runners.get('build-host-ember-web').state, 'settling');
    assert.equal(first.verdict.id, 'clear');
    const later = tracker.observe(snap, s.facts, s.now + 6 * 60 * 1000);
    assert.equal(later.runners.get('build-host-ember-web').state, 'offline');
    assert.equal(later.verdict.id, 'dead-service');
  });

  test('coming back online resets the clock', () => {
    const s = SCENARIOS.quiet();
    const snap = s.snapshot;
    const set = (status) => {
      for (const list of [snap.runners, snap.fleetRunners]) {
        list.find((r) => r.name === 'build-host-ember-web').ghStatus = status;
      }
    };
    const tracker = createVerdictTracker();
    set('offline'); tracker.observe(snap, s.facts, s.now);
    set('online'); tracker.observe(snap, s.facts, s.now + 2 * 60 * 1000);
    set('offline');
    const r = tracker.observe(snap, s.facts, s.now + 6 * 60 * 1000);
    assert.equal(r.runners.get('build-host-ember-web').state, 'settling');
  });
});

describe('parseDiskHold', () => {
  test('reads the hook\'s own wording', () => {
    assert.deepEqual(parseDiskHold('36 GB disk free, below the 40 GB floor'), { freeGb: 36, floorGb: 40 });
    assert.equal(parseDiskHold('2 job(s) already running, at the limit of 2'), null);
    assert.equal(parseDiskHold(null), null);
  });
});

describe('the glance payload', () => {
  const glanceOf = (name) => {
    const { s, r } = run(name);
    return buildGlance(s.snapshot, r, { now: s.now, staleMs: 240000, floorGb: 40, localHostId: 'build-host' });
  };

  test('carries the schema, the verdict, and every runner', () => {
    const g = glanceOf('live');
    assert.equal(g.schema, GLANCE_SCHEMA);
    assert.equal(g.verdict.id, 'account-blocked');
    assert.equal(g.runners.length, 54);
    assert.equal(g.stale, false);
  });

  test('runners registered on another machine get their own lane', () => {
    const g = glanceOf('live');
    const mini = g.hosts.find((h) => h.id === 'elsewhere:mini');
    assert.ok(mini, JSON.stringify(g.hosts.map((h) => h.id)));
    assert.equal(mini.ghOnly, true);
    assert.equal(g.runners.filter((r) => r.host === 'elsewhere:mini').length, 6);
    assert.equal(g.runners.filter((r) => r.host === 'build-host').length, 48);
  });

  test('the local host lane carries the disk floor', () => {
    const g = glanceOf('diskHold');
    const local = g.hosts.find((h) => h.local);
    assert.equal(local.vitals.diskFloorGb, 40);
    assert.equal(local.vitals.diskFreeGb, 36.6);
  });

  test('carries active runs and the last two hours of finished ones, compact', () => {
    const g = glanceOf('live');
    assert.ok(Array.isArray(g.runs) && Array.isArray(g.recent));
    assert.ok(g.runs.every((r) => r.id && r.repo && r.status));
    assert.ok(g.recent.every((r) => r.conclusion));
    assert.ok((g.runs.find((r) => r.status === 'in_progress')?.sha?.length ?? 0) >= 7);
  });

  test("a PR run carries the PR's head commit, so a wait judges the head", () => {
    const { s, r } = run('live');
    const active = s.snapshot.active ?? [];
    assert.ok(active.length > 0);
    const snapshot = { ...s.snapshot, active: [{ ...active[0], prNumber: 79, prHeadSha: '16c0536773bcd1c6cb6a' }, ...active.slice(1)] };
    const g = buildGlance(snapshot, r, { now: s.now, staleMs: 240000, floorGb: 40, localHostId: 'build-host' });
    assert.equal(g.runs.find((x) => x.id === active[0].id).prHead, '16c0536773bc');
    assert.ok(g.runs.slice(1).every((x) => x.prHead === undefined || x.prHead === null));
  });

  test('is small enough to stream every tick over a phone link', () => {
    const bytes = Buffer.byteLength(JSON.stringify(glanceOf('live')));
    assert.ok(bytes < 16 * 1024, `${bytes} bytes`);
  });

  test('recent failures carry whether the code is to blame', () => {
    const { s, r } = run('saturated');
    const g = buildGlance(s.snapshot, r, { now: s.now, failures: s.facts.recentFailures });
    assert.deepEqual(g.failures.map((f) => [f.cls, f.notYourCode]), [['runner-lost', true], ['job-failed', false]]);
  });

  test('posture carries risks and unchecked items, never the passing ones', () => {
    const { s, r } = run('quiet');
    const posture = { checkedAt: s.now, items: [
      { id: 'spotlight', title: 'Spotlight indexing', ok: null, detail: 'mdfind did not answer' },
      { id: 'auto-login', title: 'No auto-login', ok: false },
      { id: 'sleep', title: 'Does not sleep', ok: true },
    ] };
    const g = buildGlance(s.snapshot, r, { now: s.now, posture });
    assert.deepEqual(g.posture.items.map((i) => [i.id, i.ok ?? null]), [['spotlight', null], ['auto-login', false]]);
  });

  test('a snapshot older than the stale window says so', () => {
    const { s, r } = run('quiet');
    const g = buildGlance(s.snapshot, r, { now: s.now + 300000, staleMs: 240000 });
    assert.equal(g.stale, true);
  });
});

describe('loadFailureFacts', () => {
  test('reads runner-lost and account classes from the jobs table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verdict-'));
    try {
      const db = openDb(join(dir, 't.db'));
      const now = LIVE_TS;
      const iso = (m) => new Date(now - m * 60000).toISOString();
      const ins = db.prepare(`INSERT INTO jobs (id, run_id, repo, name, status, conclusion, started_at, completed_at,
        runner_name, failure_class) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      ins.run(1, 1, 'acme/a', 'j', 'completed', 'failure', iso(20), iso(10), 'build-host-a', 'runner-lost');
      ins.run(2, 2, 'acme/a', 'j', 'completed', 'failure', iso(200), iso(190), 'build-host-a', 'runner-lost');
      ins.run(3, 3, 'acme/b', 'j', 'completed', 'failure', iso(30), iso(29), null, 'account-blocked');
      ins.run(4, 4, 'acme/c', 'j', 'completed', 'failure', iso(60), iso(59), null, 'account-quota');
      const f = loadFailureFacts(db, now);
      assert.equal(f.runnerLost.length, 1);
      assert.equal(f.runnerLost[0].runner, 'build-host-a');
      assert.equal(f.account.blocked, 1);
      assert.equal(f.account.quota, 1);
      assert.deepEqual(f.account.repos, ['acme/b', 'acme/c']);
      assert.equal(f.account.lastAt, Date.parse(iso(29)));
      assert.deepEqual(f.recentFailures.map((x) => x.cls).sort(), ['account-blocked', 'account-quota', 'runner-lost']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
