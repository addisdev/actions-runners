import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { analytics } from '../lib/analytics.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const dirs = [];
let db;

function insertRun(id, repo, workflow, startedAt) {
  db.prepare(`
    INSERT INTO runs (id, repo, workflow_name, status, conclusion, run_started_at, duration_ms)
    VALUES (?, ?, ?, 'completed', 'success', ?, 600000)`).run(id, repo, workflow, startedAt);
}

function insertJob(id, runId, repo, name, workflow, startedAt, opts = {}) {
  db.prepare(`
    INSERT INTO jobs (id, run_id, repo, name, status, conclusion, started_at, completed_at,
                      runner_name, queued_ms, duration_ms)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`).run(
    id, runId, repo, name,
    opts.conclusion ?? 'success',
    startedAt,
    opts.completedAt ?? startedAt,
    opts.runnerName ?? 'host-web',
    opts.queuedMs ?? 5000,
    opts.durationMs ?? 120000,
  );
}

function insertStep(jobId, number, name, durationMs) {
  db.prepare(`
    INSERT INTO steps (job_id, number, name, status, conclusion, duration_ms)
    VALUES (?, ?, ?, 'completed', 'success', ?)`).run(jobId, number, name, durationMs);
}

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-'));
  dirs.push(dir);
  db = openDb(join(dir, 'test.db'));

  const since = new Date(Date.now() - 5 * 86400000).toISOString();

  insertRun(1, 'testowner/project-web', 'Web E2E', since);
  insertJob(101, 1, 'testowner/project-web', 'smoke', 'Web E2E', since, {
    durationMs: 180000,
    queuedMs: 10000,
  });
  insertStep(101, 1, 'Install Chromium', 90000);
  insertStep(101, 2, 'Run smoke tests', 80000);

  insertRun(2, 'testowner/project-web', 'Web E2E', since);
  insertJob(102, 2, 'testowner/project-web', 'smoke', 'Web E2E', since, {
    conclusion: 'failure',
    durationMs: 200000,
    queuedMs: 2000,
  });
  insertStep(102, 1, 'Install Chromium', 120000);
  insertStep(102, 2, 'Run smoke tests', 70000);

  insertRun(3, 'testowner/app-ios', 'CI', since);
  insertJob(103, 3, 'testowner/app-ios', 'build', 'CI', since, {
    durationMs: 300000,
  });
  insertStep(103, 1, 'Build', 280000);
  insertStep(103, 2, 'Install Chromium', 45000);
});

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('playwright analytics', () => {
  test('aggregates browser install steps and E2E job metrics', () => {
    const data = analytics(db, { days: 30 });
    assert.ok(data.playwright, 'expected playwright section');

    const bi = data.playwright.browserInstall;
    assert.equal(bi.count, 2);
    assert.equal(bi.p50, 90000);
    assert.equal(bi.p95, 120000);

    const e2e = data.playwright.e2eJobs;
    assert.equal(e2e.count, 2);
    assert.equal(e2e.successes, 1);
    assert.equal(e2e.failures, 1);
    assert.equal(e2e.successRate, 0.5);
    assert.equal(e2e.p50Duration, 180000);
    assert.equal(e2e.p50Queue, 2000);
    assert.equal(e2e.p95Queue, 10000);
  });

  test('does not count unrelated iOS jobs as E2E', () => {
    const data = analytics(db, { days: 30 });
    assert.equal(data.playwright.e2eJobs.count, 2);
    assert.equal(data.playwright.browserInstall.count, 2);
  });

  test('returns empty playwright metrics when nothing matches', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'analytics-empty-'));
    dirs.push(emptyDir);
    const emptyDb = openDb(join(emptyDir, 'test.db'));
    const data = analytics(emptyDb, { days: 30 });
    assert.equal(data.playwright.browserInstall.count, 0);
    assert.equal(data.playwright.e2eJobs.count, 0);
    assert.equal(data.playwright.e2eJobs.successRate, null);
  });

  test('playwright.flakyTests is an array', () => {
    const result = analytics(db);
    assert.ok(Array.isArray(result.playwright.flakyTests));
  });
});

describe('analytics UI contract', () => {
  test('public analytics.js wires the Playwright panel to API fields', () => {
    const src = readFileSync(join(HERE, '..', 'public', 'analytics.js'), 'utf8');
    assert.match(src, /playwrightPanel/);
    assert.match(src, /browserInstall\.count/);
    assert.match(src, /e2eJobs\.successRate/);
    assert.match(src, /e2eJobs\.p50Queue/);
  });
});
