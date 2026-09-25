import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { remediationCandidates, classifyRun, SAFE_EVENTS, MAX_CANDIDATE_AGE_MS } from '../lib/remediation.js';

const dirs = [];
let db;

// ---------------------------------------------------------------------------
// Helpers

function insertRun(id, repo, workflow, startedAt, opts = {}) {
  db.prepare(`
    INSERT INTO runs (id, repo, workflow_name, workflow_path, status, conclusion,
                      head_branch, head_sha, event, html_url, run_attempt,
                      pr_number, actor, run_started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, repo, workflow,
    opts.workflowPath ?? `.github/workflows/${workflow.toLowerCase().replace(/\s+/g, '-')}.yml`,
    opts.status ?? 'completed',
    opts.conclusion ?? 'failure',
    opts.branch ?? 'main',
    opts.sha ?? `sha${id}`,
    opts.event ?? 'push',
    opts.url ?? `https://github.com/${repo}/actions/runs/${id}`,
    opts.runAttempt ?? 1,
    opts.prNumber ?? null,
    opts.actor ?? 'dev',
    startedAt,
  );
}

function insertJob(id, runId, repo, opts = {}) {
  db.prepare(`
    INSERT INTO jobs (id, run_id, repo, name, status, conclusion, started_at,
                      completed_at, failure_class, failure_detail, runner_name, html_url)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`).run(
    id, runId, repo,
    opts.name ?? `job-${id}`,
    opts.conclusion ?? 'failure',
    opts.startedAt ?? new Date().toISOString(),
    opts.completedAt ?? new Date().toISOString(),
    opts.failureClass ?? null,
    opts.failureDetail ?? null,
    opts.runnerName ?? 'host-1',
    opts.url ?? `https://github.com/${repo}/actions/runs/${runId}/jobs/${id}`,
  );
}

function recentIso(offsetMs = 0) {
  return new Date(Date.now() - offsetMs).toISOString();
}

// ---------------------------------------------------------------------------

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'remediation-'));
  dirs.push(dir);
  db = openDb(join(dir, 'test.db'));

  // Insert a repo record so the JOIN in remediationCandidates can find default_branch.
  db.prepare(`INSERT OR IGNORE INTO repos (full_name, name, default_branch, archived, private, workflows, has_runner)
              VALUES (?, ?, ?, 0, 0, 1, 1)`).run('org/repo-a', 'repo-a', 'main');
  db.prepare(`INSERT OR IGNORE INTO repos (full_name, name, default_branch, archived, private, workflows, has_runner)
              VALUES (?, ?, ?, 0, 0, 1, 1)`).run('org/repo-b', 'repo-b', 'main');
});

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classifyRun unit tests

describe('classifyRun — policy', () => {
  test('unsupported event returns skip', () => {
    assert.equal(classifyRun({ event: 'repository_dispatch' }, [{ conclusion: 'failure', failure_class: 'job-failed' }]), 'skip');
    assert.equal(classifyRun({ event: 'deployment' }, [{ conclusion: 'failure', failure_class: 'job-failed' }]), 'skip');
  });

  test('safe events are allowed', () => {
    for (const ev of SAFE_EVENTS) {
      const result = classifyRun(
        { event: ev },
        [{ conclusion: 'failure', failure_class: 'runner-lost' }],
      );
      assert.notEqual(result, 'skip', `event ${ev} should not be skipped`);
    }
  });

  test('no jobs returns diagnose', () => {
    assert.equal(classifyRun({ event: 'push' }, []), 'diagnose');
  });

  test('no failed jobs returns skip', () => {
    const jobs = [{ conclusion: 'success', failure_class: null }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'skip');
  });

  test('job row with no conclusion yet returns diagnose, not skip', () => {
    // The run is recorded as failed but backfill has not yet written the job
    // outcome. Skipping would hide it; diagnose surfaces it and lets a later
    // sweep reclassify once the conclusion lands.
    assert.equal(classifyRun({ event: 'push' }, [{ conclusion: null, failure_class: null }]), 'diagnose');
    assert.equal(
      classifyRun({ event: 'push' }, [
        { conclusion: 'success', failure_class: null },
        { conclusion: null, failure_class: null },
      ]),
      'diagnose',
    );
  });

  test('null failure_class (unclassified) returns diagnose', () => {
    const jobs = [
      { conclusion: 'failure', failure_class: null },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('account-blocked returns diagnose', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'account-blocked' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('account-quota returns diagnose', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'account-quota' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('unknown (expired annotations) returns diagnose', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'unknown' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('all runner-lost returns infra-rerun', () => {
    const jobs = [
      { conclusion: 'failure', failure_class: 'runner-lost' },
      { conclusion: 'failure', failure_class: 'runner-lost' },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'infra-rerun');
  });

  test('single runner-lost job returns infra-rerun', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'runner-lost' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'infra-rerun');
  });

  test('job-failed returns ai-fix', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'job-failed' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'ai-fix');
  });

  test('no-runner returns ai-fix', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'no-runner' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'ai-fix');
  });

  test('mixed runner-lost and job-failed returns diagnose (conservative)', () => {
    const jobs = [
      { conclusion: 'failure', failure_class: 'runner-lost' },
      { conclusion: 'failure', failure_class: 'job-failed' },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('job-failed mixed with no-runner returns ai-fix', () => {
    const jobs = [
      { conclusion: 'failure', failure_class: 'job-failed' },
      { conclusion: 'failure', failure_class: 'no-runner' },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'ai-fix');
  });

  test('account-blocked mixed with job-failed returns diagnose (account wins)', () => {
    const jobs = [
      { conclusion: 'failure', failure_class: 'account-blocked' },
      { conclusion: 'failure', failure_class: 'job-failed' },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('null mixed with runner-lost returns diagnose (incomplete classification wins)', () => {
    const jobs = [
      { conclusion: 'failure', failure_class: null },
      { conclusion: 'failure', failure_class: 'runner-lost' },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'diagnose');
  });

  test('timed_out jobs are treated as failures for classification', () => {
    const jobs = [{ conclusion: 'timed_out', failure_class: 'runner-lost' }];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'infra-rerun');
  });

  test('success jobs are excluded from failure class set', () => {
    // Only the failed job matters; success jobs have null class and should be ignored.
    const jobs = [
      { conclusion: 'success', failure_class: null },
      { conclusion: 'failure', failure_class: 'runner-lost' },
    ];
    assert.equal(classifyRun({ event: 'push' }, jobs), 'infra-rerun');
  });

  test('null event is allowed (not all events have type)', () => {
    const jobs = [{ conclusion: 'failure', failure_class: 'runner-lost' }];
    assert.equal(classifyRun({ event: null }, jobs), 'infra-rerun');
    assert.equal(classifyRun({}, jobs), 'infra-rerun');
  });
});

// ---------------------------------------------------------------------------
// remediationCandidates integration tests

describe('remediationCandidates — candidate selection', () => {
  before(() => {
    // Run 100: runner-lost, recent
    insertRun(100, 'org/repo-a', 'CI', recentIso(10 * 60_000));
    insertJob(1001, 100, 'org/repo-a', { failureClass: 'runner-lost' });

    // Run 101: job-failed, recent
    insertRun(101, 'org/repo-a', 'Deploy', recentIso(20 * 60_000));
    insertJob(1011, 101, 'org/repo-a', { failureClass: 'job-failed' });

    // Run 102: account-blocked, recent
    insertRun(102, 'org/repo-b', 'Build', recentIso(15 * 60_000));
    insertJob(1021, 102, 'org/repo-b', { failureClass: 'account-blocked' });

    // Run 103: TOO OLD — outside the 2-hour window
    insertRun(103, 'org/repo-a', 'Nightly', recentIso(3 * 60 * 60_000));
    insertJob(1031, 103, 'org/repo-a', { failureClass: 'runner-lost' });

    // Run 104: unclassified (NULL failure_class)
    insertRun(104, 'org/repo-b', 'Lint', recentIso(5 * 60_000));
    insertJob(1041, 104, 'org/repo-b', { failureClass: null });

    // Run 105: successful (should not appear)
    insertRun(105, 'org/repo-a', 'Smoke', recentIso(8 * 60_000), { conclusion: 'success' });
    insertJob(1051, 105, 'org/repo-a', { conclusion: 'success', failureClass: null });

    // Run 106: two attempts; run 106 is the older (attempt 1), run 107 is newer (attempt 2)
    // Only the latest should be returned per workflow.
    insertRun(106, 'org/repo-b', 'Integration', recentIso(60 * 60_000), { runAttempt: 1 });
    insertJob(1061, 106, 'org/repo-b', { failureClass: 'runner-lost' });
    insertRun(107, 'org/repo-b', 'Integration', recentIso(30 * 60_000), { runAttempt: 2 });
    insertJob(1071, 107, 'org/repo-b', { failureClass: 'runner-lost' });
  });

  test('returns candidates within the time window', () => {
    const candidates = remediationCandidates(db);
    const runIds = candidates.map((c) => c.runId);
    assert.ok(runIds.includes(100), 'should include run 100 (runner-lost)');
    assert.ok(runIds.includes(101), 'should include run 101 (job-failed)');
  });

  test('excludes runs outside the time window', () => {
    const candidates = remediationCandidates(db);
    const runIds = candidates.map((c) => c.runId);
    assert.ok(!runIds.includes(103), 'should NOT include run 103 (too old)');
  });

  test('excludes successful runs', () => {
    const candidates = remediationCandidates(db);
    const runIds = candidates.map((c) => c.runId);
    assert.ok(!runIds.includes(105), 'should NOT include run 105 (success)');
  });

  test('assigns correct strategies', () => {
    const candidates = remediationCandidates(db);
    const byId = Object.fromEntries(candidates.map((c) => [c.runId, c]));

    assert.equal(byId[100]?.strategy, 'infra-rerun');
    assert.equal(byId[101]?.strategy, 'ai-fix');
    assert.equal(byId[102]?.strategy, 'diagnose');
    assert.equal(byId[104]?.strategy, 'diagnose');
  });

  test('returns only the latest attempt per workflow', () => {
    const candidates = remediationCandidates(db);
    const runIds = candidates.map((c) => c.runId);
    // Run 107 (attempt 2) is newer than 106 (attempt 1); only 107 should appear.
    assert.ok(runIds.includes(107), 'should include run 107 (latest attempt)');
    assert.ok(!runIds.includes(106), 'should NOT include run 106 (earlier attempt)');
  });

  test('respects custom maxAgeMs', () => {
    const candidates = remediationCandidates(db, { maxAgeMs: 12 * 60_000 });
    const runIds = candidates.map((c) => c.runId);
    // Run 100 is 10 minutes old → in window
    assert.ok(runIds.includes(100));
    // Run 101 is 20 minutes old → out of 12-minute window
    assert.ok(!runIds.includes(101));
  });

  test('each candidate has required fields', () => {
    const candidates = remediationCandidates(db);
    assert.ok(candidates.length > 0);
    for (const c of candidates) {
      assert.ok(typeof c.repo === 'string', 'has repo');
      assert.ok(typeof c.runId === 'number', 'has runId');
      assert.ok(typeof c.runAttempt === 'number', 'has runAttempt');
      assert.ok(c.runStartedAt == null || typeof c.runStartedAt === 'string', 'has runStartedAt');
      assert.ok(['infra-rerun', 'ai-fix', 'diagnose', 'skip'].includes(c.strategy), `strategy is valid: ${c.strategy}`);
      assert.ok(Array.isArray(c.jobs), 'has jobs array');
    }
  });

  test('runStartedAt is returned for bridge age gates', () => {
    const startedAt = recentIso(10 * 60_000);
    insertRun(109, 'org/repo-a', 'AgeGate', startedAt);
    insertJob(1091, 109, 'org/repo-a', { failureClass: 'runner-lost' });

    const candidate = remediationCandidates(db).find((c) => c.runId === 109);
    assert.ok(candidate, 'run 109 present');
    assert.equal(candidate.runStartedAt, startedAt);
  });

  test('jobs include only positive-id rows', () => {
    // Negative ids are placeholder markers from backfill failures — should be excluded.
    db.prepare(`INSERT INTO jobs (id, run_id, repo, name, status, conclusion, started_at)
                VALUES (-9999, 100, 'org/repo-a', '(detail unavailable)', 'completed', 'skipped', ?)`).run(
      new Date().toISOString(),
    );
    const candidates = remediationCandidates(db);
    const run100 = candidates.find((c) => c.runId === 100);
    assert.ok(run100, 'run 100 is present');
    const negIds = run100.jobs.filter((j) => j.id < 0);
    assert.equal(negIds.length, 0, 'no negative-id placeholder jobs');
  });

  test('failure_detail is truncated to 500 chars', () => {
    const longDetail = 'x'.repeat(1000);
    insertRun(108, 'org/repo-a', 'LongDetail', recentIso(5 * 60_000));
    insertJob(1081, 108, 'org/repo-a', { failureClass: 'job-failed', failureDetail: longDetail });

    const candidates = remediationCandidates(db);
    const run108 = candidates.find((c) => c.runId === 108);
    assert.ok(run108, 'run 108 present');
    const failedJob = run108.jobs.find((j) => j.id === 1081);
    assert.ok(failedJob?.failureDetail?.length <= 500, 'detail truncated');
  });
});

// A failure that something else has already dealt with must not be a candidate.
// This is the shape that shipped broken: the query filtered to failure rows
// before deduplicating, so the later green run was never in the result set and
// could not suppress the red one. A workflow that failed and then passed on a
// re-dispatch stayed eligible until it aged out of the window.
describe('remediationCandidates — superseded failures', () => {
  before(() => {
    // Failed, then re-dispatched and passed two minutes later.
    insertRun(200, 'org/repo-a', 'Promote', recentIso(30 * 60_000));
    insertJob(2001, 200, 'org/repo-a', { failureClass: 'job-failed' });
    insertRun(201, 'org/repo-a', 'Promote', recentIso(28 * 60_000), { conclusion: 'success' });
    insertJob(2011, 201, 'org/repo-a', { conclusion: 'success', failureClass: null });

    // Failed, and a retry is currently in flight.
    insertRun(210, 'org/repo-a', 'Package', recentIso(30 * 60_000));
    insertJob(2101, 210, 'org/repo-a', { failureClass: 'runner-lost' });
    insertRun(211, 'org/repo-a', 'Package', recentIso(2 * 60_000), {
      status: 'in_progress', conclusion: null,
    });

    // Failed, and a retry is queued but has not started.
    insertRun(220, 'org/repo-a', 'Publish', recentIso(30 * 60_000));
    insertJob(2201, 220, 'org/repo-a', { failureClass: 'runner-lost' });
    insertRun(221, 'org/repo-a', 'Publish', recentIso(60_000), {
      status: 'queued', conclusion: null,
    });

    // Passed, then failed. The newest run is red, so this IS still a candidate.
    insertRun(230, 'org/repo-b', 'Regress', recentIso(40 * 60_000), { conclusion: 'success' });
    insertJob(2301, 230, 'org/repo-b', { conclusion: 'success', failureClass: null });
    insertRun(231, 'org/repo-b', 'Regress', recentIso(20 * 60_000));
    insertJob(2311, 231, 'org/repo-b', { failureClass: 'job-failed' });
  });

  test('a failure followed by a successful run is not a candidate', () => {
    const runIds = remediationCandidates(db).map((c) => c.runId);
    assert.ok(!runIds.includes(200), 'run 200 was superseded by a green run 201');
    assert.ok(!runIds.includes(201), 'the successful run is not itself a candidate');
  });

  test('a failure with a retry in flight is not a candidate', () => {
    const runIds = remediationCandidates(db).map((c) => c.runId);
    assert.ok(!runIds.includes(210), 'run 210 has an in_progress retry');
    assert.ok(!runIds.includes(220), 'run 220 has a queued retry');
  });

  test('a failure that is the newest run is still a candidate', () => {
    const candidates = remediationCandidates(db);
    const runIds = candidates.map((c) => c.runId);
    assert.ok(runIds.includes(231), 'run 231 is the newest run and is red');
    assert.ok(!runIds.includes(230), 'the earlier green run is not a candidate');
    assert.equal(candidates.find((c) => c.runId === 231)?.strategy, 'ai-fix');
  });

  test('a success in one workflow does not suppress another workflow', () => {
    // Promote went green; CI in the same repo is unaffected and still a candidate.
    const runIds = remediationCandidates(db).map((c) => c.runId);
    assert.ok(runIds.includes(100), 'run 100 (repo-a CI) is unaffected by Promote going green');
  });
});

describe('remediationCandidates — MAX_CANDIDATE_AGE_MS constant', () => {
  test('default age is 2 hours', () => {
    assert.equal(MAX_CANDIDATE_AGE_MS, 2 * 60 * 60 * 1000);
  });
});
