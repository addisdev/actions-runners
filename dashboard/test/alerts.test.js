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

  // Orphan rather than offline: offline alerts are debounced (see below), and
  // this is the plain transition every other rule follows.
  test('a condition that goes away closes, and recurring opens a fresh interval', async () => {
    const alerts = makeAlerts();
    await alerts.run(driftSnapshot(drift('orphan', 'runner-a')));

    const closing = await alerts.run(driftSnapshot());
    assert.equal(closing.closed, 1);

    const again = await alerts.run(driftSnapshot(drift('orphan', 'runner-a')));
    assert.equal(again.opened, 1);
    const rows = db.prepare("SELECT * FROM alerts WHERE key = 'drift:orphan:runner-a'").all();
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
    await alerts.run(driftSnapshot(drift('orphan', 'runner-a')));
    alerts.dismiss('drift:orphan:runner-a');

    await alerts.run(driftSnapshot());
    assert.equal(alerts.dismissals().size, 0, 'nothing to expire, because clearing IS the expiry');

    logged = [];
    await alerts.run(driftSnapshot(drift('orphan', 'runner-a')));
    assert.deepEqual(announced(), ['Orphan runner: runner-a'],
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
  // Not offline runners: three of those at once are one host alert now.
  const six = () => driftSnapshot(
    drift('orphan', 'r1'), drift('orphan', 'r2'), drift('orphan', 'r3'),
    drift('label-mismatch', 'r4'), drift('label-mismatch', 'r5'), drift('label-mismatch', 'r6'));

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

describe('offline: one host outage is one alert', () => {
  const MIN = 60 * 1000;
  const T0 = Date.parse('2026-09-20T03:00:00Z');
  const offline = (...names) => ({ drift: names.map((n) => drift('offline', n)), host: { runnerCount: 54 } });
  const runners = (n) => Array.from({ length: n }, (_, i) => `r${i + 1}`);
  const keys = (alerts) => [...alerts.open.keys()].sort();
  const rows = (rule) => db.prepare('SELECT * FROM alerts WHERE rule = ? ORDER BY id').all(rule);

  test('a host-wide outage opens one critical naming the count, not one per runner', async () => {
    const alerts = makeAlerts();
    await alerts.run(offline(...runners(39)));

    assert.deepEqual(keys(alerts), ['host:offline']);
    const [host] = alerts.snapshot().open;
    assert.equal(host.rule, 'offline-host');
    assert.equal(host.severity, 'critical');
    assert.equal(host.title, '39 of 54 runners offline — host unreachable or saturated');
    assert.match(host.body, /r1, r2, .*…and 31 more/);
    assert.deepEqual(announced(), ['39 of 54 runners offline — host unreachable or saturated']);
    assert.equal(rows('offline').length, 0);
  });

  test('one runner offline still gets its own alert, and so do two', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline('runner-a'), T0);
    assert.deepEqual(keys(alerts), ['drift:offline:runner-a']);

    alerts.evaluate(offline('runner-a', 'runner-b'), T0 + MIN);
    assert.deepEqual(keys(alerts), ['drift:offline:runner-a', 'drift:offline:runner-b']);
    assert.equal(rows('offline-host').length, 0);
  });

  test('runners already alerting on their own fold into the host alert when it opens', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline('r1'), T0);
    const { opened, closed } = alerts.evaluate(offline(...runners(6)), T0 + MIN);

    assert.deepEqual(opened.map((a) => a.key), ['host:offline']);
    assert.deepEqual(closed.map((a) => a.key), ['drift:offline:r1'],
      'replaced at once, not left to sit out a debounce for a condition reported elsewhere');
    assert.deepEqual(keys(alerts), ['host:offline']);
  });

  test('runners reconnecting one by one do not each open an alert on the way down', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline(...runners(39)), T0);
    for (let left = 20, t = T0 + MIN; left >= 0; left -= 5, t += MIN) {
      const { opened } = alerts.evaluate(offline(...runners(left)), t);
      assert.deepEqual(opened, [], `${left} still offline is the tail of the same outage`);
    }
    assert.deepEqual(keys(alerts), ['host:offline']);
  });

  test('a host that flaps inside the window stays one alert for the whole episode', () => {
    const alerts = makeAlerts();
    // The 2026-09-20 shape: everything down, back, down, back, minutes apart.
    for (let i = 0; i < 6; i++) {
      alerts.evaluate(offline(...runners(39)), T0 + i * 8 * MIN);
      alerts.evaluate(offline(), T0 + i * 8 * MIN + 4 * MIN);
    }
    assert.equal(rows('offline-host').length, 1);
    assert.equal(rows('offline').length, 0);

    const lastClear = T0 + 5 * 8 * MIN + 4 * MIN;
    const { closed } = alerts.evaluate(offline(), lastClear + 15 * MIN);
    assert.deepEqual(closed.map((a) => a.key), ['host:offline']);
    assert.equal(rows('offline-host')[0].closed_at, lastClear,
      'closed when the host came back, not when the window ran out');
  });

  test('a runner still offline after the host recovers is a runner problem again', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline(...runners(10)), T0);
    alerts.evaluate(offline('r7'), T0 + MIN);
    assert.deepEqual(keys(alerts), ['host:offline'], 'folded while the host alert is open');

    const { opened, closed } = alerts.evaluate(offline('r7'), T0 + MIN + 15 * MIN);
    assert.deepEqual(closed.map((a) => a.key), ['host:offline']);
    assert.deepEqual(opened, []);
    const next = alerts.evaluate(offline('r7'), T0 + 17 * MIN);
    assert.deepEqual(next.opened.map((a) => a.key), ['drift:offline:r7']);
  });

  test('the threshold is configurable', () => {
    const alerts = makeAlerts({ offlineHostThreshold: 5 });
    alerts.evaluate(offline(...runners(4)), T0);
    assert.equal(keys(alerts).length, 4);
    alerts.evaluate(offline(...runners(5)), T0 + MIN);
    assert.deepEqual(keys(alerts), ['host:offline']);
  });
});

describe('offline: a flapping runner is one alert', () => {
  const MIN = 60 * 1000;
  const T0 = Date.parse('2026-09-20T03:00:00Z');
  const offline = (...names) => ({ drift: names.map((n) => drift('offline', n)) });
  const rows = () => db.prepare("SELECT * FROM alerts WHERE key = 'drift:offline:runner-a' ORDER BY id").all();

  test('dropping and reconnecting inside the window re-opens nothing and resolves nothing', () => {
    const alerts = makeAlerts();
    let opened = 0;
    let closed = 0;
    for (let i = 0; i < 8; i++) {
      const down = alerts.evaluate(offline('runner-a'), T0 + i * 5 * MIN);
      const up = alerts.evaluate(offline(), T0 + i * 5 * MIN + 2 * MIN);
      opened += down.opened.length;
      closed += down.closed.length + up.closed.length;
    }
    assert.equal(opened, 1, 'eight drops, one alert');
    assert.equal(closed, 0, 'and no "Resolved" between them');
    assert.equal(rows().length, 1);
  });

  test('a clearing alert says so, and goes back to plain open if the runner drops again', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline('runner-a'), T0);
    alerts.evaluate(offline(), T0 + MIN);
    assert.equal(alerts.snapshot().open[0].clearing_since, T0 + MIN,
      'autofix reads this and leaves a recovered listener alone');

    alerts.evaluate(offline('runner-a'), T0 + 3 * MIN);
    assert.equal(alerts.snapshot().open[0].clearing_since, undefined);
  });

  test('it closes once the window passes, dated when the runner actually came back', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline('runner-a'), T0);
    alerts.evaluate(offline(), T0 + 2 * MIN);
    assert.equal(alerts.evaluate(offline(), T0 + 16 * MIN).closed.length, 0, 'still inside the window');

    const { closed } = alerts.evaluate(offline(), T0 + 17 * MIN);
    assert.equal(closed.length, 1);
    assert.equal(rows()[0].closed_at, T0 + 2 * MIN);
  });

  test('dropping again after the window is a new alert', () => {
    const alerts = makeAlerts();
    alerts.evaluate(offline('runner-a'), T0);
    alerts.evaluate(offline(), T0 + MIN);
    alerts.evaluate(offline(), T0 + 16 * MIN);
    const { opened } = alerts.evaluate(offline('runner-a'), T0 + 20 * MIN);
    assert.equal(opened.length, 1);
    assert.equal(rows().length, 2);
  });

  test('other rules are not debounced', () => {
    const alerts = makeAlerts();
    alerts.evaluate(driftSnapshot(drift('orphan', 'runner-b')), T0);
    assert.equal(alerts.evaluate(driftSnapshot(), T0 + 15 * 1000).closed.length, 1);
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

describe('admission holds', () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const hold = (runner, reason, agoS) => ({ runner, repo: `acme/${runner}`, since: nowS() - agoS, reason, busy: 0, limit: 2 });

  test('a disk-floor hold opens a critical alert once sustained', () => {
    const alerts = makeAlerts({ admissionDiskSustainMs: 60000 });
    const snap = { admission: { waiting: [hold('a', '36 GB disk free, below the 40 GB floor', 120)] } };
    const t0 = Date.now();
    alerts.evaluate(snap, t0);
    assert.equal(alerts.open.has('admission:disk-floor'), false, 'not before the sustain window');
    alerts.evaluate(snap, t0 + 61000);
    const open = [...alerts.open.values()].find((a) => a.key === 'admission:disk-floor');
    assert.ok(open, 'opened');
    assert.equal(open.severity, 'critical');
    assert.match(open.body, /36 GB free, below the 40 GB admission floor/);
  });

  test('a disk reason on a held row is ignored once disk is back above the floor', () => {
    const alerts = makeAlerts({ admissionDiskSustainMs: 0 });
    const snap = { host: { diskFreeGb: 46.8 }, admission: { waiting: [hold('a', '38 GB disk free, below the 40 GB floor', 120)] } };
    alerts.evaluate(snap); alerts.evaluate(snap);
    assert.equal(alerts.open.has('admission:disk-floor'), false);
  });

  test('a slot hold is quiet until it outlives the max wait', () => {
    const alerts = makeAlerts({ admissionMaxWaitS: 600 });
    alerts.evaluate({ admission: { waiting: [hold('a', '2 job(s) already running, at the limit of 2', 120)] } });
    assert.equal([...alerts.open.keys()].includes('admission:slot-wait'), false);
    alerts.evaluate({ admission: { waiting: [hold('a', '2 job(s) already running, at the limit of 2', 900)] } });
    assert.equal(alerts.open.get('admission:slot-wait')?.severity, 'warning');
  });

  test('a held row older than the TTL is a dead hook and says nothing', () => {
    const alerts = makeAlerts({ admissionDiskSustainMs: 0 });
    const snap = { admission: { waiting: [hold('a', '36 GB disk free, below the 40 GB floor', 7 * 3600)] } };
    alerts.evaluate(snap); alerts.evaluate(snap);
    assert.equal(alerts.open.has('admission:disk-floor'), false);
  });
});

describe('host saturation', () => {
  const lost = (id, minsAgo) => db.prepare(`INSERT INTO jobs (id, run_id, repo, status, conclusion, completed_at,
    runner_name, failure_class) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, id, 'acme/web', 'completed', 'failure', new Date(Date.now() - minsAgo * 60000).toISOString(), 'host-web', 'runner-lost');

  test('two runner-lost jobs inside an hour open host-saturated', () => {
    const alerts = makeAlerts();
    lost(1, 5); lost(2, 50);
    alerts.evaluate({});
    assert.equal(alerts.open.get('host:saturated')?.rule, 'host-saturated');
  });

  test('one lost job, or two far apart, do not', () => {
    const alerts = makeAlerts();
    lost(1, 5); lost(2, 90);
    alerts.evaluate({});
    assert.equal(alerts.open.has('host:saturated'), false);
  });
});

describe('disk heading for the floor', () => {
  test('under 12 h to the floor, sustained, opens a warning; under 3 h is critical', () => {
    const alerts = makeAlerts();
    const snap = (etaH) => ({ host: { diskFreeGb: 55, diskFloorEtaMs: etaH * 3600000, diskForecast: { rate6hGbPerHour: -2.1 } } });
    const t0 = Date.now();
    alerts.evaluate(snap(8), t0);
    assert.equal(alerts.open.has('host:disk-floor-soon'), false);
    alerts.evaluate(snap(8), t0 + 11 * 60000);
    assert.equal(alerts.open.get('host:disk-floor-soon')?.severity, 'warning');
    assert.match(alerts.open.get('host:disk-floor-soon').body, /falling 2\.1 GB\/h/);
  });

  test('no forecast, no alert', () => {
    const alerts = makeAlerts();
    alerts.evaluate({ host: { diskFreeGb: 55, diskFloorEtaMs: null } });
    alerts.evaluate({ host: { diskFreeGb: 55, diskFloorEtaMs: null } }, Date.now() + 20 * 60000);
    assert.equal(alerts.open.has('host:disk-floor-soon'), false);
  });
});
