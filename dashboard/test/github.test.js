import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_RUN_STATUSES,
  isActiveRunStatus,
  filterActiveRuns,
  mergeRunPages,
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
