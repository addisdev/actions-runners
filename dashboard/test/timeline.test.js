// The week in the ladder's terms.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { timeline, rungOf } from '../lib/timeline.js';

describe('rungOf', () => {
  test('alert rules land on the rung that explains them', () => {
    assert.equal(rungOf('launchd-dead'), 'dead-service');
    assert.equal(rungOf('stuck-queue', 'drift:stuck-queue:runner-down:web · ci'), 'dead-service');
    assert.equal(rungOf('stuck-queue', 'drift:stuck-queue:label-mismatch:ion · CI'), 'config-drift');
    assert.equal(rungOf('stuck-queue', 'drift:stuck-queue:repo-capacity:web · ci'), 'waiting');
    assert.equal(rungOf('admission-hold', 'admission:disk-floor'), 'disk-floor');
    assert.equal(rungOf('disk-floor-soon'), 'disk-floor');
    assert.equal(rungOf('host-saturated'), 'saturated');
    assert.equal(rungOf('account-blocked-recurring'), 'account-blocked');
    assert.equal(rungOf('host-stale'), 'host-down');
  });
});

describe('timeline', () => {
  test('intervals, today, the week, flaky runners and samples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-timeline-'));
    try {
      const db = openDb(join(dir, 't.db'));
      const now = Date.now();
      const H = 3600 * 1000;
      const ins = db.prepare(`INSERT INTO alerts (key, rule, severity, title, body, opened_at, closed_at, notified) VALUES (?,?,?,?,?,?,?,1)`);
      ins.run('admission:disk-floor', 'admission-hold', 'critical', 'Disk floor', '', now - 30 * H, now - 28 * H);
      ins.run('drift:launchd-dead:x', 'launchd-dead', 'critical', 'Dead', '', now - 5 * H, now - 4 * H);
      ins.run('host:pressure', 'memory-pressure', 'warning', 'Pressure', '', now - H, null);
      ins.run('api:x', 'x', 'info', 'Info', '', now - H, null);
      const job = db.prepare(`INSERT INTO jobs (id, run_id, repo, started_at, completed_at, runner_name, queued_ms, duration_ms, failure_class)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const iso = (ms) => new Date(ms).toISOString();
      job.run(1, 1, 'acme/web', iso(now - 60000), iso(now - 30000), 'h-web', 120000, 30000, null);
      job.run(2, 2, 'acme/web', iso(now - 50000), iso(now - 20000), 'h-web', 60000, 30000, 'runner-lost');
      db.prepare(`INSERT INTO host_samples (ts, load1, disk_free_gb, swapins_per_sec, busy_runners) VALUES (?,?,?,?,?)`)
        .run(now - 60000, 24, 49.3, 3, 2);
      const t = timeline(db, { days: 7, now, cores: 12 });
      assert.deepEqual(t.incidents.map((i) => i.rung), ['disk-floor', 'dead-service', 'saturated']);
      assert.equal(t.today.jobs, 2);
      assert.equal(t.today.queueMs, 180000);
      assert.equal(t.today.buildMs, 60000);
      assert.equal(t.today.lostJobs, 1);
      assert.equal(t.week.incidents, 3);
      assert.equal(t.week.mttrMs, 1.5 * H);
      assert.equal(t.week.worstWait[0].repo, 'acme/web');
      assert.deepEqual(t.flaky, [{ runner: 'h-web', lost: 1 }]);
      assert.deepEqual(t.samples[0].slice(1), [2, 3, 49.3, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
