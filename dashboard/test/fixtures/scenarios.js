// Recorded and reconstructed fleet states, one per rung of the verdict ladder.
//
// `live` is a real /api/state snapshot from a 54-runner fleet (names scrubbed
// with scripts/scrub-snapshot.mjs). Every other scenario starts from it and
// changes only what the incident it reproduces changed, using the numbers that
// incident recorded — so a regression here is a regression against something
// that actually happened, not against a shape invented for the test.
//
// The same scenarios generate the cockpit's Swift fixtures
// (scripts/make-glance-fixtures.mjs), which is what keeps the two decoders of
// one contract from drifting apart.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIVE = JSON.parse(readFileSync(join(HERE, 'snapshots', 'live-2026-09-30.json'), 'utf8'));
export const LIVE_TS = LIVE.ts;
const MIN = 60 * 1000;

const clone = (o) => structuredClone(o);
const runner = (snap, suffix) => snap.runners.find((r) => r.name === `build-host-${suffix}`);
const fleetRunner = (snap, suffix) => snap.fleetRunners.find((r) => r.name === `build-host-${suffix}`);
const noFacts = () => ({ runnerLost: [], account: { blocked: 0, quota: 0, repos: [], lastAt: null } });

function withRunner(snap, suffix, patch) {
  Object.assign(runner(snap, suffix), patch);
  Object.assign(fleetRunner(snap, suffix), patch);
}

export const SCENARIOS = {
  // 2026-09-30 15:26Z as it was: two comet-web jobs, a quota failure 38 min
  // earlier, kernel pressure "warning". The fleet is fine; the account is not.
  live: () => ({
    snapshot: clone(LIVE),
    facts: {
      runnerLost: [],
      account: { blocked: 0, quota: 3, repos: ['acme/comet-web'], lastAt: Date.parse('2026-09-30T14:48:55Z') },
    },
    now: LIVE_TS,
    expect: 'account-blocked',
  }),

  // Nothing wrong and nothing to do.
  quiet: () => {
    const snapshot = clone(LIVE);
    snapshot.active = [];
    snapshot.queue = [];
    for (const r of [...snapshot.runners, ...snapshot.fleetRunners]) { r.ghBusy = false; r.workingLocally = false; }
    snapshot.alertState.open = [];
    return { snapshot, facts: noFacts(), now: LIVE_TS, expect: 'clear' };
  },

  // A queue is not a stall: one run waiting behind a busy sibling.
  waiting: () => {
    const snapshot = clone(LIVE);
    snapshot.queue = [{
      id: 1, repo: 'acme/ember-ios', project: 'ember', workflowName: 'ios-ci', labels: ['self-hosted', 'macOS'],
      queuedSinceMs: 9 * MIN, cause: 'repo-capacity', confidence: 'medium',
      evidence: ['all 4 matching runners are busy'], recommended: 'Wait, or add a runner.', actionEligible: true,
      etaStartMs: [4 * MIN, 11 * MIN], etaDoneMs: [26 * MIN, 41 * MIN], etaBasis: 'the job ahead on this repo\'s runner',
    }];
    return { snapshot, facts: noFacts(), now: LIVE_TS, expect: 'waiting' };
  },

  // RunnerService.js died; launchd keeps the job loaded with no process.
  dead: () => {
    const snapshot = clone(LIVE);
    withRunner(snapshot, 'ember-ios', { launchdState: 'dead', lastExit: 137, pid: null, ghStatus: 'offline', ghBusy: true });
    snapshot.drift = [{
      severity: 'critical', kind: 'launchd-dead', subject: 'build-host-ember-ios',
      detail: 'launchd job loaded but not running (last exit 137)',
      hint: 'no runner plist sets KeepAlive, so launchd will not revive it — health.sh --repair',
    }];
    snapshot.queue = [{
      id: 2, repo: 'acme/ember-ios', project: 'ember', workflowName: 'ios-ci', labels: ['self-hosted', 'macOS'],
      queuedSinceMs: 14 * MIN, cause: 'runner-down', confidence: 'high',
      evidence: ['build-host-ember-ios GitHub status: offline'], recommended: 'Run health.sh --repair.', actionEligible: false,
    }];
    return { snapshot, facts: noFacts(), now: LIVE_TS, expect: 'dead-service', runner: ['build-host-ember-ios', 'dead'] };
  },

  // 2026-09-29 ~01:40Z: 36.6 GB free against the 40 GB floor; every job sat at
  // "Set up runner" with busy=0 and no error anywhere.
  diskHold: () => {
    const snapshot = clone(LIVE);
    snapshot.host.diskFreeGb = 36.6;
    snapshot.hosts[0].host.diskFreeGb = 36.6;
    snapshot.active = [];
    for (const r of [...snapshot.runners, ...snapshot.fleetRunners]) { r.ghBusy = false; r.workingLocally = false; }
    const since = Math.floor(LIVE_TS / 1000) - 31 * 60;
    snapshot.admission.waiting = ['comet-web', 'comet-backend', 'ember-ios'].map((s, i) => ({
      runner: `build-host-${s}`, repo: `acme/${s}`, since: since + i * 240,
      reason: '36 GB disk free, below the 40 GB floor', busy: 0, limit: 2,
    }));
    return { snapshot, facts: noFacts(), now: LIVE_TS, floorGb: 40, expect: 'disk-floor', runner: ['build-host-comet-web', 'held-disk'] };
  },

  // Disk is under the floor and admission enforces it, but nothing has asked
  // to start yet. The next job will be held, so this is already the verdict.
  diskBelowIdle: () => {
    const s = SCENARIOS.diskHold();
    s.snapshot.admission.waiting = [];
    return { ...s, expect: 'disk-floor', runner: null };
  },

  // 2026-09-12: Spotlight indexing _work; runner-lost at 03:13 and 04:10 on
  // one repo while `uptime` said 3 days.
  saturated: () => {
    const snapshot = clone(LIVE);
    snapshot.host.load1 = 19.4;
    const at = (m) => LIVE_TS - m * MIN;
    return {
      snapshot,
      facts: {
        runnerLost: [
          { runner: 'build-host-comet-web', repo: 'acme/comet-web', at: at(5), url: null },
          { runner: 'build-host-comet-web-2', repo: 'acme/comet-web', at: at(62 - 5), url: null },
        ],
        account: { blocked: 0, quota: 0, repos: [], lastAt: null },
        recentFailures: [
          { runId: 901, repo: 'acme/comet-web', workflow: 'web-e2e', branch: 'main', url: 'https://github.com/acme/comet-web/actions/runs/901', cls: 'runner-lost', at: at(5), runner: 'build-host-comet-web' },
          { runId: 902, repo: 'acme/delta-web', workflow: 'web-ci', branch: 'fix-login', url: 'https://github.com/acme/delta-web/actions/runs/902', cls: 'job-failed', at: at(30), runner: 'build-host-delta-web' },
        ],
      },
      now: LIVE_TS,
      expect: 'saturated',
      runner: ['build-host-comet-web', 'lost'],
    };
  },

  // A billing block: jobs refused before they reach any runner.
  accountBlocked: () => ({
    snapshot: SCENARIOS.quiet().snapshot,
    facts: {
      runnerLost: [],
      account: { blocked: 87, quota: 0, repos: ['acme/ion', 'acme/watchtower'], lastAt: LIVE_TS - 40 * MIN },
    },
    now: LIVE_TS,
    expect: 'account-blocked',
  }),

  // A second runner with different extra labels: it will never match runs-on.
  drift: () => {
    const snapshot = SCENARIOS.quiet().snapshot;
    snapshot.drift = [{
      severity: 'serious', kind: 'label-mismatch', subject: 'acme/delta-web',
      detail: 'sibling runners of the same role carry different extra labels', hint: '',
    }];
    return { snapshot, facts: noFacts(), now: LIVE_TS, expect: 'config-drift', runner: ['build-host-delta-web', 'misconfigured'] };
  },

  // A federated agent stopped heartbeating. The coordinator can see that; it
  // cannot see its own absence, which is the cockpit's job.
  agentDown: () => {
    const snapshot = SCENARIOS.quiet().snapshot;
    snapshot.hosts.push({
      id: 'studio', name: 'studio', stale: true, lastHeartbeat: LIVE_TS - 9 * MIN, staleForMs: 9 * MIN,
      runnerCount: 1, busyCount: 0, capacity: {}, host: {}, repos: [], labels: [], drained: false, local: false,
    });
    snapshot.fleetRunners.push({
      name: 'studio-comet-web', repo: 'acme/comet-web', project: 'comet', registered: true,
      ghStatus: 'online', ghBusy: false, hostId: 'studio', hostName: 'studio', hostStale: true, staleForMs: 9 * MIN,
    });
    return { snapshot, facts: noFacts(), now: LIVE_TS, expect: 'host-down', runner: ['studio-comet-web', 'host-down'] };
  },

  // The collector could read nothing: everything else would be a guess.
  blind: () => {
    const snapshot = clone(LIVE);
    const polled = snapshot.repos.filter((r) => r.hasRunner || r.workflows > 0).length;
    snapshot.collector.lastError = `${polled} of ${polled} repos failed: fetch failed`;
    snapshot.collector.failedRepos = polled;
    return { snapshot, facts: noFacts(), now: LIVE_TS, expect: 'unknown' };
  },
};
