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
  // The suites below describe self-drain onto standby twins, which predates
  // parking; describe('parking') turns it on.
  park: false,
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

  test('reads the self-drain hysteresis timers, defaulting to 60 s / 5 min / 10 min / 5 min', () => {
    const d = tiersConfigFromEnv({});
    assert.deepEqual([d.selfDrainAfterMs, d.selfResumeAfterMs, d.selfMinHoldMs, d.selfMinOpenMs],
      [60_000, 300_000, 600_000, 300_000]);
    const c = tiersConfigFromEnv({
      FLEET_TIERS_SELF_DRAIN_AFTER_S: '90',
      FLEET_TIERS_SELF_RESUME_AFTER_S: '120',
      FLEET_TIERS_SELF_MIN_HOLD_S: '900',
      FLEET_TIERS_SELF_MIN_OPEN_S: '0',
    });
    assert.deepEqual([c.selfDrainAfterMs, c.selfResumeAfterMs, c.selfMinHoldMs, c.selfMinOpenMs],
      [90_000, 120_000, 900_000, 0]);
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

  // A host switched off has every runner drained --by=host, which the
  // controller reads as somebody else's drain.
  const hostOff = () => ({ drainState: 'drained', drainBy: 'host', ghStatus: 'offline' });

  test('an off primary wakes the overflow tier and is sent nothing itself', () => {
    const runners = fleet({
      ...resting(),
      'laptop-app-web': hostOff(), 'laptop-app-web-2': hostOff(), 'laptop-app-api': hostOff(),
      'laptop-app-ios': hostOff(), 'laptop-app-ios-2': owned(), 'laptop-app-db': hostOff(),
    });
    // Lanes free for five minutes after a long hold: the self-drained primary
    // runner is due back.
    const state = {
      ...STANDBY_STATE,
      freeSince: { build: NOW - 5 * MIN, simulator: NOW - 5 * MIN },
      shed: { build: { on: true, since: NOW - 15 * MIN }, simulator: { on: true, since: NOW - 15 * MIN } },
    };
    const r = decideTiers(input({ runners, state, primary: { id: 'laptop', lastHeartbeat: NOW, rungs: [], off: true } }));
    assert.equal(r.decision.overflow, 'active');
    assert.equal(r.decision.triggers[0].id, 'primary-off');
    assert.deepEqual(names(r.decision.actions, 'resume'), ['studio-app-api', 'studio-app-web', 'studio-app-web-2']);
    assert.ok(r.decision.actions.every((a) => a.hostId === 'studio'));
    assert.ok(r.decision.deferred.some((d) => d.name === 'laptop-app-ios-2' && /switched off/.test(d.reason)));
  });

  test('a standby host that is off is not woken and gets no resume, even of its own drains', () => {
    const r = decideTiers(input({
      runners: fleet(resting()),
      state: STANDBY_STATE,
      primary: { id: 'laptop', lastHeartbeat: NOW, rungs: ['saturated'] },
      standby: [{ id: 'studio', name: 'studio', lastHeartbeat: NOW - 10 * SEC, memPressure: 'normal', off: true }],
    }));
    assert.equal(r.decision.overflow, 'standby');
    assert.deepEqual(r.decision.actions, []);

    const active = decideTiers(input({
      runners: fleet(resting()),
      state: { overflow: 'active', since: NOW - MIN, reason: 'busy', pending: {} },
      standby: [{ id: 'studio', name: 'studio', lastHeartbeat: NOW - 10 * SEC, memPressure: 'normal', off: true }],
    }));
    assert.deepEqual(active.decision.actions, []);
    assert.deepEqual(active.decision.deferred.map((d) => d.name).sort(), ['studio-app-api', 'studio-app-web', 'studio-app-web-2']);
    assert.ok(active.decision.deferred.every((d) => /studio is switched off/.test(d.reason)));
  });

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
  // Overflow online, and any lane at cap now has been for two minutes: past
  // selfDrainAfterMs, so an at-cap lane is shedding.
  const ACTIVE = {
    overflow: 'active', since: NOW - MIN, reason: 'busy', pending: {},
    atCapSince: { build: NOW - 2 * MIN, simulator: NOW - 2 * MIN },
  };

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
    const r = decideTiers(input({ runners, state: { ...STANDBY_STATE, atCapSince: ACTIVE.atCapSince } }));
    assert.ok(r.decision.lanes.build.shedding);
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
    // At cap for under 60 s, so the overflow tier is still going to standby,
    // with a self-drain threshold short enough to shed already.
    const config = { ...CONFIG, selfDrainAfterMs: 30 * SEC };
    const runners = fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const r = decideTiers(input({ config, runners, state: { ...STANDBY_STATE, atCapSince: { build: NOW - 45 * SEC } } }));
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

  test('resumes its drains after the lane has had room for 5 min and a 10 min hold, never an operator\'s', () => {
    const runners = fleet({ 'laptop-app-web-2': owned(), 'laptop-app-api': operator() });
    // At start, a lane with the controller's drains in it is shedding, held from now.
    let r = decideTiers(input({ runners, state: ACTIVE }));
    assert.deepEqual(r.decision.actions, []);
    assert.equal(r.decision.lanes.build.shedding, true);
    r = decideTiers(input({ runners, state: r.state, now: NOW + 30 * SEC }));
    assert.deepEqual(r.decision.actions, [], 'room for 30 s is not enough any more');
    r = decideTiers(input({ runners, state: r.state, now: NOW + 6 * MIN }));
    assert.deepEqual(r.decision.actions, [], 'room for 6 min, but held for under 10');
    r = decideTiers(input({ runners, state: r.state, now: NOW + 10 * MIN }));
    const primary = r.decision.actions.filter((a) => a.tier === 'primary');
    assert.deepEqual(primary.map((a) => [a.name, a.action]), [['laptop-app-web-2', 'resume']]);
    assert.equal(r.decision.lanes.build.shedding, false);
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

// The cap is the lane's normal operating point, so without hysteresis every job
// that starts or ends near it drained or resumed the whole primary host
// (runner-host 10-10..10-13: 489 drain batches of up to 55 runners, a median
// hold of 2.9 min, 88 drains landing on a runner that had just taken a job).
describe('self-drain hysteresis', () => {
  const ACTIVE = { overflow: 'active', since: NOW - MIN, reason: 'busy', pending: {} };
  const atCap = { 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } };
  const primaryActions = (r) => r.decision.actions.filter((a) => a.tier === 'primary');

  // Carries out a step's actions on the runner list, the way the next tick
  // would see them: a drain leaves the runner drained by tiers, a resume clears it.
  const apply = (runners, actions) => runners.map((r) => {
    const a = actions.find((x) => x.name === r.name);
    if (!a) return r;
    return a.action === 'drain' ? { ...r, ...owned(r.workingLocally ? 'draining' : 'drained') } : { ...r, drainState: null, drainBy: null, ghStatus: 'online' };
  });

  test('a lane must stay at cap for selfDrainAfterMs before anything is drained', () => {
    let r = decideTiers(input({ runners: fleet(atCap), state: ACTIVE }));
    assert.deepEqual(primaryActions(r), [], 'one tick at cap drains nothing');
    assert.equal(r.decision.lanes.build.shedding, false);
    r = decideTiers(input({ runners: fleet(atCap), state: r.state, now: NOW + 59 * SEC }));
    assert.deepEqual(primaryActions(r), []);
    r = decideTiers(input({ runners: fleet(atCap), state: r.state, now: NOW + 60 * SEC }));
    assert.equal(r.decision.lanes.build.shedding, true);
    assert.deepEqual(names(primaryActions(r), 'drain'), ['laptop-app-ios', 'laptop-app-ios-2', 'laptop-app-web-2']);
  });

  test('a dip below cap during the at-cap wait starts it again', () => {
    let r = decideTiers(input({ runners: fleet(atCap), state: ACTIVE }));
    r = decideTiers(input({ runners: fleet({ 'laptop-app-web': { workingLocally: true } }), state: r.state, now: NOW + 45 * SEC }));
    r = decideTiers(input({ runners: fleet(atCap), state: r.state, now: NOW + 50 * SEC }));
    r = decideTiers(input({ runners: fleet(atCap), state: r.state, now: NOW + 100 * SEC }));
    assert.deepEqual(primaryActions(r), [], 'at cap again for 50 s only');
    r = decideTiers(input({ runners: fleet(atCap), state: r.state, now: NOW + 110 * SEC }));
    assert.ok(primaryActions(r).length > 0);
  });

  test('the lane refilling before selfResumeAfterMs keeps its runners drained', () => {
    const drained = { ...atCap, 'laptop-app-web-2': owned() };
    const shedding = { ...ACTIVE, shed: { build: { on: true, since: NOW - 20 * MIN }, simulator: { on: false, since: null } } };
    // Free for 4 min, one tick back at cap, then free again.
    let r = decideTiers(input({ runners: fleet({ 'laptop-app-web-2': owned() }), state: { ...shedding, freeSince: { build: NOW - 4 * MIN } } }));
    assert.deepEqual(primaryActions(r), []);
    r = decideTiers(input({ runners: fleet(drained), state: r.state, now: NOW + 15 * SEC }));
    r = decideTiers(input({ runners: fleet({ 'laptop-app-web-2': owned() }), state: r.state, now: NOW + 30 * SEC }));
    r = decideTiers(input({ runners: fleet({ 'laptop-app-web-2': owned() }), state: r.state, now: NOW + 5 * MIN }));
    assert.deepEqual(primaryActions(r), [], 'free for 4.5 min since the refill');
    r = decideTiers(input({ runners: fleet({ 'laptop-app-web-2': owned() }), state: r.state, now: NOW + 5.5 * MIN }));
    assert.deepEqual(primaryActions(r).map((a) => [a.name, a.action]), [['laptop-app-web-2', 'resume']]);
  });

  test('after a resume the lane stays open for selfMinOpenMs, however busy', () => {
    const opened = { ...ACTIVE, shed: { build: { on: false, since: NOW - 2 * MIN }, simulator: { on: false, since: null } }, atCapSince: { build: NOW - 2 * MIN } };
    let r = decideTiers(input({ runners: fleet(atCap), state: opened }));
    assert.deepEqual(primaryActions(r), [], 'opened 2 min ago');
    r = decideTiers(input({ runners: fleet(atCap), state: r.state, now: NOW + 3 * MIN }));
    assert.equal(r.decision.lanes.build.shedding, true, 'open for 5 min, at cap throughout');
    assert.ok(primaryActions(r).length > 0);
  });

  test('a hold never outlasts safety: no twin, a primary-only repo or self-drain off resume at once', () => {
    const shedding = { ...ACTIVE, shed: { build: { on: true, since: NOW - MIN }, simulator: { on: false, since: null } } };
    const runners = fleet({ ...atCap, 'laptop-app-web-2': owned(), 'studio-app-web': { ghStatus: 'offline' }, 'studio-app-web-2': operator() });
    const r = decideTiers(input({ runners, state: shedding }));
    assert.deepEqual(names(primaryActions(r), 'resume'), ['laptop-app-web-2']);
    const off = decideTiers(input({ config: { ...CONFIG, selfDrain: false }, runners: fleet({ 'laptop-app-web-2': owned() }), state: shedding }));
    assert.deepEqual(names(primaryActions(off), 'resume'), ['laptop-app-web-2']);
  });

  test('a restart with the controller\'s drains in place holds them from the restart, and drains no more while the lane has room', () => {
    const runners = fleet({ 'laptop-app-web-2': owned(), 'laptop-app-ios-2': owned() });
    const r = decideTiers(input({ runners, state: null }));
    assert.equal(r.decision.lanes.build.shedding, true);
    assert.equal(r.decision.lanes.build.shedSince, NOW);
    assert.deepEqual(primaryActions(r), []);
  });

  // The flap seen on runner-host, replayed: two jobs, one of which finishes and
  // is replaced every couple of minutes, so the build lane (cap 2) swings
  // 2 → 1 → 2 all hour. The old rule (drain on the first tick at cap, resume
  // after 30 s with room) drained and resumed every idle runner each swing.
  function swing(config, minutes) {
    let runners = fleet();
    let state = { ...ACTIVE };
    const batches = { drain: 0, resume: 0 };
    for (let t = 0; t <= minutes * MIN; t += 15 * SEC) {
      // 90 s at cap, then 45 s at 1/2, repeating.
      const busy = (t % (135 * SEC)) < 90 * SEC ? 2 : 1;
      runners = runners.map((r) => (r.name === 'laptop-app-web' ? { ...r, workingLocally: true }
        : r.name === 'laptop-app-api' ? { ...r, workingLocally: busy === 2 } : r));
      const r = decideTiers(input({ config, runners, state, now: NOW + t }));
      state = r.state;
      const p = primaryActions(r);
      if (p.some((a) => a.action === 'drain')) batches.drain += 1;
      if (p.some((a) => a.action === 'resume')) batches.resume += 1;
      runners = apply(runners, p);
    }
    return batches;
  }

  test('replay: a lane swinging around its cap for an hour sheds once, not every swing', () => {
    const old = { ...CONFIG, selfDrainAfterMs: 0, selfResumeAfterMs: 30_000, selfMinHoldMs: 0, selfMinOpenMs: 0 };
    const before = swing(old, 60);
    assert.ok(before.drain >= 20, `the old rule flaps (${before.drain} drain batches)`);
    const after = swing(CONFIG, 60);
    assert.deepEqual(after, { drain: 1, resume: 0 });
  });

  test('replay: once the swinging stops, the lane opens again after the hold and the room window', () => {
    let runners = fleet(atCap);
    let state = { ...ACTIVE };
    let resumedAt = null;
    for (let t = 0; t <= 30 * MIN && resumedAt == null; t += 15 * SEC) {
      // At cap for the first 2 minutes, then one job: room from then on.
      runners = runners.map((r) => (r.name === 'laptop-app-api' ? { ...r, workingLocally: t < 2 * MIN } : r));
      const r = decideTiers(input({ runners, state, now: NOW + t }));
      state = r.state;
      const p = primaryActions(r);
      if (p.some((a) => a.action === 'resume')) resumedAt = t;
      runners = apply(runners, p);
    }
    // Shed at 60 s; room from 2 min; the 10 min hold ends at 11 min, after 9 min of room.
    assert.equal(resumedAt, 11 * MIN);
  });
});

// 2026-10-15: ultra (the standby host) sat at 97 GB under its own 100 GB
// admission floor. The controller kept its runners online and self-drained the
// primary's runners onto them as "twins", so every job GitHub gave ultra sat
// at Set up runner for 30–60 min and was cancelled, while the primary had room.
describe('a host that cannot admit', () => {
  const FLOOR = { kind: 'disk', freeGb: 96, floorGb: 100, reason: '96 GB disk free, below the 100 GB floor' };
  const ACTIVE_STATE = { overflow: 'active', since: NOW - 5 * MIN, reason: 'busy', pending: {} };
  const blockedStandby = (over = {}) => [{ id: 'studio', name: 'studio', lastHeartbeat: NOW - 10 * SEC, memPressure: 'normal', cannotAdmit: FLOOR, ...over }];

  test('every runner on a standby host that cannot admit is drained, floor and busy ones included', () => {
    const runners = fleet({ 'studio-app-api': { workingLocally: true } });
    const r = decideTiers(input({ runners, standby: blockedStandby(), state: ACTIVE_STATE }));
    assert.deepEqual(names(r.decision.actions, 'drain'), ['studio-app-api', 'studio-app-ios', 'studio-app-web', 'studio-app-web-2']);
    assert.ok(r.decision.actions.every((a) => /studio cannot start jobs: 96 GB disk free/.test(a.reason)), r.decision.actions.map((a) => a.reason).join(' | '));
    assert.equal(r.decision.hosts[0].cannotAdmit, FLOOR.reason);
  });

  test('a busy primary lane does not resume a standby host that cannot admit', () => {
    const runners = fleet({ ...resting(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const state = { ...STANDBY_STATE, atCapSince: { build: NOW - 2 * MIN } };
    const r = decideTiers(input({ runners, standby: blockedStandby(), state }));
    assert.deepEqual(names(r.decision.actions, 'resume'), []);
  });

  test('is no twin: the primary keeps its runners, and resumes the ones it shed', () => {
    const runners = fleet({
      'laptop-app-web': { workingLocally: true },
      'laptop-app-api': { workingLocally: true },
      'laptop-app-web-2': owned(),
    });
    const state = { ...ACTIVE_STATE, atCapSince: { build: NOW - 5 * MIN }, shed: { build: { on: true, since: NOW - 2 * MIN } } };
    const r = decideTiers(input({ runners, standby: blockedStandby(), state }));
    assert.deepEqual(names(r.decision.actions.filter((a) => a.tier === 'primary'), 'resume'), ['laptop-app-web-2']);
    assert.deepEqual(names(r.decision.actions.filter((a) => a.tier === 'primary'), 'drain'), []);
  });

  test('stays drained until it has been able to admit for admitResumeAfterMs', () => {
    let runners = fleet();
    let r = decideTiers(input({ runners, standby: blockedStandby(), state: ACTIVE_STATE }));
    let state = r.state;
    // Drains land; then the disk crosses back over the floor.
    runners = fleet({ 'studio-app-web': owned(), 'studio-app-web-2': owned(), 'studio-app-api': owned(), 'studio-app-ios': owned() });
    const queue = [{ id: 1, repo: 'o/app-web', labels: ['ci'], queuedSinceMs: 5 * MIN }];
    for (const t of [1, 2, 4]) {
      r = decideTiers(input({ now: NOW + t * MIN, runners, queue, standby: blockedStandby({ cannotAdmit: null, lastHeartbeat: NOW + t * MIN }), state }));
      state = r.state;
      assert.deepEqual(names(r.decision.actions, 'resume'), [], `still held at ${t} min`);
      assert.match(r.decision.hosts[0].cannotAdmit, /until \d+s ago|until \d+m ago/);
    }
    r = decideTiers(input({ now: NOW + 7 * MIN, runners, queue, standby: blockedStandby({ cannotAdmit: null, lastHeartbeat: NOW + 7 * MIN }), state }));
    assert.equal(r.decision.hosts[0].cannotAdmit, null);
    assert.deepEqual(names(r.decision.actions, 'resume'), ['studio-app-api', 'studio-app-ios', 'studio-app-web', 'studio-app-web-2']);
  });

  test('a fresh block restarts the wait', () => {
    let r = decideTiers(input({ standby: blockedStandby(), state: ACTIVE_STATE }));
    r = decideTiers(input({ now: NOW + 4 * MIN, standby: blockedStandby({ cannotAdmit: null, lastHeartbeat: NOW + 4 * MIN }), state: r.state }));
    r = decideTiers(input({ now: NOW + 5 * MIN, standby: blockedStandby({ lastHeartbeat: NOW + 5 * MIN }), state: r.state }));
    r = decideTiers(input({ now: NOW + 9 * MIN, standby: blockedStandby({ cannotAdmit: null, lastHeartbeat: NOW + 9 * MIN }), state: r.state }));
    assert.ok(r.decision.hosts[0].cannotAdmit, 'blocked again at 5 min, so 9 min is only 4 min clear');
  });

  test('an agent that does not report admission (null) is not blocked', () => {
    const r = decideTiers(input({ standby: blockedStandby({ cannotAdmit: null }), state: ACTIVE_STATE }));
    assert.deepEqual(names(r.decision.actions, 'drain'), []);
    assert.equal(r.decision.hosts[0].cannotAdmit, null);
  });

  test('a primary that cannot admit wakes the overflow tier and drains its own runners, busy ones too, onto online twins', () => {
    const runners = fleet({ ...resting(), 'laptop-app-web': { workingLocally: true } });
    const primary = { id: 'laptop', lastHeartbeat: NOW, memPressure: 'normal', rungs: [], cannotAdmit: FLOOR };
    let r = decideTiers(input({ runners, primary, state: STANDBY_STATE }));
    assert.equal(r.decision.triggers[0].id, 'primary-cannot-admit');
    assert.equal(r.decision.overflow, 'active');
    assert.deepEqual(names(r.decision.actions, 'resume'), ['studio-app-api', 'studio-app-web', 'studio-app-web-2']);
    // Next step, with the standby twins online: the primary's runners go,
    // except the primary-only repo and one with no twin (app-ios-2 shares the
    // floor twin with app-ios, which is enough).
    r = decideTiers(input({ runners: fleet({ 'laptop-app-web': { workingLocally: true } }), primary, state: r.state }));
    const drained = names(r.decision.actions.filter((a) => a.tier === 'primary'), 'drain');
    assert.ok(drained.includes('laptop-app-web'), 'busy runner drained too');
    assert.ok(!drained.includes('laptop-app-db'), 'primary-only repo stays');
    assert.ok(r.decision.actions.filter((a) => a.tier === 'primary').every((a) => /the primary cannot start jobs/.test(a.reason)));
  });

  test('off mode drains nothing for admission and releases what it drained', () => {
    const config = { ...CONFIG, mode: 'off' };
    const runners = fleet({ 'studio-app-ios': owned() });
    const r = decideTiers(input({ config, runners, standby: blockedStandby(), state: ACTIVE_STATE }));
    assert.deepEqual(names(r.decision.actions, 'drain'), []);
    assert.deepEqual(names(r.decision.actions, 'resume'), ['studio-app-ios']);
  });

  test('primaryRungs: a disk-floor rung about a standby host is not the primary\'s', () => {
    const v = (hosts) => ({ open: [{ id: 'disk-floor', hosts }] });
    assert.deepEqual(primaryRungs(v(['studio']), [], { primaryId: 'laptop', primaryIsLocal: true }), []);
    assert.deepEqual(primaryRungs(v([null]), [], { primaryId: 'laptop', primaryIsLocal: true }), ['disk-floor']);
    assert.deepEqual(primaryRungs(v(['laptop']), [], { primaryId: 'laptop', primaryIsLocal: false }), ['disk-floor']);
  });

  test('reads FLEET_TIERS_ADMIT_RESUME_AFTER_S', () => {
    assert.equal(tiersConfigFromEnv({}).admitResumeAfterMs, 300_000);
    assert.equal(tiersConfigFromEnv({ FLEET_TIERS_ADMIT_RESUME_AFTER_S: '120' }).admitResumeAfterMs, 120_000);
  });
});

// 2026-10-16: ultra sat under its 100 GB disk floor, so it could not admit and
// every homelake runner there was drained. runner-host's homelake runners then
// had no standby twin, self-drain left them online at the lane's cap, and every
// job they took sat in the admission hook, charged to its own timeout-minutes:
// homelake release-check timed out at 30 min after a 26 min hold for a 4 min
// job, and `words` hit its 10 min limit six times. Parking keeps such a runner
// offline instead, so the job waits in GitHub's queue, and brings parked
// runners back one per free slot.
describe('parking (no standby twin)', () => {
  const PARK = { ...CONFIG, park: true };
  const FLOOR = { kind: 'disk', freeGb: 94, floorGb: 100, reason: '94 GB disk free, below the 100 GB floor' };
  const blocked = [{ id: 'studio', name: 'studio', lastHeartbeat: NOW - 10 * SEC, memPressure: 'normal', cannotAdmit: FLOOR }];
  // The standby host's runners, all drained because it cannot admit.
  const standbyDown = () => ({
    'studio-app-web': owned(), 'studio-app-web-2': owned(), 'studio-app-api': owned(), 'studio-app-ios': owned(),
  });
  // Build lane shedding for two minutes: inside the ten-minute minimum hold.
  const SHEDDING = {
    overflow: 'standby', since: NOW - 30 * MIN, reason: 'quiet', pending: {},
    atCapSince: { build: NOW - 3 * MIN }, freeSince: { simulator: NOW - 30 * MIN },
    shed: { build: { on: true, since: NOW - 2 * MIN }, simulator: { on: false, since: null } },
    admit: { studio: { on: true, since: NOW - 60 * MIN, clearSince: null, reason: FLOOR.reason } },
  };
  const step = (over) => decideTiers(input({ config: PARK, standby: blocked, state: SHEDDING, ...over }));
  const queued = (id, repo, ageMin, labels = [], cause = 'runner-down') => ({ id, repo, labels: [...BASE, ...labels], queuedSinceMs: ageMin * MIN, cause });
  const primaryActions = (r) => r.decision.actions.filter((a) => a.tier === 'primary');

  test('FLEET_TIERS_PARK defaults on; 0 turns it off', () => {
    assert.equal(tiersConfigFromEnv({}).park, true);
    assert.equal(tiersConfigFromEnv({ FLEET_TIERS_PARK: '0' }).park, false);
  });

  test('at cap with no standby twin, idle primary runners are parked, a primary-only repo too', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const r = step({ runners });
    assert.deepEqual(names(primaryActions(r), 'drain'), ['laptop-app-db', 'laptop-app-ios', 'laptop-app-ios-2', 'laptop-app-web-2']);
    assert.ok(primaryActions(r).every((a) => /parked, no standby twin/.test(a.reason)));
    assert.deepEqual(r.decision.deferred.filter((d) => /twin/.test(d.reason)), []);
  });

  test('parking off keeps the old rule: twinless runners stay online and are deferred', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const r = step({ runners, config: { ...PARK, park: false } });
    assert.deepEqual(names(primaryActions(r), 'drain'), []);
    assert.ok(r.decision.deferred.some((d) => d.name === 'laptop-app-web-2' && /no online standby twin/.test(d.reason)));
  });

  test('a parked runner stays parked while the lane is full; its run waits at GitHub', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true }, 'laptop-app-web-2': owned() });
    const r = step({ runners, queue: [queued(1, 'o/app-web', 12, ['ci'])] });
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
    assert.deepEqual(r.decision.release.slots, { build: 0, simulator: 1 });
  });

  test('a job held in the hook still fills its slot', () => {
    // laptop-app-api has a Worker sitting in the hook: workingLocally, so busy.
    const runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true }, 'laptop-app-db': owned() });
    const r = step({ runners, queue: [queued(1, 'o/app-db', 20, ['postgres'])] });
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
  });

  test('one slot frees: exactly one parked runner comes back, for the oldest queued run', () => {
    const runners = fleet({
      ...standbyDown(),
      'laptop-app-api': { workingLocally: true },
      'laptop-app-web': owned(), 'laptop-app-web-2': owned(), 'laptop-app-db': owned(),
    });
    const queue = [queued(7, 'o/app-db', 3, ['postgres']), queued(8, 'o/app-web', 9, ['ci'])];
    const r = step({ runners, queue });
    const resumed = primaryActions(r).filter((a) => a.action === 'resume');
    assert.deepEqual(resumed.map((a) => a.name), ['laptop-app-web']);
    assert.match(resumed[0].reason, /slot is free for queued run 8/);
    assert.equal(r.decision.lanes.build.shedding, true, 'still inside the hold: the rest stay parked');
  });

  test('a runner already online and idle for the run takes the slot; nothing is resumed for it', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-api': { workingLocally: true }, 'laptop-app-web-2': owned(), 'laptop-app-db': owned() });
    const queue = [queued(8, 'o/app-web', 9, ['ci']), queued(7, 'o/app-db', 3, ['postgres'])];
    const r = step({ runners, queue });
    assert.deepEqual(names(primaryActions(r), 'resume'), [], 'laptop-app-web is online for run 8; no slot is left for run 7');
    assert.deepEqual(r.decision.release.runners, { 'laptop-app-web': 8 });
  });

  test('a runner GitHub has handed a job, whose Worker has not started, spends a slot', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-api': { workingLocally: true }, 'laptop-app-web': { ghBusy: true }, 'laptop-app-db': owned() });
    const r = step({ runners, queue: [queued(7, 'o/app-db', 3, ['postgres'])] });
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
  });

  test('the Simulator lane meters on its own cap as well as the build lane', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-ios': { workingLocally: true }, 'laptop-app-ios-2': owned() });
    const r = step({ runners, queue: [queued(3, 'o/app-ios', 6)] });
    // Build has a slot (1/2), but the Simulator lane is 1/1.
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
  });

  test('a run GitHub itself is holding gets no slot', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-api': { workingLocally: true }, 'laptop-app-web': owned(), 'laptop-app-web-2': owned() });
    const r = step({ runners, queue: [queued(8, 'o/app-web', 30, ['ci'], 'concurrency-block')] });
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
  });

  test('a primary that cannot admit has no slots: its twinless runners all wait parked', () => {
    const primary = { id: 'laptop', lastHeartbeat: NOW, memPressure: 'normal', rungs: [], cannotAdmit: FLOOR };
    const runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true } });
    const r = step({ runners, primary, queue: [queued(8, 'o/app-api', 9)] });
    const drained = names(primaryActions(r), 'drain');
    assert.ok(drained.includes('laptop-app-web'), 'the busy one stops after its job');
    assert.ok(drained.includes('laptop-app-db'));
    assert.ok(drained.includes('laptop-app-api'));
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
    assert.ok(primaryActions(r).every((a) => /parked, no standby twin: the primary cannot start jobs/.test(a.reason)));
  });

  test('with an online twin, parking changes nothing: the runner drains onto the twin', () => {
    const runners = fleet({ 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    const standby = [{ id: 'studio', name: 'studio', lastHeartbeat: NOW - 10 * SEC, memPressure: 'normal' }];
    const r = step({ runners, standby, state: { ...SHEDDING, overflow: 'active', admit: {} } });
    const reasons = Object.fromEntries(primaryActions(r).map((a) => [a.name, a.reason]));
    assert.equal(reasons['laptop-app-web-2'], 'build lane at cap');
    assert.match(reasons['laptop-app-db'], /parked/, 'primary-only: never sent to the twin, parked instead');
  });

  test('parked runners all come back once the lane has had room past the hold', () => {
    const runners = fleet({ ...standbyDown(), 'laptop-app-web-2': owned(), 'laptop-app-db': owned() });
    const state = { ...SHEDDING, shed: { build: { on: true, since: NOW - 11 * MIN }, simulator: { on: false, since: null } }, atCapSince: {}, freeSince: { build: NOW - 6 * MIN, simulator: NOW - 30 * MIN } };
    const r = step({ runners, state });
    assert.deepEqual(names(primaryActions(r), 'resume'), ['laptop-app-db', 'laptop-app-web-2']);
    assert.equal(r.decision.lanes.build.shedding, false);
  });

  test('replay: a backlog drains one job per slot, oldest first, with nothing held in the hook', () => {
    const queue = [queued(7, 'o/app-db', 3, ['postgres']), queued(8, 'o/app-web', 9, ['ci'])];
    // 1. At cap: the idle runners park.
    let runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-api': { workingLocally: true } });
    let r = step({ runners, queue });
    assert.ok(names(primaryActions(r), 'drain').includes('laptop-app-db'));
    assert.ok(names(primaryActions(r), 'drain').includes('laptop-app-web-2'));
    // 2. laptop-app-web's job ends; it is idle and online, and the oldest run
    //    is its repo's, so it keeps its place and nothing else comes back.
    runners = fleet({ ...standbyDown(), 'laptop-app-api': { workingLocally: true }, 'laptop-app-web-2': owned(), 'laptop-app-db': owned(), 'laptop-app-ios': owned(), 'laptop-app-ios-2': owned() });
    r = step({ runners, queue, state: r.state, now: NOW + 15 * SEC });
    assert.deepEqual(names(primaryActions(r), 'resume'), []);
    assert.deepEqual(r.decision.release.runners, { 'laptop-app-web': 8 });
    // 3. It took run 8 (2/2 again); then app-api's job ends: run 7's runner
    //    is resumed for the one free slot.
    runners = fleet({ ...standbyDown(), 'laptop-app-web': { workingLocally: true }, 'laptop-app-web-2': owned(), 'laptop-app-db': owned(), 'laptop-app-ios': owned(), 'laptop-app-ios-2': owned() });
    r = step({ runners, queue: [queue[0]], state: r.state, now: NOW + 4 * MIN });
    assert.deepEqual(names(primaryActions(r), 'resume'), ['laptop-app-db']);
    assert.deepEqual(names(primaryActions(r), 'drain'), [], 'laptop-app-api is busy-free but the lane has room: it is not newly parked');
  });
});
