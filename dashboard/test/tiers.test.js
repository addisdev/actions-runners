import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTiers,
  tiersConfigFromEnv,
  primaryRungs,
  isSimulatorRunner,
  repoIn,
  DRAIN_OWNER,
  TIERS_DEFAULTS,
} from '../lib/tiers.js';

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;

const CONFIG = {
  ...TIERS_DEFAULTS,
  mode: 'enforce',
  primaryHost: 'laptop',
  standbyHosts: ['studio'],
  floorRepos: ['app-ios'],
  primaryOnlyRepos: ['app-db'],
  caps: { build: 2, simulator: 1 },
  simulatorRunners: ['*-ios', '*-ios-*'],
};

const BASE = ['self-hosted', 'macOS', 'ARM64'];

function runner(host, repo, n = 1, extra = {}) {
  const short = repo.split('/').pop();
  const name = `${host}-${short}${n > 1 ? `-${n}` : ''}`;
  return {
    name,
    dirName: `${short}${n > 1 ? `-${n}` : ''}`,
    repo,
    hostId: host,
    local: host === 'laptop',
    labels: [...BASE, ...(extra.labels ?? [])],
    ghStatus: 'online',
    ghUnknown: false,
    workingLocally: false,
    ghBusy: false,
    drainState: null,
    drainBy: null,
    ...extra,
    ...(extra.labels ? { labels: [...BASE, ...extra.labels] } : {}),
  };
}

// The fleet in miniature: a primary runner per repo, the standby host's twins,
// a floor repo, a primary-only repo with a label the standby lacks.
function fleet(overrides = {}) {
  const list = [
    runner('laptop', 'o/app-web', 1, { labels: ['ci'] }),
    runner('laptop', 'o/app-web', 2, { labels: ['ci'] }),
    runner('laptop', 'o/app-api'),
    runner('laptop', 'o/app-ios'),
    runner('laptop', 'o/app-ios', 2),
    runner('laptop', 'o/app-db', 1, { labels: ['postgres'] }),
    runner('studio', 'o/app-web', 1, { labels: ['ci'] }),
    runner('studio', 'o/app-web', 2, { labels: ['ci'] }),
    runner('studio', 'o/app-api'),
    runner('studio', 'o/app-ios'),
  ];
  return list.map((r) => ({ ...r, ...(overrides[r.name] ?? {}) }));
}

// Heartbeats are fresh relative to the step's own clock unless a test says
// otherwise.
function input(over = {}) {
  const now = over.now ?? NOW;
  return {
    config: CONFIG,
    now,
    state: null,
    primary: { id: 'laptop', lastHeartbeat: now, memPressure: 'normal', rungs: [] },
    standby: [{ id: 'studio', name: 'studio', lastHeartbeat: now - 10 * SEC, memPressure: 'normal' }],
    runners: fleet(),
    queue: [],
    ...over,
  };
}

const owned = (state = 'drained') => ({ drainState: state, drainBy: DRAIN_OWNER, ghStatus: 'offline' });
const operator = () => ({ drainState: 'drained', drainBy: null, ghStatus: 'offline' });
const names = (actions, action) => actions.filter((a) => !action || a.action === action).map((a) => a.name).sort();

// Every overflow runner drained by the controller: the resting state.
const resting = () => ({
  'studio-app-web': owned(),
  'studio-app-web-2': owned(),
  'studio-app-api': owned(),
});
const STANDBY_STATE = { overflow: 'standby', since: NOW - 30 * MIN, reason: 'quiet', pending: {} };

describe('tiersConfigFromEnv', () => {
  test('defaults to off, and an unknown mode is off', () => {
    assert.equal(tiersConfigFromEnv({}).mode, 'off');
    assert.equal(tiersConfigFromEnv({ FLEET_TIERS_MODE: 'enforec' }).mode, 'off');
    assert.equal(tiersConfigFromEnv({ FLEET_TIERS_MODE: 'Enforce' }).mode, 'enforce');
  });

  test('reads timers in seconds, lists, and the admission caps', () => {
    const c = tiersConfigFromEnv({
      FLEET_TIERS_MODE: 'observe',
      FLEET_TIERS_STANDBY_HOSTS: 'studio, other',
      FLEET_TIERS_FLOOR_REPOS: 'app-ios,o/app-tv',
      FLEET_TIERS_RESUME_AFTER_S: '45',
      FLEET_TIERS_DRAIN_AFTER_S: '300',
      FLEET_ADMIT_MAX_CONCURRENT: '2',
      FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT: '1',
      FLEET_SIMULATOR_RUNNERS: '*-ios *-tvos',
    }, { localHostId: 'laptop' });
    assert.equal(c.primaryHost, 'laptop');
    assert.deepEqual(c.standbyHosts, ['studio', 'other']);
    assert.deepEqual(c.floorRepos, ['app-ios', 'o/app-tv']);
    assert.equal(c.resumeAfterBusyMs, 45_000);
    assert.equal(c.drainAfterQuietMs, 300_000);
    assert.equal(c.queueAgeMs, 120_000);
    assert.deepEqual(c.caps, { build: 2, simulator: 1 });
    assert.deepEqual(c.simulatorRunners, ['*-ios', '*-tvos']);
  });

  test('FLEET_TIERS_*_CAP overrides the admission caps', () => {
    const c = tiersConfigFromEnv({ FLEET_ADMIT_MAX_CONCURRENT: '2', FLEET_TIERS_BUILD_CAP: '3' });
    assert.equal(c.caps.build, 3);
  });
});

describe('helpers', () => {
  test('repoIn matches a short name or the full name', () => {
    assert.ok(repoIn('o/app-ios', ['app-ios']));
    assert.ok(repoIn('o/app-ios', ['o/app-ios']));
    assert.ok(!repoIn('o/app-ios-kit', ['app-ios']));
  });

  test('isSimulatorRunner uses the hook\'s shell patterns', () => {
    const p = ['*-ios', '*-ios-*'];
    assert.ok(isSimulatorRunner('laptop-app-ios', p));
    assert.ok(isSimulatorRunner('laptop-app-ios-2', p));
    assert.ok(!isSimulatorRunner('laptop-app-iosx', p));
    assert.ok(!isSimulatorRunner('laptop-app-web', p));
  });

  test('primaryRungs keeps only the rungs about the primary', () => {
    const verdict = { open: [{ id: 'disk-floor' }, { id: 'dead-service' }, { id: 'host-down' }, { id: 'saturated' }] };
    const states = [{ hostId: 'studio', state: 'dead' }];
    assert.deepEqual(primaryRungs(verdict, states, { primaryId: 'laptop', primaryIsLocal: true, staleHostIds: ['studio'] }),
      ['disk-floor', 'saturated']);
    assert.deepEqual(primaryRungs(verdict, [{ hostId: 'laptop', state: 'offline' }], { primaryId: 'laptop', primaryIsLocal: true }),
      ['disk-floor', 'dead-service', 'saturated']);
    assert.deepEqual(primaryRungs(verdict, [], { primaryId: 'laptop', primaryIsLocal: false, staleHostIds: ['laptop'] }),
      ['host-down']);
  });
});

describe('overflow tier', () => {
  test('starts active when overflow runners are online, and does nothing yet', () => {
    const { decision } = decideTiers(input());
    assert.equal(decision.overflow, 'active');
    assert.deepEqual(decision.actions, []);
    assert.equal(decision.drainInMs, 10 * MIN);
  });

  test('drains overflow after ten quiet minutes, never the floor or an operator drain', () => {
    const runners = fleet({ 'studio-app-api': operator() });
    let { state } = decideTiers(input({ runners }));
    let r = decideTiers(input({ runners, state, now: NOW + 9 * MIN }));
    assert.equal(r.decision.overflow, 'active');
    assert.deepEqual(r.decision.actions, []);
    r = decideTiers(input({ runners, state: r.state, now: NOW + 10 * MIN }));
    assert.equal(r.decision.overflow, 'standby');
    assert.deepEqual(names(r.decision.actions, 'drain'), ['studio-app-web', 'studio-app-web-2']);
    assert.ok(r.decision.actions.every((a) => a.tier === 'overflow' && a.hostId === 'studio'));
  });

  test('a queued run resets the quiet timer', () => {
    let { state } = decideTiers(input());
    const queue = [{ id: 1, repo: 'o/app-web', labels: ['self-hosted', 'ci'], queuedSinceMs: 5 * SEC }];
    ({ state } = decideTiers(input({ state, queue, now: NOW + 9 * MIN })));
    const r = decideTiers(input({ state, now: NOW + 12 * MIN }));
    assert.equal(r.decision.overflow, 'active');
    assert.equal(r.decision.quietForMs, 0);
    assert.equal(r.decision.drainInMs, 10 * MIN);
  });

  test('resumes after a lane has been at cap for 60 s, only its own drains', () => {
    const runners = fleet({
      ...resting(),
      'studio-app-api': operator(),
      'laptop-app-web': { workingLocally: true },
      'laptop-app-api': { workingLocally: true },
    });
    let r = decideTiers(input({ runners, state: STANDBY_STATE }));
    assert.equal(r.decision.overflow, 'standby');
    assert.equal(r.decision.lanes.build.atCap, true);
    r = decideTiers(input({ runners, state: r.state, now: NOW + 59 * SEC }));
    assert.equal(r.decision.overflow, 'standby');
    r = decideTiers(input({ runners, state: r.state, now: NOW + 60 * SEC }));
    assert.equal(r.decision.overflow, 'active');
    assert.match(r.decision.reason, /build lane 2\/2 for 60s/);
    assert.deepEqual(names(r.decision.actions, 'resume'), ['studio-app-web', 'studio-app-web-2']);
  });

  test('held jobs count as busy: a Worker exists for them', () => {
    const runners = fleet({ ...resting(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-web-2': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const r = decideTiers(input({ runners, state: STANDBY_STATE }));
    assert.equal(r.decision.lanes.build.busy, 3);
  });

  test('resumes for a run queued over 2 min with no idle primary runner', () => {
    const runners = fleet({ ...resting(), 'laptop-app-web': { ghBusy: true }, 'laptop-app-web-2': { workingLocally: true } });
    const queue = [{ id: 7, repo: 'o/app-web', labels: ['self-hosted', 'ci'], queuedSinceMs: 2 * MIN + SEC }];
    const r = decideTiers(input({ runners, queue, state: STANDBY_STATE }));
    assert.equal(r.decision.overflow, 'active');
    assert.equal(r.decision.triggers[0].id, 'queue-age');
  });

  test('a queued run with an idle primary runner, or a label nobody has, does not resume', () => {
    const runners = fleet(resting());
    const queue = [
      { id: 8, repo: 'o/app-web', labels: ['ci'], queuedSinceMs: 5 * MIN },
      { id: 9, repo: 'o/app-web', labels: ['gpu'], queuedSinceMs: 5 * MIN },
    ];
    const r = decideTiers(input({ runners, queue, state: STANDBY_STATE }));
    assert.equal(r.decision.overflow, 'standby');
    assert.deepEqual(r.decision.triggers, []);
  });

  test('a run GitHub is holding (concurrency group) neither resumes nor keeps overflow online', () => {
    const runners = fleet({ ...resting(), 'laptop-app-web': { ghBusy: true }, 'laptop-app-web-2': { ghBusy: true } });
    const queue = [{ id: 11, repo: 'o/app-web', labels: ['ci'], queuedSinceMs: 10 * MIN, cause: 'concurrency-block' }];
    let r = decideTiers(input({ runners, queue, state: STANDBY_STATE }));
    assert.equal(r.decision.overflow, 'standby');
    assert.deepEqual(r.decision.triggers, []);
    r = decideTiers(input({ queue, state: { overflow: 'active', since: NOW - 20 * MIN, quietSince: NOW - 11 * MIN, pending: {} } }));
    assert.equal(r.decision.overflow, 'standby');
  });

  test('a run only the primary can serve does not resume the standby host', () => {
    const runners = fleet({ ...resting(), 'laptop-app-db': { workingLocally: true } });
    const queue = [{ id: 10, repo: 'o/app-db', labels: ['postgres'], queuedSinceMs: 5 * MIN }];
    const r = decideTiers(input({ runners, queue, state: STANDBY_STATE }));
    assert.equal(r.decision.overflow, 'standby');
  });

  for (const rung of ['disk-floor', 'dead-service', 'saturated', 'host-down']) {
    test(`resumes at once when the primary shows ${rung}`, () => {
      const r = decideTiers(input({ runners: fleet(resting()), state: STANDBY_STATE, primary: { id: 'laptop', lastHeartbeat: NOW, rungs: [rung] } }));
      assert.equal(r.decision.overflow, 'active');
      assert.equal(r.decision.triggers[0].id, `primary-${rung}`);
    });
  }

  test('resumes when the primary stops reporting or its memory pressure is critical', () => {
    let r = decideTiers(input({ runners: fleet(resting()), state: STANDBY_STATE, primary: { id: 'laptop', lastHeartbeat: NOW - 4 * MIN } }));
    assert.equal(r.decision.triggers[0].id, 'primary-down');
    r = decideTiers(input({ runners: fleet(resting()), state: STANDBY_STATE, primary: { id: 'laptop', lastHeartbeat: NOW, memPressure: 'critical' } }));
    assert.equal(r.decision.triggers[0].id, 'primary-memory-critical');
    assert.equal(r.decision.overflow, 'active');
  });

  test('never resumes onto a standby host whose memory pressure is critical, and drains it early', () => {
    const standby = [{ id: 'studio', lastHeartbeat: NOW, memPressure: 'critical' }];
    let r = decideTiers(input({ runners: fleet(resting()), standby, state: STANDBY_STATE, primary: { id: 'laptop', lastHeartbeat: NOW, rungs: ['disk-floor'] } }));
    assert.equal(r.decision.overflow, 'standby');
    assert.deepEqual(r.decision.actions, []);
    r = decideTiers(input({ standby, state: { overflow: 'active', since: NOW - MIN, pending: {} } }));
    assert.deepEqual(names(r.decision.actions, 'drain'), ['studio-app-api', 'studio-app-web', 'studio-app-web-2']);
  });

  test('a floor runner is never drained; one the controller drained comes back', () => {
    const runners = fleet({ 'studio-app-ios': owned() });
    const r = decideTiers(input({ runners, state: STANDBY_STATE }));
    assert.deepEqual(r.decision.actions.map((a) => [a.name, a.action, a.tier]).sort(),
      [['studio-app-api', 'drain', 'overflow'], ['studio-app-ios', 'resume', 'floor'], ['studio-app-web', 'drain', 'overflow'], ['studio-app-web-2', 'drain', 'overflow']]);
  });

  test('a busy overflow runner is drained gracefully (drain-runner.sh lets its job finish)', () => {
    const runners = fleet({ 'studio-app-api': { workingLocally: true } });
    const r = decideTiers(input({ runners, state: STANDBY_STATE }));
    assert.ok(names(r.decision.actions, 'drain').includes('studio-app-api'));
  });

  test('commands wait for a standby host that is not reporting', () => {
    const standby = [{ id: 'studio', lastHeartbeat: NOW - 5 * MIN, memPressure: 'normal' }];
    const r = decideTiers(input({ standby, state: STANDBY_STATE }));
    assert.deepEqual(r.decision.actions, []);
    assert.equal(r.decision.deferred.length, 3);
  });

  test('an action is not re-sent while it is in flight, and is again after retryMs', () => {
    let r = decideTiers(input({ state: STANDBY_STATE }));
    assert.equal(r.decision.actions.length, 3);
    r = decideTiers(input({ state: r.state, now: NOW + 15 * SEC }));
    assert.equal(r.decision.actions.length, 0);
    r = decideTiers(input({ state: r.state, now: NOW + 3 * MIN }));
    assert.equal(r.decision.actions.length, 3);
  });

  test('observe mode reports the same actions every tick and applies none', () => {
    const config = { ...CONFIG, mode: 'observe' };
    let r = decideTiers(input({ config, state: STANDBY_STATE }));
    assert.equal(r.decision.applied, false);
    assert.equal(r.decision.actions.length, 3);
    r = decideTiers(input({ config, state: r.state, now: NOW + 15 * SEC }));
    assert.equal(r.decision.actions.length, 3);
  });

  test('off mode releases only the controller\'s own drains', () => {
    const config = { ...CONFIG, mode: 'off' };
    const runners = fleet({ 'studio-app-web': owned(), 'studio-app-api': operator(), 'laptop-app-web': owned() });
    const r = decideTiers(input({ config, runners }));
    assert.deepEqual(names(r.decision.actions, 'resume'), ['laptop-app-web', 'studio-app-web']);
    assert.deepEqual(names(r.decision.actions, 'drain'), []);
  });
});

describe('primary self-drain', () => {
  const ACTIVE = { overflow: 'active', since: NOW - MIN, reason: 'busy', pending: {} };

  test('at cap, drains idle primary runners that have an online standby twin', () => {
    const runners = fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-ios': { workingLocally: true } });
    const r = decideTiers(input({ runners, state: ACTIVE }));
    // app-web-2 and app-api have twins; app-ios-2's twin is the floor runner;
    // app-db is primary-only; the busy ones are left alone.
    assert.deepEqual(names(r.decision.actions, 'drain'), ['laptop-app-api', 'laptop-app-ios-2', 'laptop-app-web-2']);
    assert.ok(r.decision.actions.every((a) => a.tier === 'primary' && a.hostId === 'laptop'));
  });

  test('never strands a repo: no online twin, no drain', () => {
    const runners = fleet({
      'laptop-app-web': { workingLocally: true },
      'laptop-app-api': { workingLocally: true },
      'studio-app-web': owned(),
      'studio-app-web-2': owned(),
    });
    const r = decideTiers(input({ runners, state: STANDBY_STATE }));
    assert.ok(!names(r.decision.actions, 'drain').includes('laptop-app-web-2'));
    assert.ok(r.decision.deferred.some((d) => d.name === 'laptop-app-web-2' && /twin/.test(d.reason)));
  });

  test('a twin with too few labels does not count', () => {
    const runners = fleet({
      'laptop-app-web': { workingLocally: true },
      'laptop-app-api': { workingLocally: true },
      'studio-app-web': { labels: BASE },
      'studio-app-web-2': { labels: BASE },
    });
    const r = decideTiers(input({ runners, state: ACTIVE }));
    assert.ok(!names(r.decision.actions, 'drain').includes('laptop-app-web-2'));
  });

  test('a twin being drained this tick does not count', () => {
    // At cap for under 60 s, so the overflow tier is still going to standby.
    const runners = fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const r = decideTiers(input({ runners, state: STANDBY_STATE }));
    // Only the runners whose twin is the always-online floor runner go.
    assert.deepEqual(names(r.decision.actions, 'drain'),
      ['laptop-app-ios', 'laptop-app-ios-2', 'studio-app-api', 'studio-app-web', 'studio-app-web-2']);
  });

  test('a standby host under critical memory pressure is no twin', () => {
    const runners = fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const standby = [{ id: 'studio', lastHeartbeat: NOW, memPressure: 'critical' }];
    const r = decideTiers(input({ runners, standby, state: ACTIVE }));
    assert.deepEqual(names(r.decision.actions.filter((a) => a.tier === 'primary')), []);
  });

  test('the Simulator lane at cap drains idle Simulator runners only', () => {
    const runners = fleet({ 'laptop-app-ios': { workingLocally: true } });
    const r = decideTiers(input({ runners, state: ACTIVE }));
    assert.equal(r.decision.lanes.simulator.atCap, true);
    assert.equal(r.decision.lanes.build.atCap, false);
    assert.deepEqual(names(r.decision.actions, 'drain'), ['laptop-app-ios-2']);
  });

  test('resumes its drains after the lane has had room for 30 s, never an operator\'s', () => {
    const runners = fleet({ 'laptop-app-web-2': owned(), 'laptop-app-api': operator() });
    let r = decideTiers(input({ runners, state: ACTIVE }));
    assert.deepEqual(r.decision.actions, []);
    r = decideTiers(input({ runners, state: r.state, now: NOW + 30 * SEC }));
    assert.deepEqual(r.decision.actions.map((a) => [a.name, a.action]), [['laptop-app-web-2', 'resume']]);
  });

  test('resumes at once when its twin goes away', () => {
    const runners = fleet({
      'laptop-app-web': { workingLocally: true },
      'laptop-app-api': { workingLocally: true },
      'laptop-app-web-2': owned(),
      'studio-app-web': { ghStatus: 'offline' },
      'studio-app-web-2': operator(),
    });
    const r = decideTiers(input({ runners, state: ACTIVE }));
    assert.deepEqual(names(r.decision.actions, 'resume'), ['laptop-app-web-2']);
  });

  test('a primary-only repo is never drained, and is resumed if it was', () => {
    const runners = fleet({
      'laptop-app-web': { workingLocally: true },
      'laptop-app-api': { workingLocally: true },
      'laptop-app-db': owned(),
      'studio-app-db': {},
    });
    runners.push(runner('studio', 'o/app-db', 1, { labels: ['postgres'] }));
    const r = decideTiers(input({ runners, state: ACTIVE }));
    assert.deepEqual(names(r.decision.actions, 'resume'), ['laptop-app-db']);
  });

  test('overflow drain waits while a self-drained primary runner leans on it', () => {
    const runners = fleet({ 'laptop-app-web-2': owned() });
    // Quiet long enough to drain, but the primary runner has not come back yet.
    const state = { overflow: 'active', since: NOW - 20 * MIN, quietSince: NOW - 11 * MIN, freeSince: { build: NOW - 5 * SEC, simulator: NOW - 11 * MIN }, pending: {} };
    const r = decideTiers(input({ runners, state }));
    assert.equal(r.decision.overflow, 'standby');
    assert.ok(!names(r.decision.actions, 'drain').includes('studio-app-web'));
    assert.ok(!names(r.decision.actions, 'drain').includes('studio-app-web-2'));
    assert.ok(r.decision.deferred.some((d) => d.name === 'studio-app-web'));
    assert.deepEqual(names(r.decision.actions, 'drain'), ['studio-app-api']);
  });

  test('release runners on hosts with no agent are not the primary\'s', () => {
    const runners = [...fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } }),
      { ...runner('laptop', 'o/app-web', 9), dirName: undefined, local: false }];
    const r = decideTiers(input({ runners, state: ACTIVE }));
    assert.ok(!names(r.decision.actions).includes('laptop-app-web-9'));
  });

  test('self-drain off: its earlier drains come back', () => {
    const config = { ...CONFIG, selfDrain: false };
    const runners = fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true }, 'laptop-app-web-2': owned() });
    const r = decideTiers(input({ config, runners, state: ACTIVE }));
    assert.deepEqual(r.decision.actions.map((a) => [a.name, a.action]), [['laptop-app-web-2', 'resume']]);
  });
});
