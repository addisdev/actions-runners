import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planMirror, extraLabels, globMatch } from '../lib/mirror.js';

// Shapes as /api/state reports them on the coordinator.
const r = (name, repo, labels, instance = 1) => ({
  name: `SRC-${name}`, repo: `o/${repo}`, instance,
  labels: ['self-hosted', 'macOS', 'ARM64', ...labels],
});

const SIM = ['*-ios', '*-ios-*', '*-tvos', '*-tvos-*'];

describe('planMirror', () => {
  test('copies one runner per distinct label set, not per repo', () => {
    // On runner-host aliquant-web is ci, ui-web, ui-web, ci. Copying instance 1
    // only would leave every ui-web job queued for the old host.
    const plan = planMirror({
      runners: [r('web', 'web', ['ci'], 1), r('web-2', 'web', ['ui-web'], 2),
        r('web-3', 'web', ['ui-web'], 3), r('web-4', 'web', ['ci'], 4)],
      hostLabels: ['ci', 'ui-web'],
    });
    assert.deepEqual(plan.register.map((x) => [x.instance, x.dir, x.labels]), [
      [1, 'web', ['ci']], [2, 'web-2', ['ui-web']],
    ]);
  });

  test('a runner with no extra labels is copied with none', () => {
    const plan = planMirror({ runners: [r('radiator', 'radiator', [])], hostLabels: [] });
    assert.deepEqual(plan.register.map((x) => x.labels), [[]]);
  });

  test('a label the host does not advertise is a skip with the reason', () => {
    const plan = planMirror({
      runners: [r('backend', 'backend', ['postgres']), r('map', 'homelab-map', ['hmap'])],
      hostLabels: ['ci'],
    });
    assert.equal(plan.register.length, 0);
    assert.deepEqual(plan.skipped.map((x) => x.reason), ['host lacks label postgres', 'host lacks label hmap']);
  });

  test('Simulator runners need Xcode, by the admission hook\'s name patterns', () => {
    const runners = [r('app-ios', 'app-ios', ['ci']), r('app-tvos-2', 'app-tvos', ['ci'], 2), r('app-web', 'app-web', ['ci'])];
    const without = planMirror({ runners, hostLabels: ['ci'], simulatorPatterns: SIM, hasXcode: false });
    assert.deepEqual(without.register.map((x) => x.repo), ['o/app-web']);
    assert.match(without.skipped[0].reason, /no Xcode/);
    const withX = planMirror({ runners, hostLabels: ['ci'], simulatorPatterns: SIM, hasXcode: true });
    assert.equal(withX.register.length, 3);
  });

  test('operator skips match bare names and owner/repo', () => {
    const runners = [r('a', 'alpha', ['ci']), r('b', 'beta', ['ci']), r('c', 'gamma', ['ci'])];
    const plan = planMirror({ runners, hostLabels: ['ci'], skipRepos: ['alpha', 'o/beta'] });
    assert.deepEqual(plan.register.map((x) => x.repo), ['o/gamma']);
    assert.equal(plan.skipped.length, 2);
  });

  test('--only limits the plan to a pilot without reporting the rest as skipped', () => {
    const runners = [r('a', 'alpha', ['ci']), r('b', 'beta', ['ci'])];
    const plan = planMirror({ runners, hostLabels: ['ci'], onlyRepos: ['beta'] });
    assert.deepEqual(plan.register.map((x) => x.repo), ['o/beta']);
    assert.equal(plan.skipped.length, 0);
  });

  test('re-running is safe: runners already on this host are present, not registered', () => {
    const runners = [r('web', 'web', ['ci'], 1), r('web-2', 'web', ['ui-web'], 2)];
    const plan = planMirror({ runners, hostLabels: ['ci', 'ui-web'], existing: ['web'] });
    assert.deepEqual(plan.present.map((x) => x.dir), ['web']);
    assert.deepEqual(plan.register.map((x) => x.dir), ['web-2']);
  });

  test('a skipped label set does not use up an instance number', () => {
    // web-2 [postgres] is skipped; [ui-web] must still be instance 2 here, so
    // its directory and runner name follow register.sh's numbering.
    const runners = [r('web', 'web', ['ci'], 1), r('web-2', 'web', ['postgres'], 2), r('web-3', 'web', ['ui-web'], 3)];
    const plan = planMirror({ runners, hostLabels: ['ci', 'ui-web'] });
    assert.deepEqual(plan.register.map((x) => [x.instance, x.labels]), [[1, ['ci']], [2, ['ui-web']]]);
  });

  test('labels compare case-insensitively against the host list', () => {
    const plan = planMirror({ runners: [r('x', 'x', ['UI-Web'])], hostLabels: ['ui-web'] });
    assert.equal(plan.register.length, 1);
  });
});

describe('helpers', () => {
  test('extraLabels drops the defaults and accepts GitHub label objects', () => {
    assert.deepEqual(extraLabels(['self-hosted', { name: 'macOS' }, 'ARM64', { name: 'ci' }, 'ui-web']), ['ci', 'ui-web']);
  });
  test('globMatch handles * and escapes the rest', () => {
    assert.ok(globMatch('*-ios-*', 'jerv-ios-2'));
    assert.ok(!globMatch('*-ios', 'jerv-ios-2'));
    assert.ok(!globMatch('a.b', 'axb'));
  });
});
