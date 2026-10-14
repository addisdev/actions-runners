import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyJob, findOrphans, trimJob } from '../lib/orphans.js';

// lake-api PR #73's three jobs as GitHub recorded them. The fixture lives with
// the cockpit's because make-glance-fixtures.mjs builds the v1 orphan
// fixtures the cockpit decodes from it.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)),
  '../../cockpit/Sources/CockpitCore/Fixtures/orphaned-jobs.json');
const JOBS = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const job = (name) => structuredClone(JOBS[name]);
const at = (iso) => Date.parse(iso);
const repo = 'addisdev/lake-api';
const runner = (name, state) => ({ name, repo, host: 'runner-host', state });

test('a cancelled completion on a draining runner', () => {
  const o = classifyJob(job('docsBuild1'), {
    repo, runner: runner('MACSERIAL0-lake-api', 'draining'), now: at('2026-10-12T23:12:33Z'),
  });
  assert.equal(o.runId, 38318681067);
  assert.equal(o.jobId, 115041321171);
  assert.equal(o.job, 'build');
  assert.equal(o.runner, 'MACSERIAL0-lake-api');
  assert.equal(o.runnerState, 'draining');
  assert.equal(o.stuckStep, 'Complete job');
  assert.equal(o.stuckSince, at('2026-10-12T23:00:33Z'));
  assert.equal(o.stuckForMs, 12 * 60_000);
  assert.equal(o.workPassed, true);
  assert.equal(o.failedStep, null);
  assert.match(o.summary, /orphaned by a draining runner — not your code/);
  assert.match(o.summary, /for 12 min\.$/);
  assert.deepEqual(o.recovery, [
    'gh api -X POST repos/addisdev/lake-api/actions/runs/38318681067/force-cancel',
    '# about a minute later, once the run shows completed:',
    'gh run rerun 38318681067 -R addisdev/lake-api',
  ]);
});

test('a cancelled completion is enough on a resumed runner, or an unknown one', () => {
  const now = at('2026-10-12T23:10:00Z');
  assert.equal(classifyJob(job('docsBuild1'), { repo, runner: runner('MACSERIAL0-lake-api', 'busy'), now })?.runnerState, 'busy');
  assert.ok(classifyJob(job('docsBuild1'), { repo, runner: null, now }));
});

test('an unfinished completion needs the runner gone', () => {
  const now = at('2026-10-13T01:26:00Z');
  for (const state of ['draining', 'offline', 'dead', 'lost', 'host-down']) {
    const o = classifyJob(job('docsBuild2'), { repo, runner: runner('MACSERIAL0-lake-api', state), now });
    assert.equal(o?.stuckStep, 'Complete runner', state);
    assert.equal(o.stuckSince, at('2026-10-13T01:22:59Z'));
  }
  assert.equal(classifyJob(job('docsBuild2'), { repo, runner: runner('MACSERIAL0-lake-api', 'busy'), now }), null);
  assert.equal(classifyJob(job('docsBuild2'), { repo, runner: null, now }), null);
});

test('the site job on the second runner', () => {
  const o = classifyJob(job('siteJob'), {
    repo, runner: runner('MACSERIAL0-lake-api-2', 'offline'), now: at('2026-10-13T01:26:00Z'),
  });
  assert.equal(o.job, 'site');
  assert.equal(o.runner, 'MACSERIAL0-lake-api-2');
  assert.equal(o.stuckStep, 'Complete job');
  assert.equal(o.workPassed, true);
});

test('not before three minutes', () => {
  const draining = runner('MACSERIAL0-lake-api', 'draining');
  assert.equal(classifyJob(job('docsBuild1'), { repo, runner: draining, now: at('2026-10-12T23:03:32Z') }), null);
  assert.ok(classifyJob(job('docsBuild1'), { repo, runner: draining, now: at('2026-10-12T23:03:33Z') }));
});

test('a job still running a work step is not orphaned', () => {
  const j = job('docsBuild1');
  j.steps[4].status = 'in_progress';
  j.steps[4].conclusion = null;
  assert.equal(classifyJob(j, { repo, runner: runner('MACSERIAL0-lake-api', 'draining'), now: at('2026-10-12T23:30:00Z') }), null);
});

test('a completed job is not orphaned', () => {
  const j = job('docsBuild1');
  j.status = 'completed';
  j.conclusion = 'cancelled';
  assert.equal(classifyJob(j, { repo, runner: runner('MACSERIAL0-lake-api', 'draining'), now: at('2026-10-12T23:30:00Z') }), null);
});

test('a failed step is named, and the job is not "not your code"', () => {
  const j = job('docsBuild1');
  j.steps[4].conclusion = 'failure';
  const o = classifyJob(j, { repo, runner: runner('MACSERIAL0-lake-api', 'draining'), now: at('2026-10-12T23:30:00Z') });
  assert.equal(o.workPassed, false);
  assert.equal(o.failedStep, 'Build');
  assert.doesNotMatch(o.summary, /not your code/);
});

test('findOrphans looks each runner up and sorts oldest first', () => {
  const runs = [
    { repo, jobs: [trimJob(job('siteJob'))] },
    { repo, jobs: [trimJob(job('docsBuild2'))] },
  ];
  const found = findOrphans(runs, [runner('MACSERIAL0-lake-api-2', 'draining'), runner('MACSERIAL0-lake-api', 'busy')],
    at('2026-10-13T01:40:00Z'));
  assert.deepEqual(found.map((o) => o.runId), [38331315807]);
  assert.equal(found[0].runnerState, 'draining');
});

test('trimJob keeps what classification reads and nothing else', () => {
  const t = trimJob(job('docsBuild1'));
  assert.deepEqual(Object.keys(t), ['id', 'run_id', 'name', 'status', 'runner_name', 'html_url', 'steps']);
  assert.deepEqual(Object.keys(t.steps[0]), ['name', 'status', 'conclusion', 'started_at']);
  assert.ok(classifyJob(t, { repo, now: at('2026-10-12T23:12:33Z') }));
});
