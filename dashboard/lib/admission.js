// Job admission control, as seen from the dashboard.
//
// The mechanism itself lives in ../../hooks/job-started.sh, which is the only
// thing in this fleet that can limit how many jobs RUN at once. lib/capacity.js
// explains why that gap existed: `ceiling` refuses to ADD a runner, and cannot
// stop a burst across runners that already exist — every runner listens
// independently, so if 29 of them are offered work in the same second, 29 jobs
// start, which is how this host recorded a load average of 760.
//
// This file does not make decisions. It reads the ones the hooks already made.
//
// WHY A LOG FILE AND NOT A DIRECT WRITE. The hooks run inside a CI job, as
// shell, on a machine where this process holds the database open in WAL mode. A
// second writer arriving from inside a build is a race that would only ever
// appear under concurrency — which is precisely when this feature is doing its
// job and precisely when nobody wants to debug it. So the hooks append NDJSON
// and this ingests it, which also means a hook can never be blocked by, or fail
// because of, the dashboard's database.
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Events the hooks emit. Anything else is stored verbatim but not counted, so a
// future hook change cannot break this ingest.
export const ADMISSION_EVENTS = ['admitted', 'held', 'timeout', 'released', 'would-hold', 'observed'];

export function createAdmission({ db, logPath, warn = () => {} }) {
  const insert = db.prepare(`
    INSERT INTO admission_events (ts, event, mode, runner, repo, run_id, job,
                                  waited_s, ran_s, busy, limit_n, owner_kind,
                                  owner_pid, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const stmt = {
    // The newest event per runner. If that event is a hold, the runner is
    // waiting right now — the one thing about this mechanism an operator needs
    // live rather than after the fact, because an unexplained pause before a
    // job's first step is otherwise invisible.
    latestPerRunner: db.prepare(`
      SELECT runner, repo, event, ts, reason, busy, limit_n
      FROM admission_events
      WHERE id IN (
        SELECT MAX(id) FROM admission_events WHERE runner IS NOT NULL GROUP BY runner
      )`),
    countsSince: db.prepare(`
      SELECT event, COUNT(*) AS n, SUM(COALESCE(waited_s, 0)) AS waited
      FROM admission_events WHERE ts >= ? GROUP BY event`),
    recent: db.prepare(`
      SELECT ts, event, mode, runner, repo, job, waited_s, ran_s, busy, limit_n,
             owner_kind, owner_pid, reason
      FROM admission_events ORDER BY ts DESC LIMIT ?`),
    // Restricted to rows that actually carry a mode. Reporting the newest row
    // unconditionally would let one event written without one — an older hook,
    // a hand-appended line — read as "installed but switched off" while the
    // fleet is in fact enforcing.
    last: db.prepare(`
      SELECT ts, mode, limit_n FROM admission_events
      WHERE mode IS NOT NULL AND mode != '' ORDER BY id DESC LIMIT 1`),
    // Separate query because only the hook that CLAIMS a slot resolves an owner;
    // job-completed.sh does not, so the newest row is usually a release with no
    // owner and reading the two from one row would always report none.
    lastOwner: db.prepare(`
      SELECT owner_kind FROM admission_events
      WHERE owner_kind IS NOT NULL AND owner_kind != '' ORDER BY id DESC LIMIT 1`),
    offset: db.prepare("SELECT value FROM meta WHERE key = 'admission_log_offset'"),
    setOffset: db.prepare(`
      INSERT INTO meta(key, value) VALUES('admission_log_offset', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  // Without this the dashboard cannot tell "installed but switched off" from
  // "never installed". Both look like an empty event log and they need
  // completely different responses, so the distinction is worth 29 file reads
  // on the slow loop.
  let installed = { installed: 0, total: 0, checkedAt: null };

  return {
    /**
     * Reads only the bytes appended since the last pass, so this stays cheap on
     * the fast loop however large the file grows.
     * @returns {number} rows inserted
     */
    ingest() {
      if (!existsSync(logPath)) return 0;
      const size = statSync(logPath).size;
      let offset = Number(stmt.offset.get()?.value ?? 0) || 0;
      // Smaller than the cursor means the file was rotated or truncated.
      // Reading from the old offset would land mid-line and stay wrong forever.
      if (size < offset) offset = 0;
      if (size <= offset) return 0;

      const fd = openSync(logPath, 'r');
      let text = '';
      try {
        const buf = Buffer.allocUnsafe(size - offset);
        const read = readSync(fd, buf, 0, buf.length, offset);
        text = buf.subarray(0, read).toString('utf8');
      } finally {
        closeSync(fd);
      }

      // Consume only up to the last newline. A hook may be mid-append, and half
      // an object would otherwise be parsed, dropped, and never seen again
      // because the cursor had already moved past it.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return 0;
      const consumed = text.slice(0, lastNl + 1);

      let n = 0;
      for (const line of consumed.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          insert.run(
            // The hooks are shell and emit epoch seconds. Everything else in
            // this database is milliseconds.
            Number(e.ts) ? Number(e.ts) * 1000 : Date.now(),
            String(e.event ?? 'unknown'),
            e.mode ?? null, e.runner ?? null, e.repo ?? null,
            e.run != null ? String(e.run) : null,
            e.job ?? null,
            Number.isFinite(Number(e.waited_s)) ? Number(e.waited_s) : null,
            Number.isFinite(Number(e.ran_s)) ? Number(e.ran_s) : null,
            Number.isFinite(Number(e.busy)) ? Number(e.busy) : null,
            Number.isFinite(Number(e.limit)) ? Number(e.limit) : null,
            // `owner` is the old key, which carried the kind. Accepted so a log
            // written before the rename still reads correctly rather than
            // silently reporting no owner at all.
            e.owner_kind || e.owner || null,
            e.owner_pid || null,
            e.reason || null
          );
          n += 1;
        } catch (err) {
          // One malformed row must not stop the cursor advancing, or the same
          // bad line is retried on every tick for the life of the process.
          warn('admission row:', err.message);
        }
      }
      stmt.setOffset.run(String(offset + Buffer.byteLength(consumed, 'utf8')));
      return n;
    },

    countInstalled(dirs) {
      let count = 0;
      for (const d of dirs) {
        try {
          const env = readFileSync(join(d.dir, '.env'), 'utf8');
          if (env.includes('ACTIONS_RUNNER_HOOK_JOB_STARTED=')) count += 1;
        } catch {
          // No .env, or unreadable. Counts as not installed, which is true.
        }
      }
      installed = { installed: count, total: dirs.length, checkedAt: Date.now() };
      return installed;
    },

    summary() {
      const since = Date.now() - 24 * 3600 * 1000;
      const counts = {};
      let heldSeconds = 0;
      for (const row of stmt.countsSince.all(since)) {
        counts[row.event] = row.n;
        // Only a wait that ended in the job starting is time the mechanism
        // actually cost. A `held` row is the announcement of a wait, not the
        // wait itself — its waited_s is 0 by construction.
        if (row.event === 'admitted' || row.event === 'timeout') heldSeconds += row.waited ?? 0;
      }
      const last = stmt.last.get();
      const waiting = stmt.latestPerRunner
        .all()
        .filter((r) => r.event === 'held')
        .map((r) => ({
          runner: r.runner,
          repo: r.repo,
          since: r.ts,
          reason: r.reason,
          busy: r.busy,
          limit: r.limit_n,
        }));
      return {
        // Reported from the events rather than from configuration. fleet.env is
        // read by the hooks inside a job, not by this process, so the events are
        // the only honest source for what mode is actually in force.
        mode: last?.mode ?? null,
        limit: last?.limit_n ?? null,
        lastDecisionAt: last?.ts ?? null,
        // 'fallback' means a hook could not find a Runner.Worker ancestor to
        // own its slot. Admission still functions, but it is the one condition
        // that can silently under-count concurrency, so it is surfaced here
        // rather than left to be inferred from an absence of holds.
        ownerKind: stmt.lastOwner.get()?.owner_kind ?? null,
        hooks: installed,
        last24h: counts,
        heldSeconds,
        waiting,
      };
    },

    recent(limit = 60) {
      return stmt.recent.all(Math.min(Number(limit) || 60, 500));
    },
  };
}
