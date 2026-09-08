// The fixture fleet: a complete, plainly fictional runner fleet, as data.
//
// It exists so the dashboard screenshots in docs/img can be taken from the real
// front-end without a real fleet. `fleetd.js` builds its runner list from
// discoverRunnerDirs(), `launchctl list` and the GitHub API — none of which
// exist on a machine that is only building the documentation — so this file
// supplies the three inputs those produce and lets the real code do the rest.
//
// Nothing here is a measurement. Every repo is `testowner/…`, every host is
// `testhost`/`teststudio`, and the run history below is generated from a seeded
// PRNG. The numbers the Analytics tab derives from it are arithmetic over
// invented rows, and no figure from docs/design/ is reproduced or approximated.
//
// WHAT IS FIXTURE AND WHAT IS REAL
//
//   fixture — the runner directories, the GitHub API responses, `launchctl`
//             output, process table, host vitals, and the run/job history.
//   real    — everything derived from them. buildRunners, deriveDrift,
//             deriveGroups, headroom, sizeFleet, classifyQueueCause,
//             analytics, repoDetail, lintAll, adviseAll, compareScenarios,
//             buildBaseline/forecastDemand/evaluateGate, mergeHostSnapshots and
//             Alerts are imported and called. A hand-written snapshot stops
//             matching the code the first time somebody changes it; a generated
//             one fails loudly instead.
//
// The runner directories are written into a throwaway temp directory so that
// discoverRunnerDirs, runnerVersions, diagSummary and diagTail are exercised for
// real too. Nothing is ever written inside dashboard/.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildRunners, deriveDrift, shapeRun, shapeJob } from '../../dashboard/lib/state.js';
import { deriveGroups } from '../../dashboard/lib/groups.js';
import { discoverRunnerDirs, hostDrainState } from '../../dashboard/lib/local.js';
import { headroom } from '../../dashboard/lib/capacity.js';
import { sizeFleet, concurrencyByRepo, queueEffect } from '../../dashboard/lib/sizing.js';
import { classifyQueueCause } from '../../dashboard/lib/queue-cause.js';
import { lintAll } from '../../dashboard/lib/lint.js';

export const OWNER = 'testowner';

// Where the fixture fleet says its runners live. The directories are really in a
// temp directory — see materialiseFleetRoot — because diagSummary, diagTail and
// runnerVersions read from disk and driving the real ones is the point. But the
// path is a fact about this machine, not about the fleet, so what the UI shows
// is the fixture's own root and DIAG_DIRS keeps the mapping back.
export const DISPLAY_ROOT = '/Users/testowner/actions-runners';
export const DIAG_DIRS = new Map();
export const HOST = 'testhost';
export const REMOTE_HOST = 'teststudio';

const repo = (short) => `${OWNER}/${short}`;

// One clock for the whole fixture, so a snapshot and the history under it cannot
// disagree by however long the process took to start.
export const NOW = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const iso = (ms) => new Date(ms).toISOString();

// Deterministic, so two runs of the rig produce identical screenshots.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ runners

// version, drain and _diag are written to disk below and read back by the real
// lib/local.js, so the fields those produce are absent here on purpose.
const RUNNER_SPECS = [
  {
    dirName: 'app-ios', repo: 'app-ios', ghId: 4101, version: '2.337.0',
    extra: ['xcode16'], gh: { status: 'online', busy: true },
    launchd: { pid: 4211 }, listener: { pid: 4211, rssKb: 92 * 1024, etime: '6-02:14:51' },
    worker: { pid: 51233 }, workKb: 5_820_416,
  },
  {
    dirName: 'app-ios-2', repo: 'app-ios', ghId: 4102, version: '2.337.0',
    extra: ['xcode16'], gh: { status: 'online', busy: false },
    // An update is downloaded and waiting for a restart.
    staged: '2.340.0',
    launchd: { pid: 4219 }, listener: { pid: 4219, rssKb: 88 * 1024, etime: '6-02:14:49' },
    workKb: 5_112_320,
  },
  {
    dirName: 'app-web', repo: 'app-web', ghId: 4103, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: true },
    launchd: { pid: 4227 }, listener: { pid: 4227, rssKb: 74 * 1024, etime: '6-02:14:47' },
    worker: { pid: 61884 }, workKb: 2_204_672,
  },
  {
    dirName: 'app-backend', repo: 'app-backend', ghId: 4104, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: false },
    launchd: { pid: 4235 }, listener: { pid: 4235, rssKb: 71 * 1024, etime: '6-02:14:45' },
    workKb: 1_884_160,
  },
  {
    // The state the documentation keeps pointing at: launchd loaded the job,
    // the job exited, and no runner plist sets KeepAlive — so nothing revives
    // it, while GitHub still lists the runner as registered.
    dirName: 'app-backend-2', repo: 'app-backend', ghId: 4105, version: '2.340.0',
    extra: [], gh: { status: 'offline', busy: false },
    launchd: { pid: null, lastExit: 78 },
    diagErrors: true, workKb: 1_640_448,
  },
  {
    dirName: 'site-backend', repo: 'site-backend', ghId: 4106, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: false },
    launchd: { pid: 4243 }, listener: { pid: 4243, rssKb: 69 * 1024, etime: '6-02:14:43' },
    workKb: 1_212_416,
  },
  {
    dirName: 'site-frontend', repo: 'site-frontend', ghId: 4107, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: false },
    launchd: { pid: 4251 }, listener: { pid: 4251, rssKb: 70 * 1024, etime: '6-02:14:41' },
    workKb: 1_398_784,
  },
  {
    // Stopped deliberately. Drain is not drift, and health.sh --repair skips it.
    dirName: 'site-frontend-2', repo: 'site-frontend', ghId: 4108, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: false },
    drain: 'drained', workKb: 1_361_920,
  },
  {
    dirName: 'tools-cli', repo: 'tools-cli', ghId: 4109, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: false },
    launchd: { pid: 4259 }, listener: { pid: 4259, rssKb: 66 * 1024, etime: '6-02:14:39' },
    workKb: 706_560,
  },
  {
    dirName: 'tools-notify', repo: 'tools-notify', ghId: 4110, version: '2.337.0',
    extra: [], gh: { status: 'online', busy: false },
    launchd: { pid: 4267 }, listener: { pid: 4267, rssKb: 65 * 1024, etime: '6-02:14:37' },
    workKb: 512_000,
  },
];

const runnerName = (dirName) => `${HOST}-${dirName}`;

// Runners GitHub knows about that have no directory on this host: one on the
// second Mac, and one ephemeral runner living under .ephemeral where disk
// discovery deliberately does not look.
const ELSEWHERE_SPECS = [
  { name: `${REMOTE_HOST}-site-backend`, repo: 'site-backend', ghId: 4301, status: 'online', busy: false, extra: [] },
  { name: `${HOST}-app-web-eph-20260908-041500-1`, repo: 'app-web', ghId: 4302, status: 'online', busy: false, extra: [] },
];

const BASE_LABELS = ['self-hosted', 'macOS', 'ARM64'];
const ghLabels = (extra) => [...BASE_LABELS, ...extra].map((name) => ({ name }));

// ------------------------------------------------------------- workflow YAML

const IOS_CI = (timeout) => `name: iOS CI
on:
  push:
    branches: [main]
  pull_request:
concurrency:
  group: ios-ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: [self-hosted, macos, arm64, xcode16]
${timeout ? '    timeout-minutes: 45\n' : ''}    strategy:
      matrix:
        scheme: [App, AppTests, AppUITests]
        config: [debug, release]
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild build -scheme \${{ matrix.scheme }}
  test:
    runs-on: [self-hosted, macos, arm64, xcode16]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild test
`;

export const WORKFLOW_FILES = [
  {
    repo: repo('app-ios'), path: '.github/workflows/ci.yml', ref: '__default__',
    name: 'iOS CI', content: IOS_CI(true), is_default: 1,
  },
  {
    // The same file, one branch behind: the timeout is already on main. This is
    // the case the lint's ref note exists for.
    repo: repo('app-ios'), path: '.github/workflows/ci.yml', ref: 'develop',
    name: 'iOS CI', content: IOS_CI(false), is_default: 0,
  },
  {
    repo: repo('app-ios'), path: '.github/workflows/nightly.yml', ref: '__default__',
    name: 'Nightly Archive', is_default: 1,
    content: `name: Nightly Archive
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  archive:
    runs-on: [self-hosted, macos, arm64, xcode16]
    timeout-minutes: 90
    steps:
      - run: ./scripts/archive.sh
`,
  },
  {
    repo: repo('app-web'), path: '.github/workflows/ci.yml', ref: '__default__',
    name: 'Web CI', is_default: 1,
    content: `name: Web CI
on: [push, pull_request]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
  e2e:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - run: npm run test:e2e
`,
  },
  {
    repo: repo('app-backend'), path: '.github/workflows/ci.yml', ref: '__default__',
    name: 'Backend CI', is_default: 1,
    content: `name: Backend CI
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 25
    steps:
      - run: make build
  integration:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 40
    steps:
      - run: make integration
`,
  },
  {
    repo: repo('site-backend'), path: '.github/workflows/ci.yml', ref: '__default__',
    name: 'Site API', is_default: 1,
    content: `name: Site API
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - run: make test
  package-smoke:
    runs-on: macos-15
    timeout-minutes: 15
    steps:
      - run: ./scripts/smoke.sh
`,
  },
  {
    repo: repo('site-frontend'), path: '.github/workflows/ci.yml', ref: '__default__',
    name: 'Site Build', is_default: 1,
    content: `name: Site Build
on: [push, pull_request]
concurrency:
  group: site-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 15
    steps:
      - run: npm ci && npm run build
  lint:
    runs-on: [self-hosted, macos, arm64]
    steps:
      - run: npm run lint
`,
  },
  {
    repo: repo('tools-cli'), path: '.github/workflows/release.yml', ref: '__default__',
    name: 'CLI Release', is_default: 1,
    content: `name: CLI Release
on:
  push:
    tags: ['v*']
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - run: make release
`,
  },
  {
    repo: repo('tools-notify'), path: '.github/workflows/release.yml', ref: '__default__',
    name: 'Notify Release', is_default: 1,
    content: `name: Notify Release
on: [push]
jobs:
  package:
    runs-on: [self-hosted, macos, arm64, notarize]
    timeout-minutes: 30
    steps:
      - run: ./scripts/notarize.sh
`,
  },
  {
    repo: repo('site-docs'), path: '.github/workflows/deploy.yml', ref: '__default__',
    name: 'Docs Deploy', is_default: 1,
    content: `name: Docs Deploy
on: [push]
jobs:
  deploy:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    steps:
      - run: ./scripts/deploy-docs.sh
`,
  },
];

// ------------------------------------------------------------- repo roster

export const REPO_ROSTER = [
  { short: 'app-ios', workflows: 2, private: true, pushedAt: NOW - 2 * HOUR },
  { short: 'app-web', workflows: 1, private: true, pushedAt: NOW - 40 * MIN },
  { short: 'app-backend', workflows: 1, private: true, pushedAt: NOW - 5 * HOUR },
  { short: 'site-backend', workflows: 1, private: false, pushedAt: NOW - 9 * HOUR },
  { short: 'site-frontend', workflows: 1, private: false, pushedAt: NOW - 26 * HOUR },
  { short: 'tools-cli', workflows: 1, private: false, pushedAt: NOW - 3 * DAY },
  { short: 'tools-notify', workflows: 1, private: false, pushedAt: NOW - 6 * DAY },
  // Has workflows and no runner here — the "unserved" row on the Fleet tab and
  // the `unserved` finding on the Lint tab.
  { short: 'site-docs', workflows: 1, private: false, pushedAt: NOW - 11 * DAY },
].map((r) => ({
  fullName: repo(r.short),
  name: r.short,
  archived: false,
  private: r.private,
  pushedAt: iso(r.pushedAt),
  workflows: r.workflows,
  hasRunner: RUNNER_SPECS.some((s) => s.repo === r.short),
  defaultBranch: 'main',
  project: 'other', // re-stamped once the groups are derived
}));

// ------------------------------------------------------------- host vitals

export const HOST_VITALS = {
  hostname: HOST,
  cores: 12,
  platform: 'macOS 26.0',
  darwin: '25.0.0',
  uptimeSec: 6 * 86400 + 2 * 3600 + 15 * 60,
  load1: 3.42,
  load5: 2.87,
  load15: 2.31,
  memUsedMb: 21_504,
  memTotalMb: 65_536,
  swapUsedMb: 3_072,
  swapTotalMb: 8_192,
  memCompressedMb: 2_048,
  memPressure: 'normal',
  memFreePct: 61,
  swapins: 184_320,
  swapouts: 92_160,
  swapinsPerSec: 0,
  swapoutsPerSec: 0,
  diskFreeGb: 412.6,
  diskTotalGb: 1_863.0,
};

// The second Mac. Deliberately stale: its last heartbeat is older than
// STALE_HEARTBEAT_MS, which is the state the Hosts tab is built to make obvious.
export const REMOTE_HOST_REPORT = {
  id: REMOTE_HOST,
  name: `${REMOTE_HOST} (mac studio)`,
  lastHeartbeat: NOW - 6 * MIN,
  labels: ['studio', 'm2-ultra'],
  version: 3,
  drained: false,
  repos: [repo('site-backend')],
  host: {
    hostname: REMOTE_HOST,
    cores: 24,
    platform: 'macOS 26.0',
    load1: 1.18,
    memFreePct: 78,
    memPressure: 'normal',
    diskFreeGb: 902.4,
    diskTotalGb: 3_726.0,
  },
  capacity: { ok: true, busy: 0, ceiling: 3, maxTotalRunners: 32, reasons: [] },
  runners: [
    {
      name: `${REMOTE_HOST}-site-backend`, repo: repo('site-backend'), project: 'site',
      launchdState: 'running', registered: true, ghStatus: 'online', ghBusy: false,
      workingLocally: false, pid: 8801, rssMb: 72,
      labels: [...BASE_LABELS], extraLabels: [], drainState: null, instance: 1,
    },
  ],
};

// Job admission comes from hooks/job-started.sh writing an NDJSON log inside a
// running job. There is no such log here, so the summary is stated directly —
// this is the one panel with no code of its own to drive.
export const ADMISSION = {
  mode: 'observe',
  limit: 3,
  lastDecisionAt: NOW - 11 * MIN,
  ownerKind: 'worker',
  hooks: { installed: 10, total: 10, checkedAt: NOW - 4 * MIN },
  last24h: { admitted: 46, observed: 0, 'would-hold': 7, held: 0, timeout: 0, released: 46 },
  heldSeconds: 0,
  waiting: [],
};

// ---------------------------------------------------------- the temp fleet

const DIAG_CLEAN = `[2026-09-08 05:41:02Z INFO Listener] Runner listener is running.
[2026-09-08 05:41:02Z INFO Listener] Connecting to the server.
[2026-09-08 05:41:03Z INFO Listener] Session created.
[2026-09-08 06:12:44Z INFO JobDispatcher] Job request 88213 accepted.
[2026-09-08 06:28:10Z INFO JobDispatcher] Job request 88213 finished with result: Succeeded.
[2026-09-08 07:02:19Z INFO Listener] Waiting for job request.
`;

const DIAG_DEAD = `[2026-09-08 04:55:11Z INFO Listener] Runner listener is running.
[2026-09-08 04:55:12Z INFO Listener] Session created.
[2026-09-08 05:31:48Z WARN Listener] Message queue listen failed. Retry in 30 seconds.
[2026-09-08 05:32:19Z WARN Listener] Message queue listen failed. Retry in 60 seconds.
[2026-09-08 05:33:20Z ERR  Listener] Unable to connect to the server after 3 attempts.
[2026-09-08 05:33:20Z ERR  Terminal] WRITE ERROR: Runner listener exited with error code 78.
[2026-09-08 05:33:20Z INFO Listener] Runner listener exiting.
`;

/**
 * Write the fixture runner directories to a throwaway temp root, so that
 * discoverRunnerDirs, runnerVersions, diagSummary and diagTail all run for real.
 *
 * @returns {{ root: string, cleanup: () => void }}
 */
export function materialiseFleetRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fixture-fleet-'));

  // versionReport() reads the pinned version straight out of register.sh rather
  // than duplicating it, so the fleet root needs one.
  writeFileSync(join(root, 'register.sh'), '#!/usr/bin/env bash\nVERSION="2.337.0"\n');

  for (const spec of RUNNER_SPECS) {
    const dir = join(root, spec.dirName);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, '.runner'), JSON.stringify({
      agentId: spec.ghId,
      agentName: runnerName(spec.dirName),
      poolId: 1,
      poolName: 'Default',
      serverUrl: 'https://pipelines.actions.githubusercontent.com/',
      gitHubUrl: `https://github.com/${repo(spec.repo)}`,
      workFolder: '_work',
    }, null, 2));
    writeFileSync(join(dir, 'bin', 'runner.version'), `${spec.version}\n`);
    if (spec.staged) mkdirSync(join(dir, `bin.${spec.staged}`), { recursive: true });
    if (spec.drain) writeFileSync(join(dir, '.drain'), `${spec.drain}\nfixture fleet\n`);

    mkdirSync(join(dir, '_diag'), { recursive: true });
    writeFileSync(
      join(dir, '_diag', 'Runner_20260908-054102-utc.log'),
      spec.diagErrors ? DIAG_DEAD : DIAG_CLEAN
    );
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// -------------------------------------------------------- collector inputs

/** The three things fleetd asks the machine and GitHub for, as fixture data. */
export function collectorInputs() {
  const ghRunnersByRepo = new Map();
  const push = (r, entry) => {
    const key = repo(r);
    if (!ghRunnersByRepo.has(key)) ghRunnersByRepo.set(key, []);
    ghRunnersByRepo.get(key).push(entry);
  };

  for (const spec of RUNNER_SPECS) {
    push(spec.repo, {
      id: spec.ghId,
      name: runnerName(spec.dirName),
      os: 'macOS',
      status: spec.gh.status,
      busy: spec.gh.busy,
      labels: ghLabels(spec.extra),
    });
  }
  for (const e of ELSEWHERE_SPECS) {
    push(e.repo, { id: e.ghId, name: e.name, os: 'macOS', status: e.status, busy: e.busy, labels: ghLabels(e.extra) });
  }

  const launchd = new Map();
  const listeners = new Map();
  const workers = new Map();

  return {
    ghRunnersByRepo,
    // `dirs` come from the real discoverRunnerDirs, so these two are keyed off
    // whatever it produced rather than off a second copy of the same names.
    attach(dirs) {
      for (const d of dirs) {
        const spec = RUNNER_SPECS.find((s) => s.dirName === d.dirName);
        if (!spec) continue;
        if (spec.launchd) launchd.set(d.launchdLabel, { pid: spec.launchd.pid, lastExit: spec.launchd.lastExit ?? 0 });
        if (spec.listener) listeners.set(d.dir, { ...spec.listener });
        if (spec.worker) workers.set(d.dir, { ...spec.worker });
      }
      return { launchd, processes: { listeners, workers } };
    },
    runnersKnownFor: new Set(RUNNER_SPECS.map((s) => repo(s.repo))),
  };
}

// ------------------------------------------------------------- run history

// One entry per workflow that produces history. `runsPerDay` is the mean; the
// generator jitters it. Durations are in milliseconds and are entirely invented.
const HISTORY = [
  {
    repo: 'app-ios', workflowId: 6101, workflow: 'iOS CI', path: '.github/workflows/ci.yml',
    runsPerDay: 3.2, events: ['push', 'pull_request'],
    jobs: [
      { name: 'build', base: 11 * MIN, jitter: 5 * MIN, steps: [
        ['Set up job', 4_000], ['Checkout', 22_000], ['Restore build cache', 38_000, 'bimodal'],
        ['Resolve packages', 51_000], ['xcodebuild build', 8 * MIN], ['Save build cache', 44_000],
      ] },
      { name: 'test', base: 9 * MIN, jitter: 4 * MIN, steps: [
        ['Set up job', 4_000], ['Checkout', 21_000], ['Boot simulator', 63_000],
        ['xcodebuild test', 6 * MIN], ['Upload results', 26_000],
      ] },
    ],
  },
  {
    repo: 'app-ios', workflowId: 6102, workflow: 'Nightly Archive', path: '.github/workflows/nightly.yml',
    runsPerDay: 1, events: ['schedule'], atHour: 3,
    jobs: [
      { name: 'archive', base: 27 * MIN, jitter: 6 * MIN, steps: [
        ['Set up job', 4_000], ['Checkout', 24_000], ['Archive', 19 * MIN], ['Export IPA', 5 * MIN],
      ] },
    ],
  },
  {
    repo: 'app-web', workflowId: 6103, workflow: 'Web CI', path: '.github/workflows/ci.yml',
    runsPerDay: 3.4, events: ['push', 'pull_request'],
    jobs: [
      { name: 'build', base: 6 * MIN, jitter: 3 * MIN, steps: [
        ['Set up job', 3_000], ['Checkout', 14_000], ['npm ci', 71_000, 'bimodal'],
        ['npm run build', 3 * MIN], ['Upload artefact', 18_000],
      ] },
      { name: 'e2e', base: 8 * MIN, jitter: 4 * MIN, steps: [
        ['Set up job', 3_000], ['Checkout', 14_000], ['npm ci', 68_000],
        ['npm run test:e2e', 6 * MIN],
      ] },
    ],
  },
  {
    repo: 'app-backend', workflowId: 6104, workflow: 'Backend CI', path: '.github/workflows/ci.yml',
    runsPerDay: 2.4, events: ['push'],
    jobs: [
      { name: 'build', base: 7 * MIN, jitter: 2 * MIN, steps: [
        ['Set up job', 3_000], ['Checkout', 15_000], ['make build', 5 * MIN], ['Package', 42_000],
      ] },
      { name: 'integration', base: 13 * MIN, jitter: 5 * MIN, steps: [
        ['Set up job', 3_000], ['Checkout', 15_000], ['Start services', 48_000],
        ['make integration', 10 * MIN], ['Collect logs', 21_000],
      ] },
    ],
  },
  {
    repo: 'site-backend', workflowId: 6105, workflow: 'Site API', path: '.github/workflows/ci.yml',
    runsPerDay: 1.6, events: ['push'],
    jobs: [
      { name: 'build', base: 5 * MIN, jitter: 2 * MIN, steps: [
        ['Set up job', 3_000], ['Checkout', 13_000], ['make test', 4 * MIN],
      ] },
    ],
  },
  {
    repo: 'site-frontend', workflowId: 6106, workflow: 'Site Build', path: '.github/workflows/ci.yml',
    runsPerDay: 2.2, events: ['push', 'pull_request'],
    jobs: [
      { name: 'build', base: 4 * MIN, jitter: 90_000, steps: [
        ['Set up job', 3_000], ['Checkout', 12_000], ['npm ci', 58_000], ['npm run build', 2 * MIN],
      ] },
      { name: 'lint', base: 96_000, jitter: 30_000, steps: [
        ['Set up job', 3_000], ['Checkout', 12_000], ['npm run lint', 70_000],
      ] },
    ],
  },
  {
    repo: 'tools-cli', workflowId: 6107, workflow: 'CLI Release', path: '.github/workflows/release.yml',
    runsPerDay: 0.9, events: ['push'],
    jobs: [
      { name: 'build', base: 3 * MIN, jitter: 60_000, steps: [
        ['Set up job', 3_000], ['Checkout', 11_000], ['make release', 2 * MIN],
      ] },
    ],
  },
  {
    repo: 'tools-notify', workflowId: 6108, workflow: 'Notify Release', path: '.github/workflows/release.yml',
    runsPerDay: 0.6, events: ['push'],
    jobs: [
      { name: 'package', base: 2 * MIN, jitter: 40_000, steps: [
        ['Set up job', 3_000], ['Checkout', 10_000], ['Notarize', 95_000],
      ] },
    ],
  },
];

const BRANCHES = ['main', 'main', 'main', 'develop', 'feature/pipeline-cache', 'feature/settings-panel'];
const ACTORS = ['testowner', 'test-bot[bot]', 'testdev'];
const COMMITS = [
  'Cache the resolved package graph between runs',
  'Split the integration suite into two jobs',
  'Pin the toolchain in the release workflow',
  'Drop the unused notification target',
  'Tidy the build script and its comments',
  'Reduce the simulator boot timeout',
  'Rename the staging environment variable',
];

// Which runner claimed a job. Two runners for a repo alternate; the runner that
// died two days ago and the one that was drained yesterday stop appearing at the
// point they stopped working, which is what makes the drawer's 7-day
// utilisation and the Analytics workload chart tell the same story as the
// Fleet tab.
const DIED_AT = NOW - 2 * DAY;
const DRAINED_AT = NOW - 1 * DAY;

function runnersFor(short) {
  return RUNNER_SPECS.filter((s) => s.repo === short).map((s) => ({
    name: runnerName(s.dirName), id: s.ghId, dirName: s.dirName,
  }));
}

function pickRunner(short, at, n) {
  const pool = runnersFor(short);
  if (!pool.length) return null;
  let choice = pool[n % pool.length];
  if (choice.dirName === 'app-backend-2' && at >= DIED_AT) choice = pool[0];
  if (choice.dirName === 'site-frontend-2' && at >= DRAINED_AT) choice = pool[0];
  return choice;
}

const HISTORY_DAYS = 30;

/**
 * Generate the run and job history, in the shapes the GitHub API returns, so
 * shapeRun()/shapeJob() can do the conversion rather than this file guessing at
 * their output.
 */
function generateHistory() {
  const rnd = mulberry32(0x5eed1e);
  const runs = [];
  const jobs = [];
  const steps = [];

  let runId = 900_000_000;
  let jobId = 800_000_000;
  const runNumbers = new Map();
  let seq = 0;

  const sha = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

  // One occurrence, which may be a cluster of runs. Pushes arrive in bursts —
  // a branch updated three times inside five minutes is the ordinary way a repo
  // with one runner ends up with a queue, and without it the scenario replay has
  // no contention to replay.
  const emit = (spec, occurrenceAt) => {
    const burst = spec.atHour != null ? 1 : rnd() < 0.13 ? 2 : 1;

    for (let k = 0; k < burst; k++) {
      seq++;
      const createdAt = occurrenceAt + k * (110_000 + Math.floor(rnd() * 200_000));
      if (createdAt > NOW - 20 * MIN) continue;

      // Most jobs start within seconds. A job behind a sibling in the same burst
      // waits for the runner, which is where the queue percentiles come from.
      const queuedMs = k > 0
        ? Math.floor(40_000 + rnd() * 190_000)
        : rnd() < 0.12 ? Math.floor(20_000 + rnd() * 120_000) : Math.floor(2_000 + rnd() * 9_000);
      const startedAt = createdAt + queuedMs;

      const roll = rnd();
      const conclusion = roll < 0.085 ? 'failure' : roll < 0.10 ? 'cancelled' : 'success';

      const id = ++runId;
      const number = (runNumbers.get(spec.workflow) ?? 0) + 1;
      runNumbers.set(spec.workflow, number);
      const branch = BRANCHES[Math.floor(rnd() * BRANCHES.length)];
      const headSha = sha();
      const message = COMMITS[Math.floor(rnd() * COMMITS.length)];
      const event = spec.events[Math.floor(rnd() * spec.events.length)];

      const jobRows = [];
      let runEnd = startedAt;
      let n = 0;
      for (const j of spec.jobs) {
        n++;
        const dur = Math.max(20_000, Math.floor(j.base + (rnd() - 0.5) * 2 * j.jitter));
        const claimed = pickRunner(spec.repo, startedAt, seq + n);
        const jobStart = startedAt + (n === 1 ? 0 : Math.floor(rnd() * 12_000));
        const jobEnd = jobStart + dur;
        runEnd = Math.max(runEnd, jobEnd);
        const jobConclusion = conclusion === 'cancelled'
          ? 'cancelled'
          : conclusion === 'failure' && n === spec.jobs.length ? 'failure' : 'success';
        const jid = ++jobId;
        jobRows.push({
          id: jid,
          run_id: id,
          name: j.name,
          status: 'completed',
          conclusion: jobConclusion,
          created_at: iso(createdAt),
          started_at: iso(jobStart),
          completed_at: iso(jobEnd),
          runner_name: claimed?.name ?? '',
          runner_id: claimed?.id ?? 0,
          labels: ['self-hosted', 'macOS', 'ARM64'],
          html_url: `https://github.com/${repo(spec.repo)}/actions/runs/${id}/job/${jid}`,
          // A failure this fleet caused versus one the code caused, so the
          // "Why jobs failed" table has more than one row in it.
          failure_class: jobConclusion !== 'failure'
            ? null
            : rnd() < 0.18 ? 'runner-lost' : rnd() < 0.08 ? 'account-blocked' : 'job-failed',
          _steps: j.steps,
          _start: jobStart,
        });
      }

      runs.push({
        repo: repo(spec.repo),
        api: {
          id,
          workflow_id: spec.workflowId,
          name: spec.workflow,
          path: spec.path,
          run_number: number,
          run_attempt: 1,
          event,
          status: 'completed',
          conclusion,
          head_branch: branch,
          head_sha: headSha,
          created_at: iso(createdAt),
          run_started_at: iso(startedAt),
          updated_at: iso(runEnd),
          html_url: `https://github.com/${repo(spec.repo)}/actions/runs/${id}`,
          display_title: message,
          actor: { login: ACTORS[Math.floor(rnd() * ACTORS.length)] },
          head_commit: { message },
          pull_requests: event === 'pull_request' ? [{ number: 100 + (seq % 90) }] : [],
        },
      });

      for (const jr of jobRows) {
        jobs.push({ repo: repo(spec.repo), api: jr });
        let at = jr._start;
        let sn = 0;
        for (const [name, base, mode] of jr._steps) {
          sn++;
          // A cache step that misses some of the time: the p95-far-above-p50
          // shape the Analytics tab calls out.
          const factor = mode === 'bimodal' && rnd() < 0.22 ? 4.5 : 1;
          const stepDur = Math.max(1_000, Math.floor(base * factor * (0.8 + rnd() * 0.4)));
          steps.push({
            job_id: jr.id, number: sn, name,
            status: 'completed', conclusion: jr.conclusion === 'cancelled' ? 'cancelled' : 'success',
            started_at: iso(at), completed_at: iso(at + stepDur), duration_ms: stepDur,
          });
          at += stepDur;
        }
        delete jr._steps;
        delete jr._start;
      }
    }
  };

  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const dayStart = NOW - d * DAY;
    for (const spec of HISTORY) {
      const occurrences = spec.atHour != null
        ? 1
        : Math.max(0, Math.round(spec.runsPerDay + (rnd() - 0.5) * 2));
      for (let i = 0; i < occurrences; i++) {
        // Spread across the working day and a little either side, so whatever
        // hour the rig happens to run at, the forecast has buckets to match.
        const hour = spec.atHour ?? 7 + Math.floor(rnd() * 15);
        emit(spec, dayStart + hour * HOUR + Math.floor(rnd() * 55) * MIN);
      }
    }
  }

  // A re-run of a commit that was red and then green with nothing changed. The
  // whole point of the Flaky panel, so it is placed rather than left to chance.
  const flakySeeds = [
    { spec: HISTORY[0], daysAgo: 4, branch: 'develop' },
    { spec: HISTORY[3], daysAgo: 9, branch: 'main' },
  ];
  for (const seed of flakySeeds) {
    const headSha = sha();
    const message = 'Retry the flaky integration assertion';
    for (const [attempt, conclusion] of [[1, 'failure'], [2, 'success']]) {
      seq++;
      const id = ++runId;
      const createdAt = NOW - seed.daysAgo * DAY + attempt * 22 * MIN;
      const startedAt = createdAt + 6_000;
      const number = (runNumbers.get(seed.spec.workflow) ?? 0) + 1;
      runNumbers.set(seed.spec.workflow, number);
      const j = seed.spec.jobs[seed.spec.jobs.length - 1];
      const dur = j.base;
      const jid = ++jobId;
      const claimed = pickRunner(seed.spec.repo, startedAt, seq);
      runs.push({
        repo: repo(seed.spec.repo),
        api: {
          id, workflow_id: seed.spec.workflowId, name: seed.spec.workflow, path: seed.spec.path,
          run_number: number, run_attempt: attempt, event: 'push', status: 'completed',
          conclusion, head_branch: seed.branch, head_sha: headSha,
          created_at: iso(createdAt), run_started_at: iso(startedAt), updated_at: iso(startedAt + dur),
          html_url: `https://github.com/${repo(seed.spec.repo)}/actions/runs/${id}`,
          display_title: message, actor: { login: 'testdev' },
          head_commit: { message }, pull_requests: [],
        },
      });
      jobs.push({
        repo: repo(seed.spec.repo),
        api: {
          id: jid, run_id: id, name: j.name, status: 'completed', conclusion,
          created_at: iso(createdAt), started_at: iso(startedAt), completed_at: iso(startedAt + dur),
          runner_name: claimed?.name ?? '', runner_id: claimed?.id ?? 0,
          labels: ['self-hosted', 'macOS', 'ARM64'],
          html_url: `https://github.com/${repo(seed.spec.repo)}/actions/runs/${id}/job/${jid}`,
          failure_class: conclusion === 'failure' ? 'job-failed' : null,
        },
      });
    }
  }

  // Runs that queued until GitHub killed them: the shape a `runs-on:` label no
  // live runner carries produces. tools-notify asks for `notarize`, which is
  // exactly the mismatch its queued run is diagnosed with right now.
  for (const daysAgo of [3, 8, 15]) {
    const id = ++runId;
    const createdAt = NOW - daysAgo * DAY;
    const number = (runNumbers.get('Notify Release') ?? 0) + 1;
    runNumbers.set('Notify Release', number);
    runs.push({
      repo: repo('tools-notify'),
      api: {
        id, workflow_id: 6108, name: 'Notify Release', path: '.github/workflows/release.yml',
        run_number: number, run_attempt: 1, event: 'push', status: 'completed',
        conclusion: 'cancelled', head_branch: 'main', head_sha: sha(),
        created_at: iso(createdAt), run_started_at: iso(createdAt),
        updated_at: iso(createdAt + 24 * HOUR),
        html_url: `https://github.com/${repo('tools-notify')}/actions/runs/${id}`,
        display_title: 'Ship the notarised build', actor: { login: 'testowner' },
        head_commit: { message: 'Ship the notarised build' }, pull_requests: [],
      },
    });
  }

  return { runs, jobs, steps };
}

// ----------------------------------------------------------- live activity

/** The runs that are in flight right now, in GitHub API shape. */
function liveRuns() {
  const mk = (o) => ({
    workflow_id: o.workflowId, name: o.workflow, path: o.path, run_number: o.number,
    run_attempt: 1, event: o.event, status: o.status, conclusion: null,
    head_branch: o.branch, head_sha: o.sha, created_at: iso(o.created),
    run_started_at: iso(o.started ?? o.created), updated_at: iso(NOW),
    html_url: `https://github.com/${o.repo}/actions/runs/${o.id}`,
    display_title: o.title, actor: { login: o.actor ?? 'testdev' },
    head_commit: { message: o.title }, pull_requests: o.pr ? [{ number: o.pr }] : [],
    id: o.id,
  });

  return [
    {
      repo: repo('app-ios'),
      api: mk({
        id: 900_900_001, repo: repo('app-ios'), workflowId: 6101, workflow: 'iOS CI',
        path: '.github/workflows/ci.yml', number: 2181, event: 'pull_request', status: 'in_progress',
        branch: 'feature/pipeline-cache', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        created: NOW - 7 * MIN, started: NOW - 7 * MIN, title: 'Cache the resolved package graph between runs',
        pr: 184,
      }),
      jobs: [{
        id: 809_900_001, run_id: 900_900_001, name: 'build', status: 'in_progress', conclusion: null,
        created_at: iso(NOW - 7 * MIN), started_at: iso(NOW - 6 * MIN), completed_at: null,
        runner_name: `${HOST}-app-ios`, runner_id: 4101,
        labels: ['self-hosted', 'macOS', 'ARM64', 'xcode16'],
        html_url: `https://github.com/${repo('app-ios')}/actions/runs/900900001/job/809900001`,
      }],
    },
    {
      repo: repo('app-web'),
      api: mk({
        id: 900_900_002, repo: repo('app-web'), workflowId: 6103, workflow: 'Web CI',
        path: '.github/workflows/ci.yml', number: 3410, event: 'push', status: 'in_progress',
        branch: 'main', sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
        created: NOW - 4 * MIN, started: NOW - 4 * MIN, title: 'Tidy the build script and its comments',
      }),
      jobs: [{
        id: 809_900_002, run_id: 900_900_002, name: 'build', status: 'in_progress', conclusion: null,
        created_at: iso(NOW - 4 * MIN), started_at: iso(NOW - 4 * MIN), completed_at: null,
        runner_name: `${HOST}-app-web`, runner_id: 4103,
        labels: ['self-hosted', 'macOS', 'ARM64'],
        html_url: `https://github.com/${repo('app-web')}/actions/runs/900900002/job/809900002`,
      }],
    },
    {
      // Every runner this repo has is executing a job, and the host has room for
      // another: the one diagnosis that offers to add a runner.
      repo: repo('app-web'),
      api: mk({
        id: 900_900_003, repo: repo('app-web'), workflowId: 6103, workflow: 'Web CI',
        path: '.github/workflows/ci.yml', number: 3411, event: 'pull_request', status: 'queued',
        branch: 'feature/settings-panel', sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
        created: NOW - 14 * MIN, title: 'Rename the staging environment variable', pr: 211,
      }),
      jobs: [{
        id: 809_900_003, run_id: 900_900_003, name: 'build', status: 'queued', conclusion: null,
        created_at: iso(NOW - 14 * MIN), started_at: null, completed_at: null,
        runner_name: '', runner_id: 0, labels: ['self-hosted', 'macOS', 'ARM64'],
        html_url: `https://github.com/${repo('app-web')}/actions/runs/900900003/job/809900003`,
      }],
    },
    {
      // Asks for a label no runner carries. A second runner would share the
      // mismatch, so no button is offered for this one.
      repo: repo('tools-notify'),
      api: mk({
        id: 900_900_004, repo: repo('tools-notify'), workflowId: 6108, workflow: 'Notify Release',
        path: '.github/workflows/release.yml', number: 142, event: 'push', status: 'queued',
        branch: 'main', sha: 'd4e5f60718293a4b5c6d7e8f9012345678901234',
        created: NOW - 23 * MIN, title: 'Ship the notarised build', actor: 'testowner',
      }),
      jobs: [{
        id: 809_900_004, run_id: 900_900_004, name: 'package', status: 'queued', conclusion: null,
        created_at: iso(NOW - 23 * MIN), started_at: null, completed_at: null,
        runner_name: '', runner_id: 0, labels: ['self-hosted', 'macOS', 'ARM64', 'notarize'],
        html_url: `https://github.com/${repo('tools-notify')}/actions/runs/900900004/job/809900004`,
      }],
    },
    {
      // Queued for seconds, which is ordinary dispatch latency and not drift.
      repo: repo('site-frontend'),
      api: mk({
        id: 900_900_005, repo: repo('site-frontend'), workflowId: 6106, workflow: 'Site Build',
        path: '.github/workflows/ci.yml', number: 1877, event: 'push', status: 'queued',
        branch: 'main', sha: 'e5f60718293a4b5c6d7e8f901234567890123456',
        created: NOW - 40_000, title: 'Drop the unused notification target',
      }),
      jobs: [{
        id: 809_900_005, run_id: 900_900_005, name: 'build', status: 'queued', conclusion: null,
        created_at: iso(NOW - 40_000), started_at: null, completed_at: null,
        runner_name: '', runner_id: 0, labels: ['self-hosted', 'macOS', 'ARM64'],
        html_url: `https://github.com/${repo('site-frontend')}/actions/runs/900900005/job/809900005`,
      }],
    },
  ];
}

// ------------------------------------------------------------------- alerts

export const ALERT_ROWS = [
  {
    key: `runner-down:${HOST}-app-backend-2`, rule: 'runner-down', severity: 'critical',
    title: `${HOST}-app-backend-2 is not running`,
    body: 'launchd loaded the job and it exited with code 78. No runner plist sets KeepAlive, so it '
      + 'will not come back on its own.',
    opened_at: NOW - 2 * DAY + 41 * MIN, closed_at: null, notified: 1,
  },
  {
    key: 'queue-stuck:testowner/tools-notify', rule: 'queue-stuck', severity: 'warning',
    title: 'tools-notify · Notify Release queued for 41m',
    body: 'Diagnosed as label-mismatch: the job asks for `notarize` and no runner carries it.',
    opened_at: NOW - 8 * DAY, closed_at: NOW - 8 * DAY + 3 * HOUR, notified: 1,
  },
  {
    key: 'disk-low:testhost', rule: 'disk-low', severity: 'warning',
    title: 'Disk below the floor on testhost',
    body: 'Free space fell under the 40 GB floor while three archives ran at once.',
    opened_at: NOW - 12 * DAY, closed_at: NOW - 12 * DAY + 74 * MIN, notified: 1,
  },
  {
    key: 'newly-failing:testowner/app-backend', rule: 'newly-failing', severity: 'warning',
    title: 'app-backend · Backend CI started failing',
    body: 'Three consecutive failures after a run of successes.',
    opened_at: NOW - 17 * DAY, closed_at: NOW - 17 * DAY + 5 * HOUR, notified: 1,
  },
  {
    key: `runner-down:${HOST}-site-frontend-2`, rule: 'runner-down', severity: 'critical',
    title: `${HOST}-site-frontend-2 is not running`,
    body: 'The listener stopped and launchd did not revive it. Cleared by a restart.',
    opened_at: NOW - 22 * DAY, closed_at: NOW - 22 * DAY + 26 * MIN, notified: 1,
  },
];

export const ACTION_LOG_ROWS = [
  { ts: NOW - 34 * MIN, action: 'fleet.health', command: './health.sh', exit_code: 0, ok: 1,
    output: 'checked 10 runners — 1 not running (testhost-app-backend-2)' },
  { ts: NOW - 2 * DAY + 39 * MIN, action: 'runner.drain', command: './scripts/drain-runner.sh testhost-site-frontend-2',
    exit_code: 0, ok: 1, output: 'drain requested; runner will stop after its current job' },
  { ts: NOW - 3 * DAY, action: 'fleet.status', command: './status.sh', exit_code: 0, ok: 1,
    output: '10 runners, 8 online, 1 drained, 1 dead' },
  { ts: NOW - 6 * DAY, action: 'runner.register', command: './register.sh testowner/tools-notify',
    exit_code: 0, ok: 1, output: 'registered testhost-tools-notify' },
  { ts: NOW - 9 * DAY, action: 'fleet.cleanupPreview', command: './cleanup.sh --dry-run',
    exit_code: 0, ok: 1, output: 'would reclaim 18.4 GB from _work across 10 runners' },
];

export const AUTOSCALE_DECISIONS = [
  { ts: NOW - 12 * MIN, repo: repo('app-web'), action: 'proposed',
    reason: 'repo-capacity at high confidence; host has headroom (2 busy, ceiling 3)' },
  { ts: NOW - 21 * MIN, repo: repo('tools-notify'), action: 'refused',
    reason: 'queue cause is label-mismatch — a second runner would share the mismatch' },
  { ts: NOW - 4 * HOUR, repo: repo('app-ios'), action: 'refused',
    reason: 'already at the per-repo instance cap of 4' },
  { ts: NOW - 9 * HOUR, repo: repo('app-web'), action: 'proposed',
    reason: 'p90 concurrent demand 2 over 118 jobs' },
];

// ----------------------------------------------------------------- seed db

/** Fill an open (in-memory) fleet database with the fixture history. */
export function seedDb(db) {
  const { runs, jobs, steps } = generateHistory();

  const insertRun = db.prepare(`
    INSERT OR REPLACE INTO runs (id, repo, workflow_id, workflow_name, run_number, event, status,
      conclusion, head_branch, head_sha, created_at, run_started_at, updated_at, html_url,
      duration_ms, seen_at, run_attempt, display_title, workflow_path, pr_number, actor,
      head_commit_msg)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertJob = db.prepare(`
    INSERT OR REPLACE INTO jobs (id, run_id, repo, name, status, conclusion, created_at, started_at,
      completed_at, runner_name, runner_id, labels, queued_ms, duration_ms, html_url, seen_at,
      failure_class)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertStep = db.prepare(`
    INSERT OR REPLACE INTO steps (job_id, number, name, status, conclusion, started_at,
      completed_at, duration_ms)
    VALUES (?,?,?,?,?,?,?,?)`);

  db.exec('BEGIN');

  for (const r of runs) {
    // shapeRun rather than a hand-written row: the shaping (duration, sha
    // truncation, PR number, commit subject) is the daemon's, not this file's.
    const s = shapeRun(r.repo, r.api);
    insertRun.run(s.id, s.repo, s.workflowId, s.workflowName, s.runNumber, s.event, s.status,
      s.conclusion, s.branch, s.sha, s.createdAt, s.startedAt, s.updatedAt, s.url, s.durationMs,
      NOW, s.runAttempt, s.displayTitle, s.workflowPath, s.prNumber, s.actor, s.headCommitMsg);
  }
  for (const j of jobs) {
    const s = shapeJob(j.repo, j.api);
    insertJob.run(s.id, s.runId, s.repo, s.name, s.status, s.conclusion, s.createdAt, s.startedAt,
      s.completedAt, s.runnerName, s.runnerId, JSON.stringify(s.labels), s.queuedMs, s.durationMs,
      s.url, NOW, j.api.failure_class ?? null);
  }
  for (const s of steps) {
    insertStep.run(s.job_id, s.number, s.name, s.status, s.conclusion, s.started_at, s.completed_at,
      s.duration_ms);
  }

  // Workflow YAML, exactly as the collector caches it.
  const insertWf = db.prepare(`
    INSERT OR REPLACE INTO workflow_files (repo, path, ref, name, sha, content, fetched_at, is_default)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const f of WORKFLOW_FILES) {
    insertWf.run(f.repo, f.path, f.ref, f.name, 'fixture', f.content, NOW, f.is_default);
  }

  const insertRepo = db.prepare(`
    INSERT OR REPLACE INTO repos (full_name, name, archived, private, pushed_at, workflows,
      has_runner, updated_at, default_branch)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of REPO_ROSTER) {
    insertRepo.run(r.fullName, r.name, 0, r.private ? 1 : 0, r.pushedAt, r.workflows,
      r.hasRunner ? 1 : 0, NOW, r.defaultBranch);
  }

  // Host vitals, one sample a minute for the window, so "minutes under pressure"
  // on the Analytics tab means what it says.
  const insertSample = db.prepare(`
    INSERT OR REPLACE INTO host_samples (ts, load1, mem_used_mb, mem_total_mb, swap_used_mb,
      swap_total_mb, disk_free_gb, disk_total_gb, listeners, busy_runners, mem_free_pct, pressure,
      swapins_per_sec, swapouts_per_sec, mem_compressed_mb)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const prnd = mulberry32(0xc0ffee);
  // Three days where the machine was actually under pressure for a while.
  const pressureDays = new Map([[5, 34], [11, 18], [19, 51]]);
  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const pressureMinutes = pressureDays.get(d) ?? 0;
    const pressureStart = 14 * 60 + 20;
    for (let m = 0; m < 1440; m++) {
      const ts = NOW - d * DAY + m * MIN;
      if (ts > NOW) break;
      const workday = m > 8 * 60 && m < 19 * 60;
      const load = (workday ? 2.6 : 0.6) + prnd() * (workday ? 3.4 : 0.8);
      const underPressure = pressureMinutes > 0 && m >= pressureStart && m < pressureStart + pressureMinutes;
      insertSample.run(
        Math.floor(ts / 1000) * 1000, Number(load.toFixed(2)),
        underPressure ? 58_000 : 20_000 + Math.floor(prnd() * 6_000), 65_536,
        3_072, 8_192, 412 + Math.floor(prnd() * 30), 1_863,
        10, workday ? Math.floor(prnd() * 3) : 0,
        underPressure ? 8 : 55 + Math.floor(prnd() * 12),
        underPressure ? 'warning' : 'normal',
        underPressure ? 62 + prnd() * 40 : 0, 0,
        underPressure ? 9_000 : 2_048
      );
    }
  }

  const insertAlert = db.prepare(`
    INSERT INTO alerts (key, rule, severity, title, body, opened_at, closed_at, notified)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const a of ALERT_ROWS) {
    insertAlert.run(a.key, a.rule, a.severity, a.title, a.body, a.opened_at, a.closed_at, a.notified);
  }

  const insertAction = db.prepare(`
    INSERT INTO action_log (ts, action, args, command, exit_code, ok, output)
    VALUES (?,?,?,?,?,?,?)`);
  for (const a of ACTION_LOG_ROWS) {
    insertAction.run(a.ts, a.action, '{}', a.command, a.exit_code, a.ok, a.output);
  }

  const insertDecision = db.prepare(
    'INSERT INTO autoscale_decisions (ts, repo, action, reason, dry_run) VALUES (?,?,?,?,1)'
  );
  for (const d of AUTOSCALE_DECISIONS) insertDecision.run(d.ts, d.repo, d.action, d.reason);

  // Shadow-mode forecast scoring. evaluateGate() needs at least twenty scored
  // windows before it will report a number at all.
  const insertEval = db.prepare(`
    INSERT INTO forecast_evals (ts, window_start, window_end, repo, predicted_peak, actual_peak,
      precision_score, recall_score, false_positive, model_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const ernd = mulberry32(0x9a17);
  for (let i = 0; i < 28; i++) {
    const start = NOW - (i + 1) * 8 * HOUR;
    const predicted = ernd() < 0.55 ? 2 + Math.floor(ernd() * 2) : 1;
    const hit = predicted > 1 ? ernd() < 0.82 : ernd() < 0.25;
    const actual = hit ? Math.max(2, predicted) : 1;
    insertEval.run(NOW - i * 8 * HOUR, start, start + HOUR, repo(HISTORY[i % HISTORY.length].repo),
      predicted, actual, null, null, predicted > 1 && actual <= 1 ? 1 : 0, 'fixture-1');
  }

  // Runner state and transitions, which the drawer reads.
  const insertRunnerState = db.prepare(`
    INSERT OR REPLACE INTO runner_state (name, repo, dir, labels, gh_id, gh_status, gh_busy,
      launchd_label, launchd_state, pid, rss_kb, work_kb, updated_at, drain_state, runner_version,
      install_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const spec of RUNNER_SPECS) {
    const name = runnerName(spec.dirName);
    insertRunnerState.run(name, repo(spec.repo), `/fixture/${spec.dirName}`,
      JSON.stringify([...BASE_LABELS, ...spec.extra]), spec.ghId, spec.gh.status,
      spec.gh.busy ? 1 : 0, `actions.runner.${OWNER}-${spec.repo}.${name}`,
      spec.launchd ? (spec.launchd.pid ? 'running' : 'dead') : 'not-loaded',
      spec.listener?.pid ?? null, spec.listener?.rssKb ?? null, spec.workKb, NOW,
      spec.drain ?? null, spec.version, '2.337.0');
  }

  const insertEvent = db.prepare(
    'INSERT INTO runner_events (ts, name, repo, kind, detail) VALUES (?,?,?,?,?)'
  );
  const events = [
    [NOW - 2 * DAY + 40 * MIN, `${HOST}-app-backend-2`, 'app-backend', 'launchd',
      'launchd running → dead (last exit 78)'],
    [NOW - 2 * DAY + 40 * MIN, `${HOST}-app-backend-2`, 'app-backend', 'github',
      'GitHub status online → offline'],
    [NOW - 6 * DAY, `${HOST}-app-backend-2`, 'app-backend', 'version',
      'runner version 2.337.0 → 2.340.0 (GitHub auto-update)'],
    [NOW - 14 * DAY, `${HOST}-app-backend-2`, 'app-backend', 'launchd', 'launchd dead → running'],
    [NOW - 1 * DAY, `${HOST}-site-frontend-2`, 'site-frontend', 'drain', 'drain state → drained'],
    [NOW - 9 * DAY, `${HOST}-app-ios-2`, 'app-ios', 'launchd', 'launchd not-loaded → running'],
  ];
  for (const [ts, name, short, kind, detail] of events) {
    insertEvent.run(ts, name, repo(short), kind, detail);
  }

  db.exec('COMMIT');
}

// -------------------------------------------------------------- the snapshot

/**
 * Assemble the live snapshot the way fleetd's fast tick does, calling the real
 * derivation functions on the fixture inputs.
 */
export function buildSnapshot({ db, root, settings }) {
  const dirs = discoverRunnerDirs(root);
  const inputs = collectorInputs();
  const { launchd, processes } = inputs.attach(dirs);

  const corpus = [...dirs.map((d) => d.repo), ...REPO_ROSTER.map((r) => r.fullName)];
  const groups = deriveGroups(corpus, {
    min: settings.get('groupMin'),
    ignore: settings.get('groupIgnore'),
    pinned: settings.get('projects'),
    enabled: settings.get('groupsEnabled'),
  });
  for (const r of REPO_ROSTER) r.project = groups.of(r.fullName);

  const { runners, elsewhere } = buildRunners({
    dirs,
    ghRunnersByRepo: inputs.ghRunnersByRepo,
    launchd,
    processes,
    runnersKnownFor: inputs.runnersKnownFor,
    groups,
  });

  DIAG_DIRS.clear();
  for (const r of runners) {
    DIAG_DIRS.set(r.name, r.dir);
    r.dir = `${DISPLAY_ROOT}/${r.dirName}`;
  }

  const live = liveRuns();
  const active = live
    .map(({ repo: r, api, jobs }) => {
      const shaped = shapeRun(r, api, groups);
      shaped.jobs = jobs.map((j) => shapeJob(r, j));
      const claimed = shaped.jobs.find((j) => j.runnerName);
      shaped.runnerName = claimed?.runnerName ?? null;
      shaped.onThisHost = shaped.jobs.some((j) => runners.some((x) => x.name === j.runnerName));
      return shaped;
    })
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

  const recent = db.prepare(`
    SELECT * FROM runs WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 40`).all()
    .map((r) => ({
      id: r.id, repo: r.repo, project: groups.of(r.repo), workflowId: r.workflow_id,
      workflowName: r.workflow_name, workflowPath: r.workflow_path, runNumber: r.run_number,
      runAttempt: r.run_attempt, event: r.event, status: r.status, conclusion: r.conclusion,
      branch: r.head_branch, sha: r.head_sha, createdAt: r.created_at, startedAt: r.run_started_at,
      updatedAt: r.updated_at, url: r.html_url, durationMs: r.duration_ms,
      displayTitle: r.display_title, prNumber: r.pr_number, actor: r.actor,
      headCommitMsg: r.head_commit_msg, jobs: [],
    }));

  const host = {
    ...HOST_VITALS,
    root: DISPLAY_ROOT,
    listeners: processes.listeners.size,
    workers: processes.workers.size,
    runnerCount: runners.length,
    totalRssMb: [...processes.listeners.values()].reduce((s, p) => s + p.rssKb, 0) / 1024,
  };

  const capacity = headroom({ host, runners, limits: settings.limits() });

  // The lint findings that matter to the queue classifier are the critical ones:
  // a structural proof that a `runs-on:` can never be satisfied.
  const criticalLintRepos = (() => {
    const byRepo = new Map();
    const add = (r, labels) => {
      if (!byRepo.has(r)) byRepo.set(r, []);
      byRepo.get(r).push({ labels: (labels ?? []).map((l) => String(l).toLowerCase()) });
    };
    for (const r of runners) if (r.registered) add(r.repo, r.labels);
    for (const e of elsewhere) add(e.repo, e.labels);
    const files = db.prepare('SELECT repo, path, ref, name, content, is_default FROM workflow_files').all();
    return new Set(
      lintAll({ files, runnersByRepo: byRepo })
        .filter((f) => f.severity === 'critical')
        .map((f) => f.repo)
    );
  })();

  const classifyRun = (run) => classifyQueueCause({
    run,
    runners,
    capacity,
    api: API_RATE,
    collector: { lastError: null },
    runLabels: run.jobs?.flatMap((j) => j.labels ?? []) ?? null,
    hasLintFindings: criticalLintRepos.has(run.repo),
  });

  const drift = deriveDrift({
    runners, elsewhere, active, repos: REPO_ROSTER, now: NOW, classify: classifyRun,
  });

  const concurrency = concurrencyByRepo(db, { days: 60 });
  // The split is when this repo stopped being served by a single runner. On a
  // real host it is the duplicate directory's birthtime; the fixture
  // directories were all created seconds ago, so it is stated here instead.
  const scaleEffect = queueEffect(db, [{ repo: repo('app-ios'), at: NOW - 18 * DAY }]);

  return {
    ts: NOW,
    starting: false,
    host,
    runners,
    elsewhere,
    active,
    recent,
    repos: REPO_ROSTER,
    drift,
    projects: groups.order,
    capacity,
    sizing: sizeFleet({ runners, active, concurrency, limits: settings.limits() }),
    autoscale: {
      at: NOW - 12 * MIN, acted: false, action: null,
      reason: 'app-web would take one more runner; the autoscaler is in dry run and did not act',
      enabled: settings.get('autoscale'), dryRun: settings.get('autoscaleDryRun'),
    },
    scaleEffect,
    admission: ADMISSION,
    api: API_RATE,
    collector: {
      lastFast: NOW,
      durationMs: 412,
      lastSlow: NOW - 7 * MIN,
      lastError: null,
      failedRepos: 0,
      transientRetries: 2,
      fastMs: 15_000,
      tokenSource: 'fixture',
      backfill: { phase: 'complete', pending: 0, unclassified: 0, done: true },
      alerts: { open: ALERT_ROWS.filter((a) => !a.closed_at).length, channels: { macos: true, webhook: false } },
    },
    queue: active
      .filter((r) => r.status === 'queued')
      .map((r) => {
        const c = classifyRun(r);
        return {
          id: r.id,
          repo: r.repo,
          project: r.project,
          workflowName: r.workflowName,
          labels: r.jobs?.flatMap((j) => j.labels ?? []) ?? [],
          queuedSinceMs: NOW - Math.max(
            new Date(r.createdAt).getTime(),
            new Date(r.startedAt ?? r.createdAt).getTime()
          ),
          cause: c.cause,
          confidence: c.confidence,
          evidence: c.evidence,
          recommended: c.recommended,
          actionEligible: c.actionEligible,
        };
      }),
    _groups: groups,
    _hostDrained: Boolean(hostDrainState(root)),
  };
}

export const API_RATE = { limit: 5000, remaining: 4736, used: 264, resetAt: iso(NOW + 41 * MIN) };
