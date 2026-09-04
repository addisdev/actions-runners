// Shared test fixtures for the fleet dashboard test suite.
//
// Everything here is minimal but structurally valid — the same shapes the
// production code builds — so tests can import what they need and mutate
// only the fields relevant to their assertion.

export function makeRunner(overrides = {}) {
  return {
    name: 'test-host-app-ios',
    repo: 'testowner/app-ios',
    project: 'app',
    dir: '/fleet/app-ios',
    dirName: 'app-ios',
    instance: 1,
    launchdLabel: 'actions.runner.testowner-app-ios.test-host-app-ios',
    launchdState: 'running',
    lastExit: null,
    pid: 12345,
    rssMb: 42,
    uptime: '01:30:00',
    workingLocally: false,
    registered: true,
    ghUnknown: false,
    ghId: 100,
    ghStatus: 'online',
    ghBusy: false,
    labels: ['self-hosted', 'macos', 'arm64'],
    extraLabels: [],
    // Spelled the way buildRunners spells it. A test that reaches for
    // drain_state instead will now read undefined against a field that is
    // present, rather than silently agreeing with code that misspelled it.
    drainState: null,
    version: '2.337.0',
    ...overrides,
  };
}

export function makeRunner2(overrides = {}) {
  return makeRunner({
    name: 'test-host-app-ios-2',
    dirName: 'app-ios-2',
    instance: 2,
    launchdLabel: 'actions.runner.testowner-app-ios.test-host-app-ios-2',
    dir: '/fleet/app-ios-2',
    ...overrides,
  });
}

export function makeActiveRun(overrides = {}) {
  const createdAt = new Date(Date.now() - 8 * 60 * 1000).toISOString();
  return {
    id: 1,
    repo: 'testowner/app-ios',
    project: 'app',
    workflowId: 10,
    workflowName: 'CI',
    workflowPath: '.github/workflows/ci.yml',
    status: 'queued',
    conclusion: null,
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
    event: 'push',
    branch: 'main',
    jobs: [],
    labels: ['self-hosted', 'macos', 'arm64'],
    ...overrides,
  };
}

export function makeHost(overrides = {}) {
  return {
    hostname: 'test-host',
    cores: 12,
    platform: 'macOS 26.0.0',
    darwin: '25.0.0',
    uptimeSec: 86400,
    load1: 1.5,
    load5: 2.0,
    load15: 1.8,
    memUsedMb: 8192,
    memTotalMb: 32768,
    swapUsedMb: 512,
    swapTotalMb: 2048,
    memCompressedMb: 1024,
    memPressure: 'normal',
    memFreePct: 75,
    swapins: 100,
    swapouts: 50,
    swapinsPerSec: 0.1,
    swapoutsPerSec: 0,
    diskFreeGb: 200,
    diskTotalGb: 500,
    root: '/fleet',
    listeners: 5,
    workers: 0,
    runnerCount: 5,
    totalRssMb: 210,
    ...overrides,
  };
}

export function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: 1,
    run_id: 1,
    repo: 'testowner/app-ios',
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date(now - 10 * 60000).toISOString(),
    started_at: new Date(now - 9 * 60000).toISOString(),
    completed_at: new Date(now - 2 * 60000).toISOString(),
    runner_name: 'test-host-app-ios',
    runner_id: 100,
    labels: ['self-hosted', 'macos', 'arm64'],
    queued_ms: 60000,
    duration_ms: 420000,
    ...overrides,
  };
}

// Minimal workflow YAML fixtures. Keys chosen to cover the lint/advisor rules.
export const WORKFLOW_NO_TIMEOUT = `
name: CI
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    steps:
      - run: echo hello
`;

export const WORKFLOW_WITH_TIMEOUT = `
name: CI
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 30
    steps:
      - run: echo hello
`;

export const WORKFLOW_PR_NO_CONCURRENCY = `
name: PR Check
on: [pull_request]
jobs:
  test:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - run: echo test
`;

export const WORKFLOW_PR_WITH_CONCURRENCY = `
name: PR Check
on: [pull_request]
concurrency:
  group: pr-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - run: echo test
`;

export const WORKFLOW_UNBOUNDED_MATRIX = `
name: Matrix CI
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 30
    strategy:
      matrix:
        os: [14, 15, 16]
        config: [debug, release]
    steps:
      - run: echo build
`;

export const WORKFLOW_SCHEDULED = `
name: Nightly
on:
  schedule:
    - cron: '0 2 * * *'
jobs:
  nightly:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 60
    steps:
      - run: echo nightly
`;
