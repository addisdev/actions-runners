import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, matchRoute, openApi, ROUTES, ApiError } from '../lib/api.js';

// The cockpit fixtures are real /api/glance payloads, regenerated from
// buildGlance and checked in CI, so the API is tested against the shape the
// daemon actually serves rather than one written by hand here.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../cockpit/Sources/CockpitCore/Fixtures');
const glance = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

function ctx(g = glance('live'), orphans = []) {
  return {
    glance: () => g,
    orphans: () => orphans,
    actions: () => ({ readOnly: false, items: [{ id: 'fleet.health', label: 'Health check', danger: 'none', confirm: null }] }),
  };
}

async function get(path, c = ctx()) {
  return handleApi({ method: 'GET', url: new URL(path, 'http://localhost') }, c);
}

describe('route table', () => {
  test('ids are unique and snake_case, so they can be MCP tool names', () => {
    const ids = ROUTES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/);
  });

  test('every route says what it is for and what it needs', () => {
    for (const r of ROUTES) {
      assert.ok(r.summary && r.description, `${r.id} is described`);
      assert.ok(['read', 'act'].includes(r.scope), `${r.id} has a scope`);
      for (const p of r.params) assert.ok(p.description, `${r.id}.${p.name} is described`);
    }
  });

  test('every path parameter is declared', () => {
    for (const r of ROUTES) {
      for (const [, name] of r.path.matchAll(/\{(\w+)\}/g)) {
        assert.ok(r.params.some((p) => p.name === name && p.in === 'path'), `${r.id} declares {${name}}`);
      }
    }
  });
});

describe('responses', () => {
  test('status carries the verdict and freshness', async () => {
    const out = await get('/api/v1/status');
    assert.equal(out.status, 200);
    assert.equal(out.headers['fleet-api-version'], '1');
    assert.equal(out.body.verdict.id, glance('live').verdict.id);
    assert.deepEqual(Object.keys(out.body.freshness), ['generatedAt', 'ageMs', 'stale']);
  });

  test('runners filter by repo, case-insensitively, and by host and state', async () => {
    const all = (await get('/api/v1/runners')).body.items;
    const repo = all[0].repo;
    const some = (await get(`/api/v1/runners?repo=${repo.toUpperCase()}`)).body.items;
    assert.ok(some.length > 0 && some.every((r) => r.repo === repo));
    const idle = (await get(`/api/v1/runners?state=idle&host=${all[0].host}`)).body.items;
    assert.ok(idle.every((r) => r.state === 'idle' && r.host === all[0].host));
  });

  test('a diagnosis gathers one repository from every section', async () => {
    const g = glance('live');
    const repo = g.runs[0].repo;
    const out = await get(`/api/v1/repos/${repo}/diagnosis`);
    assert.equal(out.status, 200);
    assert.equal(out.body.repo, repo);
    assert.equal(out.body.verdict.id, g.verdict.id);
    for (const key of ['runners', 'queue', 'runs', 'recent', 'failures', 'incidents']) {
      assert.ok(Array.isArray(out.body[key]), key);
      assert.ok(out.body[key].every((x) => !x.repo || x.repo === repo), `${key} is only ${repo}`);
    }
    assert.ok(out.body.runs.length > 0);
  });

  test('a diagnosis of a repository the fleet does not know is a 404 with a hint', async () => {
    const out = await get('/api/v1/repos/acme/never-heard-of-it/diagnosis');
    assert.equal(out.status, 404);
    assert.equal(out.body.error.code, 'unknown_repo');
    assert.match(out.body.error.hint, /\/api\/v1\/runners/);
  });

  test('a diagnosis carries the repository\'s orphans, and /orphans filters by repo', async () => {
    const g = glance('live');
    const repo = g.runs[0].repo;
    const orphans = [{ repo, runId: 1, workPassed: true }, { repo: 'acme/other', runId: 2, workPassed: true }];
    const diag = await get(`/api/v1/repos/${repo}/diagnosis`, ctx(g, orphans));
    assert.deepEqual(diag.body.orphans.map((o) => o.runId), [1]);
    assert.equal((await get('/api/v1/orphans', ctx(g, orphans))).body.items.length, 2);
    assert.deepEqual((await get('/api/v1/orphans?repo=acme/other', ctx(g, orphans))).body.items.map((o) => o.runId), [2]);
  });

  test('incidents match the full repository or one of its runners, not a bare name', async () => {
    const g = glance('live');
    const r = g.runners[0];
    const [owner, name] = r.repo.split('/');
    g.incidents = [
      { key: `newfail:${r.repo}:ci:1`, title: 'newly failing' },
      { key: `runner:unused:${r.name}`, title: 'unused runner' },
      { key: `newfail:${owner}/${name}-extra:ci:2`, title: 'a different repo' },
      { key: 'host:pressure', title: `Kernel pressure, mentions ${name}` },
    ];
    const keys = (await get(`/api/v1/repos/${r.repo}/diagnosis`, ctx(g))).body.incidents.map((i) => i.key);
    assert.deepEqual(keys, [`newfail:${r.repo}:ci:1`, `runner:unused:${r.name}`]);
  });

  test('checks pass the target and the wait through, and reject a repository the fleet does not serve', async () => {
    const g = glance('live');
    const repo = g.runs[0].repo;
    let asked = null;
    const c = { ...ctx(g), waitForChecks: async (target, opts) => { asked = { target, waitS: opts.waitS }; return { state: 'pending' }; } };
    const out = await get(`/api/v1/repos/${repo}/checks?pr=73&wait=120`, c);
    assert.equal(out.status, 200);
    assert.deepEqual(asked, { target: { repo, pr: 73, sha: null, branch: null }, waitS: 120 });
    assert.equal(out.body.state, 'pending');
    assert.equal((await get('/api/v1/repos/someone/elses-repo/checks?pr=1', c)).status, 404);
  });

  test('checks take one of pr, sha or branch, and wait is at most 300', async () => {
    const repo = glance('live').runs[0].repo;
    const c = { ...ctx(), waitForChecks: async () => ({ state: 'pending' }) };
    assert.equal((await get(`/api/v1/repos/${repo}/checks?pr=1&sha=abcdef1`, c)).status, 400);
    const tooLong = await get(`/api/v1/repos/${repo}/checks?pr=1&wait=301`, c);
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error.message, /between 0 and 300/);
    assert.equal((await get(`/api/v1/repos/${repo}/checks?sha=xyz`, c)).status, 400);
    assert.equal((await get(`/api/v1/repos/${repo}/checks?pr=0`, c)).status, 400);
  });

  test('actions come from the catalogue', async () => {
    const out = await get('/api/v1/actions');
    assert.equal(out.body.items[0].id, 'fleet.health');
  });

  test('the glance is built once per request', async () => {
    let calls = 0;
    const c = ctx();
    const g = c.glance();
    c.glance = () => { calls++; return g; };
    await get(`/api/v1/repos/${g.runs[0].repo}/diagnosis`, c);
    assert.equal(calls, 1);
  });
});

describe('errors', () => {
  test('an unknown query parameter is refused, naming the ones that exist', async () => {
    const out = await get('/api/v1/queue?repository=acme/comet-web');
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, 'unknown_param');
    assert.match(out.body.error.hint, /repo/);
  });

  test('a repo without an owner is refused', async () => {
    const out = await get('/api/v1/queue?repo=comet-web');
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, 'invalid_param');
  });

  test('a path parameter that does not look like a name is refused', async () => {
    const out = await get('/api/v1/repos/acme/%2e%2e%2fx/diagnosis');
    assert.equal(out.status, 400);
  });

  test('a wrong method names the right one', () => {
    assert.throws(() => matchRoute('POST', new URL('http://localhost/api/v1/status')),
      (err) => err instanceof ApiError && err.status === 405 && err.allow === 'GET');
  });

  test('a handler that throws is a 500 in the same shape, not a dropped connection', async () => {
    const out = await get('/api/v1/status', { glance: () => { throw new Error('boom'); } });
    assert.equal(out.status, 500);
    assert.equal(out.body.error.code, 'internal');
    assert.equal(out.headers['fleet-api-version'], '1');
  });
});

describe('openapi', () => {
  test('every route appears under its id, with its scope', () => {
    const doc = openApi();
    for (const r of ROUTES) {
      const op = doc.paths[`/api/v1${r.path}`][r.method.toLowerCase()];
      assert.equal(op.operationId, r.id);
      assert.equal(op['x-fleet-scope'], r.scope);
    }
  });

  test('integer bounds appear in the schema', () => {
    const wait = openApi().paths['/api/v1/repos/{owner}/{repo}/checks'].get.parameters.find((p) => p.name === 'wait');
    assert.deepEqual(wait.schema, { type: 'integer', minimum: 0, maximum: 300 });
  });

  test('path parameters are required', () => {
    const op = openApi().paths['/api/v1/repos/{owner}/{repo}/diagnosis'].get;
    assert.ok(op.parameters.every((p) => p.in !== 'path' || p.required));
  });
});
