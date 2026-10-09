import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerProcesses } from '../lib/local.js';

// `ps -axo pid=,rss=,etime=,command=` as it reads on a host whose runners have
// updated themselves: the listener under bin/, the worker under bin.<version>/.
const PS = [
  '31519  98304 02:11:05 /Users/me/actions-runners/app-ios/bin/Runner.Listener run --startuptype service',
  '71823 412000    01:12 /Users/me/actions-runners/app-ios/bin.2.337.0/Runner.Worker spawnclient 156 161',
  '97830  97000 02:10:59 /Users/me/actions-runners/app-ios-2/bin/Runner.Listener run --startuptype service',
  '80001  50000    00:05 /Users/me/actions-runners/app-web/bin/Runner.Worker spawnclient 150 153',
  '  123   1000    00:01 /usr/bin/grep Runner.Worker',
].join('\n');

describe('parseRunnerProcesses', () => {
  test('finds a worker started from a versioned bin directory', () => {
    const { listeners, workers } = parseRunnerProcesses(PS);
    assert.ok(workers.has('/Users/me/actions-runners/app-ios'));
    assert.equal(workers.get('/Users/me/actions-runners/app-ios').pid, 71823);
    assert.ok(workers.has('/Users/me/actions-runners/app-web'));
    assert.equal(workers.size, 2);
    assert.ok(listeners.has('/Users/me/actions-runners/app-ios'));
    assert.ok(listeners.has('/Users/me/actions-runners/app-ios-2'));
  });

  test('a busy runner does not make its -2 sibling look busy', () => {
    const { workers } = parseRunnerProcesses(PS);
    assert.ok(!workers.has('/Users/me/actions-runners/app-ios-2'));
  });
});
