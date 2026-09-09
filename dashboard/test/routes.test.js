// Lightweight route-level smoke tests.
//
// These spin up a real fleetd.js instance against an in-memory database and
// verify that the right status codes come back for the endpoints we care about.
// They exercise the HTTP layer, not the business logic — the business logic has
// its own unit tests. Each test makes one or two real HTTP requests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEETD = join(HERE, '..', 'fleetd.js');

// Spin up a fleetd instance and return { port, token, kill }
async function startDaemon() {
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
      FLEET_ALERTS: '0',
      FLEET_BACKFILL_MS: '999999999',
      FLEET_FAST_MS: '999999999',
      FLEET_SLOW_MS: '999999999',
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
