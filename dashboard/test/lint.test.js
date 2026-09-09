import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lintWorkflow } from '../lib/lint.js';
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
