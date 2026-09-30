import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The scheduler's overlap guard, extracted exactly as fleetd.js runs it.
//
// Pinning behaviour rather than implementation: the real loop is wired into a
// 3,700-line daemon with a database, a GitHub client and a leader election, so
// reproducing it here would test the harness. What actually failed on
// 2026-09-29 was one decision — "a tick is already in flight, what now?" — and
// that decision is what this models.
//
// The bug: fastInFlight was cleared only by the task's own .finally(). A tick
// that never settles therefore blocked every later tick for the life of the
// process. One ran for 82,144 seconds while the 120s deadline "fired" on the
// first pass and changed nothing.
function makeScheduler({ deadlineMs = 120_000 } = {}) {
  let inFlight = null;
  let since = 0;
  const events = [];

  return {
    events,
    // One turn of the loop at time `now`, starting `run()` if the slot is free.
    tick(now, run) {
      if (inFlight && now - since > deadlineMs) {
        events.push({ type: 'abandoned', stuckMs: now - since });
        inFlight = null;
      }
      if (inFlight) {
        events.push({ type: 'skipped', runningMs: now - since });
        return null;
      }
      const task = run();
      inFlight = task;
      since = now;
      events.push({ type: 'started' });
      // The identity guard: a late finisher must not clear a newer slot.
      task.finally(() => { if (inFlight === task) inFlight = null; }).catch(() => {});
      return task;
    },
    get busy() { return inFlight !== null; },
  };
}

const never = () => new Promise(() => {});

describe('fast tick overlap guard', () => {
  test('a tick that never settles is abandoned once past its deadline', () => {
    const s = makeScheduler();
    s.tick(0, never);
    s.tick(45_000, never);                 // inside the deadline: skip
    assert.equal(s.events.at(-1).type, 'skipped');

    s.tick(200_000, never);                // past it: abandon and restart
    assert.equal(s.events.at(-2).type, 'abandoned');
    assert.equal(s.events.at(-1).type, 'started');
  });

  test('collection keeps going indefinitely against a permanently hung tick', () => {
    // The regression in one assertion. Before the fix this loop started
    // exactly one tick and then skipped forever, which is how a fleet went
    // 22.8 hours without a completed collection.
    const s = makeScheduler();
    let started = 0;
    for (let now = 0; now <= 3_600_000; now += 45_000) {
      if (s.tick(now, never)) started++;
    }
    assert.ok(started > 20, `expected collection to keep restarting, only started ${started}`);
  });

  test('a healthy tick is never abandoned and never double-started', async () => {
    const s = makeScheduler();
    let running = 0, maxConcurrent = 0;
    const quick = () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running);
      return Promise.resolve().then(() => { running--; });
    };
    for (let now = 0; now <= 450_000; now += 45_000) {
      const t = s.tick(now, quick);
      if (t) await t;
    }
    assert.equal(maxConcurrent, 1, 'a fast tick must never overlap itself');
    assert.ok(!s.events.some((e) => e.type === 'abandoned'));
  });

  test('an abandoned tick landing late does not clear the live slot', async () => {
    let release;
    const s = makeScheduler();
    s.tick(0, () => new Promise((r) => { release = r; }));
    s.tick(200_000, never);       // abandons the first, starts a second
    release();                     // the abandoned one finally settles
    await Promise.resolve(); await Promise.resolve();
    assert.equal(s.busy, true, 'the live tick must still hold the slot');
  });
});
