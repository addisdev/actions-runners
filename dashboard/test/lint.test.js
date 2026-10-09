import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lintWorkflow, lintAll } from '../lib/lint.js';
import { WORKFLOW_WITH_TIMEOUT } from './fixtures/index.js';

const REPO = 'testowner/app-web';
const LABELS = [{ labels: ['self-hosted', 'macos', 'arm64'] }];

function file(content, overrides = {}) {
  return {
    repo: REPO,
    path: '.github/workflows/e2e.yml',
    name: 'Web E2E',
    content,
    runnerLabelSets: LABELS,
    fleetLabelSets: LABELS,
    ...overrides,
  };
}

const lint = (content, overrides = {}) =>
  lintWorkflow(file(content, overrides));

const rules = (findings) => findings.map((f) => f.rule);

const WORKFLOW_PW_GOOD = `
name: Web E2E
on: [push]
jobs:
  smoke:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright" >> "$GITHUB_ENV"
      - run: npm ci
      - name: Install browsers
        timeout-minutes: 15
        run: npx playwright install chromium
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-blob-reporter
          path: blob-report/
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
`;

describe('playwright lint rules', () => {
  test('a well-formed Playwright workflow passes all playwright rules', () => {
    const found = lint(WORKFLOW_PW_GOOD);
    const pw = rules(found).filter((r) => r.startsWith('playwright-'));
    assert.deepEqual(pw, [], `expected no playwright findings, got ${pw.join(', ')}`);
  });

  test('shared default cache is flagged on self-hosted Playwright jobs', () => {
    const bad = WORKFLOW_PW_GOOD.replace(
      '      - run: echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright" >> "$GITHUB_ENV"\n',
      ''
    );
    const found = lint(bad);
    assert.ok(rules(found).includes('playwright-shared-cache'));
  });

  test('per-runner cache in a step env satisfies the shared-cache rule', () => {
    const jobScoped = WORKFLOW_PW_GOOD.replace(
      '      - run: echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright" >> "$GITHUB_ENV"',
      '      - run: echo cache path\n        env:\n          PLAYWRIGHT_BROWSERS_PATH: \${{ runner.tool_cache }}/ms-playwright'
    );
    const found = lint(jobScoped);
    assert.ok(!rules(found).includes('playwright-shared-cache'));
  });

  test('runner context at workflow scope does not satisfy the cache rule', () => {
    const invalidScope = WORKFLOW_PW_GOOD
      .replace(
        '      - run: echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright" >> "$GITHUB_ENV"\n',
        ''
      )
      .replace('on: [push]\n', 'on: [push]\nenv:\n  PLAYWRIGHT_BROWSERS_PATH: \${{ runner.tool_cache }}/ms-playwright\n');
    const found = lint(invalidScope);
    assert.ok(rules(found).includes('playwright-shared-cache'));
  });

  test('playwright install without a step timeout is serious', () => {
    const noInstallTimeout = WORKFLOW_PW_GOOD.replace(
      '        timeout-minutes: 15\n        run: npx playwright install chromium',
      '        run: npx playwright install chromium'
    );
    const found = lint(noInstallTimeout);
    assert.ok(rules(found).includes('playwright-install-timeout'));
  });

  test('missing failure artifacts are flagged when tests run', () => {
    const noArtifacts = WORKFLOW_PW_GOOD.replace(
      /      - uses: actions\/upload-artifact@v4[\s\S]*?path: blob-report\/\n/,
      ''
    ).replace(
      /      - uses: actions\/upload-artifact@v4[\s\S]*?path: playwright-report\/\n/,
      ''
    );
    const found = lint(noArtifacts);
    assert.ok(rules(found).includes('playwright-no-failure-artifacts'));
  });

  test('an unrelated failure artifact does not satisfy Playwright diagnostics', () => {
    const unrelated = WORKFLOW_PW_GOOD
      .replace(
        '          name: playwright-blob-reporter\n          path: blob-report/',
        '          name: build-log\n          path: build.log'
      )
      .replace(
        '          name: playwright-report\n          path: playwright-report/',
        '          name: deploy-log\n          path: deploy.log'
      );
    const found = lint(unrelated);
    assert.ok(rules(found).includes('playwright-no-failure-artifacts'));
  });

  test('install-only jobs are not asked for test failure artifacts', () => {
    const installOnly = `
name: Setup
on: [push]
jobs:
  prep:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 15
    steps:
      - run: echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright" >> "$GITHUB_ENV"
      - run: npm ci
      - name: Install browsers
        timeout-minutes: 15
        run: npx playwright install chromium
`;
    const found = lint(installOnly);
    assert.ok(!rules(found).includes('playwright-no-failure-artifacts'));
  });

  test('missing blob reporter hint is flagged at info severity', () => {
    const noBlob = WORKFLOW_PW_GOOD.replace(
      /      - uses: actions\/upload-artifact@v4\n        if: always\(\)\n        with:\n          name: playwright-blob-reporter\n          path: blob-report\/\n/,
      ''
    );
    const found = lint(noBlob);
    const blob = found.find((f) => f.rule === 'playwright-no-blob-reporter');
    assert.ok(blob, 'expected playwright-no-blob-reporter finding');
    assert.equal(blob.severity, 'info');
  });

  test('hosted Playwright jobs are not checked for fleet cache conventions', () => {
    const hosted = WORKFLOW_PW_GOOD.replace(
      'runs-on: [self-hosted, macos, arm64]',
      'runs-on: ubuntu-latest'
    ).replace(
      '      - run: echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright" >> "$GITHUB_ENV"\n',
      ''
    );
    const found = lint(hosted);
    assert.ok(!rules(found).some((r) => r.startsWith('playwright-')));
  });

  test('non-Playwright self-hosted jobs are untouched', () => {
    const found = lint(WORKFLOW_WITH_TIMEOUT);
    assert.ok(!rules(found).some((r) => r.startsWith('playwright-')));
  });
});

// Builds a PR workflow with the given workflow-level and per-job concurrency
// blocks (YAML text, already indented for their position).
function prWorkflow({ concurrency = '', jobs = { build: '' } } = {}) {
  const jobBlocks = Object.entries(jobs).map(([name, extra]) => `  ${name}:
    runs-on: ubuntu-latest
${extra}    steps:
      - run: echo hi
`).join('');
  return `name: CI
on:
  push:
    branches: [main]
  pull_request:
${concurrency}jobs:
${jobBlocks}`;
}

const cancelFindings = (content) =>
  lint(content).filter((f) => f.rule === 'no-cancel-in-progress');

describe('no-cancel-in-progress: expressions and job-level concurrency', () => {
  test('a literal true passes', () => {
    const wf = prWorkflow({ concurrency: 'concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n' });
    assert.deepEqual(cancelFindings(wf), []);
  });

  test('the recommended event_name expression passes', () => {
    const wf = prWorkflow({
      concurrency: "concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    });
    assert.deepEqual(cancelFindings(wf), []);
  });

  test("actions-runners' own ref comparison passes", () => {
    const wf = prWorkflow({
      concurrency: "concurrency:\n  group: ${{ github.ref }}-ci\n  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}\n",
    });
    assert.deepEqual(cancelFindings(wf), []);
  });

  test('a quoted expression and other ref reads pass', () => {
    for (const expr of [
      `"\${{ github.event_name == 'pull_request' }}"`,
      `\${{ github.head_ref != '' }}`,
      `\${{ !contains(github.ref_name, 'release') }}`,
      `\${{ startsWith(github.event_name, 'pull_request') }}`,
    ]) {
      const wf = prWorkflow({ concurrency: `concurrency:\n  group: g\n  cancel-in-progress: ${expr}\n` });
      assert.deepEqual(cancelFindings(wf), [], expr);
    }
  });

  test('no concurrency at all is a warning', () => {
    const [f, ...rest] = cancelFindings(prWorkflow());
    assert.equal(rest.length, 0);
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /no concurrency group/);
    assert.match(f.hint, /github\.event_name == 'pull_request'/);
  });

  test('a group with cancel-in-progress false or missing is a warning', () => {
    for (const block of [
      'concurrency:\n  group: g\n  cancel-in-progress: false\n',
      'concurrency:\n  group: g\n',
      'concurrency: ci-group\n',
    ]) {
      const [f] = cancelFindings(prWorkflow({ concurrency: block }));
      assert.equal(f?.severity, 'warning', block);
      assert.match(f.message, /cancel-in-progress is not true/);
    }
  });

  test('an expression that reads neither event nor ref is info, not a warning', () => {
    const wf = prWorkflow({ concurrency: 'concurrency:\n  group: g\n  cancel-in-progress: ${{ inputs.cancel }}\n' });
    const [f, ...rest] = cancelFindings(wf);
    assert.equal(rest.length, 0);
    assert.equal(f.severity, 'info');
  });

  test('job-level concurrency on every job passes', () => {
    const wf = prWorkflow({
      jobs: {
        build: "    concurrency:\n      group: build-${{ github.ref }}\n      cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
        test: '    concurrency:\n      group: test-${{ github.ref }}\n      cancel-in-progress: true\n',
      },
    });
    assert.deepEqual(cancelFindings(wf), []);
  });

  test('job-level concurrency on some jobs names the ones without it', () => {
    const wf = prWorkflow({
      jobs: {
        build: '    concurrency:\n      group: build-${{ github.ref }}\n      cancel-in-progress: true\n',
        test: '',
        lint: '    concurrency: lint-group\n',
      },
    });
    const [f, ...rest] = cancelFindings(wf);
    assert.equal(rest.length, 0);
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /test, lint do not cancel/);
  });

  test('a job-level block covers a workflow-level group that does not cancel', () => {
    const wf = prWorkflow({
      concurrency: 'concurrency:\n  group: g\n',
      jobs: { build: '    concurrency:\n      group: b\n      cancel-in-progress: true\n' },
    });
    assert.deepEqual(cancelFindings(wf), []);
  });

  test('push-only workflows are not checked', () => {
    const wf = prWorkflow().replace('  pull_request:\n', '');
    assert.deepEqual(cancelFindings(wf), []);
  });
});

const CI_SELF_HOSTED = `
name: Web CI
on: [push]
jobs:
  web-tests:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 20
    steps:
      - run: npm test
`;

const CI_HOSTED_MAC = `
name: CI
on: [push]
jobs:
  build:
    runs-on: macos-latest
    steps:
      - run: make
`;

const row = (repo, content, path = '.github/workflows/ci.yml') =>
  ({ repo, path, ref: 'main', name: null, content, is_default: 1 });

// A web repo archived when its product moved to a single repo, and
// its cached web-ci.yml kept the Lint tab CRITICAL: "No runner is registered for
// <repo> at all". True, and irrelevant: GitHub runs nothing in
// an archived repo.
describe('lintAll repo facts', () => {
  test('an archived repo is not linted at all', () => {
    const findings = lintAll({
      files: [row('owner/archived-web', CI_SELF_HOSTED), row('owner/live-web', CI_SELF_HOSTED)],
      runnersByRepo: new Map(),
      repos: new Map([
        ['owner/archived-web', { archived: true, private: true }],
        ['owner/live-web', { archived: false, private: true }],
      ]),
    });
    assert.ok(!findings.some((f) => f.repo === 'owner/archived-web'), 'archived repo must be skipped');
    assert.ok(findings.some((f) => f.repo === 'owner/live-web' && f.rule === 'unserved'),
      'a live repo with no runner is still critical');
  });

  test('archived rows straight from SQLite (integers) are skipped too', () => {
    const findings = lintAll({
      files: [row('owner/archived-web', CI_SELF_HOSTED)],
      runnersByRepo: new Map(),
      repos: [{ full_name: 'owner/archived-web', archived: 1, private: 1 }],
    });
    assert.deepEqual(findings, []);
  });

  // Cached files of a repo that has since been deleted (its workflow list now
  // 404s) stayed in the cache and were linted as live for weeks.
  test('a repo the roster no longer knows is not linted', () => {
    const findings = lintAll({
      files: [row('owner/deleted-ios', CI_HOSTED_MAC), row('owner/live-web', CI_SELF_HOSTED)],
      runnersByRepo: new Map(),
      repos: new Map([['owner/live-web', { archived: false, private: true }]]),
    });
    assert.ok(!findings.some((f) => f.repo === 'owner/deleted-ios'));
    assert.ok(findings.some((f) => f.repo === 'owner/live-web'));
  });

  test('without repo facts every file is linted, as before', () => {
    const findings = lintAll({ files: [row('owner/x', CI_SELF_HOSTED)], runnersByRepo: new Map() });
    assert.ok(findings.some((f) => f.rule === 'unserved'));
  });

  // Hosted macOS bills 10x only on private repos; public repos run it free.
  test('hosted-macos is not reported for a public repo', () => {
    const findings = lintAll({
      files: [row('owner/public-tool', CI_HOSTED_MAC)],
      runnersByRepo: new Map(),
      repos: [{ full_name: 'owner/public-tool', archived: 0, private: 0 }],
    });
    assert.ok(!findings.some((f) => f.rule === 'hosted-macos'));
  });

  test('hosted-macos is still reported for a repo of unknown visibility', () => {
    const findings = lintAll({
      files: [row('owner/unknown-tool', CI_HOSTED_MAC)],
      runnersByRepo: new Map(),
      repos: new Map(),
    });
    assert.ok(findings.some((f) => f.rule === 'hosted-macos' && f.repo === 'owner/unknown-tool'),
      'unknown visibility counts as private');
  });

  test('hosted-macos is reported for a repo known to be private', () => {
    const findings = lintAll({
      files: [row('owner/private-tool', CI_HOSTED_MAC)],
      runnersByRepo: new Map(),
      repos: new Map([['owner/private-tool', { archived: false, private: true }]]),
    });
    assert.ok(findings.some((f) => f.rule === 'hosted-macos'));
  });
});

// A TV app parks its `hardware` job behind `if: vars.LAB_HOST != ''` until
// a device lab exists; the nightly is skipped, never queued. Reported CRITICAL,
// it made the queue classifier call every run in the repo a label mismatch.
describe('label findings on vars-gated jobs', () => {
  const GATED = `
name: hardware
on:
  schedule:
    - cron: '0 9 * * *'
jobs:
  hardware:
    if: vars.LAB_HOST != ''
    runs-on: [self-hosted, device-lab]
    timeout-minutes: 30
    steps:
      - run: make hardware-test
`;

  test('an unmatched label on a job gated by a repo variable is info, not critical', () => {
    const found = lint(GATED, { path: '.github/workflows/hardware.yml' });
    const f = found.find((x) => x.rule === 'unmatched-label');
    assert.ok(f, 'still reported, so the lab setup is not forgotten');
    assert.equal(f.severity, 'info');
    assert.match(f.message, /gated on vars\.LAB_HOST/);
    assert.deepEqual(f.gatedOn, ['LAB_HOST']);
  });

  test('a job gated by a repo variable in a repo with no runner is info, not critical', () => {
    const found = lint(GATED, { runnerLabelSets: [] });
    const f = found.find((x) => x.rule === 'unserved');
    assert.equal(f.severity, 'info');
  });

  test('the same job without the gate stays critical', () => {
    const found = lint(GATED.replace("    if: vars.LAB_HOST != ''\n", ''));
    const f = found.find((x) => x.rule === 'unmatched-label');
    assert.equal(f.severity, 'critical');
  });

  test('a gate on something other than a variable stays critical', () => {
    const found = lint(GATED.replace("vars.LAB_HOST != ''", "github.event_name == 'schedule'"));
    assert.equal(found.find((x) => x.rule === 'unmatched-label').severity, 'critical');
  });

  test('label findings carry the job\'s runs-on labels', () => {
    const found = lint(GATED.replace("    if: vars.LAB_HOST != ''\n", ''));
    assert.deepEqual(found.find((x) => x.rule === 'unmatched-label').labels, ['self-hosted', 'device-lab']);
  });
});

describe('hosted-macos visibility guard', () => {
  const GUARDED = `
name: CI
on: [push, workflow_dispatch]
jobs:
  test:
    if: \${{ !github.event.repository.private || github.event_name == 'workflow_dispatch' }}
    runs-on: macos-15
    steps:
      - run: swift test
`;

  test('a job whose if: reads repo visibility is info, not a warning', () => {
    const f = lint(GUARDED).find((x) => x.rule === 'hosted-macos');
    assert.ok(f);
    assert.equal(f.severity, 'info');
    assert.match(f.message, /guarded on repo visibility/);
  });

  test('an unguarded hosted macOS job on a private repo is still a warning', () => {
    const f = lint(GUARDED.replace(/    if: .*\n/, '')).find((x) => x.rule === 'hosted-macos');
    assert.equal(f.severity, 'warning');
  });
});

describe('no-cancel-in-progress', () => {
  const PR_WF = (cancel) => `
name: CI
on:
  pull_request:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: ${cancel}
jobs:
  test:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    steps:
      - run: make test
`;

  test('literal true satisfies the rule', () => {
    assert.ok(!rules(lint(PR_WF('true'))).includes('no-cancel-in-progress'));
  });

  test('an expression satisfies the rule (cancel PRs, never main)', () => {
    for (const expr of [
      "\${{ github.event_name == 'pull_request' }}",
      "\${{ github.ref != 'refs/heads/main' }}",
    ]) {
      assert.ok(!rules(lint(PR_WF(expr))).includes('no-cancel-in-progress'), expr);
    }
  });

  test('false is still flagged', () => {
    assert.ok(rules(lint(PR_WF('false'))).includes('no-cancel-in-progress'));
  });
});
