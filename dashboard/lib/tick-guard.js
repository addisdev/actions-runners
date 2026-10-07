// Keeps a periodic task from overlapping itself without letting one tick that
// never finishes stop the loop.
//
// The fast loop used to skip a tick whenever the previous one was still
// running. That prevents overlap, and it also means a tick whose promise never
// settles stops collection for good: on runner-host a tick blew its deadline at
// 2026-10-06 16:31Z and every tick for the next 19 hours was skipped as an
// "overlap", 1,034 of them on 10-07 alone, while the daemon held no socket, pipe
// or child process that the tick could have been waiting on. The dashboard
// looked alive only because the slow loop calls the tick directly.
//
// So a stuck tick is waited out for a bounded time and then abandoned: the next
// one starts while the old promise is left to finish or not. There is no way to
// cancel a promise, and every write a tick makes is an upsert keyed by id, so a
// late finisher costs duplicated effort rather than a corrupted row. Abandoned
// ticks that never settle still hold their memory, so only a few may be
// outstanding at once; past that the guard goes back to skipping and says, every
// time, that the process needs a restart.
//
// Each tick is handed a progress object to stamp its current stage into, so
// every warning names where the tick was when it overran or got stuck.

export class TickGuard {
  constructor({ name, deadlineMs, abandonMs = deadlineMs * 2, maxAbandoned = 3, warn, now = Date.now }) {
    this.name = name;
    this.deadlineMs = deadlineMs;
    this.abandonMs = abandonMs;
    this.maxAbandoned = maxAbandoned;
    this.warn = warn;
    this.now = now;
    this.current = null; // { task, progress, startedAt }
    this.abandoned = new Set(); // ticks given up on that have not settled yet
    this.abandonedTotal = 0;
  }

  where(tick) {
    const p = tick.progress;
    if (!p.stage) return 'before its first stage';
    return `in "${p.stage}" for ${Math.round((this.now() - p.stageSince) / 1000)}s`;
  }

  // Starts fn(progress) unless the previous tick is still inside its abandon
  // window, then waits for it up to the deadline. Resolves with 'ran',
  // 'skipped' or 'refused'; a tick that throws or overruns is warned about, not
  // rethrown, because the caller's only job is to schedule the next one.
  async run(fn) {
    if (this.current) {
      const age = this.now() - this.current.startedAt;
      if (age < this.abandonMs) {
        this.warn(`${this.name}: previous tick still running after ${Math.round(age / 1000)}s ` +
          `(${this.where(this.current)}); skipping overlap`);
        return 'skipped';
      }
      if (this.abandoned.size >= this.maxAbandoned) {
        this.warn(`${this.name}: STUCK — ${this.abandoned.size} abandoned ticks never finished and the ` +
          `current one has run ${Math.round(age / 1000)}s (${this.where(this.current)}); ` +
          'not starting another. Restart the daemon.');
        return 'refused';
      }
      this.warn(`${this.name}: abandoning a tick stuck for ${Math.round(age / 1000)}s ` +
        `(${this.where(this.current)}); starting a fresh one`);
      this.abandoned.add(this.current);
      this.abandonedTotal++;
      this.current = null;
    }

    const progress = { stage: null, stageSince: null, now: this.now };
    const tick = { progress, startedAt: this.now(), task: null };
    tick.task = Promise.resolve().then(() => fn(progress));
    this.current = tick;
    tick.task.catch(() => {}).finally(() => {
      if (this.current === tick) this.current = null;
      if (this.abandoned.delete(tick)) {
        this.warn(`${this.name}: an abandoned tick finished after ${Math.round((this.now() - tick.startedAt) / 1000)}s`);
      }
    });

    let timer;
    try {
      await Promise.race([
        tick.task,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { deadline: true })), this.deadlineMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      this.warn(err.deadline
        ? `${this.name}: exceeded ${this.deadlineMs}ms (${this.where(tick)})`
        : `${this.name}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    return 'ran';
  }

  state() {
    return {
      running: this.current ? { forMs: this.now() - this.current.startedAt, stage: this.current.progress.stage } : null,
      abandonedPending: this.abandoned.size,
      abandonedTotal: this.abandonedTotal,
    };
  }
}

// Marks the stage a tick is in. A no-op for callers that pass no progress object.
export function stage(progress, name) {
  if (!progress) return;
  progress.stage = name;
  progress.stageSince = (progress.now ?? Date.now)();
}
