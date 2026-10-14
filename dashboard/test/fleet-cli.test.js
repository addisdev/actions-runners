import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, openApi, ROUTES } from '../lib/api.js';
import { commands, parseArgv, requestFor, main, parseTimeout, UsageError } from '../bin/fleet.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../cockpit/Sources/CockpitCore/Fixtures');
const live = JSON.parse(readFileSync(join(FIXTURES, 'live.json'), 'utf8'));
const CMDS = commands(openApi());

const DEFS = {
  'runner.drain': { id: 'runner.drain', label: 'Drain runner', danger: 'medium', confirm: 'Stops the runner.', scope: 'act', args: [{ name: 'name', type: 'string', required: true }] },
  'fleet.health': { id: 'fleet.health', label: 'Health check', danger: 'none', confirm: null, scope: 'act', args: [] },
};

// The daemon, in process: fetch() answered by handleApi itself.
function daemon({ checks = { state: 'green', checks: { progress: '1 of 1 green' } } } = {}) {
  const ran = [];
  let n = 0;
  const ctx = {
    glance: () => live,
    orphans: () => [],
    actions: () => ({ items: Object.values(DEFS) }),
    actionInfo: (id) => DEFS[id] ?? null,
    readOnly: () => false,
    previewAction: async (id, a) => `run ${id} ${JSON.stringify(a)}`,
    confirmations: { issue: () => ({ token: `c${++n}`, expiresAt: 0 }), consume: () => null },
    runAction: async (id, args) => { ran.push([id, args]); return { ok: true, code: 0, output: 'done' }; },
    waitForChecks: async () => (typeof checks === 'function' ? checks() : checks),
  };
  const fetchImpl = async (url, init = {}) => {
    const auth = init.headers?.authorization;
    const principal = auth === 'Bearer master' ? { id: 'master', name: 'master', kind: 'master', scopes: ['read', 'act', 'act:danger'] } : null;
    const r = await handleApi({ method: init.method ?? 'GET', url: new URL(url), principal, body: init.body ?? '' }, ctx);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { ran, fetchImpl };
}

async function run(argv, d = daemon(), env = { FLEET_TOKEN: 'master' }) {
  const out = [];
  const err = [];
  const code = await main(argv, { env, out: (s) => out.push(s), err: (s) => err.push(s), fetchImpl: d.fetchImpl });
  return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out.join('\n')) };
}

describe('commands from the OpenAPI document', () => {
  test('every route has one, under a unique name', () => {
    const names = ROUTES.map((r) => r.cli?.name);
    assert.ok(names.every(Boolean));
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual([...CMDS.keys()].sort(), [...names].sort());
  });

  test('positionals, flags and body fields land where the route takes them', () => {
    const why = requestFor(CMDS.get('why'), parseArgv(['acme/comet-web']));
    assert.equal(why.path, '/api/v1/repos/acme/comet-web/diagnosis');
    const checks = requestFor(CMDS.get('checks'), parseArgv(['acme/comet-web', '--pr', '12', '--wait=30']));
    assert.equal(checks.path, '/api/v1/repos/acme/comet-web/checks?pr=12&wait=30');
    const drain = requestFor(CMDS.get('run'), parseArgv(['runner.drain', '--name', 'x', '--dry-run']));
    assert.deepEqual([drain.method, drain.path, drain.body], ['POST', '/api/v1/actions/runner.drain', { args: { name: 'x' }, dryRun: true }]);
    const tok = requestFor(CMDS.get('token'), parseArgv(['laptop agent', '--scopes', 'read,act']));
    assert.deepEqual(tok.body, { name: 'laptop agent', scopes: 'read,act' });
  });

  test('a flag the route does not declare is left for the daemon to refuse', async () => {
    const r = await run(['queue', '--repository', 'acme/comet-web']);
    assert.equal(r.code, 1);
    assert.equal(r.json().error.code, 'unknown_param');
    assert.match(r.err, /It takes repo/);
  });

  test('usage mistakes are caught before any request', () => {
    assert.throws(() => requestFor(CMDS.get('why'), parseArgv(['comet-web'])), UsageError);
    assert.throws(() => requestFor(CMDS.get('why'), parseArgv([])), /needs owner\/repo/);
    assert.throws(() => requestFor(CMDS.get('status'), parseArgv(['extra'])), UsageError);
  });
});

describe('running', () => {
  test('a read prints the daemon\'s JSON', async () => {
    const r = await run(['status']);
    assert.equal(r.code, 0);
    assert.equal(r.json().verdict.id, live.verdict.id);
  });

  test('a refusal exits 1 with the hint on stderr', async () => {
    const r = await run(['why', 'someone/else']);
    assert.equal(r.code, 1);
    assert.equal(r.json().error.code, 'unknown_repo');
    assert.match(r.err, /GET \/api\/v1\/runners/);
  });

  test('an action that changes the fleet stops at the preview without --yes', async () => {
    const d = daemon();
    const r = await run(['run', 'runner.drain', '--name', 'build-host-web-2'], d);
    assert.equal(r.code, 2);
    assert.equal(r.json().status, 'confirm_required');
    assert.match(r.err, /nothing has run/);
    assert.deepEqual(d.ran, []);
  });

  test('--yes confirms the preview, and a read-only action needs no --yes', async () => {
    const d = daemon();
    assert.equal((await run(['run', 'runner.drain', '--name', 'build-host-web-2', '--yes'], d)).code, 0);
    assert.equal((await run(['run', 'fleet.health'], d)).code, 0);
    assert.deepEqual(d.ran, [['runner.drain', { name: 'build-host-web-2' }], ['fleet.health', {}]]);
  });

  test('without a token an action is refused by the daemon, not the CLI', async () => {
    const r = await run(['run', 'fleet.health'], daemon(), {});
    assert.equal(r.code, 1);
    assert.equal(r.json().error.code, 'missing_token');
  });

  test('wait asks again while pending and exits by the answer', async () => {
    const answers = [{ state: 'pending', checks: { progress: '1 of 2 done' } }, { state: 'red', checks: { progress: '1 failed · 2 of 2 done' } }];
    const r = await run(['wait', 'acme/comet-web', '--pr', '7', '--timeout', '10m'], daemon({ checks: () => answers.shift() }));
    assert.equal(r.code, 1);
    assert.equal(r.json().state, 'red');
    assert.match(r.err, /1 of 2 done/);
  });

  test('an unreachable daemon exits 3', async () => {
    const r = await run(['status'], { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); } });
    assert.equal(r.code, 3);
    assert.match(r.err, /ECONNREFUSED/);
  });

  test('help lists every command and one command\'s flags', async () => {
    const all = (await run([])).out;
    for (const r of ROUTES) assert.match(all, new RegExp(`^  ${r.cli.name}\\b`, 'm'));
    const one = (await run(['help', 'checks'])).out;
    assert.match(one, /--pr/);
    assert.match(one, /needs: read/);
  });

  test('timeouts read as people write them', () => {
    assert.equal(parseTimeout('90s'), 90_000);
    assert.equal(parseTimeout('45m'), 2_700_000);
    assert.equal(parseTimeout('2h'), 7_200_000);
    assert.equal(parseTimeout('10'), 600_000);
    assert.throws(() => parseTimeout('soon'), UsageError);
  });
});
