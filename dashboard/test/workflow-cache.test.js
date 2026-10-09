import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, UPSERT_REPO } from '../lib/db.js';
import { reposToPrune, repoIsGone } from '../lib/workflow-cache.js';

describe('reposToPrune', () => {
  test('drops cached repos missing from the live roster', () => {
    const cachedRepos = ['o/app', 'o/fleet-collector', 'o/data-platform-reference', 'o/app'];
    const liveRepos = new Set(['o/app', 'o/other']);
    assert.deepEqual(reposToPrune({ cachedRepos, liveRepos }),
      ['o/data-platform-reference', 'o/fleet-collector']);
  });

  test('prunes nothing when the roster refresh failed or came back empty', () => {
    const cachedRepos = ['o/app', 'o/gone'];
    assert.deepEqual(reposToPrune({ cachedRepos, liveRepos: null }), []);
    assert.deepEqual(reposToPrune({ cachedRepos, liveRepos: new Set() }), []);
  });
});

describe('repoIsGone', () => {
  test('404 and 410 mean gone; rate limits and server errors do not', () => {
    assert.equal(repoIsGone({ status: 404 }), true);
    assert.equal(repoIsGone({ status: 410 }), true);
    for (const status of [403, 429, 500, 502, undefined]) {
      assert.equal(repoIsGone({ status }), false, String(status));
    }
    assert.equal(repoIsGone(null), false);
  });
});

describe('repo upsert SQL', () => {
  let dir;
  let db;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
    db = openDb(join(dir, 'test.db'));
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the repo upsert refreshes visibility and name', () => {
    const upsert = db.prepare(UPSERT_REPO);
    upsert.run('o/fleet-runner', 'fleet-runner', 0, 1, '2026-09-01', 2, 1, 1);
    upsert.run('o/fleet-runner', 'fleet-runner2', 0, 0, '2026-10-01', 2, 1, 2);
    const row = db.prepare('SELECT name, private, pushed_at FROM repos WHERE full_name = ?').get('o/fleet-runner');
    assert.equal(row.private, 0);
    assert.equal(row.name, 'fleet-runner2');
    assert.equal(row.pushed_at, '2026-10-01');
  });
});
