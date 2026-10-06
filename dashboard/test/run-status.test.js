import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStatus } from '../lib/run-status.js';

function harness({ repos = ['acme/app'], run = { status: 'completed', conclusion: 'cancelled' } } = {}) {
  let clock = 0;
  const calls = [];
  const rs = new RunStatus({
    fetchRun: async (repo, runId) => {
      calls.push(`${repo}#${runId}`);
      if (run instanceof Error) throw run;
      return run;
    },
    knownRepo: (repo) => repos.includes(repo),
    ttlMs: 1000,
    now: () => clock,
  });
  return { rs, calls, advance: (ms) => { clock += ms; } };
}

test('answers status and conclusion for a fleet repo', async () => {
  const { rs } = harness();
  assert.deepEqual(await rs.lookup('acme/app', '42'), { status: 'completed', conclusion: 'cancelled' });
});

test('many pollers inside the window cost one GitHub request', async () => {
  const { rs, calls, advance } = harness();
  await Promise.all([rs.lookup('acme/app', '42'), rs.lookup('acme/app', '42')]);
  advance(500);
  await rs.lookup('acme/app', '42');
  assert.equal(calls.length, 1);
  advance(600);
  await rs.lookup('acme/app', '42');
  assert.equal(calls.length, 2);
});

test('refuses repos the fleet does not serve, without calling GitHub', async () => {
  const { rs, calls } = harness();
  await assert.rejects(rs.lookup('other/secret', '42'), (err) => err.status === 404);
  assert.equal(calls.length, 0);
});

test('rejects malformed queries', async () => {
  const { rs } = harness();
  for (const [repo, run] of [[null, '1'], ['acme/app', null], ['acme/app/x', '1'], ['acme/app', '1; rm']]) {
    await assert.rejects(rs.lookup(repo, run), (err) => err.status === 400);
  }
});

test('a failed lookup is not cached', async () => {
  const { rs, calls } = harness({ run: new Error('boom') });
  await assert.rejects(rs.lookup('acme/app', '7'), /boom/);
  await assert.rejects(rs.lookup('acme/app', '7'), /boom/);
  assert.equal(calls.length, 2);
});
