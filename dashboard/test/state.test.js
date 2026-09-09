import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roleLabel, deriveDrift, extraLabels } from '../lib/state.js';
import { makeRunner, makeRunner2 } from './fixtures/index.js';

// ---- roleLabel ---------------------------------------------------------------

describe('roleLabel', () => {
  test('returns "ci" for a runner carrying ci', () => {
    assert.equal(roleLabel(['ci', 'playwright']), 'ci');
  });

  test('returns "ui-web" for a runner carrying ui-web', () => {
    assert.equal(roleLabel(['ui-web']), 'ui-web');
  });

  test('returns null for a runner with no role label', () => {
    assert.equal(roleLabel([]), null);
    assert.equal(roleLabel(['playwright']), null);
  });

  test('returns the first role label when multiple are present (unusual)', () => {
    const r = roleLabel(['ci', 'ui-web']);
    assert.ok(r === 'ci' || r === 'ui-web');
  });
});

// ---- deriveDrift: label-mismatch (role-aware) --------------------------------

function runner(overrides = {}) {
  return makeRunner({ repo: 'owner/web', registered: true, ghUnknown: false, ghStatus: 'online', ...overrides });
}

function runner2(overrides = {}) {
  return makeRunner2({ repo: 'owner/web', registered: true, ghUnknown: false, ghStatus: 'online', ...overrides });
}

describe('deriveDrift — role-aware label-mismatch', () => {
  test('no alert when ci and ui-web runners are intentional siblings', () => {
    const runners = [
      runner({ extraLabels: ['ci'] }),
      runner2({ extraLabels: ['ui-web'] }),
    ];
    const drift = deriveDrift({ runners, elsewhere: [], active: [], repos: [] });
    const mismatch = drift.filter((d) => d.kind === 'label-mismatch');
    assert.equal(mismatch.length, 0, 'ci + ui-web should not trigger label-mismatch');
  });

  test('no alert for three runners: one ci, two ui-web (all same role within group)', () => {
    const runner3 = makeRunner({
      name: 'host-web-3', dirName: 'web-3', instance: 3,
      repo: 'owner/web', registered: true, ghUnknown: false, ghStatus: 'online',
      extraLabels: ['ui-web'],
    });
    const runners = [
      runner({ extraLabels: ['ci'] }),
      runner2({ extraLabels: ['ui-web'] }),
      runner3,
    ];
    const drift = deriveDrift({ runners, elsewhere: [], active: [], repos: [] });
    const mismatch = drift.filter((d) => d.kind === 'label-mismatch');
    assert.equal(mismatch.length, 0, 'one ci + two ui-web should not trigger label-mismatch');
  });

  test('alerts when two runners of the SAME role carry different labels', () => {
    const runners = [
      runner({ extraLabels: ['ci'] }),
      runner2({ extraLabels: ['ci', 'extra-tool'] }),
    ];
    const drift = deriveDrift({ runners, elsewhere: [], active: [], repos: [] });
    const mismatch = drift.filter((d) => d.kind === 'label-mismatch');
    assert.equal(mismatch.length, 1, 'same-role runners with different labels should still alert');
  });

  test('alerts when two unroled runners carry different labels', () => {
    const runners = [
      runner({ extraLabels: [] }),
      runner2({ extraLabels: ['xcode-16'] }),
    ];
    const drift = deriveDrift({ runners, elsewhere: [], active: [], repos: [] });
    const mismatch = drift.filter((d) => d.kind === 'label-mismatch');
    assert.equal(mismatch.length, 1, 'different unroled labels should still alert');
  });

  test('does not alert for a repo with only one runner of any role', () => {
    const runners = [runner({ extraLabels: ['ci'] })];
    const drift = deriveDrift({ runners, elsewhere: [], active: [], repos: [] });
    const mismatch = drift.filter((d) => d.kind === 'label-mismatch');
    assert.equal(mismatch.length, 0);
  });
});

// ---- extraLabels -------------------------------------------------------------

describe('extraLabels', () => {
  test('filters out implicit labels', () => {
    assert.deepEqual(extraLabels(['self-hosted', 'macos', 'arm64', 'ci']), ['ci']);
  });

  test('handles string labels', () => {
    assert.deepEqual(extraLabels(['self-hosted', 'macOS', 'ARM64', 'ui-web']), ['ui-web']);
  });

  test('handles object labels (GitHub API shape)', () => {
    assert.deepEqual(
      extraLabels([{ name: 'self-hosted' }, { name: 'macOS' }, { name: 'ui-web' }]),
      ['ui-web']
    );
  });
});
