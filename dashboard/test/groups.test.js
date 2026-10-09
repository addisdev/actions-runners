import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveGroups } from '../lib/groups.js';

describe('deriveGroups', () => {
  test('basic inference groups app-ios, app-web and app-backend under app', () => {
    const { order, of } = deriveGroups(['app-ios', 'app-web', 'app-backend']);
    assert.ok(order.includes('app'));
    assert.equal(of('app-ios'), 'app');
    assert.equal(of('app-web'), 'app');
    assert.equal(of('app-backend'), 'app');
  });

  test('a group below the configured minimum maps to other', () => {
    const { of } = deriveGroups(['solo-repo']);
    assert.equal(of('solo-repo'), 'other');
  });

  test('the minimum is configurable', () => {
    const { of } = deriveGroups(['app-ios', 'app-web'], { min: 3 });
    assert.equal(of('app-ios'), 'other');
  });

  test('duplicate repository names do not manufacture a group', () => {
    const { order, of } = deriveGroups(['dup-repo', 'dup-repo']);
    assert.ok(!order.includes('dup'));
    assert.equal(of('dup-repo'), 'other');
  });

  test('ignored tokens do not become automatic groups', () => {
    const { order, of } = deriveGroups(['app-ios', 'app-web'], { ignore: ['app'] });
    assert.ok(!order.includes('app'));
    assert.equal(of('app-ios'), 'other');
    assert.equal(of('app-web'), 'other');
  });

  test('the longest matching pinned prefix wins', () => {
    const { of } = deriveGroups(['app-legacy-tool'], { pinned: ['app', 'app-legacy'] });
    assert.equal(of('app-legacy-tool'), 'app-legacy');
  });

  test('pinned groups come first in the order given', () => {
    const { order } = deriveGroups(['app-ios', 'app-web'], { pinned: ['zeta', 'alpha'] });
    assert.deepEqual(order.slice(0, 2), ['zeta', 'alpha']);
  });

  test('disabled grouping maps every repository to other', () => {
    const { order, of } = deriveGroups(['app-ios', 'app-web'], { enabled: false });
    assert.deepEqual(order, ['other']);
    assert.equal(of('app-ios'), 'other');
    assert.equal(of('app-web'), 'other');
  });

  test('a leading token with no letter is not inferred as a group', () => {
    const { order, of } = deriveGroups(['2024-alpha', '2024-beta']);
    assert.ok(!order.includes('2024'));
    assert.equal(of('2024-alpha'), 'other');
  });

  test('repo names may carry an owner', () => {
    const { of } = deriveGroups(['octocat/app-ios', 'octocat/app-web']);
    assert.equal(of('octocat/app-ios'), 'app');
    assert.equal(of('app-web'), 'app');
  });

  test('names are case-insensitive', () => {
    const { of } = deriveGroups(['App-Ios', 'APP-WEB']);
    assert.equal(of('app-ios'), 'app');
  });

  test('separators are hyphen, underscore and dot', () => {
    const { of } = deriveGroups(['app_ios', 'app.web']);
    assert.equal(of('app_ios'), 'app');
    assert.equal(of('app.web'), 'app');
  });

  test('an empty corpus yields only other', () => {
    const { order, of } = deriveGroups([]);
    assert.deepEqual(order, ['other']);
    assert.equal(of('anything'), 'other');
  });
});
