import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import {
  buildDurationBaselines,
  annotateActiveRuns,
  annotateActiveFromDb,
  percentile,
  thresholdMs,
  resolveBaseline,
  longRunningAlertFindings,
  DEFAULTS,
} from '../lib/long-running.js';

const dirs = [];
let db;

function insertCompletedRun(id, repo, workflow, startedAt, durationMs) {
  db.prepare(`
    INSERT INTO runs (id, repo, workflow_name, status, conclusion, run_started_at, duration_ms)
    VALUES (?, ?, ?, 'completed', 'success', ?, ?)`).run(id, repo, workflow, startedAt, durationMs);
}

function activeRun(id, repo, workflow, startedAt, status = 'in_progress') {
  return {
    id,
    repo,
    workflowName: workflow,
    status,
    startedAt,
    url: `https://github.com/${repo}/actions/runs/${id}`,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'long-running-'));
  dirs.push(dir);
  db = openDb(join(dir, 'test.db'));
});

after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('percentile and threshold', () => {
  test('p95 of ten values picks the 95th rank', () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    assert.equal(percentile(sorted, 95), 1000);
    assert.equal(percentile(sorted, 50), 500);
  });

  test('thresholdMs applies multiplier then floor', () => {
    assert.equal(thresholdMs(600000, { multiplier: 1.5, floorMs: 900000 }), 900000);
    assert.equal(thresholdMs(800000, { multiplier: 1.5, floorMs: 900000 }), 1200000);
  });
});

describe('buildDurationBaselines', () => {
  test('builds workflow baseline from completed runs in the lookback window', () => {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    for (let i = 0; i < 5; i++) {
      insertCompletedRun(100 + i, 'org/web', 'CI', since, (i + 1) * 60000);
    }

    const bl = buildDurationBaselines(db, { minSamples: 3, percentile: 95 });
    const wf = bl.byWorkflow.get('org/web\u0000CI');
    assert.ok(wf);
    assert.equal(wf.expectedMs, 300000);
    assert.equal(wf.n, 5);
    assert.equal(wf.scope, 'workflow');
  });

  test('degrades to repo baseline when workflow history is sparse', () => {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    insertCompletedRun(1, 'org/web', 'CI', since, 120000);
    insertCompletedRun(2, 'org/web', 'Deploy', since, 180000);
    insertCompletedRun(3, 'org/web', 'Deploy', since, 240000);

    const bl = buildDurationBaselines(db, { minSamples: 3, percentile: 95 });
    assert.equal(bl.byWorkflow.has('org/web\u0000CI'), false);
    const repo = bl.byRepo.get('org/web');
    assert.ok(repo);
    assert.equal(repo.scope, 'repo');
    assert.equal(resolveBaseline(bl, 'org/web', 'CI').scope, 'repo');
  });

  test('returns empty baselines safely when db has no history', () => {
    const bl = buildDurationBaselines(db);
    assert.equal(bl.byWorkflow.size, 0);
    assert.equal(bl.fleet.expectedMs, null);
  });
});

describe('annotateActiveRuns', () => {
  test('flags in-progress run when elapsed exceeds threshold', () => {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    for (let i = 0; i < 5; i++) {
      insertCompletedRun(200 + i, 'org/app', 'Build', since, 600000);
    }
    const bl = buildDurationBaselines(db, { minSamples: 3 });

    const now = Date.now();
    const startedAt = new Date(now - 20 * 60 * 1000).toISOString();
    const active = [activeRun(999, 'org/app', 'Build', startedAt)];

    annotateActiveRuns(active, bl, { multiplier: 1.5, floorMs: 900000, now });

    assert.equal(active[0].expectedDurationMs, 600000);
    assert.equal(active[0].thresholdMs, 900000);
    assert.ok(active[0].elapsedMs >= 19 * 60 * 1000);
    assert.equal(active[0].longRunning, true);
    assert.match(active[0].reason, /exceeds/);
  });

  test('does not flag when elapsed is under threshold', () => {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    for (let i = 0; i < 5; i++) {
      insertCompletedRun(300 + i, 'org/app', 'Build', since, 600000);
    }
    const bl = buildDurationBaselines(db, { minSamples: 3 });

    const now = Date.now();
    const startedAt = new Date(now - 5 * 60 * 1000).toISOString();
    const active = [activeRun(888, 'org/app', 'Build', startedAt)];

    annotateActiveRuns(active, bl, { multiplier: 1.5, floorMs: 900000, now });

    assert.equal(active[0].longRunning, false);
    assert.equal(active[0].reason, null);
  });

  test('leaves queued runs unflagged', () => {
    const active = [activeRun(777, 'org/app', 'Build', new Date().toISOString(), 'queued')];
    annotateActiveRuns(active, buildDurationBaselines(db));
    assert.equal(active[0].longRunning, false);
    assert.equal(active[0].elapsedMs, null);
  });

  test('annotateActiveFromDb end-to-end', () => {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    for (let i = 0; i < 4; i++) {
      insertCompletedRun(400 + i, 'org/x', 'Test', since, 300000);
    }
    const now = Date.now();
    const active = [activeRun(555, 'org/x', 'Test', new Date(now - 30 * 60 * 1000).toISOString())];
    annotateActiveFromDb(db, active, { now, multiplier: 1.5, floorMs: 600000, minSamples: 3 });
    assert.equal(active[0].longRunning, true);
  });
});

describe('longRunningAlertFindings', () => {
  test('emits one finding per flagged active run', () => {
    const active = [{
      id: 42,
      repo: 'org/web',
      workflowName: 'CI',
      status: 'in_progress',
      longRunning: true,
      elapsedMs: 1200000,
      expectedDurationMs: 600000,
      thresholdMs: 900000,
      reason: 'elapsed 1200000ms exceeds threshold',
      url: 'https://github.com/org/web/actions/runs/42',
    }];
    const findings = longRunningAlertFindings(active);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, 'run:long-running:42');
    assert.equal(findings[0].rule, 'long-running-job');
    assert.match(findings[0].title, /web · CI running long/);
  });
});
