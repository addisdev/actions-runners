import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_RUN_STATUSES,
  isActiveRunStatus,
  filterActiveRuns,
  mergeRunPages,
  newerRun,
  activeRunQueryPaths,
  rateLimitBackoffUntil,
  GitHub,
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

  // jot-ios PR #181, 2026-10-11: attempt 2 failed, `gh run rerun --failed`
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

describe('rateLimitBackoffUntil', () => {
  const now = 1_000_000;
  test('honours Retry-After', () => {
    assert.equal(rateLimitBackoffUntil({ now, retryAfterS: 30, remaining: 4995, resetAt: now + 3_600_000 }), now + 30_000);
  });
  test('waits for the reset only when the primary allowance is spent', () => {
    assert.equal(rateLimitBackoffUntil({ now, remaining: 0, resetAt: now + 900_000 }), now + 900_000);
  });
  test('a secondary limit waits a minute, doubling per strike up to 15 minutes', () => {
    const at = (strikes) => rateLimitBackoffUntil({ now, remaining: 4995, resetAt: now + 3_600_000, strikes }) - now;
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(at), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
});

describe('GitHub.get rate limiting', () => {
  function respond(status, headers = {}, body = '{}') {
    return new Response(body, { status, headers: { 'x-ratelimit-limit': '5000', ...headers } });
  }
  async function withFetch(responses, fn) {
    const real = globalThis.fetch;
    const queue = [...responses];
    globalThis.fetch = async () => queue.shift();
    try { return await fn(); } finally { globalThis.fetch = real; }
  }
  const reset = String(Math.floor(Date.now() / 1000) + 3000);

  test('a 429 with calls left backs off a minute, not until the hourly reset', async () => {
    const logs = [];
    const gh = new GitHub({ log: (m) => logs.push(m) });
    gh.token = 't';
    await withFetch([respond(429, { 'x-ratelimit-remaining': '4995', 'x-ratelimit-reset': reset })], async () => {
      await assert.rejects(gh.get('repos/a/b/actions/runs', { attempts: 1 }), (err) => err.rateLimited === true);
    });
    const wait = gh.backoffUntil - Date.now();
    assert.ok(wait > 50_000 && wait <= 60_000, `waited ${wait} ms`);
    assert.match(logs.join('\n'), /429 rate limited \(4995 of 5000 left\)/);
  });

  test('a 403 that is not rate limiting is an ordinary error and sets no backoff', async () => {
    const gh = new GitHub({ log: () => {} });
    gh.token = 't';
    await withFetch([respond(403, { 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': reset }, '{"message":"Resource not accessible by integration"}')], async () => {
      await assert.rejects(gh.get('repos/a/b/actions/runners', { attempts: 1 }), (err) => err.status === 403 && !err.rateLimited);
    });
    assert.equal(gh.backoffUntil, 0);
  });

  test('a secondary-limit 403 backs off; a later success resets the strikes', async () => {
    const gh = new GitHub({ log: () => {} });
    gh.token = 't';
    await withFetch([
      respond(403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': reset }, '{"message":"You have exceeded a secondary rate limit"}'),
    ], async () => {
      await assert.rejects(gh.get('x', { attempts: 1 }), (err) => err.rateLimited === true);
    });
    assert.equal(gh.rateStrikes, 1);
    gh.backoffUntil = 0;
    await withFetch([respond(200, { 'x-ratelimit-remaining': '3999', 'x-ratelimit-reset': reset }, '{"ok":true}')], async () => {
      assert.deepEqual((await gh.get('x', { attempts: 1, etag: false })).data, { ok: true });
    });
    assert.equal(gh.rateStrikes, 0);
  });
});
