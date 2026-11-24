// "Runner down" needs GitHub and the host to agree.
//
// 2026-11-24 ~02:30–03:08Z on ultra: GitHub's runner list called
// ultra-homelake-2..-5 `offline busy=false` while homelake-2's _diag logged
// "Successfully renew job" every minute and five homelake runs were building.
// `cockpit why homelake` read every queued run as "runner down (high); will not
// start on its own → Run health.sh --repair", wait_for_checks returned
// `pointless`, and the advice would have restarted runners in the middle of
// other sessions' jobs. At 22:00 EST the night cap then parked the same runners
// (launchd unloaded, `.drain` by=night-cap). Each case below is one of those
// readings, plus the ones that must still say runner-down.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyQueueCause, CAUSES } from '../lib/queue-cause.js';
import { markGitHubDisagreement, ownLifeEvidence, deriveDrift } from '../lib/state.js';
import { computeVerdict, createVerdictTracker } from '../lib/verdict.js';
import { estimateQueue } from '../lib/eta.js';
import { decide } from '../lib/checks.js';
import { Alerts } from '../lib/alerts.js';
import { openDb } from '../lib/db.js';
import { makeRunner, makeActiveRun } from './fixtures/index.js';

const REPO = 'addisdev/homelake';
const ULTRA = '__local__';
const goodCapacity = { ok: true, reasons: [] };
const fullHost = { ok: false, reasons: ['35 job(s) already running, at the limit of 6 for adding more'] };
const ciLabels = ['self-hosted', 'macOS', 'ARM64', 'ci'];
const releaseLabels = ['self-hosted', 'macOS', 'ARM64', 'release'];

// A homelake runner on ultra as fleetd builds it, the way GitHub listed it
// that night: offline, not busy.
function homelake(suffix, patch = {}) {
  const name = `ultra-homelake${suffix ? `-${suffix}` : ''}`;
  return makeRunner({
    name,
    repo: REPO,
    dirName: `homelake${suffix ? `-${suffix}` : ''}`,
    hostId: ULTRA,
    hostName: 'ultra',
    labels: suffix === 'release' ? releaseLabels : ciLabels,
    extraLabels: [suffix === 'release' ? 'release' : 'ci'],
    ghStatus: 'offline',
    ghBusy: false,
    workingLocally: false,
    launchdState: 'running',
    drainState: null,
    drainBy: null,
    ...patch,
  });
}

// 02:59Z: four ci runners building (Runner.Worker up), the release runner idle.
function workingNight() {
  return [
    homelake('', { workingLocally: true }),
    homelake('2', { workingLocally: true }),
    homelake('3', { workingLocally: true }),
    homelake('4', { workingLocally: true }),
    homelake('5', { workingLocally: true }),
    homelake('release'),
  ];
}

// 03:08Z: the night cap has parked them. Parked runners keep their marker;
// two still finish the job they had (`draining`).
function parkedNight() {
  return [
    homelake('', { drainState: 'draining', drainBy: 'night-cap', workingLocally: true }),
    homelake('2', { drainState: 'drained', drainBy: 'night-cap', launchdState: 'not-loaded', rssMb: null, pid: null }),
    homelake('3', { drainState: 'drained', drainBy: 'night-cap', launchdState: 'not-loaded', rssMb: null, pid: null }),
    homelake('4', { drainState: 'draining', drainBy: 'night-cap', workingLocally: true }),
    homelake('5', { drainState: 'drained', drainBy: 'night-cap', launchdState: 'not-loaded', rssMb: null, pid: null }),
    homelake('release', { drainState: 'drained', drainBy: 'night-cap', launchdState: 'not-loaded', rssMb: null, pid: null }),
  ];
}

const nightCap = {
  active: true, until: '06:00', maxBusy: 2, window: '22:00-06:00', busy: 34, host: 'ultra', hostId: ULTRA,
  endsAt: Date.now() + 3 * 3600_000,
};

const queuedRun = (id = 1, name = 'ios-ci') => makeActiveRun({
  id, repo: REPO, workflowName: name, status: 'queued',
  createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  jobs: [{ name: 'build', status: 'queued', labels: ciLabels }],
});

const classify = (runners, extra = {}) => classifyQueueCause({
  run: extra.run ?? queuedRun(), runners, capacity: extra.capacity ?? goodCapacity,
  runLabels: extra.runLabels ?? ciLabels, nightCap: extra.nightCap ?? null,
});

describe('GitHub says offline, the host shows the runner working', () => {
  test('busy locally is not runner-down: it is a full repo, with the disagreement as evidence', () => {
    const r = classify(workingNight());
    assert.notEqual(r.cause, CAUSES.RUNNER_DOWN);
    assert.equal(r.cause, CAUSES.REPO_CAPACITY);
    assert.match(r.evidence.join('\n'), /GitHub says ultra-homelake(-\d)? is offline; the host shows it running a job/);
    assert.doesNotMatch(r.recommended, /health\.sh --repair/);
  });

  test('before the window on a full host it reads host-saturation, as fleetd did at 02:56Z', () => {
    assert.equal(classify(workingNight(), { capacity: fullHost }).cause, CAUSES.HOST_SATURATION);
  });

  test('in the tick the night cap opens (03:00:36Z), it is the night cap, with its resume time', () => {
    const r = classify(workingNight(), { nightCap });
    assert.equal(r.cause, CAUSES.NIGHT_CAP);
    assert.match(r.recommended, /until 06:00/);
  });

  test('a job GitHub shows in progress on it, with its listener up, is evidence too', () => {
    const runners = [homelake('2')];
    const active = [{ id: 9, repo: REPO, status: 'in_progress', jobs: [{ status: 'in_progress', runnerName: 'ultra-homelake-2' }] }];
    assert.equal(markGitHubDisagreement(runners, active), 1);
    assert.equal(runners[0].ghDisagrees.working, true);
    assert.match(runners[0].ghDisagrees.reason, /job in progress on it/);
    // Busy, so the queued run waits for it rather than reading an idle runner.
    assert.equal(classify(runners).cause, CAUSES.REPO_CAPACITY);
  });

  test('an idle sibling on the same host is believed alive when its repo-mates disagree with GitHub', () => {
    // A release job only homelake-release can take, while GitHub's list calls
    // every homelake runner offline and the ci ones are visibly building.
    const runners = workingNight();
    markGitHubDisagreement(runners, []);
    const release = runners.find((r) => r.name === 'ultra-homelake-release');
    assert.equal(release.ghDisagrees.working, false);
    assert.match(release.ghDisagrees.reason, /GitHub's runner list is behind/);
    const r = classify(runners, { runLabels: releaseLabels, run: queuedRun(2, 'release') });
    assert.notEqual(r.cause, CAUSES.RUNNER_DOWN);
    assert.match(r.evidence.join('\n'), /GitHub says ultra-homelake-release is offline/);
  });

  test('the sibling rule stays on its host', () => {
    const runners = [homelake('2', { workingLocally: true }), homelake('release', { hostId: 'other-host' })];
    markGitHubDisagreement(runners, []);
    assert.equal(runners[1].ghDisagrees, undefined);
    assert.equal(classify(runners, { runLabels: releaseLabels }).cause, CAUSES.RUNNER_DOWN);
  });
});

describe('true runner-down still fires', () => {
  test('GitHub offline and the host shows nothing: runner-down', () => {
    const runners = [homelake('2'), homelake('3')];
    assert.equal(markGitHubDisagreement(runners, []), 0);
    const r = classify(runners);
    assert.equal(r.cause, CAUSES.RUNNER_DOWN);
    assert.match(r.evidence.join('\n'), /ultra-homelake-2 GitHub status: offline/);
  });

  test('launchd not running for an un-parked runner: runner-down, whatever the Worker says', () => {
    for (const launchdState of ['dead', 'not-loaded']) {
      const runners = [homelake('2', { launchdState, workingLocally: true })];
      assert.equal(ownLifeEvidence(runners[0]), null);
      assert.equal(classify(runners).cause, CAUSES.RUNNER_DOWN, launchdState);
    }
  });

  test('a job on a runner whose listener is gone is not evidence of life', () => {
    const runners = [homelake('2', { rssMb: null })];
    const active = [{ id: 9, repo: REPO, jobs: [{ status: 'in_progress', runnerName: 'ultra-homelake-2' }] }];
    assert.equal(markGitHubDisagreement(runners, active), 0);
    assert.equal(classify(runners).cause, CAUSES.RUNNER_DOWN);
  });

  test('a runner drained by hand is still runner-down', () => {
    const r = classify([homelake('2', { drainState: 'drained', drainBy: null, launchdState: 'not-loaded' })]);
    assert.equal(r.cause, CAUSES.RUNNER_DOWN);
  });

  test('GitHub unknown still abstains', () => {
    assert.equal(classify([homelake('2', { ghUnknown: true, workingLocally: true })]).cause, CAUSES.TELEMETRY_UNAVAILABLE);
  });
});

describe('parked by the night cap is not down', () => {
  test('every serving runner parked: the night cap, until its end', () => {
    const r = classify(parkedNight(), { nightCap });
    assert.equal(r.cause, CAUSES.NIGHT_CAP);
    assert.match(r.evidence.join('\n'), /ultra-homelake-2 is parked by the night cap until 06:00/);
    assert.match(r.recommended, /until 06:00/);
  });

  test('parked plus one GitHub calls offline and idle (the cap leaves those alone): still the night cap', () => {
    const runners = parkedNight();
    runners[2] = homelake('3');
    assert.equal(classify(runners, { nightCap }).cause, CAUSES.NIGHT_CAP);
  });

  test('parked runners, the window just ended and the resume not yet seen: still the night cap', () => {
    assert.equal(classify(parkedNight(), { nightCap: null }).cause, CAUSES.NIGHT_CAP);
  });

  test('its ETA is the end of the window, never "will not start"', () => {
    const eta = estimateQueue({
      queue: [{ id: 1, repo: REPO, workflowName: 'ios-ci', cause: CAUSES.NIGHT_CAP, queuedSinceMs: 60_000 }],
      active: [], nightCap,
      baselines: {
        p50: { byWorkflow: new Map(), byRepo: new Map(), fleet: { expectedMs: null, n: 0 } },
        p90: { byWorkflow: new Map(), byRepo: new Map(), fleet: { expectedMs: null, n: 0 } },
      },
    });
    assert.doesNotMatch(eta.get(1).basis, /will not start/);
    assert.ok(eta.get(1).etaStartMs);
  });
});

describe('drift, alerts and the verdict agree', () => {
  const dirs = [];
  let db;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-agreement-'));
    dirs.push(dir);
    db = openDb(join(dir, 'test.db'));
  });
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  const alertsFor = (drift) => {
    const alerts = new Alerts({ db, config: { macos: false, webhook: null, offlineSettleMs: 0 }, log: () => {}, warn: () => {} });
    alerts.evaluate({ drift }, Date.now());
    return [...alerts.open.values()];
  };

  const driftFor = (runners, nc = null) => {
    const run = queuedRun();
    run.createdAt = run.startedAt = new Date(Date.now() - 40 * 60_000).toISOString();
    return deriveDrift({
      runners, elsewhere: [], active: [run], repos: [],
      classify: (x) => classifyQueueCause({ run: x, runners, capacity: goodCapacity, runLabels: ciLabels, nightCap: nc }),
    });
  };

  test('working runners GitHub calls offline raise no offline drift and no critical alert', () => {
    const runners = workingNight();
    markGitHubDisagreement(runners, []);
    const drift = driftFor(runners);
    assert.equal(drift.filter((d) => d.kind === 'offline').length, 0);
    assert.deepEqual(alertsFor(drift).filter((a) => a.severity === 'critical'), []);
  });

  test('parked runners raise no critical alert either', () => {
    const drift = driftFor(parkedNight(), nightCap);
    assert.deepEqual(drift.filter((d) => d.severity === 'critical'), []);
    assert.deepEqual(alertsFor(drift).filter((a) => a.severity === 'critical'), []);
  });

  test('runners both sides call down still raise the critical offline-host alert', () => {
    const runners = [homelake('2'), homelake('3'), homelake('4')];
    const drift = driftFor(runners);
    assert.equal(drift.filter((d) => d.kind === 'offline').length, 3);
    assert.ok(alertsFor(drift).some((a) => a.rule === 'offline-host' && a.severity === 'critical'));
  });

  test('the verdict reads them busy, names the disagreement, and opens no dead-service rung', () => {
    const runners = workingNight();
    markGitHubDisagreement(runners, []);
    const snapshot = { runners, fleetRunners: runners, active: [], drift: [], queue: [], hosts: [], admission: {} };
    const tracker = createVerdictTracker();
    const now = Date.now();
    tracker.observe(snapshot, {}, now);
    const r = tracker.observe(snapshot, {}, now + 10 * 60_000);
    assert.equal(r.runners.get('ultra-homelake-2').state, 'busy');
    assert.match(r.runners.get('ultra-homelake-2').detail, /GitHub says ultra-homelake-2 is offline/);
    assert.equal(r.runners.get('ultra-homelake-release').state, 'idle');
    assert.ok(!r.verdict.open.some((o) => o.id === 'dead-service'), r.verdict.open.map((o) => o.id).join(','));
  });

  test('the verdict still calls a runner both sides see as down offline', () => {
    const runners = [homelake('2')];
    const snapshot = { runners, fleetRunners: runners, active: [], drift: [], queue: [], hosts: [], admission: {} };
    const now = Date.now();
    const tracker = createVerdictTracker();
    tracker.observe(snapshot, {}, now);
    const r = tracker.observe(snapshot, {}, now + 10 * 60_000);
    assert.equal(r.runners.get('ultra-homelake-2').state, 'offline');
    assert.equal(r.verdict.id, 'dead-service');
  });

  test('computeVerdict without the tick\'s mark still trusts the Worker', () => {
    const runners = [homelake('2', { workingLocally: true })];
    const r = computeVerdict({ runners, fleetRunners: runners, active: [], drift: [], queue: [], hosts: [] }, {}, { now: Date.now() });
    assert.equal(r.runners.get('ultra-homelake-2').state, 'busy');
  });
});

describe('wait_for_checks', () => {
  const glance = (runners, queue) => ({
    verdict: { id: 'waiting', open: [] },
    runs: [{ id: 1, repo: REPO, workflow: 'ios-ci', status: 'queued', prNumber: 7 }],
    recent: [],
    queue,
    runners,
    nightCap: { mode: 'enforce', active: true, until: '06:00', maxBusy: 2, window: '22:00-06:00', busy: 10, host: 'ultra', held: [1] },
  });
  const nightRow = { id: 1, repo: REPO, workflow: 'ios-ci', cause: 'night-cap', etaBasis: 'held by the night cap until 06:00: the next job to finish on the host, or the end of the window' };

  test('a run the night cap holds is pending, not pointless', () => {
    const d = decide(glance([{ name: 'ultra-homelake-2', repo: REPO, state: 'draining' }], [nightRow]), { repo: REPO, pr: 7 });
    assert.equal(d.state, 'pending');
    assert.equal(d.heldBy, 'night-cap');
  });

  test('parked runners plus one GitHub calls offline: still pending under the night cap', () => {
    const d = decide(glance([
      { name: 'ultra-homelake-2', repo: REPO, state: 'draining' },
      { name: 'ultra-homelake-3', repo: REPO, state: 'offline' },
    ], [nightRow]), { repo: REPO, pr: 7 });
    assert.equal(d.state, 'pending');
    assert.equal(d.heldBy, 'night-cap');
  });

  test('a real runner-down is still pointless', () => {
    const g = glance([], [{ ...nightRow, cause: 'runner-down', etaBasis: 'runner-down: will not start on its own' }]);
    g.nightCap = null;
    assert.equal(decide(g, { repo: REPO, pr: 7 }).state, 'pointless');
  });
});
