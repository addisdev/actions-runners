import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_RUN_STATUSES,
  isActiveRunStatus,
  filterActiveRuns,
  mergeRunPages,
  newerRun,
  activeRunQueryPaths,
} from '../lib/github.js';

describe('isActiveRunStatus', () => {
  test('recognises queued and in_progress', () => {
    assert.equal(isActiveRunStatus('queued'), true);
    assert.equal(isActiveRunStatus('in_progress'), true);
    assert.equal(isActiveRunStatus('IN_PROGRESS'), true);
  });

  test('rejects completed work', () => {
    assert.equal(isActiveRunStatus('completed'), false);
    assert.equal(isActiveRunStatus('failure'), false);
  });
});

describe('filterActiveRuns', () => {
  test('keeps only live statuses', () => {
    const runs = [
      { id: 1, status: 'queued' },
      { id: 2, status: 'completed' },
      { id: 3, status: 'in_progress' },
    ];
    const out = filterActiveRuns(runs);
    assert.deepEqual(out.map((r) => r.id), [1, 3]);
  });
});

describe('mergeRunPages', () => {
  test('dedupes by run id across pages', () => {
    const merged = mergeRunPages([
      [{ id: 10, status: 'queued' }, { id: 11, status: 'queued' }],
      [{ id: 11, status: 'queued' }, { id: 12, status: 'in_progress' }],
    ]);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map((r) => r.id).sort((a, b) => a - b), [10, 11, 12]);
  });

  // jerv-ios PR #181, 2026-10-11: attempt 2 failed, `gh run rerun --failed`
  // started attempt 3 under the same run id. Whichever page arrives first,
  // the merged run is the re-run, not the failure it retries.
  test('keeps the latest attempt of a re-run, in either page order', () => {
    const failed = { id: 38163415231, run_attempt: 2, status: 'completed', conclusion: 'failure', updated_at: '2026-10-11T21:32:14Z' };
    const rerun = { id: 38163415231, run_attempt: 3, status: 'in_progress', conclusion: null, updated_at: '2026-10-11T21:46:33Z' };
    for (const pages of [[[failed], [rerun]], [[rerun], [failed]]]) {
      const [only, ...rest] = mergeRunPages(pages);
      assert.equal(rest.length, 0);
      assert.equal(only.run_attempt, 3);
      assert.equal(only.status, 'in_progress');
    }
  });
});

describe('newerRun', () => {
  test('a higher attempt beats a later updated_at', () => {
    const a = { id: 1, run_attempt: 2, updated_at: '2026-10-11T22:00:00Z' };
    const b = { id: 1, run_attempt: 3, updated_at: '2026-10-11T21:00:00Z' };
    assert.equal(newerRun(a, b), b);
    assert.equal(newerRun(b, a), b);
  });

  test('within one attempt the later update wins, and a tie keeps the held copy', () => {
    const early = { id: 1, run_attempt: 1, status: 'in_progress', updated_at: '2026-10-11T21:00:00Z' };
    const late = { id: 1, run_attempt: 1, status: 'completed', updated_at: '2026-10-11T21:05:00Z' };
    assert.equal(newerRun(early, late), late);
    assert.equal(newerRun(late, early), late);
    const twin = { ...early };
    assert.equal(newerRun(early, twin), early);
    assert.equal(newerRun(undefined, early), early);
  });
});

describe('activeRunQueryPaths', () => {
  test('builds paginated queries for every live workflow status', () => {
    const paths = activeRunQueryPaths('owner/repo', { perPage: 100, maxPages: 2 });
    assert.equal(paths.length, 6);
    assert.ok(paths.some((p) => p.path.includes('status=queued&per_page=100&page=1')));
    assert.ok(paths.some((p) => p.path.includes('status=in_progress&per_page=100&page=2')));
    assert.ok(paths.some((p) => p.path.includes('status=waiting&per_page=100&page=1')));
  });

  test('every built status is an active one', () => {
    for (const { status } of activeRunQueryPaths('owner/repo')) {
      assert.ok(ACTIVE_RUN_STATUSES.has(status));
    }
  });
});
