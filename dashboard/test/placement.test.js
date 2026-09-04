import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { choosePlacement, mergeHostSnapshots, STALE_HEARTBEAT_MS } from '../lib/placement.js';

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const REPO = 'testowner/app-ios';

// The shape headroom() actually returns — {ok, busy, ceiling, maxTotalRunners,
// reasons} — with load and core count arriving separately as host vitals. Earlier
// versions of this helper invented loadPerCore and maxRunners on the capacity
// object, which made the ranking tests below pass for a reason that could not
// occur against a real heartbeat. ceiling is set to its real default of 3 here
// precisely so that reading it as a runner cap would fail these tests.
function host(name, overrides = {}) {
  return {
    id: `id-${name}`,
    name,
    lastHeartbeat: NOW - 5_000,
    runnerCount: 1,
    repos: [],
    labels: ['self-hosted', 'macos', 'arm64'],
    capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
    host: { cores: 12, load1: 6.0 },
    runners: [],
    ...overrides,
  };
}

describe('choosePlacement — eligibility', () => {
  test('picks the only eligible host', () => {
    const out = choosePlacement({ hosts: [host('mac-1')], repo: REPO, now: NOW });
    assert.equal(out.chosen, 'mac-1');
    assert.match(out.reason, /only eligible host/);
  });

  test('an empty fleet is reported plainly, not as an error', () => {
    const out = choosePlacement({ hosts: [], repo: REPO, now: NOW });
    assert.equal(out.chosen, null);
    assert.match(out.reason, /no hosts are registered/);
  });

  test('a host with a stale heartbeat is refused, and the age is named', () => {
    const out = choosePlacement({
      hosts: [host('mac-1', { lastHeartbeat: NOW - STALE_HEARTBEAT_MS - 60_000 })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, null);
    assert.match(out.reason, /heartbeat/);
    assert.match(out.reason, /s ago/);
  });

  test('a host that never sent a heartbeat is refused', () => {
    const out = choosePlacement({
      hosts: [host('mac-1', { lastHeartbeat: null })], repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, null);
    assert.match(out.reason, /never sent a heartbeat/);
  });

  test('a host with no headroom is refused with its own reason', () => {
    const out = choosePlacement({
      hosts: [host('mac-1', { capacity: { ok: false, reasons: ['load/core 2.9 (limit 2.0)'] } })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, null);
    assert.match(out.reason, /load\/core 2\.9/);
  });

  test('a drained host is refused', () => {
    const out = choosePlacement({ hosts: [host('mac-1', { drained: true })], repo: REPO, now: NOW });
    assert.equal(out.chosen, null);
    assert.match(out.reason, /drained/);
  });

  test('a host missing a required label is refused, naming the label', () => {
    const out = choosePlacement({
      hosts: [host('mac-1')], repo: REPO, requiredLabels: ['xcode-16'], now: NOW,
    });
    assert.equal(out.chosen, null);
    assert.match(out.reason, /xcode-16/);
  });

  test('label matching ignores case', () => {
    const out = choosePlacement({
      hosts: [host('mac-1', { labels: ['self-hosted', 'XCode-16'] })],
      repo: REPO, requiredLabels: ['xcode-16'], now: NOW,
    });
    assert.equal(out.chosen, 'mac-1');
  });

  test('one stale host does not prevent placing on a healthy one', () => {
    const out = choosePlacement({
      hosts: [host('mac-stale', { lastHeartbeat: NOW - 600_000 }), host('mac-ok')],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-ok');
  });

  test('every host is accounted for in considered', () => {
    const out = choosePlacement({
      hosts: [host('mac-1'), host('mac-2', { drained: true }), host('mac-3', { lastHeartbeat: null })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.considered.length, 3);
    for (const c of out.considered) assert.ok(c.reason, `${c.host} has no stated reason`);
  });
});

describe('choosePlacement — scoring', () => {
  test('prefers the host with more free slots', () => {
    const out = choosePlacement({
      hosts: [host('mac-full', { runnerCount: 7 }), host('mac-empty', { runnerCount: 1 })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-empty');
  });

  test('prefers lower load when free slots are equal', () => {
    const out = choosePlacement({
      hosts: [
        host('mac-busy', { host: { cores: 10, load1: 18.0 } }),
        host('mac-idle', { host: { cores: 10, load1: 2.0 } }),
      ],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-idle');
  });

  // Load is derived from vitals, so a heartbeat missing them must not silently
  // hand every host identical full marks and drop load out of the ranking —
  // which is what happened when this read a capacity field that never existed.
  test('load actually influences the ranking, and the reason says so', () => {
    const out = choosePlacement({
      hosts: [
        host('mac-loaded', { host: { cores: 8, load1: 12.0 } }),
        host('mac-quiet', { host: { cores: 8, load1: 0.8 } }),
      ],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-quiet');
    const quiet = out.considered.find((c) => c.host === 'mac-quiet');
    const loaded = out.considered.find((c) => c.host === 'mac-loaded');
    assert.ok(quiet.score > loaded.score, 'the quieter host must score higher');
    assert.match(quiet.reason, /load\/core 0\.10/);
  });

  test('the configured runner cap is respected, not a hardcoded 8', () => {
    // Both have 4 runners. The Studio allows 12, the Mini 4 — so the Mini has no
    // free slots and the Studio has 8, and that must decide it.
    const out = choosePlacement({
      hosts: [
        host('mac-mini', { runnerCount: 4, capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 4 } }),
        host('mac-studio', { runnerCount: 4, capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 12 } }),
      ],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-studio');
  });

  // ceiling is the "do not add while this many jobs are running" gate and real
  // hosts report 3. Scoring free slots against it made any host with three or
  // more runners look full, so a 12-runner Studio and a 4-runner Mini both
  // scored zero for capacity and the ranking fell back to load and locality.
  test('the busy-jobs ceiling is not mistaken for the runner cap', () => {
    const out = choosePlacement({
      hosts: [
        host('mac-small', { runnerCount: 4, capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 4 } }),
        host('mac-large', { runnerCount: 4, capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 16 } }),
      ],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-large');
    const large = out.considered.find((c) => c.host === 'mac-large');
    const small = out.considered.find((c) => c.host === 'mac-small');
    assert.ok(
      large.score > small.score,
      `a host allowing 16 runners must outscore one allowing 4 (got ${large.score} vs ${small.score})`
    );
  });

  test('locality breaks a tie between otherwise equal hosts', () => {
    const out = choosePlacement({
      hosts: [host('mac-a'), host('mac-b', { repos: [REPO] })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-b');
  });

  test('locality does NOT outweigh real spare capacity', () => {
    // mac-warm already serves the repo but is nearly full; mac-cold is empty.
    // Spreading load is the point of federation, so capacity must win.
    const out = choosePlacement({
      hosts: [host('mac-warm', { runnerCount: 7, repos: [REPO] }), host('mac-cold', { runnerCount: 0 })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, 'mac-cold');
  });

  test('is deterministic when hosts are genuinely identical', () => {
    const hosts = [host('mac-b'), host('mac-a')];
    const first = choosePlacement({ hosts, repo: REPO, now: NOW }).chosen;
    const second = choosePlacement({ hosts: [...hosts].reverse(), repo: REPO, now: NOW }).chosen;
    assert.equal(first, second, 'input order changed the decision');
  });

  test('names the runners-up, so a decision can be argued with', () => {
    const out = choosePlacement({
      hosts: [host('mac-a', { runnerCount: 0 }), host('mac-b', { runnerCount: 3 })],
      repo: REPO, now: NOW,
    });
    assert.match(out.reason, /preferred over mac-b/);
  });

  test('a host already at its own max is not eligible on slots alone', () => {
    // Its capacity gate is what refuses this; free slots reaching zero must not
    // be the only thing standing between a full host and another runner.
    const out = choosePlacement({
      hosts: [host('mac-1', {
        runnerCount: 8,
        capacity: { ok: false, reasons: ['at maxRunners 8'], loadPerCore: 0.5, maxRunners: 8 },
      })],
      repo: REPO, now: NOW,
    });
    assert.equal(out.chosen, null);
  });
});

describe('mergeHostSnapshots', () => {
  const runner = (name) => ({ name, repo: REPO, ghStatus: 'online', ghBusy: false });

  test('tags every runner with the host it came from', () => {
    const out = mergeHostSnapshots({
      hosts: [
        host('mac-1', { runners: [runner('mac-1-app-ios')] }),
        host('mac-2', { runners: [runner('mac-2-app-ios')] }),
      ],
      now: NOW,
    });
    assert.equal(out.runners.length, 2);
    assert.deepEqual(out.runners.map((r) => r.hostName).sort(), ['mac-1', 'mac-2']);
  });

  test('marks a stale host\'s runners rather than dropping them', () => {
    // Dropping them makes a partitioned host's runners appear to have been
    // removed, which is the most alarming possible way to render a network blip.
    const out = mergeHostSnapshots({
      hosts: [host('mac-1', {
        lastHeartbeat: NOW - 600_000,
        runners: [runner('mac-1-app-ios')],
      })],
      now: NOW,
    });
    assert.equal(out.runners.length, 1);
    assert.equal(out.runners[0].hostStale, true);
    assert.ok(out.runners[0].staleForMs > STALE_HEARTBEAT_MS);
    assert.equal(out.staleHosts, 1);
  });

  test('counts busy runners per host', () => {
    const out = mergeHostSnapshots({
      hosts: [host('mac-1', {
        runners: [runner('a'), { ...runner('b'), ghBusy: true }, { ...runner('c'), workingLocally: true }],
      })],
      now: NOW,
    });
    assert.equal(out.hosts[0].runnerCount, 3);
    assert.equal(out.hosts[0].busyCount, 2);
  });

  test('sorts hosts by name for a stable view', () => {
    const out = mergeHostSnapshots({
      hosts: [host('mac-z'), host('mac-a'), host('mac-m')], now: NOW,
    });
    assert.deepEqual(out.hosts.map((h) => h.name), ['mac-a', 'mac-m', 'mac-z']);
  });

  test('an empty federation is not an error', () => {
    const out = mergeHostSnapshots({ hosts: [], now: NOW });
    assert.deepEqual(out.runners, []);
    assert.equal(out.totalHosts, 0);
    assert.equal(out.staleHosts, 0);
  });

  test('a host with no runners still appears', () => {
    const out = mergeHostSnapshots({ hosts: [host('mac-1', { runners: [] })], now: NOW });
    assert.equal(out.hosts.length, 1);
    assert.equal(out.hosts[0].runnerCount, 0);
  });
});
