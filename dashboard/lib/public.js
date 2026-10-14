// The listener a tunnel (Tailscale Funnel, Cloudflare Tunnel) exposes to the
// internet. It serves /mcp and the OAuth endpoints that hand out its tokens,
// and nothing else: no dashboard, no /api, no legacy routes. Every /mcp call
// needs a token from lib/oauth.js; the master token and paired devices are
// refused here, so nothing that predates OAuth is usable from the internet.
//
// Bound to loopback by fleetd: the tunnel daemon is the only peer, and it
// forwards the client's address in X-Forwarded-For.

const BODY_LIMIT = 16384;

// For the per-client limits on pairing codes and registration. A client can
// send its own X-Forwarded-For, which the tunnel appends to, so only the last
// entry is the tunnel's word. A tunnel that adds none leaves every client on
// one loopback address, sharing one limit, which errs the safe way.
function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) ?? req.socket?.remoteAddress ?? 'unknown';
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'no-store',
};

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostOf(header) {
  const value = String(header ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.replace(/:\d+$/, '');
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

function sendResult(res, out) {
  if (out.location) {
    res.writeHead(out.status, { ...BASE_HEADERS, location: out.location });
    return res.end();
  }
  if (out.html != null) {
    res.writeHead(out.status, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP });
    return res.end(out.html);
  }
  return send(res, out.status, out.body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BODY_LIMIT) return null;
  }
  return body;
}

function formOf(req, body) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(body || '{}');
      return new URLSearchParams(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      return null;
    }
  }
  return new URLSearchParams(body);
}

// authenticate(token) → principal or null; mcp({ method, headers, body,
// principal, signal }) → { status, body, headers }, i.e. lib/mcp.js's
// handleMcp with the API context bound.
export function createPublicHandler({ oauth, authenticate, mcp }) {
  const publicHost = hostOf(new URL(oauth.issuer).host);

  return async function handle(req, res) {
    const host = hostOf(req.headers.host);
    if (host !== publicHost && !LOOPBACK.has(host)) {
      return send(res, 421, { error: 'misdirected_request', error_description: `this listener answers to ${publicHost}` });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ip = clientAddress(req);
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    if (isGet && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      return send(res, 200, oauth.protectedResource(), { 'cache-control': 'max-age=300' });
    }
    if (isGet && path === '/.well-known/oauth-authorization-server') {
      return send(res, 200, oauth.serverMetadata(), { 'cache-control': 'max-age=300' });
    }

    if (path === '/oauth/register' && req.method === 'POST') {
      const body = await readBody(req);
      if (body == null) return send(res, 413, { error: 'invalid_client_metadata', error_description: 'body too large' });
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      return sendResult(res, oauth.register(parsed, ip));
    }

    if (path === '/oauth/authorize' && isGet) return sendResult(res, oauth.authorizeStart(url.searchParams));
    if (path === '/oauth/authorize' && req.method === 'POST') {
      const body = await readBody(req);
      const form = body == null ? null : formOf(req, body);
      if (!form) return sendResult(res, { status: 400, html: 'bad request' });
      return sendResult(res, oauth.authorizeSubmit(form, ip));
    }

    if (path === '/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      const form = body == null ? null : formOf(req, body);
      if (!form) return send(res, 400, { error: 'invalid_request', error_description: 'unreadable body' });
      return sendResult(res, oauth.token(form, req.headers));
    }

    if (path === '/mcp') {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''));
      if (!m) {
        return send(res, 401, { error: 'invalid_token', error_description: 'sign in to use this server' }, { 'www-authenticate': oauth.challenge() });
      }
      const principal = authenticate(m[1]);
      if (!principal) {
        return send(res, 401, { error: 'invalid_token', error_description: 'the token is expired, revoked or not an OAuth token' }, { 'www-authenticate': oauth.challenge('invalid_token') });
      }
      let body = '';
      if (!isGet) {
        body = await readBody(req);
        if (body == null) return send(res, 413, { error: 'too_large', error_description: 'body too large' });
      }
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      const out = await mcp({ method: req.method, headers: req.headers, body, principal, signal: gone.signal });
      if (res.destroyed) return undefined;
      if (!out.body) {
        res.writeHead(out.status, { ...BASE_HEADERS, ...out.headers });
        return res.end();
      }
      return send(res, out.status, out.body, out.headers);
    }

    return send(res, 404, { error: 'not_found', error_description: 'this listener serves /mcp only' });
  };
}
