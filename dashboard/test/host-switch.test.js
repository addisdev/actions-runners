import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { switchOffImpact, drainsToReassert, reassertArgs, HOST_OWNER } from '../lib/host-switch.js';
import { hostDrainState } from '../lib/local.js';
import { buildHostList } from '../lib/fleet.js';
import { mergeHostSnapshots, choosePlacement } from '../lib/placement.js';

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);
const SEC = 1000;

const r = (name, repo, hostId, extra = {}) => ({
  name, repo, hostId, ghStatus: 'online', ghUnknown: false, drainState: null,
  workingLocally: false, ghBusy: false, ...extra,
});

describe('switchOffImpact', () => {
  const fleet = [
    r('mac-web', 'o/web', 'mac', { workingLocally: true }),
    r('mac-api', 'o/api', 'mac'),
    r('mac-ios', 'o/ios', 'mac', { ghBusy: true }),
    r('mac-old', 'o/old', 'mac', { drainState: 'drained', ghStatus: 'offline' }),
    r('studio-web', 'o/web', 'studio'),
    r('studio-api', 'o/api', 'studio', { drainState: 'drained' }),
    r('studio-ios', 'o/ios', 'studio', { hostStale: true }),
  ];

  test('names the busy jobs that will finish first', () => {
    const i = switchOffImpact('mac', fleet);
    assert.equal(i.runners, 4);
    assert.equal(i.active, 3);
    assert.deepEqual(i.busy, ['mac-ios', 'mac-web']);
  });

  test('a repo is stranded unless another host has a runner online and undrained for it', () => {
    assert.deepEqual(switchOffImpact('mac', fleet).stranded, ['o/api', 'o/ios']);
  });

  test('a runner on another off host does not count as cover', () => {
    const both = fleet.map((x) => (x.name === 'studio-web' ? { ...x, hostOff: true } : x));
    assert.deepEqual(switchOffImpact('mac', both).stranded, ['o/api', 'o/ios', 'o/web']);
  });

  test('on a single host every repo it serves is stranded', () => {
    const one = fleet.filter((x) => x.hostId === 'mac');
    assert.deepEqual(switchOffImpact('mac', one).stranded, ['o/api', 'o/ios', 'o/web']);
  });

  test('a host already off strands nothing new and has nothing busy to wait for', () => {
    const off = fleet.map((x) => (x.hostId === 'mac' ? { ...x, drainState: 'drained', workingLocally: false, ghBusy: false } : x));
    const i = switchOffImpact('mac', off);
    assert.equal(i.active, 0);
    assert.deepEqual(i.busy, []);
    assert.deepEqual(i.stranded, []);
  });
});

describe('drainsToReassert', () => {
  const local = (dirName, extra = {}) => ({
    name: `host-${dirName}`, dirName, drainState: 'drained', drainBy: null,
    launchdState: 'running', workingLocally: false, ...extra,
  });

  test('a drained runner that is running again is due after the grace period, not before', () => {
    const runners = [local('app-web')];
    let step = drainsToReassert({ runners, now: NOW });
    assert.deepEqual(step.due, []);
    step = drainsToReassert({ runners, now: NOW + 29 * SEC, seen: step.seen });
    assert.deepEqual(step.due, []);
    step = drainsToReassert({ runners, now: NOW + 30 * SEC, seen: step.seen });
    assert.deepEqual(step.due, [{ name: 'host-app-web', dirName: 'app-web', by: null }]);
  });

  test('is not retried for five minutes, then is', () => {
    const runners = [local('app-web')];
    let step = drainsToReassert({ runners, now: NOW });
    step = drainsToReassert({ runners, now: NOW + 30 * SEC, seen: step.seen });
    step = drainsToReassert({ runners, now: NOW + 4 * 60 * SEC, seen: step.seen });
    assert.deepEqual(step.due, []);
    step = drainsToReassert({ runners, now: NOW + 30 * SEC + 5 * 60 * SEC, seen: step.seen });
    assert.equal(step.due.length, 1);
  });

  test('leaves alone a stopped runner, an undrained one, and a draining one mid-job', () => {
    const runners = [
      local('stopped', { launchdState: 'not-loaded' }),
      local('dead', { launchdState: 'dead' }),
      local('working', { drainState: null }),
      local('finishing', { drainState: 'draining', workingLocally: true }),
    ];
    let step = drainsToReassert({ runners, now: NOW });
    step = drainsToReassert({ runners, now: NOW + 60 * SEC, seen: step.seen });
    assert.deepEqual(step.due, []);
    assert.equal(step.seen.size, 0);
  });

  test('a draining runner that is idle but still running is due (its stop never came)', () => {
    const runners = [local('idle', { drainState: 'draining' })];
    let step = drainsToReassert({ runners, now: NOW });
    step = drainsToReassert({ runners, now: NOW + 30 * SEC, seen: step.seen });
    assert.deepEqual(step.due.map((d) => d.dirName), ['idle']);
  });

  test('a runner that stops in the meantime is forgotten, so a later restart waits out the grace again', () => {
    let step = drainsToReassert({ runners: [local('app-web')], now: NOW });
    step = drainsToReassert({ runners: [local('app-web', { launchdState: 'not-loaded' })], now: NOW + 10 * SEC, seen: step.seen });
    step = drainsToReassert({ runners: [local('app-web')], now: NOW + 40 * SEC, seen: step.seen });
    assert.deepEqual(step.due, []);
  });

  test('keeps the drain\'s owner', () => {
    const runners = [local('a', { drainBy: HOST_OWNER }), local('b', { drainBy: 'tiers' }), local('c')];
    let step = drainsToReassert({ runners, now: NOW });
    step = drainsToReassert({ runners, now: NOW + 30 * SEC, seen: step.seen });
    assert.deepEqual(step.due.map(reassertArgs), [
      ['a', '--drain', '--by=host'],
      ['b', '--drain', '--by=tiers'],
      ['c', '--drain'],
    ]);
  });
});

describe('host off state', () => {
  test('hostDrainState tells off from paused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-off-'));
    try {
      assert.equal(hostDrainState(dir), null);
      writeFileSync(join(dir, '.drain'), 'drained\n');
      assert.equal(hostDrainState(dir), 'drained');
      writeFileSync(join(dir, '.drain'), 'off\nrequested_at=1\nby=host\n');
      assert.equal(hostDrainState(dir), 'off');
      writeFileSync(join(dir, '.drain'), '');
      assert.equal(hostDrainState(dir), 'drained');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an off host is drained for placement, on the coordinator and on an agent', () => {
    const hostState = new Map([['studio', { id: 'studio', name: 'studio', lastHeartbeat: NOW, off: true, runners: [] }]]);
    const hosts = buildHostList({ ts: NOW, runners: [] }, hostState, { coordinatorOff: true, coordinatorId: 'mac', coordinatorName: 'mac' });
    assert.deepEqual(hosts.map((h) => [h.id, h.drained, h.off]), [['mac', true, true], ['studio', true, true]]);
    const placed = choosePlacement({ hosts, repo: 'o/web', now: NOW });
    assert.equal(placed.chosen ?? null, null);
  });

  test('host summaries count what is still finishing', () => {
    const { hosts } = mergeHostSnapshots({
      now: NOW,
      hosts: [{
        id: 'mac', name: 'mac', lastHeartbeat: NOW, off: true,
        runners: [{ drainState: 'draining' }, { drainState: 'drained' }, { drainState: null }],
      }],
    });
    assert.equal(hosts[0].off, true);
    assert.equal(hosts[0].drained, true);
    assert.equal(hosts[0].drainingCount, 1);
    assert.equal(hosts[0].activeCount, 1);
  });
});
