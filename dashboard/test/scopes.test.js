import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grants, parseScopes, scopeForAction, ACT_ACTIONS } from '../lib/scopes.js';
import { buildActions } from '../lib/actions.js';
import { issueConfirmation, consumeConfirmation, resetConfirmations, CONFIRM_TTL_MS } from '../lib/confirm.js';

test('act:danger implies act, and either implies read', () => {
  assert.ok(grants(['act:danger'], 'act'));
  assert.ok(grants(['act'], 'read'));
  assert.ok(!grants(['read'], 'act'));
  assert.ok(!grants(['act'], 'act:danger'));
  assert.ok(!grants([], 'read'));
});

test('parseScopes takes a list or a string, in canonical order, and refuses unknown ones', () => {
  assert.deepEqual(parseScopes('act, read'), ['read', 'act']);
  assert.deepEqual(parseScopes(['act:danger']), ['act:danger']);
  assert.equal(parseScopes('read,admin'), null);
  assert.equal(parseScopes(''), null);
});

test('every act action exists, and the ones that stop or change the fleet need act:danger', () => {
  const ids = Object.keys(buildActions({ root: '/tmp', gh: {}, getSnapshot: () => ({ runners: [] }) }));
  for (const id of ACT_ACTIONS) assert.ok(ids.includes(id), `${id} is a real action`);
  for (const id of ['host.off', 'runner.restart', 'fleet.healthRepair', 'fleet.cleanupApply', 'runner.register',
    'runner.duplicate', 'runner.deregister', 'workflow.dispatch']) {
    assert.equal(scopeForAction(id), 'act:danger', id);
  }
  assert.equal(scopeForAction('runner.drain'), 'act');
  assert.equal(scopeForAction('not.an.action'), 'act:danger');
});

test('a confirmation runs once, for the same caller, action and arguments, in either key order', () => {
  resetConfirmations();
  const c = issueConfirmation({ action: 'runner.drain', args: { name: 'a', x: 1 }, caller: 'device:1' }, 1000);
  assert.match(consumeConfirmation(c.token, { action: 'runner.drain', args: { name: 'b', x: 1 }, caller: 'device:1' }, 1001), /different action or different arguments/);
  assert.match(consumeConfirmation(c.token, { action: 'runner.drain', args: { name: 'a', x: 1 }, caller: 'device:2' }, 1001), /different caller/);
  assert.equal(consumeConfirmation(c.token, { action: 'runner.drain', args: { x: 1, name: 'a' }, caller: 'device:1' }, 1001), null);
  assert.match(consumeConfirmation(c.token, { action: 'runner.drain', args: { name: 'a', x: 1 }, caller: 'device:1' }, 1002), /unknown or expired/);
});

test('a confirmation expires after five minutes', () => {
  resetConfirmations();
  const req = { action: 'run.cancel', args: { repo: 'a/b', runId: 1 }, caller: 'master' };
  const c = issueConfirmation(req, 0);
  assert.match(consumeConfirmation(c.token, req, CONFIRM_TTL_MS), /expired/);
});
