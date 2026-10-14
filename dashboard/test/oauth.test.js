import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPairingCode, redeemCode, addToken, refreshGrant, revokeDevice, deviceTokenEntry,
  resetPairingState,
} from '../lib/devices.js';
import { createOAuth, parsePublicUrl } from '../lib/oauth.js';
import { createPublicHandler } from '../lib/public.js';
import { handleMcp } from '../lib/mcp.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../cockpit/Sources/CockpitCore/Fixtures');
const live = JSON.parse(readFileSync(join(FIXTURES, 'live.json'), 'utf8'));
const ctx = {
  glance: () => live,
  orphans: () => [],
  actions: () => ({ items: [] }),
  actionInfo: () => null,
  readOnly: () => false,
};

const REDIRECT = 'https://chat.example/callback';
let dir;
let server;
let base;
let tokensFile;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-oauth-'));
  tokensFile = join(dir, 'tokens.json');
  let handler = null;
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
  handler = createPublicHandler({
    oauth: createOAuth({
      publicUrl: base,
      clientsFile: join(dir, 'clients.json'),
      redeemCode,
      issueGrant: (grant) => addToken(tokensFile, { ...grant, kind: 'oauth' }),
      refreshGrant: (token, opts) => refreshGrant(tokensFile, token, opts),
      revokeGrant: (key) => revokeDevice(tokensFile, key),
      registerLimits: { perIp: 10, total: 1000 },
    }),
    authenticate: (token) => {
      const d = deviceTokenEntry(tokensFile, token);
      return d?.kind === 'oauth' ? { id: `oauth:${d.key}`, name: d.name, kind: 'oauth', scopes: d.scopes } : null;
    },
    mcp: (request) => handleMcp(request, ctx),
  });
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetPairingState());

const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let caller = 0;
async function register(extra = {}, headers = {}) {
  caller += 1;
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${caller % 250}`, ...headers },
    body: JSON.stringify({ client_name: 'Chat <b>Tool</b>', redirect_uris: [REDIRECT], ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function startSignIn(clientId, { challenge, scope, redirect = REDIRECT, method = 'S256' } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'st4te' });
  if (challenge) q.set('code_challenge', challenge);
  if (method) q.set('code_challenge_method', method);
  if (scope) q.set('scope', scope);
  const res = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
  const html = res.status === 200 || res.status >= 400 ? await res.text() : '';
  return { res, html, request: /name="request" value="([^"]+)"/.exec(html)?.[1] };
}

async function submit(request, code, decision = 'allow') {
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST', headers: FORM, redirect: 'manual', body: form({ request, code, decision }),
  });
}

async function exchange(params, headers = {}) {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...FORM, ...headers }, body: form(params) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

// register, consent with a pairing code for `scopes`, exchange: the token response.
async function signIn({ scopes = ['read', 'act'], scope } = {}) {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const { request } = await startSignIn(client.client_id, { challenge, scope });
  const done = await submit(request, createPairingCode({ scopes }));
  const back = new URL(done.headers.get('location'));
  const tok = await exchange({
    grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT,
    client_id: client.client_id, code_verifier: verifier,
  });
  return { client, tok, back };
}

async function mcp(token, msg) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...msg }),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

describe('public URL', () => {
  test('must be an https origin, or http on loopback', () => {
    assert.equal(parsePublicUrl('https://fleet.example.com/'), 'https://fleet.example.com');
    assert.equal(parsePublicUrl('https://mac.tail1.ts.net:8443'), 'https://mac.tail1.ts.net:8443');
    assert.equal(parsePublicUrl('http://localhost:7879'), 'http://localhost:7879');
    for (const bad of ['http://fleet.example.com', 'https://fleet.example.com/mcp', 'ftp://x', '', 'https://u:p@x.com']) {
      assert.equal(parsePublicUrl(bad), null, bad);
    }
  });
});

describe('discovery', () => {
  test('an unauthenticated /mcp call points at the resource metadata, which names the server', async () => {
    const r = await mcp(null, { method: 'tools/list' });
    assert.equal(r.status, 401);
    const m = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate'));
    assert.ok(m, r.headers.get('www-authenticate'));
    const prm = await (await fetch(m[1])).json();
    assert.equal(prm.resource, `${base}/mcp`);
    const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.ok(as.registration_endpoint.endsWith('/oauth/register'));
  });

  test('nothing but /mcp and OAuth is served', async () => {
    for (const path of ['/', '/api/state', '/api/v1/status', '/index.html']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  });

  test('a Host that is not the public one is refused', async () => {
    const status = await new Promise((resolve) => {
      http.get({ port: server.address().port, path: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
    assert.equal(status, 421);
  });
});

describe('registration', () => {
  test('a public client gets an id and no secret', async () => {
    const r = await register();
    assert.equal(r.status, 201);
    assert.ok(r.body.client_id);
    assert.equal(r.body.client_secret, undefined);
    assert.equal(r.body.token_endpoint_auth_method, 'none');
  });

  test('redirects must be https, loopback http, or an app scheme', async () => {
    assert.equal((await register({ redirect_uris: ['http://chat.example/cb'] })).status, 400);
    assert.equal((await register({ redirect_uris: ['javascript:alert(1)'] })).status, 400);
    assert.equal((await register({ redirect_uris: ['https://chat.example/cb#x'] })).status, 400);
    assert.equal((await register({ redirect_uris: ['http://127.0.0.1:3334/cb'] })).status, 201);
    assert.equal((await register({ redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] })).status, 201);
  });

  test('one address can only register a few clients an hour', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await register({}, ip)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429);
  });
});

describe('sign-in', () => {
  test('the consent page escapes the client name and shows where it returns to', async () => {
    const { body: client } = await register();
    const { res, html, request } = await startSignIn(client.client_id, { challenge: pkce().challenge });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok(html.includes('Chat &lt;b&gt;Tool&lt;/b&gt;'));
    assert.ok(!html.includes('<b>Tool</b>'));
    assert.ok(html.includes('chat.example'));
    assert.ok(request);
  });

  test('an unknown client or a redirect it did not register gets a page, never a redirect', async () => {
    assert.equal((await startSignIn('nope', { challenge: pkce().challenge })).res.status, 400);
    const { body: client } = await register();
    const r = await startSignIn(client.client_id, { challenge: pkce().challenge, redirect: 'https://evil.example/cb' });
    assert.equal(r.res.status, 400);
    assert.equal(r.res.headers.get('location'), null);
  });

  test('PKCE is required', async () => {
    const { body: client } = await register();
    const r = await startSignIn(client.client_id, {});
    assert.equal(r.res.status, 302);
    assert.equal(new URL(r.res.headers.get('location')).searchParams.get('error'), 'invalid_request');
    const plain = await startSignIn(client.client_id, { challenge: pkce().challenge, method: 'plain' });
    assert.equal(new URL(plain.res.headers.get('location')).searchParams.get('error'), 'invalid_request');
  });

  test('a wrong pairing code re-asks; the right one returns a code, the state and the issuer', async () => {
    const { body: client } = await register();
    const { request } = await startSignIn(client.client_id, { challenge: pkce().challenge });
    const code = createPairingCode({ scopes: ['read'] });
    const wrong = await submit(request, code === '123456' ? '654321' : '123456');
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /invalid or expired pairing code/);
    const right = await submit(request, code);
    assert.equal(right.status, 302);
    const back = new URL(right.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    assert.ok(back.searchParams.get('code'));
    assert.equal(back.searchParams.get('state'), 'st4te');
    assert.equal(back.searchParams.get('iss'), base);
  });

  test('cancelling returns access_denied and spends nothing', async () => {
    const { body: client } = await register();
    const { request } = await startSignIn(client.client_id, { challenge: pkce().challenge });
    const code = createPairingCode();
    const r = await submit(request, '', 'deny');
    assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'access_denied');
    assert.deepEqual(redeemCode(code, 'test'), { scopes: null });
  });
});

describe('tokens', () => {
  test('the pairing code\'s scopes become the token\'s, and the token works on /mcp', async () => {
    const { tok } = await signIn({ scopes: ['read', 'act'] });
    assert.equal(tok.status, 200);
    assert.equal(tok.body.token_type, 'Bearer');
    assert.equal(tok.body.scope, 'read act');
    assert.equal(tok.body.expires_in, 3600);
    assert.ok(tok.body.refresh_token);
    assert.equal(tok.headers.get('cache-control'), 'no-store');
    const r = await mcp(tok.body.access_token, { method: 'tools/call', params: { name: 'fleet_status', arguments: {} } });
    assert.equal(r.status, 200);
    assert.ok(!r.body.result.isError);
  });

  test('a code from plain `pair` connects read-only', async () => {
    const { tok } = await signIn({ scopes: null });
    assert.equal(tok.body.scope, 'read');
  });

  test('asking for more than the pairing code allows is refused', async () => {
    const { client } = await signIn();
    const { request } = await startSignIn(client.client_id, { challenge: pkce().challenge, scope: 'act' });
    const r = await submit(request, createPairingCode({ scopes: ['read'] }));
    assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'invalid_scope');
  });

  test('the verifier must match the challenge', async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const { request } = await startSignIn(client.client_id, { challenge });
    const back = new URL((await submit(request, createPairingCode())).headers.get('location'));
    const r = await exchange({
      grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: client.client_id,
      code_verifier: pkce().verifier,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_grant');
  });

  test('a code used twice revokes the token it already bought', async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const { request } = await startSignIn(client.client_id, { challenge });
    const code = new URL((await submit(request, createPairingCode())).headers.get('location')).searchParams.get('code');
    const params = { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier };
    const first = await exchange(params);
    assert.equal(first.status, 200);
    assert.equal((await exchange(params)).body.error, 'invalid_grant');
    assert.equal((await mcp(first.body.access_token, { method: 'tools/list' })).status, 401);
  });

  test('a refresh rotates both tokens; the old pair stops working', async () => {
    const { client, tok } = await signIn();
    const r = await exchange({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: client.client_id });
    assert.equal(r.status, 200);
    assert.equal(r.body.scope, 'read act');
    assert.notEqual(r.body.access_token, tok.body.access_token);
    assert.equal((await mcp(tok.body.access_token, { method: 'tools/list' })).status, 401);
    assert.equal((await mcp(r.body.access_token, { method: 'tools/list' })).status, 200);
    const again = await exchange({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: client.client_id });
    assert.equal(again.body.error, 'invalid_grant');
  });

  test('another client cannot use the refresh token', async () => {
    const { tok } = await signIn();
    const { body: other } = await register();
    const r = await exchange({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: other.client_id });
    assert.equal(r.body.error, 'invalid_grant');
  });

  test('a confidential client must authenticate', async () => {
    const { body: client } = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    assert.ok(client.client_secret);
    const { verifier, challenge } = pkce();
    const { request } = await startSignIn(client.client_id, { challenge });
    const code = new URL((await submit(request, createPairingCode())).headers.get('location')).searchParams.get('code');
    const params = { grant_type: 'authorization_code', code, code_verifier: verifier };
    assert.equal((await exchange({ ...params, client_id: client.client_id })).status, 401);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    assert.equal((await exchange(params, { authorization: `Basic ${basic}` })).status, 200);
  });

  test('only an OAuth token opens /mcp here', async () => {
    const device = addToken(tokensFile, { name: 'phone' });
    const r = await mcp(device.token, { method: 'tools/list' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
  });
});

describe('the grant store', () => {
  test('an expired access token is refused, and revoking the entry ends the refresh too', async () => {
    const g = addToken(tokensFile, { name: 'c', kind: 'oauth', scopes: ['read'], ttlMs: 1, refreshTtlMs: 60_000, clientId: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(deviceTokenEntry(tokensFile, g.token), null);
    revokeDevice(tokensFile, g.key);
    assert.equal(refreshGrant(tokensFile, g.refreshToken, { clientId: 'x', ttlMs: 1000, refreshTtlMs: 1000 }), null);
  });
});
