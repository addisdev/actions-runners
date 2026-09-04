import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { adviseRepo, adviseAll } from '../lib/concurrency-advisor.js';
import {
  WORKFLOW_UNBOUNDED_MATRIX, WORKFLOW_WITH_TIMEOUT, WORKFLOW_SCHEDULED,
} from './fixtures/index.js';

const REPO = 'testowner/app-ios';

function file(content, overrides = {}) {
  return {
    repo: REPO, path: '.github/workflows/ci.yml', name: 'CI', ref: '__default__',
    is_default: 1, content, ...overrides,
  };
}

const advise = (files, opts = {}) =>
  adviseRepo({ repo: REPO, files, runnerCount: 1, hostCap: 8, ...opts });

const rules = (findings) => findings.map((f) => f.rule);

describe('matrix cardinality', () => {
  test('a matrix larger than the runner count is reported', () => {
    // 3 os × 2 config = 6 jobs against one runner.
    const found = advise([file(WORKFLOW_UNBOUNDED_MATRIX)], { runnerCount: 1 });
    const hit = found.find((f) => f.rule === 'matrix-exceeds-runners');
    assert.ok(hit, `expected matrix-exceeds-runners, got ${rules(found)}`);
    assert.match(hit.message, /6 job/);
  });

  test('the same matrix is fine once there are enough runners', () => {
    const found = advise([file(WORKFLOW_UNBOUNDED_MATRIX)], { runnerCount: 6 });
    assert.ok(!rules(found).includes('matrix-exceeds-runners'));
  });

  test('max-parallel is credited as the effective cap', () => {
    const capped = WORKFLOW_UNBOUNDED_MATRIX.replace(
      '    strategy:\n      matrix:',
      '    strategy:\n      max-parallel: 1\n      matrix:'
    );
    const found = advise([file(capped)], { runnerCount: 1 });
    assert.ok(!rules(found).includes('matrix-exceeds-runners'),
      `max-parallel: 1 should satisfy one runner, got ${rules(found)}`);
  });

  test('an expression-valued matrix is reported as unbounded, not sized', () => {
    const dynamic = `
name: CI
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 30
    strategy:
      matrix:
        target: \${{ fromJSON(needs.plan.outputs.targets) }}
    steps:
      - run: echo build
`;
    const found = advise([file(dynamic)], { runnerCount: 1 });
    assert.ok(rules(found).includes('matrix-unbounded'), `got ${rules(found)}`);
    // Cardinality is unknowable here, so it must not also claim a size.
    assert.ok(!rules(found).includes('matrix-exceeds-runners'));
  });
});

describe('concurrency group collisions', () => {
  test('two jobs sharing a static group in one file are reported', () => {
    const collide = `
name: CI
on: [push]
jobs:
  a:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    concurrency:
      group: build-lock
    steps:
      - run: echo a
  b:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    concurrency:
      group: build-lock
    steps:
      - run: echo b
`;
    const found = advise([file(collide)]);
    assert.ok(rules(found).includes('concurrency-collision'), `got ${rules(found)}`);
  });

  test('a static group shared across two workflows is reported', () => {
    const wf = (name) => `
name: ${name}
on: [push]
concurrency:
  group: deploy-lock
jobs:
  go:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    steps:
      - run: echo go
`;
    const found = advise([
      file(wf('One'), { path: 'a.yml' }),
      file(wf('Two'), { path: 'b.yml' }),
    ]);
    const hit = found.find((f) => f.rule === 'cross-file-concurrency-collision');
    assert.ok(hit, `got ${rules(found)}`);
    assert.match(hit.message, /a\.yml/);
    assert.match(hit.message, /b\.yml/);
  });

  test('a per-ref group expression shared across workflows is NOT reported', () => {
    // These serialize per branch, which is almost always the intent. Flagging it
    // would fire on nearly every well-written repo and teach people to ignore
    // the advisor.
    const wf = (name) => `
name: ${name}
on: [pull_request]
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  go:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    steps:
      - run: echo go
`;
    const found = advise([
      file(wf('One'), { path: 'a.yml' }),
      file(wf('Two'), { path: 'b.yml' }),
    ]);
    assert.ok(!rules(found).includes('cross-file-concurrency-collision'), `got ${rules(found)}`);
  });
});

describe('uncertain input produces a note, never a confident patch', () => {
  test('unparseable YAML is informational', () => {
    const found = advise([file('\tthis: is\n\t\tnot: valid yaml at all\n')]);
    for (const f of found) {
      assert.equal(f.severity, 'info', `${f.rule} should be info, was ${f.severity}`);
    }
  });

  test('a partially readable file reports low confidence', () => {
    const withAnchor = `
name: CI
on: [push]
jobs:
  base: &base
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 10
    steps:
      - run: echo base
`;
    const found = advise([file(withAnchor)]);
    const note = found.find((f) => f.rule === 'parse-partial');
    assert.ok(note, `got ${rules(found)}`);
    assert.equal(note.confidence, 'low');
    assert.equal(note.severity, 'info');
  });

  test('a clean single-job workflow produces nothing', () => {
    const found = advise([file(WORKFLOW_WITH_TIMEOUT)], { runnerCount: 1 });
    assert.deepEqual(found, [], `expected no findings, got ${JSON.stringify(rules(found))}`);
  });
});

describe('scope limits', () => {
  test('non-default refs are not analysed', () => {
    const found = advise([file(WORKFLOW_UNBOUNDED_MATRIX, { is_default: 0, ref: 'feature/x' })]);
    assert.deepEqual(found, []);
  });

  test('GitHub-hosted jobs are out of scope', () => {
    const hosted = `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3, 4, 5, 6]
    steps:
      - run: echo build
`;
    const found = advise([file(hosted)], { runnerCount: 1 });
    assert.ok(!rules(found).includes('matrix-exceeds-runners'), `got ${rules(found)}`);
  });

  test('a job that calls a reusable workflow is skipped', () => {
    const caller = `
name: CI
on: [push]
jobs:
  call:
    uses: testowner/shared/.github/workflows/build.yml@main
`;
    assert.deepEqual(advise([file(caller)]), []);
  });

  test('a scheduled workflow parses without error', () => {
    // The schedule itself is read by lib/forecast.js; the advisor only needs to
    // not fall over on it.
    const found = advise([file(WORKFLOW_SCHEDULED)], { runnerCount: 1 });
    assert.ok(!rules(found).includes('parse-error'), `got ${rules(found)}`);
  });

  test('no files means no findings', () => {
    assert.deepEqual(advise([]), []);
  });
});

describe('adviseAll', () => {
  test('groups by repo and uses each repo\'s own runner count', () => {
    const files = [
      { repo: 'o/a', path: 'ci.yml', name: 'CI', is_default: 1, content: WORKFLOW_UNBOUNDED_MATRIX },
      { repo: 'o/b', path: 'ci.yml', name: 'CI', is_default: 1, content: WORKFLOW_UNBOUNDED_MATRIX },
    ];
    const found = adviseAll({
      files,
      // o/a has enough runners for the 6-job matrix; o/b does not.
      runnersByRepo: new Map([['o/a', Array(6).fill({})], ['o/b', [{}]]]),
      hostCap: 8,
    });
    const oversized = found.filter((f) => f.rule === 'matrix-exceeds-runners');
    assert.equal(oversized.length, 1);
    assert.equal(oversized[0].repo, 'o/b');
  });

  test('results are severity-sorted', () => {
    const order = { critical: 0, serious: 1, warning: 2, info: 3 };
    const found = adviseAll({
      files: [
        { repo: 'o/a', path: 'ci.yml', name: 'CI', is_default: 1, content: WORKFLOW_UNBOUNDED_MATRIX },
        { repo: 'o/a', path: 'bad.yml', name: 'Bad', is_default: 1, content: '\tbroken:\n\t\tyaml\n' },
      ],
      runnersByRepo: new Map([['o/a', [{}]]]),
      hostCap: 8,
    });
    for (let i = 1; i < found.length; i++) {
      assert.ok(order[found[i - 1].severity] <= order[found[i].severity]);
    }
  });

  test('an empty fleet produces nothing', () => {
    assert.deepEqual(adviseAll({ files: [], runnersByRepo: new Map(), hostCap: 8 }), []);
  });
});
