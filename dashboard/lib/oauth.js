// OAuth 2.1 for the public MCP listener (lib/public.js).
//
// fleetd is its own authorization server: a chat tool registers itself
// (RFC 7591), sends the owner to /oauth/authorize, and the owner proves they
// run this fleet by typing a pairing code from `fleetctl.sh pair`. The code's
// scopes become the token's, so the owner decides what a connector may do on
// the runner host, not on a page anyone on the internet can reach.
//
// PKCE (S256) is required. Access tokens last an hour; refresh tokens rotate
// on every use. Both live in the device token store as kind 'oauth', so
// `fleetctl.sh devices` lists each connector and `revoke` ends it.
//
// Registered clients persist (a connector registers once). Pending sign-ins
// and authorization codes live in memory only: a restart costs a retry.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { SCOPES, grants, parseScopes } from './scopes.js';

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
const MAX_CLIENTS = 100;
// Registration is open to anyone who can reach the listener, so it is metered
// and the store is bounded: a stranger can fill it, but not grow it.
const REGISTER_PER_IP_PER_HOUR = 10;
const REGISTER_PER_HOUR = 30;
const UNUSED_CLIENT_MS = 24 * 60 * 60 * 1000;
const IDLE_CLIENT_MS = 30 * 24 * 60 * 60 * 1000;

const digest = (v) => createHash('sha256').update(String(v)).digest('hex');
const random = () => randomBytes(32).toString('base64url');

function sameSecret(given, hash) {
  const a = Buffer.from(digest(given));
  const b = Buffer.from(String(hash ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(path, data) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

// The public URL must be an origin: the issuer and the resource are derived
// from it, and a client compares them byte for byte.
export function parsePublicUrl(value) {
  let u;
  try { u = new URL(String(value ?? '').trim()); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}

// Native apps register custom schemes (RFC 8252); plain http is only for a
// loopback redirect.
const BAD_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);
function validRedirect(value) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (BAD_SCHEMES.has(u.protocol) || u.hash) return false;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return true;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function redirectTarget(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

function displayHost(uri) {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}//`;
  } catch {
    return uri;
  }
}

const PAGE_STYLE = `
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; color: #1d1d1f; }
  h1 { font-size: 1.4rem; }
  .box { border: 1px solid #d2d2d7; border-radius: 12px; padding: 1.25rem; }
  .err { background: #fff2f2; border: 1px solid #f5c2c2; border-radius: 8px; padding: .6rem .8rem; color: #8a1f1f; }
  input[name=code] { font: 1.6rem ui-monospace, monospace; letter-spacing: .3em; width: 9ch; padding: .3rem .5rem; }
  button { font-size: 1rem; padding: .5rem 1.1rem; border-radius: 8px; border: 1px solid #0071e3; background: #0071e3; color: #fff; }
  button.secondary { background: #fff; color: #0071e3; }
  code { background: #f5f5f7; padding: .1rem .3rem; border-radius: 4px; }
  .muted { color: #6e6e73; font-size: .9rem; }
  @media (prefers-color-scheme: dark) { body { background: #1d1d1f; color: #f5f5f7; } .box { border-color: #424245; } code { background: #2c2c2e; } }
`;

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body>${inner}</body></html>`;
}

export function createOAuth({
  publicUrl,
  clientsFile,
  redeemCode,
  issueGrant,
  refreshGrant,
  revokeGrant,
  registerLimits = { perIp: REGISTER_PER_IP_PER_HOUR, total: REGISTER_PER_HOUR },
  now = Date.now,
}) {
  const issuer = publicUrl;
  const resource = `${publicUrl}/mcp`;
  const pending = new Map();
  const codes = new Map();
  const registrations = { byIp: new Map(), all: [] };

  const sweep = () => {
    const t = now();
    for (const [id, p] of pending) if (p.expires < t) pending.delete(id);
    for (const [c, entry] of codes) if (entry.expires < t) codes.delete(c);
  };

  function protectedResource() {
    return {
      resource,
      authorization_servers: [issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Runner fleet',
    };
  }

  function serverMetadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  }

  function challenge(error) {
    const parts = [`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`];
    if (error) parts.push(`error="${error}"`);
    parts.push(`scope="${SCOPES.slice(0, 2).join(' ')}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  // ---- registration (RFC 7591) ----------------------------------------------

  function registrationAllowed(ip) {
    const t = now();
    const hour = 60 * 60 * 1000;
    registrations.all = registrations.all.filter((at) => t - at < hour);
    const mine = (registrations.byIp.get(ip) ?? []).filter((at) => t - at < hour);
    if (mine.length >= registerLimits.perIp || registrations.all.length >= registerLimits.total) return false;
    mine.push(t);
    registrations.byIp.set(ip, mine);
    registrations.all.push(t);
    if (registrations.byIp.size > 1000) {
      for (const [k, v] of registrations.byIp) if (!v.some((at) => t - at < hour)) registrations.byIp.delete(k);
    }
    return true;
  }

  function register(body, ip) {
    const bad = (description) => ({ status: 400, body: { error: 'invalid_client_metadata', error_description: description } });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('expected a JSON object');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must list 1 to 10 URIs' } };
    if (!uris.every((u) => typeof u === 'string' && u.length <= 2048 && validRedirect(u))) {
      return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'each redirect URI must be https, a loopback http address, or an app scheme, with no fragment' } };
    }
    const method = body.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return bad(`token_endpoint_auth_method ${method} is not supported`);
    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')
      || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
      return bad('grant_types may be authorization_code and refresh_token');
    }
    const responseTypes = body.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) return bad('response_types may only be code');
    if (body.scope != null && !parseScopes(body.scope)) return bad(`scope may be ${SCOPES.join(', ')}`);
    if (!registrationAllowed(ip)) {
      return { status: 429, body: { error: 'temporarily_unavailable', error_description: 'too many registrations; try again later' } };
    }

    const t = now();
    const clients = readJson(clientsFile);
    for (const [id, c] of Object.entries(clients)) {
      const idle = c.lastUsedAt ? t - c.lastUsedAt > IDLE_CLIENT_MS : t - c.createdAt > UNUSED_CLIENT_MS;
      if (idle) delete clients[id];
    }
    if (Object.keys(clients).length >= MAX_CLIENTS) {
      return { status: 503, body: { error: 'temporarily_unavailable', error_description: 'the client registry is full' } };
    }
    const clientId = random();
    const secret = method === 'none' ? null : random();
    const name = String(body.client_name ?? 'MCP client').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'MCP client';
    clients[clientId] = {
      name,
      redirectUris: uris,
      authMethod: method,
      grantTypes,
      ...(secret ? { secretHash: digest(secret) } : {}),
      createdAt: t,
      lastUsedAt: null,
    };
    writeJson(clientsFile, clients);
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(t / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: method,
        grant_types: grantTypes,
        response_types: ['code'],
      },
    };
  }

  // ---- authorization ---------------------------------------------------------

  function errorPage(status, message) {
    return {
      status,
      html: page('Sign-in failed', `<h1>Sign-in failed</h1><p class="err">${escapeHtml(message)}</p>
<p class="muted">Start again from the chat tool.</p>`),
    };
  }

  function consentPage(p, client, error) {
    return page('Connect to the runner fleet', `
<h1>Connect ${escapeHtml(client.name)} to the runner fleet</h1>
<div class="box">
<p>After sign-in you will be sent to <strong>${escapeHtml(displayHost(p.redirectUri))}</strong>.
If you did not just start this from a chat tool, close this page.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escapeHtml(p.id)}">
<p><label>Pairing code<br><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus></label></p>
<p><button name="decision" value="allow">Connect</button>
<button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button></p>
</form>
</div>
<p class="muted">On the runner host, run <code>./dashboard/fleetctl.sh pair --scopes read,act</code>.
The code decides what this connection may do: <code>read</code> lets it look;
<code>act</code> also lets it drain, resume, re-run and cancel, each after you confirm.
A code from plain <code>pair</code> connects read-only. The code works once and expires in 5 minutes.</p>`);
  }

  function authorizeStart(query) {
    sweep();
    const clients = readJson(clientsFile);
    const clientId = query.get('client_id');
    const client = clientId ? clients[clientId] : null;
    if (!client) return errorPage(400, 'This chat tool is not registered with the fleet, or its registration expired.');
    let redirectUri = query.get('redirect_uri');
    if (!redirectUri && client.redirectUris.length === 1) [redirectUri] = client.redirectUris;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return errorPage(400, 'The return address does not match the one this chat tool registered.');
    }
    const state = query.get('state');
    const fail = (error, description) => ({
      status: 302,
      location: redirectTarget(redirectUri, { error, error_description: description, state, iss: issuer }),
    });
    if (query.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const codeChallenge = query.get('code_challenge');
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return fail('invalid_request', 'a PKCE code_challenge is required');
    if (query.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    let scopes = null;
    if (query.get('scope')) {
      scopes = parseScopes(query.get('scope'));
      if (!scopes) return fail('invalid_scope', `scope may be ${SCOPES.join(' ')}`);
    }
    const target = query.get('resource');
    if (target && ![resource, issuer, `${issuer}/`].includes(target)) return fail('invalid_target', `this server issues tokens for ${resource}`);
    if (pending.size >= MAX_PENDING) return errorPage(503, 'Too many sign-ins are in progress. Try again in a few minutes.');

    const p = {
      id: random(),
      clientId,
      redirectUri,
      state,
      codeChallenge,
      scopes,
      expires: now() + SIGN_IN_TTL_MS,
    };
    pending.set(p.id, p);
    return { status: 200, html: consentPage(p, client) };
  }

  function authorizeSubmit(form, ip) {
    sweep();
    const p = pending.get(form.get('request') ?? '');
    if (!p) return errorPage(400, 'This sign-in has expired.');
    const client = readJson(clientsFile)[p.clientId];
    if (!client) {
      pending.delete(p.id);
      return errorPage(400, 'This chat tool is no longer registered.');
    }
    const back = (params) => ({ status: 302, location: redirectTarget(p.redirectUri, { ...params, state: p.state, iss: issuer }) });
    if (form.get('decision') === 'deny') {
      pending.delete(p.id);
      return back({ error: 'access_denied', error_description: 'the owner declined' });
    }
    const redeemed = redeemCode(form.get('code') ?? '', ip);
    if (redeemed.error) return { status: redeemed.rateLimited ? 429 : 400, html: consentPage(p, client, redeemed.error) };

    pending.delete(p.id);
    const allowed = redeemed.scopes ?? ['read'];
    const scopes = (p.scopes ?? allowed).filter((s) => grants(allowed, s));
    if (!scopes.length) {
      return back({ error: 'invalid_scope', error_description: `the pairing code allows ${allowed.join(' ')}, not ${p.scopes.join(' ')}` });
    }
    const code = random();
    codes.set(code, {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scopes,
      expires: now() + CODE_TTL_MS,
      grantKey: null,
    });
    return back({ code });
  }

  // ---- token ----------------------------------------------------------------

  function clientFor(form, headers) {
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(String(headers.authorization ?? ''));
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const at = decoded.indexOf(':');
      if (at > 0) {
        id = decodeURIComponent(decoded.slice(0, at));
        secret = decodeURIComponent(decoded.slice(at + 1));
      }
    }
    const clients = readJson(clientsFile);
    const client = id ? clients[id] : null;
    if (!client) return null;
    if (client.authMethod !== 'none' && !(secret && sameSecret(secret, client.secretHash))) return null;
    return { id, client, clients };
  }

  function token(form, headers) {
    sweep();
    const fail = (status, error, description) => ({ status, body: { error, error_description: description } });
    const who = clientFor(form, headers);
    if (!who) return fail(401, 'invalid_client', 'unknown client or wrong client secret');
    const grantType = form.get('grant_type');

    let issued;
    let scopes;
    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? '';
      const entry = codes.get(code);
      if (!entry || entry.clientId !== who.id) return fail(400, 'invalid_grant', 'unknown or expired authorization code');
      // A code presented twice was intercepted: the first exchange may have
      // been the attacker's, so its token is revoked too.
      if (entry.grantKey) {
        codes.delete(code);
        revokeGrant(entry.grantKey);
        return fail(400, 'invalid_grant', 'authorization code already used');
      }
      const redirectUri = form.get('redirect_uri');
      if (redirectUri && redirectUri !== entry.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      const target = form.get('resource');
      if (target && ![resource, issuer, `${issuer}/`].includes(target)) return fail(400, 'invalid_target', `this server issues tokens for ${resource}`);
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        || createHash('sha256').update(verifier).digest('base64url') !== entry.codeChallenge) {
        return fail(400, 'invalid_grant', 'code_verifier does not match the code_challenge');
      }
      issued = issueGrant({
        name: `${who.client.name} (OAuth)`,
        scopes: entry.scopes,
        ttlMs: ACCESS_TTL_MS,
        refreshTtlMs: who.client.grantTypes.includes('refresh_token') ? REFRESH_TTL_MS : null,
        clientId: who.id,
      });
      entry.grantKey = issued.key;
      scopes = entry.scopes;
    } else if (grantType === 'refresh_token') {
      issued = refreshGrant(form.get('refresh_token') ?? '', { clientId: who.id, ttlMs: ACCESS_TTL_MS, refreshTtlMs: REFRESH_TTL_MS });
      if (!issued) return fail(400, 'invalid_grant', 'unknown, expired or revoked refresh token');
      scopes = issued.scopes ?? SCOPES;
    } else {
      return fail(400, 'unsupported_grant_type', 'grant_type may be authorization_code or refresh_token');
    }

    who.clients[who.id] = { ...who.client, lastUsedAt: now() };
    writeJson(clientsFile, who.clients);
    return {
      status: 200,
      body: {
        access_token: issued.token,
        token_type: 'Bearer',
        expires_in: Math.round(ACCESS_TTL_MS / 1000),
        ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {}),
        scope: scopes.join(' '),
      },
    };
  }

  return {
    issuer,
    resource,
    protectedResource,
    serverMetadata,
    challenge,
    register,
    authorizeStart,
    authorizeSubmit,
    token,
  };
}
