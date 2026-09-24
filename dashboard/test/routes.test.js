// Lightweight route-level smoke tests.
//
// These spin up a real fleetd.js instance against an in-memory database and
// verify that the right status codes come back for the endpoints we care about.
// They exercise the HTTP layer, not the business logic — the business logic has
// its own unit tests. Each test makes one or two real HTTP requests.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createHostToken } from '../lib/host-auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEETD = join(HERE, '..', 'fleetd.js');

// Spin up a fleetd instance and return { port, token, kill }
async function startDaemon(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleetd-test-'));
  const port = 17878 + Math.floor(Math.random() * 1000);
  const tokenFile = join(dir, '.fleet-token');
  const token = 'a'.repeat(64);
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });

  const proc = fork(FLEETD, [], {
    env: {
      ...process.env,
      FLEET_PORT: String(port),
      FLEET_HOST: '127.0.0.1',
      FLEET_ROOT: dir,
      FLEET_DB: join(dir, 'fleet.db'),
      FLEET_TOKEN_FILE: tokenFile,
      // Stated rather than left to the fallback. Agent auth reuses the control
      // token only when no agent token is configured, and it looks for one at
      // dashboard/.fleet-agent-token — a path outside the temp FLEET_ROOT, and
      // so outside this test's control. The federation tests authenticate with
      // the control token, so they passed for as long as that file happened not
      // to exist and returned 403 the moment `fleetctl.sh install` created it,
      // naming nothing that would lead anyone to the cause.
      //
      // Setting the file path instead of the value would not fix it: that path
      // is created on demand, so the daemon would mint a random token there and
      // reject the control token just the same.
      FLEET_AGENT_TOKEN: token,
      FLEET_AGENT_TOKENS_FILE: join(dir, 'host-tokens.json'),
      FLEET_ALERTS: '0',
      FLEET_BACKFILL_MS: '999999999',
      FLEET_FAST_MS: '999999999',
      FLEET_SLOW_MS: '999999999',
      // Never depend on whether the developer's real bridge happens to be
      // running on 7879 while this isolated route daemon is tested.
      FLEET_AUTOFIX_STATUS_URL: 'http://127.0.0.1:1/status',
      ...extraEnv,
    },
    stdio: 'ignore',
  });

  // Wait for the daemon to be ready
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      if (Date.now() - start > 10000) return reject(new Error('daemon did not start'));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/state`);
        if (r.ok) return resolve();
      } catch { /* not ready yet */ }
      setTimeout(poll, 100);
    };
    poll();
  });

  return {
    port,
    token,
    dir,
    kill: () => {
      proc.kill();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// startDaemon returns as soon as the server is listening, which is before the
// first collection tick has finished. Anything asserting on collector freshness
// has to wait for a tick to actually land, or it is reading the empty snapshot
// the daemon starts with.
async function waitForFirstTick(port, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      if (body.ts > 0) return body;
    } catch { /* not ready yet */ }
    if (Date.now() - start > timeoutMs) throw new Error('no tick completed in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

let daemon;
test.before(async () => { daemon = await startDaemon(); });
after(() => daemon?.kill());

function url(path) { return `http://127.0.0.1:${daemon.port}${path}`; }

// ---------------------------------------------------------------------------
// Read routes — unauthenticated on loopback
// ---------------------------------------------------------------------------
test('GET /api/state returns 200 without auth', async () => {
  const r = await fetch(url('/api/state'));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.runners));
});

test('GET /api/actions returns 200 without auth', async () => {
  const r = await fetch(url('/api/actions'));
  assert.equal(r.status, 200);
});

test('POST /api/settings applies a valid setting', async () => {
  const r = await fetch(url('/api/settings'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemon.token}`,
    },
    body: JSON.stringify({ key: 'groupMin', value: 3 }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, key: 'groupMin', value: 3 });
});

test('GET /api/analytics includes playwright section', async () => {
  const r = await fetch(url('/api/analytics?days=30'));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.playwright, 'missing playwright key');
  assert.ok(body.playwright.browserInstall);
  assert.equal(typeof body.playwright.browserInstall.count, 'number');
  assert.ok(body.playwright.e2eJobs);
  assert.equal(typeof body.playwright.e2eJobs.count, 'number');
});

test('GET /api/health reports ok while the collector is ticking', async () => {
  const body = await waitForFirstTick(daemon.port);
  assert.equal(body.ok, true);
  assert.equal(body.stale, false);
  assert.equal(typeof body.ageMs, 'number');
  assert.equal(typeof body.collectorStaleMs, 'number');
});

test('GET /metrics exposes queue and collector gauges', async () => {
  const r = await fetch(url('/metrics'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
  const body = await r.text();
  assert.match(body, /fleet_collector_age_seconds/);
  assert.match(body, /fleet_queue_runs\{cause="/);
  assert.match(body, /fleet_autoscale_deficit/);
});

test('GET /api/remediation-candidates returns an array', async () => {
  const r = await fetch(url('/api/remediation-candidates'));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(await r.json()));
});

test('GET /api/autofix/status degrades explicitly when bridge is absent', async () => {
  const r = await fetch(url('/api/autofix/status'));
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.available, false);
});

test('GET /api/queue-history validates run ids and returns bounded rows', async () => {
  const bad = await fetch(url('/api/queue-history?runId=not-a-number'));
  assert.equal(bad.status, 400);

  const good = await fetch(url('/api/queue-history?hours=24'));
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.ok(Array.isArray(body.rows));
  assert.equal(body.hours, 24);
});

// The outage this signal exists for: the fast loop stopped re-arming itself
// while the HTTP server kept serving the frozen snapshot, and `ok` was derived
// from `starting` alone, so it stayed true for 65 minutes. watch/fleet-watch.mjs
// raises collector-not-ok off exactly this field, and reported nothing.
test('GET /api/health reports not-ok once the snapshot goes stale', async () => {
  // Its own daemon: FLEET_FAST_MS is effectively infinite in this harness, so
  // the tick taken at startup is the only one, and a 1ms staleness budget makes
  // it overdue immediately.
  const stalled = await startDaemon({ FLEET_COLLECTOR_STALE_MS: '1' });
  try {
    const body = await waitForFirstTick(stalled.port);
    assert.equal(body.ok, false, 'a frozen collector must not report ok');
    assert.equal(body.stale, true);
    assert.match(body.lastError ?? '', /collector stalled/);
  } finally {
    stalled.kill();
  }
});

test('GET / returns 200 (static index.html)', async () => {
  const r = await fetch(url('/'));
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /<html/i);
});

test('GET /nonexistent returns 404', async () => {
  const r = await fetch(url('/api/nonexistent-endpoint'));
  assert.equal(r.status, 404);
});

test('responses include security headers', async () => {
  const r = await fetch(url('/api/state'));
  assert.ok(r.headers.get('x-content-type-options'), 'missing x-content-type-options');
  assert.ok(r.headers.get('x-frame-options'), 'missing x-frame-options');
  assert.ok(r.headers.get('referrer-policy'), 'missing referrer-policy');
});

// ---------------------------------------------------------------------------
// Write routes — require bearer token
// ---------------------------------------------------------------------------
test('POST /api/action without auth returns 401', async () => {
  const r = await fetch(url('/api/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'health.check' }),
  });
  assert.equal(r.status, 401);
});

test('POST /api/action with wrong token returns 403', async () => {
  const r = await fetch(url('/api/action'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + 'b'.repeat(64),
    },
    body: JSON.stringify({ id: 'health.check' }),
  });
  assert.equal(r.status, 403);
});

test('GET /api/runner/bundle without auth returns 401', async () => {
  const r = await fetch(url('/api/runner/bundle?name=test'));
  assert.equal(r.status, 401);
});

test('GET /api/runner/bundle with wrong token returns 403', async () => {
  const r = await fetch(url('/api/runner/bundle?name=test'), {
    headers: { authorization: 'Bearer ' + 'b'.repeat(64) },
  });
  assert.equal(r.status, 403);
});

test('GET /api/leader reports single-node leadership without PostgreSQL', async () => {
  const r = await fetch(url('/api/leader'));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.enabled, false);
  assert.equal(body.role, 'leader');
  assert.ok(body.replicaId);
  assert.equal(body.leaderId, body.replicaId);
});

// ---------------------------------------------------------------------------
// Agent routes — require agent token (falls back to control token when no
// separate agent token is configured)
// ---------------------------------------------------------------------------
test('POST /api/host/heartbeat without auth returns 401', async () => {
  const r = await fetch(url('/api/host/heartbeat'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 401);
});

test('POST /api/host/heartbeat with valid token returns 200 or 400', async () => {
  // A malformed body returns 400; a valid token with any body returns not-401/403.
  const r = await fetch(url('/api/host/heartbeat'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemon.token}`,
    },
    body: JSON.stringify({ name: 'test-host', version: 1, reportedAt: Date.now(), runners: [] }),
  });
  assert.ok(r.status < 404, `expected 200..403, got ${r.status}`);
  assert.notEqual(r.status, 401);
  assert.notEqual(r.status, 403);
});

// ---------------------------------------------------------------------------
// Malformed body handling
// ---------------------------------------------------------------------------
test('POST /api/action with malformed JSON returns 4xx', async () => {
  const r = await fetch(url('/api/action'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemon.token}`,
    },
    body: 'not json {{{',
  });
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
});

// ---------------------------------------------------------------------------
// Dismissing — a write, so token-gated like any other. The daemon above runs
// with FLEET_ALERTS=0, so these need one with the engine actually loaded.
// ---------------------------------------------------------------------------
describe('dismiss routes', () => {
  let d;
  const at = (path) => `http://127.0.0.1:${d.port}${path}`;
  const post = (path, body, token = d.token) => fetch(at(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  before(async () => { d = await startDaemon({ FLEET_ALERTS: '1' }); });
  after(() => d?.kill());

  // The point of the control: from this machine it is one click, not a click
  // plus a shell command plus a paste. A 401 here would be the prompt coming
  // back. 404 is the right refusal — the key names no open alert.
  test('dismissing from the local machine needs no token', async () => {
    const r = await post('/api/alerts/dismiss', { key: 'drift:offline:a' }, null);
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
    assert.equal(r.status, 404);
  });

  // Without a token the Origin check is the only thing between this route and a
  // page in another tab, and a `text/plain` form post gets no CORS preflight.
  test('a cross-origin dismiss is refused even from loopback', async () => {
    const r = await fetch(at('/api/alerts/dismiss'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ key: 'drift:offline:a' }),
    });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /cross-origin/);
  });

  test('a request without a key is refused', async () => {
    const r = await post('/api/alerts/dismiss', {});
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /key is required/);
  });

  // Dismissing is defined against something currently open, so a key that is not
  // open is a 404 rather than a dismissal nobody can see or undo.
  test('dismissing something that is not open returns 404', async () => {
    assert.equal((await post('/api/alerts/dismiss', { key: 'drift:offline:nobody' })).status, 404);
    assert.equal((await post('/api/alerts/restore', { key: 'drift:offline:nobody' })).status, 404);
  });

  test('GET /api/alerts needs no token and reports the counts', async () => {
    const r = await fetch(at('/api/alerts'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.open));
    assert.equal(typeof body.counts.open, 'number');
    assert.equal(typeof body.counts.dismissed, 'number');
  });
});

// ---------------------------------------------------------------------------
// Federation: heartbeat → host registration → /api/hosts response
// ---------------------------------------------------------------------------
describe('federation: heartbeat and host registration', () => {
  let d;
  const at = (path) => `http://127.0.0.1:${d.port}${path}`;

  const beat = (body, token = d.token) => fetch(at('/api/host/heartbeat'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  before(async () => { d = await startDaemon(); });
  after(() => d?.kill());

  test('a valid heartbeat returns 200 and an empty commands list', async () => {
    const r = await beat({
      name: 'mac-studio',
      id: 'test-host-id',
      version: 1,
      reportedAt: Date.now(),
      runners: [],
      repos: [],
      host: { cores: 12, load1: 0.5, memFreePct: 80, diskFreeGb: 200, diskTotalGb: 500, memTotalMb: 32768, memUsedMb: 8192 },
      capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
      labels: ['xcode-16', 'macos-15'],
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.commands));
  });

  test('/api/hosts shows the registered agent after a heartbeat', async () => {
    // Send a heartbeat to register the agent
    await beat({
      name: 'visible-host',
      id: 'visible-host-id',
      version: 1,
      reportedAt: Date.now(),
      runners: [],
      repos: [],
      host: {},
      capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
      labels: ['xcode-15'],
    });

    const r = await fetch(at('/api/hosts'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.federated, 'federated should be true after an agent heartbeat');
    // mergeHostSnapshots returns { hosts: [...] } — all hosts including coordinator
    assert.ok(Array.isArray(body.hosts), '/api/hosts should return a hosts array');
    assert.ok(
      body.hosts.some((h) => h.name === 'visible-host' || h.id === 'visible-host-id'),
      'the heartbeating host should appear in /api/hosts'
    );
  });

  test('/api/hosts includes recentPlacements and pendingCommands arrays', async () => {
    const r = await fetch(at('/api/hosts'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.recentPlacements), 'recentPlacements should be an array');
    assert.ok(Array.isArray(body.pendingCommands), 'pendingCommands should be an array');
  });

  test('/api/runner returns read-only detail for a remote runner', async () => {
    await beat({
      name: 'studio-display-name',
      id: 'studio-stable-id',
      version: 1,
      reportedAt: Date.now(),
      runners: [{
        name: 'studio-example-runner',
        repo: 'testowner/example',
        launchdLabel: 'actions.runner.testowner-example.studio-example-runner',
        launchdState: 'running',
        registered: true,
      }],
      repos: ['testowner/example'],
      host: {},
      capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
      labels: [],
    });
    const r = await fetch(at('/api/runner?name=studio-example-runner'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.remote, true);
    assert.equal(body.runner.hostId, 'studio-stable-id');
    assert.equal(body.runner.hostName, 'studio-display-name');
    assert.equal(body.diag, null);
  });

  test('heartbeat with wrong token returns 401 or 403', async () => {
    // A short token that does not match returns 401 (no auth) or 403 (wrong auth).
    // The exact code depends on whether the server recognizes it as a token at all.
    const r = await beat({ name: 'x', id: 'x', version: 1, reportedAt: Date.now() }, 'bad-token');
    assert.ok(r.status === 401 || r.status === 403, `expected 401 or 403, got ${r.status}`);
  });

  test('posting results without auth returns 401', async () => {
    const r = await fetch(at('/api/host/results'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'x', results: [] }),
    });
    assert.equal(r.status, 401);
  });

  test('posting results with a valid token returns 200', async () => {
    const r = await fetch(at('/api/host/results'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${d.token}`,
      },
      body: JSON.stringify({ host: 'x', results: [] }),
    });
    assert.equal(r.status, 200);
  });

  test('pending commands cannot be acknowledged before delivery', async () => {
    const host = 'pending-result-host';
    await beat({
      name: host,
      id: host,
      version: 1,
      reportedAt: Date.now(),
      runners: [],
      repos: [],
      host: {},
      capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
      labels: [],
    });

    const queuedResponse = await fetch(at('/api/action'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${d.token}`,
      },
      body: JSON.stringify({ action: 'host.drain', args: { hostId: host } }),
    });
    const queued = await queuedResponse.json();
    assert.equal(queuedResponse.status, 200);
    assert.equal(queued.queued, true);

    const postResult = () => fetch(at('/api/host/results'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${d.token}`,
      },
      body: JSON.stringify({
        host,
        // PostgreSQL BIGSERIAL values arrive through node-postgres as strings.
        results: [{ id: String(queued.commandId), ok: true, output: 'done' }],
      }),
    });
    assert.equal((await (await postResult()).json()).recorded, 0);

    const delivery = await (await beat({
      name: host,
      id: host,
      version: 1,
      reportedAt: Date.now(),
      runners: [],
      repos: [],
      host: {},
      capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
      labels: [],
    })).json();
    assert.ok(delivery.commands.some((command) => command.id === queued.commandId));
    assert.equal((await (await postResult()).json()).recorded, 1);
  });
});

describe('federation: staged host-token rollout', () => {
  let d;
  let tokenDir;
  let scopedToken;

  before(async () => {
    tokenDir = mkdtempSync(join(tmpdir(), 'fleet-host-routes-'));
    const tokenFile = join(tokenDir, 'tokens.json');
    scopedToken = createHostToken(tokenFile, 'mac-a');
    d = await startDaemon({ FLEET_AGENT_TOKENS_FILE: tokenFile });
  });
  after(() => {
    d?.kill();
    try { rmSync(tokenDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const beat = (host, token, id = host) => fetch(`http://127.0.0.1:${d.port}/api/host/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: host,
      id,
      version: 1,
      reportedAt: Date.now(),
      runners: [],
      repos: [],
      host: {},
      capacity: { ok: true, reasons: [], busy: 0, ceiling: 3, maxTotalRunners: 8 },
      labels: [],
    }),
  });

  test('scoped hosts require their own token while unscoped hosts retain the shared token', async () => {
    assert.equal((await beat('mac-a', scopedToken)).status, 200);
    assert.equal((await beat('renamed-mac-a', scopedToken, 'mac-a')).status, 200);
    assert.equal((await beat('mac-a', d.token)).status, 403);
    assert.equal((await beat('mac-b', d.token)).status, 200);
    assert.equal((await beat('mac-b', scopedToken)).status, 403);
    assert.equal((await beat('mac-a', scopedToken, 'mac-b')).status, 403);
  });
});

// ---------------------------------------------------------------- remote access

// WHATWG fetch() forbids overriding the Host header (it's a forbidden header
// per the spec). Use Node's http.request for these tests so we can send an
// arbitrary Host header the way a real DNS-rebinding attack would.
import http from 'node:http';
function rawGet(port, path, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('host-header allowlist (DNS-rebinding defence)', () => {
  let d;
  before(async () => { d = await startDaemon(); });
  after(() => d?.kill());

  test('known host (localhost) is accepted', async () => {
    const status = await rawGet(d.port, '/api/state', `localhost:${d.port}`);
    assert.equal(status, 200);
  });

  test('unknown host gets 421', async () => {
    const status = await rawGet(d.port, '/api/state', 'evil.example.com');
    assert.equal(status, 421);
  });
});

// ---------------------------------------------------------------- pairing

describe('pairing routes', () => {
  let d;
  before(async () => { d = await startDaemon(); });
  after(() => d?.kill());

  test('POST /api/pair/start requires auth', async () => {
    const r = await fetch(`http://127.0.0.1:${d.port}/api/pair/start`, { method: 'POST' });
    assert.equal(r.status, 401);
  });

  test('full pairing round-trip: start → pair → use token', async () => {
    // 1. Generate code (master token)
    const startRes = await fetch(`http://127.0.0.1:${d.port}/api/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}` },
    });
    assert.equal(startRes.status, 200);
    const { code } = await startRes.json();
    assert.match(code, /^\d{6}$/);

    // 2. Exchange code for device token (no auth needed)
    const pairRes = await fetch(`http://127.0.0.1:${d.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'test-phone' }),
    });
    assert.equal(pairRes.status, 200);
    const { token: deviceToken } = await pairRes.json();
    assert.ok(deviceToken?.length >= 32);

    // 3. Device token can call a protected endpoint (settings read → write uses token)
    const devRes = await fetch(`http://127.0.0.1:${d.port}/api/devices`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(devRes.status, 200);
    const { devices } = await devRes.json();
    assert.ok(devices.some((dev) => dev.name === 'test-phone'));
  });

  test('invalid pairing code is rejected', async () => {
    const r = await fetch(`http://127.0.0.1:${d.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000', name: 'phone' }),
    });
    assert.equal(r.status, 403);
  });

  test('pairing code is single-use', async () => {
    const startRes = await fetch(`http://127.0.0.1:${d.port}/api/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}` },
    });
    const { code } = await startRes.json();

    // First use succeeds
    const first = await fetch(`http://127.0.0.1:${d.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'phone' }),
    });
    assert.equal(first.status, 200);

    // Second use rejected
    const second = await fetch(`http://127.0.0.1:${d.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'phone' }),
    });
    assert.equal(second.status, 403);
  });

  test('GET /api/devices requires auth', async () => {
    const r = await fetch(`http://127.0.0.1:${d.port}/api/devices`);
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------- /api/access

describe('/api/access', () => {
  let d;
  before(async () => { d = await startDaemon(); });
  after(() => d?.kill());

  test('returns via=local for loopback request', async () => {
    const r = await fetch(`http://127.0.0.1:${d.port}/api/access`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.via, 'local');
    assert.ok(Array.isArray(body.urls));
  });
});
