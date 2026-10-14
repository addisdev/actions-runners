import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../lib/api.js';
import { handleMcp, tools, requestFor, TOOL_ROUTES, PROTOCOL_VERSIONS } from '../lib/mcp.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../cockpit/Sources/CockpitCore/Fixtures');
const live = JSON.parse(readFileSync(join(FIXTURES, 'live.json'), 'utf8'));

const ctx = {
  glance: () => live,
  orphans: () => [],
  actions: () => ({ items: [] }),
  actionInfo: () => null,
  readOnly: () => false,
};

async function rpc(msg, opts = {}) {
  return handleMcp({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', ...msg }), ...opts }, ctx);
}

describe('tools', () => {
  test('one per route that offers a tool, named by its id', () => {
    const names = tools().map((t) => t.name);
    assert.deepEqual(names, ROUTES.filter((r) => r.tool !== false).map((r) => r.id));
    for (const hidden of ['openapi', 'create_token', 'whoami']) assert.ok(!names.includes(hidden), hidden);
  });

  test('a tool takes exactly the route\'s parameters and body, with no name used twice', () => {
    for (const r of TOOL_ROUTES) {
      const t = tools().find((x) => x.name === r.id);
      const fields = [...r.params, ...(r.body ?? [])].map((f) => f.name);
      assert.equal(new Set(fields).size, fields.length, `${r.id} has no colliding names`);
      assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), [...fields].sort());
      assert.equal(t.inputSchema.additionalProperties, false);
    }
  });

  test('only reads are marked read-only', () => {
    for (const t of tools()) {
      assert.equal(t.annotations.readOnlyHint, TOOL_ROUTES.find((r) => r.id === t.name).method === 'GET', t.name);
    }
  });
});

describe('arguments to requests', () => {
  const route = (id) => ROUTES.find((r) => r.id === id);

  test('path and query parameters land where the route expects them', () => {
    const r = requestFor(route('wait_for_checks'), { owner: 'acme', repo: 'atlas', pr: 12, wait: 30 });
    assert.equal(r.url.pathname, '/api/v1/repos/acme/atlas/checks');
    assert.equal(r.url.searchParams.get('pr'), '12');
    assert.equal(r.url.searchParams.get('wait'), '30');
  });

  test('a repository given as owner/name is split', () => {
    const r = requestFor(route('diagnose_repo'), { repo: 'acme/atlas' });
    assert.equal(r.url.pathname, '/api/v1/repos/acme/atlas/diagnosis');
  });

  test('body fields go in the body', () => {
    const r = requestFor(route('run_action'), { id: 'runner.drain', args: { name: 'x' }, dryRun: true });
    assert.equal(r.url.pathname, '/api/v1/actions/runner.drain');
    assert.deepEqual(JSON.parse(r.body), { args: { name: 'x' }, dryRun: true });
  });

  test('an argument the route does not take is refused, naming the ones it does', () => {
    assert.throws(() => requestFor(route('list_queue'), { repository: 'acme/atlas' }),
      (e) => e.code === 'unknown_param' && /repo/.test(e.hint));
  });
});

describe('protocol', () => {
  test('initialize agrees on a version it supports, or offers its newest', async () => {
    const asked = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(asked.body.result.protocolVersion, '2025-03-26');
    assert.ok(asked.body.result.capabilities.tools);
    const future = await rpc({ id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.equal(future.body.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  });

  test('a tool call returns the route\'s body as text and as structured content', async () => {
    const out = await rpc({ id: 3, method: 'tools/call', params: { name: 'fleet_status', arguments: {} } });
    const { result } = out.body;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.verdict.id, live.verdict.id);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  });

  test('a route\'s error is a tool error the model can read, not a protocol error', async () => {
    const out = await rpc({ id: 4, method: 'tools/call', params: { name: 'diagnose_repo', arguments: { repo: 'someone/else' } } });
    assert.equal(out.body.result.isError, true);
    assert.equal(out.body.result.structuredContent.error.code, 'unknown_repo');
    const bad = await rpc({ id: 5, method: 'tools/call', params: { name: 'list_queue', arguments: { nope: 1 } } });
    assert.equal(bad.body.result.structuredContent.error.code, 'unknown_param');
  });

  test('an unknown tool or method is a JSON-RPC error', async () => {
    assert.equal((await rpc({ id: 6, method: 'tools/call', params: { name: 'rm_rf' } })).body.error.code, -32602);
    assert.equal((await rpc({ id: 7, method: 'resources/list' })).body.error.code, -32601);
  });

  test('notifications are accepted without a body', async () => {
    const out = await rpc({ method: 'notifications/initialized' });
    assert.deepEqual([out.status, out.body], [202, null]);
  });

  test('malformed input, batches, other methods and unknown versions are refused', async () => {
    assert.equal((await handleMcp({ method: 'POST', body: '{' }, ctx)).body.error.code, -32700);
    assert.equal((await handleMcp({ method: 'POST', body: '[]' }, ctx)).status, 400);
    const get = await handleMcp({ method: 'GET' }, ctx);
    assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
    const old = await rpc({ id: 8, method: 'ping' }, { headers: { 'mcp-protocol-version': '2024-01-01' } });
    assert.equal(old.status, 400);
  });
});
