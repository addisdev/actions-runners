// The fast loop's overlap guard. The case that matters is the one that took the
// collector down on runner-host for 19 hours: a tick whose promise never
// settles, after which every later tick was skipped as an "overlap".

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TickGuard, stage } from '../lib/tick-guard.js';

const never = () => new Promise(() => {});

// The guard's deadline timer is unref'd so it never keeps a process alive on
// its own; in the daemon the HTTP server does that. Here nothing else would, and
// Node 22's test runner cancels a test whose event loop drains while a promise
// is pending, so this stands in for the server.
let keepAlive;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeGuard(opts = {}) {
  const warnings = [];
  let clock = 0;
  const guard = new TickGuard({
    name: 'fast tick',
    deadlineMs: 20,
    abandonMs: 1000,
    maxAbandoned: 2,
    warn: (m) => warnings.push(m),
    now: () => clock,
    ...opts,
  });
  return { guard, warnings, advance: (ms) => { clock += ms; } };
}

describe('a tick that finishes', () => {
  test('runs, and the next one runs too', async () => {
    const { guard, warnings } = makeGuard();
    let ran = 0;
    assert.equal(await guard.run(async () => { ran++; }), 'ran');
    assert.equal(await guard.run(async () => { ran++; }), 'ran');
    assert.equal(ran, 2);
    assert.deepEqual(warnings, []);
  });

  test('a tick that throws is warned about and does not stop the next', async () => {
    const { guard, warnings } = makeGuard();
    assert.equal(await guard.run(async () => { throw new Error('boom'); }), 'ran');
    assert.deepEqual(warnings, ['fast tick: boom']);
    assert.equal(await guard.run(async () => {}), 'ran');
  });
});

describe('a tick that never finishes', () => {
  test('overruns its deadline, naming the stage it is stuck in', async () => {
    const { guard, warnings } = makeGuard();
    await guard.run((p) => { stage(p, 'settle completed runs'); return never(); });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^fast tick: exceeded 20ms \(in "settle completed runs" for \d+s\)$/);
  });

  test('holds the next tick back while it might still be working', async () => {
    const { guard, warnings, advance } = makeGuard();
    await guard.run(() => never());
    advance(500);
    let ran = false;
    assert.equal(await guard.run(async () => { ran = true; }), 'skipped');
    assert.equal(ran, false);
    assert.match(warnings.at(-1), /previous tick still running after 1s .*skipping overlap/);
  });

  test('is abandoned after the abandon window, and the loop carries on', async () => {
    const { guard, warnings, advance } = makeGuard();
    await guard.run((p) => { stage(p, 'jobs for 3 active runs'); return never(); });
    advance(1000);

    let ran = 0;
    assert.equal(await guard.run(async () => { ran++; }), 'ran',
      'the 2026-10-06 bug: this was skipped, and so was every tick after it');
    assert.equal(await guard.run(async () => { ran++; }), 'ran');
    assert.equal(ran, 2);
    assert.ok(warnings.some((w) => /abandoning a tick stuck for 1s \(in "jobs for 3 active runs"/.test(w)));
    assert.deepEqual(guard.state(), { running: null, abandonedPending: 1, abandonedTotal: 1 });
  });

  test('stops abandoning once too many are outstanding, and says to restart', async () => {
    const { guard, warnings, advance } = makeGuard();
    for (let i = 0; i < 3; i++) {
      await guard.run(() => never());
      advance(1000);
    }
    // Two abandoned and one more stuck: the cap is reached.
    assert.equal(guard.state().abandonedPending, 2);
    let ran = false;
    assert.equal(await guard.run(async () => { ran = true; }), 'refused');
    assert.equal(ran, false, 'a fourth leaked tick would only add to the pile');
    assert.match(warnings.at(-1), /STUCK — 2 abandoned ticks never finished .*Restart the daemon\./);
  });
});

describe('an abandoned tick that finishes late', () => {
  test('frees its place, so a later stuck tick can be abandoned again', async () => {
    const { guard, warnings, advance } = makeGuard({ deadlineMs: 5, maxAbandoned: 1 });
    let release;
    await guard.run(() => new Promise((r) => { release = r; }));
    advance(1000);
    await guard.run(async () => {});
    assert.equal(guard.state().abandonedPending, 1);

    release();
    await sleep(0);
    assert.equal(guard.state().abandonedPending, 0);
    assert.ok(warnings.some((w) => /an abandoned tick finished after/.test(w)));

    await guard.run(() => never());
    advance(1000);
    assert.equal(await guard.run(async () => {}), 'ran');
  });
});

describe('stage()', () => {
  test('is a no-op for callers that pass no progress object', () => {
    assert.doesNotThrow(() => stage(null, 'anything'));
  });
});
