// Tests for fleet.js — fleet-wide runner view, host list, and capacity.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptRemoteRunner, buildFleetRunners, buildHostList, anyHostHasCapacity,
  LOCAL_HOST_ID,
} from '../lib/fleet.js';

const STALE_MS = 5 * 60 * 1000;

// ---- adaptRemoteRunner -------------------------------------------------------

describe('adaptRemoteRunner', () => {
  function elsewhere(overrides = {}) {
    return {
      name: 'RL6P9-testowner-app-ios',
      repo: 'testowner/app-ios',
      project: 'testowner',
      ghStatus: 'online',
      ghBusy: false,
      labels: ['self-hosted', 'macos', 'arm64'],
      extraLabels: [],
      role: null,
      ephemeral: false,
      ...overrides,
    };
  }

  test('online runner with no agent data gets reasonable defaults', () => {
    const r = adaptRemoteRunner(elsewhere());
    assert.equal(r.registered, true);
    assert.equal(r.ghUnknown, false);
    assert.equal(r.launchdState, 'running');
    assert.equal(r.drainState, null);
    assert.equal(r.workingLocally, false);
    assert.equal(r.ephemeral, false);
  });

  test('offline runner with no agent data gets launchdState=dead', () => {
    const r = adaptRemoteRunner(elsewhere({ ghStatus: 'offline' }));
    assert.equal(r.launchdState, 'dead');
    assert.equal(r.ghStatus, 'offline');
  });

  test('busy remote runner has workingLocally derived from ghBusy', () => {
    const r = adaptRemoteRunner(elsewhere({ ghBusy: true }));
    assert.equal(r.workingLocally, true);
  });

  test('agent data enriches launchdState and workingLocally', () => {
    const agentData = {
      launchdState: 'running',
      workingLocally: true,
      drainState: 'draining',
      hostName: 'mac-studio',
      hostId: 'id-studio',
      instance: 2,
    };
    const r = adaptRemoteRunner(elsewhere(), agentData);
    assert.equal(r.launchdState, 'running');
    assert.equal(r.workingLocally, true);
    assert.equal(r.drainState, 'draining');
    assert.equal(r.hostName, 'mac-studio');
    assert.equal(r.instance, 2);
  });

  test('agent workingLocally=false beats ghBusy=true', () => {
    // Agent has the more current signal — prefer it when present.
    const r = adaptRemoteRunner(elsewhere({ ghBusy: true }), { workingLocally: false });
    assert.equal(r.workingLocally, false);
  });
});

// ---- buildFleetRunners -------------------------------------------------------

describe('buildFleetRunners', () => {
  function localRunner(overrides = {}) {
    return {
      name: 'RL6P9-app-ios', repo: 'testowner/app-ios',
      launchdState: 'running', registered: true, ghStatus: 'online',
      ghBusy: false, workingLocally: false, ephemeral: false,
      extraLabels: [], labels: ['self-hosted', 'macos', 'arm64'],
      ...overrides,
    };
  }

  function elsewhereRunner(overrides = {}) {
    return {
      name: 'mac2-app-ios', repo: 'testowner/app-ios', project: null,
      ghStatus: 'online', ghBusy: false,
      labels: ['self-hosted', 'macos', 'arm64'], extraLabels: [],
      role: null, ephemeral: false, ...overrides,
    };
  }

  test('returns local runners unchanged', () => {
    const fleet = buildFleetRunners([localRunner()], [], new Map());
    assert.equal(fleet.length, 1);
    assert.equal(fleet[0].name, 'RL6P9-app-ios');
  });

  test('adapts elsewhere runners into the fleet list', () => {
    const fleet = buildFleetRunners([localRunner()], [elsewhereRunner()], new Map());
    assert.equal(fleet.length, 2);
    assert.ok(fleet.some((r) => r.name === 'mac2-app-ios'));
  });

  test('skips ephemeral elsewhere runners', () => {
    const fleet = buildFleetRunners(
      [localRunner()],
      [elsewhereRunner({ ephemeral: true })],
      new Map()
    );
    assert.equal(fleet.length, 1);
  });

  test('enriches elsewhere runners with agent heartbeat data', () => {
    const hostState = new Map([
      ['id-mac2', {
        id: 'id-mac2', name: 'mac2',
        runners: [{ name: 'mac2-app-ios', workingLocally: true, launchdState: 'running', hostName: 'mac2', hostId: 'id-mac2' }],
      }],
    ]);
    const fleet = buildFleetRunners([localRunner()], [elsewhereRunner()], hostState);
    const remote = fleet.find((r) => r.name === 'mac2-app-ios');
    assert.equal(remote.workingLocally, true);
    assert.equal(remote.hostId, 'id-mac2');
  });

  test('keeps heartbeat-only remote runners visible while GitHub state is unknown', () => {
    const hostState = new Map([
      ['id-mac2', {
        id: 'id-mac2',
        name: 'mac2',
        lastHeartbeat: Date.now(),
        runners: [{
          name: 'agent-only-runner',
          repo: 'testowner/new-repo',
          launchdState: 'running',
        }],
      }],
    ]);
    const remote = buildFleetRunners([], [], hostState)[0];
    assert.equal(remote.name, 'agent-only-runner');
    assert.equal(remote.ghUnknown, true);
    assert.equal(remote.ghStatus, 'unknown');
    assert.equal(remote.hostId, 'id-mac2');
  });

  test('propagates stale heartbeat state to remote runner tiles', () => {
    const now = Date.UTC(2026, 0, 5, 12, 0, 0);
    const hostState = new Map([
      ['id-mac2', {
        id: 'id-mac2',
        name: 'mac2',
        lastHeartbeat: now - STALE_MS,
        runners: [{ name: 'mac2-app-ios', launchdState: 'running' }],
      }],
    ]);
    const remote = buildFleetRunners([], [elsewhereRunner()], hostState, now)[0];
    assert.equal(remote.hostStale, true);
    assert.equal(remote.staleForMs, STALE_MS);
  });

  test('fleet spans two repos and both runner counts are correct', () => {
    const fleet = buildFleetRunners(
      [localRunner({ name: 'local-app-ios', repo: 'o/app-ios' })],
      [
        elsewhereRunner({ name: 'remote-app-web', repo: 'o/app-web' }),
        elsewhereRunner({ name: 'remote-app-ios', repo: 'o/app-ios' }),
      ],
      new Map()
    );
    const iosCount = fleet.filter((r) => r.repo === 'o/app-ios').length;
    const webCount = fleet.filter((r) => r.repo === 'o/app-web').length;
    assert.equal(iosCount, 2);
    assert.equal(webCount, 1);
  });
});

// ---- buildHostList -----------------------------------------------------------

describe('buildHostList', () => {
  const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

  test('always starts with the coordinator as the first host', () => {
    const hosts = buildHostList({ ts: NOW, runners: [], host: {}, capacity: { ok: true } }, new Map());
    assert.equal(hosts[0].id, LOCAL_HOST_ID);
    assert.equal(hosts[0].local, true);
  });

  test('coordinator host uses local snapshot capacity', () => {
    const hosts = buildHostList(
      { ts: NOW, runners: [], host: {}, capacity: { ok: false, reasons: ['full'] } },
      new Map()
    );
    assert.equal(hosts[0].capacity.ok, false);
  });

  test('remote hosts follow in the list', () => {
    const hostState = new Map([
      ['id-mac2', { id: 'id-mac2', name: 'mac2', lastHeartbeat: NOW - 1000,
        labels: [], runners: [], repos: [], host: {}, capacity: { ok: true }, drained: false }],
    ]);
    const hosts = buildHostList({ ts: NOW, runners: [], host: {}, capacity: null }, hostState);
    assert.equal(hosts.length, 2);
    assert.equal(hosts[1].id, 'id-mac2');
  });

  test('coordinator labels are passed through', () => {
    const hosts = buildHostList(
      { ts: NOW, runners: [], host: {}, capacity: null },
      new Map(),
      { coordinatorLabels: ['xcode-16', 'macos-15'] }
    );
    assert.deepEqual(hosts[0].labels, ['xcode-16', 'macos-15']);
  });

  test('coordinator drained state is passed through', () => {
    const hosts = buildHostList(
      { ts: NOW, runners: [], host: {}, capacity: null },
      new Map(),
      { coordinatorDrained: true }
    );
    assert.equal(hosts[0].drained, true);
  });
});

// ---- anyHostHasCapacity ------------------------------------------------------

describe('anyHostHasCapacity', () => {
  const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

  function host(overrides = {}) {
    return {
      id: 'id-mac1', drained: false,
      lastHeartbeat: NOW - 1000,
      capacity: { ok: true },
      ...overrides,
    };
  }

  test('returns true when one host has capacity', () => {
    assert.equal(anyHostHasCapacity([host()], NOW), true);
  });

  test('returns false when no hosts', () => {
    assert.equal(anyHostHasCapacity([], NOW), false);
  });

  test('returns false when the only host is drained', () => {
    assert.equal(anyHostHasCapacity([host({ drained: true })], NOW), false);
  });

  test('returns false when the only host has no headroom', () => {
    assert.equal(anyHostHasCapacity([host({ capacity: { ok: false } })], NOW), false);
  });

  test('returns false when the only host is stale', () => {
    assert.equal(anyHostHasCapacity(
      [host({ lastHeartbeat: NOW - STALE_MS - 1000 })], NOW
    ), false);
  });

  test('returns true when one host has capacity and another does not', () => {
    assert.equal(anyHostHasCapacity([
      host({ capacity: { ok: false } }),
      host({ id: 'id-mac2', capacity: { ok: true } }),
    ], NOW), true);
  });

  test('a host that never sent a heartbeat is excluded', () => {
    assert.equal(anyHostHasCapacity([host({ lastHeartbeat: null })], NOW), false);
  });
});
