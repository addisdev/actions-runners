import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sh } from '../lib/local.js';

// sh() is the first thing the fast tick awaits. It is tested on its own because
// the failure that mattered was not a wrong value but a promise that never
// settled: the tick never returned, the loop never re-armed, and collection
// stopped for the rest of the process's life.

describe('sh', () => {
  test('returns stdout for a command that works', async () => {
    const out = await sh('echo', ['hello']);
    assert.equal(out.trim(), 'hello');
  });

  test('returns empty for a command that does not exist', async () => {
    assert.equal(await sh('definitely-not-a-real-binary-xyz', []), '');
  });

  test('returns empty for a command that exits non-zero', async () => {
    assert.equal(await sh('false', []), '');
  });

  // The real hang. bash exits immediately but leaves a backgrounded child
  // holding the inherited stdout pipe, so the stdio EOF execFile waits for
  // never arrives — killing the direct child does not help, because it has
  // already exited. Before the deadline this await simply never came back.
  test('settles even when a grandchild holds the pipe open', async () => {
    const started = Date.now();
    const out = await sh('bash', ['-c', 'sleep 30 & exit 0'], 500);
    const elapsed = Date.now() - started;

    assert.equal(out, '');
    assert.ok(elapsed < 10000, `should give up promptly, took ${elapsed}ms`);
  });

  // A process that ignores SIGTERM outlives execFile's own timeout, which is
  // why the kill signal is SIGKILL.
  test('settles for a child that ignores SIGTERM', async () => {
    const started = Date.now();
    const out = await sh('bash', ['-c', 'trap "" TERM; sleep 30'], 500);
    const elapsed = Date.now() - started;

    assert.equal(out, '');
    assert.ok(elapsed < 10000, `should give up promptly, took ${elapsed}ms`);
  });
});
