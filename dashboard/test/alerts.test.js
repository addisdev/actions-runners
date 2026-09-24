// Alerts had no unit tests until dismissal needed them. The cases here are the
// ones where being wrong is expensive and invisible: a condition that notifies
// on a loop, a restart that re-announces everything it finds, and a dismissal
// that either leaks a notification or swallows one for ever.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { Alerts, alertScope } from '../lib/alerts.js';

const dirs = [];
let db;
let logged;

// Notifications are observed through the log rather than by stubbing the
// channels, because `notify()` logs every message it is about to send whether or
// not a channel is configured. That makes the log the honest record of what
// would have interrupted someone.
function makeAlerts(config = {}) {
  logged = [];
  const log = (...args) => logged.push(args.join(' '));
  return new Alerts({ db, config: { macos: false, webhook: null, ...config }, log, warn: log });
}

const announced = () => logged.filter((l) => l.startsWith('ALERT ')).map((l) => l.replace(/^ALERT \[\w+\] /, ''));

const drift = (kind, subject) => ({ kind, subject, detail: `${subject} is in trouble` });
const driftSnapshot = (...items) => ({ drift: items });

// A green run followed by a red one is what mints a newly-failing alert, and the
// key it mints carries the run id — which is the whole reason dismissal works on
// scopes instead of keys.
function failingWorkflow(repo, workflow, runId) {
  const t = (offset) => new Date(Date.now() - offset).toISOString();
  db.prepare(`
    INSERT INTO runs (id, repo, workflow_name, status, conclusion, run_started_at, head_branch, html_url)
    VALUES (?,?,?,'completed','success',?,'main','')`).run(runId - 1, repo, workflow, t(7200000));
  db.prepare(`
    INSERT INTO runs (id, repo, workflow_name, status, conclusion, run_started_at, head_branch, html_url)
    VALUES (?,?,?,'completed','failure',?,'main','')`).run(runId, repo, workflow, t(3600000));
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-alerts-'));
  dirs.push(dir);
  db = openDb(join(dir, 'test.db'));
});

after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('transitions', () => {
  test('a condition that stays true opens once and announces once', async () => {
    const alerts = makeAlerts();
    const snap = driftSnapshot(drift('offline', 'runner-a'));

    const first = await alerts.run(snap);
    assert.equal(first.opened, 1);
    assert.equal(announced().length, 1);

    logged = [];
    const second = await alerts.run(snap);
    assert.equal(second.opened, 0, 'a condition already open must not open again');
    assert.equal(announced().length, 0, 'nor announce again — this is the 240-an-hour bug');
  });

  test('a condition that goes away closes, and recurring opens a fresh interval', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));

    const closing = await alerts.run(driftSnapshot());
    assert.equal(closing.closed, 1);

    const again = await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    assert.equal(again.opened, 1);
    const rows = db.prepare("SELECT * FROM alerts WHERE key = 'drift:offline:runner-a'").all();
    assert.equal(rows.length, 2, 'two intervals, so how long each outage lasted stays a fact');
  });

  test('a restart reloads what was open instead of re-announcing it', async () => {
    const first = makeAlerts();
    await first.run(driftSnapshot(drift('offline', 'runner-a')));

    const restarted = makeAlerts();
    assert.equal(restarted.open.size, 1, 'the open interval is reloaded from the database');
    const result = await restarted.run(driftSnapshot(drift('offline', 'runner-a')));
    assert.equal(result.opened, 0);
    assert.equal(announced().length, 0, 'a restart is not news');
  });
});

describe('dismissing', () => {
  test('a dismissed condition stays open and stops speaking', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    alerts.dismiss('drift:offline:runner-a');

    logged = [];
    await alerts.run(driftSnapshot(drift('offline', 'runner-a'), drift('orphan', 'runner-b')));
    assert.deepEqual(announced(), ['Orphan runner: runner-b'], 'only the undismissed one speaks');

    const open = alerts.snapshot().open;
    const hidden = open.find((a) => a.key === 'drift:offline:runner-a');
    assert.ok(hidden, 'the condition is still open — dismissing is not closing');
    assert.ok(hidden.dismissed_at, 'and it says so');
    assert.equal(open.find((a) => a.key === 'drift:orphan:runner-b').dismissed_at, undefined);
  });

  test('dismissed alerts stay in the open list so the bridge still repairs them', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    alerts.dismiss('drift:offline:runner-a');

    const keys = alerts.snapshot().open.map((a) => a.key);
    assert.ok(keys.includes('drift:offline:runner-a'),
      'removing it would stop autofix repairing it and silently reset its attempt budget');
  });

  test('a dismissed alert does not announce its own resolution', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    alerts.dismiss('drift:offline:runner-a');

    logged = [];
    await alerts.run(driftSnapshot());
    assert.equal(announced().length, 0, 'it was quiet going in; it is quiet going out');
  });

  test('restoring one brings it back without waiting for a transition', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    alerts.dismiss('drift:offline:runner-a');
    assert.equal(alerts.counts().dismissed, 1);

    assert.equal(alerts.restore('drift:offline:runner-a'), true);
    assert.deepEqual(alerts.counts(), { open: 1, dismissed: 0, total: 1 });
  });

  test('dismissing something that is not open does nothing', () => {
    const alerts = makeAlerts();
    assert.equal(alerts.dismiss('drift:offline:nobody'), null);
    assert.equal(alerts.restore('drift:offline:nobody'), false);
  });

  test('counts() reports what is actually speaking', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a'), drift('orphan', 'runner-b')));
    alerts.dismiss('drift:offline:runner-a');

    assert.deepEqual(alerts.counts(), { open: 1, dismissed: 1, total: 2 });
  });

  test('a dismissal survives a restart', async () => {
    const first = makeAlerts();
    await first.run(driftSnapshot(drift('offline', 'runner-a')));
    first.dismiss('drift:offline:runner-a');

    const restarted = makeAlerts();
    await restarted.run(driftSnapshot(drift('offline', 'runner-a')));
    assert.equal(restarted.counts().dismissed, 1);
    assert.equal(announced().length, 0);
  });
});

describe('a dismissal lasts until the condition clears', () => {
  test('it is forgotten when the condition goes away', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    alerts.dismiss('drift:offline:runner-a');

    await alerts.run(driftSnapshot());
    assert.equal(alerts.dismissals().size, 0, 'nothing to expire, because clearing IS the expiry');

    logged = [];
    await alerts.run(driftSnapshot(drift('offline', 'runner-a')));
    assert.deepEqual(announced(), ['Runner is offline: runner-a'],
      'a recurrence after clearing is new news, not a continuation of what was waved away');
  });

  test('a condition that never clears stays dismissed indefinitely', async () => {
    const alerts = makeAlerts();
    const snap = driftSnapshot(drift('orphan', 'dormant-runner'));
    await alerts.run(snap);
    alerts.dismiss('drift:orphan:dormant-runner');

    logged = [];
    for (let i = 0; i < 20; i++) await alerts.run(snap);
    assert.equal(announced().length, 0, 'the dormant-repo case: dismiss once, never asked again');
    assert.equal(alerts.counts().dismissed, 1, 'and it stays listed, so it is never invisible');
  });
});

describe('dismissal follows the condition, not the run', () => {
  test('a newly-failing key names the run, so its scope drops the run id', () => {
    assert.equal(
      alertScope({ key: 'newfail:example/app:web-e2e:1841' }),
      'newfail:example/app:web-e2e');
  });

  test('every other rule is its own scope', () => {
    assert.equal(alertScope({ key: 'drift:offline:runner-a' }), 'drift:offline:runner-a');
    assert.equal(alertScope({ key: 'host:disk' }), 'host:disk');
  });

  test('dismissing a failing workflow is not undone by the next push', async () => {
    const alerts = makeAlerts();
    failingWorkflow('example/app', 'web-e2e', 1841);
    await alerts.run({});
    const first = [...alerts.open.keys()].find((k) => k.startsWith('newfail:'));
    assert.ok(first, 'the workflow alerted');
    alerts.dismiss(first);

    // A new push fails too, minting a different run id and so a different key.
    db.prepare('DELETE FROM runs').run();
    failingWorkflow('example/app', 'web-e2e', 1902);
    logged = [];
    await alerts.run({});

    const keys = [...alerts.open.keys()].filter((k) => k.startsWith('newfail:'));
    assert.ok(keys.some((k) => k.endsWith(':1902')), 'the new run did open its own alert');
    assert.equal(announced().length, 0,
      'but it did not speak — dismissing by key alone would have been undone by one push');
  });
});

describe('the storm guard', () => {
  const six = () => driftSnapshot(
    drift('orphan', 'r1'), drift('orphan', 'r2'), drift('orphan', 'r3'),
    drift('offline', 'r4'), drift('offline', 'r5'), drift('offline', 'r6'));

  test('collapses a genuine storm into one message', async () => {
    const alerts = makeAlerts({ stormThreshold: 5 });
    await alerts.run(six());
    assert.deepEqual(announced(), ['6 alerts opened']);
  });

  test('does not count dismissed conditions towards the threshold', async () => {
    const alerts = makeAlerts({ stormThreshold: 5 });
    await alerts.run(six());
    for (const r of ['r1', 'r2', 'r3']) alerts.dismiss(`drift:orphan:${r}`);

    // Close everything, then re-open it: three audible alerts is not a storm.
    // Counting the dismissed three would mean old dismissals permanently
    // collapse every future notification into a summary line.
    await alerts.run(driftSnapshot(drift('orphan', 'r1'), drift('orphan', 'r2'), drift('orphan', 'r3')));
    logged = [];
    await alerts.run(six());
    assert.equal(announced().length, 3);
    assert.ok(!announced().some((t) => /alerts opened/.test(t)));
  });
});

describe('long-running job alerts', () => {
  function seedBaseline(repo, workflow, durationMs, count = 5) {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    for (let i = 0; i < count; i++) {
      db.prepare(`
        INSERT INTO runs (id, repo, workflow_name, status, conclusion, run_started_at, duration_ms)
        VALUES (?, ?, ?, 'completed', 'success', ?, ?)`).run(5000 + i, repo, workflow, since, durationMs);
    }
  }

  test('opens when an annotated active run is long-running and closes when it clears', async () => {
    seedBaseline('org/app', 'Build', 600000);
    const alerts = makeAlerts({ longRunningFloorMs: 900000, longRunningMultiplier: 1.5 });

    const longRun = {
      id: 9001,
      repo: 'org/app',
      workflowName: 'Build',
      status: 'in_progress',
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      url: 'https://github.com/org/app/actions/runs/9001',
    };

    const first = await alerts.run({ active: [longRun] });
    assert.equal(first.opened, 1);
    assert.equal(announced().length, 1);
    assert.ok([...alerts.open.keys()].includes('run:long-running:9001'));

    logged = [];
    const second = await alerts.run({ active: [longRun] });
    assert.equal(second.opened, 0);
    assert.equal(announced().length, 0);

    logged = [];
    const closing = await alerts.run({ active: [] });
    assert.equal(closing.closed, 1);
    assert.deepEqual(announced(), ['Resolved: app · Build running long']);
  });

  test('does not alert on in-progress runs still within threshold', async () => {
    seedBaseline('org/app', 'Build', 600000);
    const alerts = makeAlerts({ longRunningFloorMs: 900000, longRunningMultiplier: 1.5 });

    const okRun = {
      id: 9002,
      repo: 'org/app',
      workflowName: 'Build',
      status: 'in_progress',
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };

    const result = await alerts.run({ active: [okRun] });
    assert.equal(result.opened, 0);
    assert.equal(announced().length, 0);
  });
});
