import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobPriority, prOfRun } from '../lib/priority.js';

function harness({ repos = ['acme/app'], run = { pull_requests: [{ number: 12 }] }, labels = ['priority'] } = {}) {
  let clock = 0;
  const calls = { run: 0, labels: 0 };
  const jp = new JobPriority({
    fetchRun: async () => {
      calls.run += 1;
      if (run instanceof Error) throw run;
      return run;
    },
    fetchLabels: async () => {
      calls.labels += 1;
      if (labels instanceof Error) throw labels;
      return typeof labels === 'function' ? labels() : labels;
    },
    knownRepo: (repo) => repos.includes(repo),
    ttlMs: 1000,
    now: () => clock,
  });
  return { jp, calls, advance: (ms) => { clock += ms; } };
}

test('a run of a PR carrying the label is a priority job', async () => {
  const { jp } = harness();
  assert.deepEqual(await jp.lookup('acme/app', '42'), { priority: true, pr: 12, label: 'priority' });
});

test('labels match without regard to case, and the label can be named', async () => {
  const { jp } = harness({ labels: ['Priority', 'ci-fast'] });
  assert.equal((await jp.lookup('acme/app', '42')).priority, true);
  assert.equal((await jp.lookup('acme/app', '42', 'ci-fast')).priority, true);
  assert.equal((await jp.lookup('acme/app', '42', 'urgent')).priority, false);
});

test('a PR without the label, and a run of no PR, are not', async () => {
  assert.deepEqual(await harness({ labels: ['docs'] }).jp.lookup('acme/app', '1'),
    { priority: false, pr: 12, label: 'priority' });
  const none = harness({ run: { event: 'push', pull_requests: [] } });
  assert.deepEqual(await none.jp.lookup('acme/app', '1'), { priority: false, pr: null, label: 'priority' });
  assert.equal(none.calls.labels, 0, 'no PR, no label lookup');
});

test('the run is asked once; the labels at most once per window', async () => {
  let names = ['priority'];
  const { jp, calls, advance } = harness({ labels: () => names });
  await Promise.all([jp.lookup('acme/app', '42'), jp.lookup('acme/app', '42')]);
  advance(500);
  await jp.lookup('acme/app', '42');
  assert.deepEqual(calls, { run: 1, labels: 1 });
  names = [];
  advance(600);
  assert.equal((await jp.lookup('acme/app', '42')).priority, false, 'a removed label is seen after the window');
  assert.deepEqual(calls, { run: 1, labels: 2 });
});

test('refuses repos the fleet does not serve and malformed queries, without calling GitHub', async () => {
  const { jp, calls } = harness();
  await assert.rejects(jp.lookup('other/secret', '42'), (err) => err.status === 404);
  for (const [repo, run] of [[null, '1'], ['acme/app', null], ['acme/app/x', '1'], ['acme/app', '1; rm']]) {
    await assert.rejects(jp.lookup(repo, run), (err) => err.status === 400);
  }
  await assert.rejects(jp.lookup('acme/app', '1', 'bad\nlabel'), (err) => err.status === 400);
  assert.deepEqual(calls, { run: 0, labels: 0 });
});

test('a failed label lookup is not cached', async () => {
  const { jp, calls } = harness({ labels: new Error('boom') });
  await assert.rejects(jp.lookup('acme/app', '7'), /boom/);
  await assert.rejects(jp.lookup('acme/app', '7'), /boom/);
  assert.equal(calls.labels, 2);
});

test('prOfRun takes this repo\'s PR, not one whose base is another repo', () => {
  assert.equal(prOfRun({ pull_requests: [{ number: 3 }] }, 'acme/app'), 3);
  assert.equal(prOfRun({ pull_requests: [
    { number: 9, base: { repo: { name: 'fork', url: 'https://api.github.com/repos/other/fork' } } },
    { number: 4, base: { repo: { name: 'app', url: 'https://api.github.com/repos/acme/app' } } },
  ] }, 'acme/app'), 4);
  assert.equal(prOfRun({}, 'acme/app'), null);
  assert.equal(prOfRun(null, 'acme/app'), null);
});
