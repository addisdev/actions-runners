// MCP over Streamable HTTP, generated from the /api/v1 route table. Each
// route with a tool becomes an MCP tool of the same name, and a tool call is
// answered by handleApi itself, so a tool cannot take an argument, skip a
// scope or word an error differently from the REST route it stands for.
//
// Stateless: one JSON response per POST, no session id, no server-initiated
// stream. Nothing here needs a session, and a stateless server survives a
// daemon restart without every connected client having to re-initialise.

import { readFileSync } from 'node:fs';
import { ROUTES, API_PREFIX, ApiError, handleApi } from './api.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const INSTRUCTIONS = `Tools for a self-hosted GitHub Actions runner fleet.
Order: fleet_status first; diagnose_repo for one repository; wait_for_checks to wait on a PR instead of polling gh.
A failure marked notYourCode, or an orphan with workPassed, is the fleet's fault: never change code for it.
run_action previews first and returns a confirm token; show the preview and confirm only what the person asked for.`;

function propertyOf(spec) {
  return {
    type: spec.type,
    description: spec.description,
    ...(spec.pattern ? { pattern: spec.pattern } : {}),
    ...(spec.enum ? { enum: spec.enum } : {}),
    ...(spec.min != null ? { minimum: spec.min } : {}),
    ...(spec.max != null ? { maximum: spec.max } : {}),
  };
}

function fieldsOf(route) {
  return [...route.params, ...(route.body ?? []).map((f) => ({ ...f, in: 'body' }))];
}

export const TOOL_ROUTES = ROUTES.filter((r) => r.tool !== false);

export function tools() {
  return TOOL_ROUTES.map((r) => {
    const fields = fieldsOf(r);
    const read = r.method === 'GET';
    return {
      name: r.id,
      title: r.summary,
      description: r.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(fields.map((f) => [f.name, propertyOf(f)])),
        required: fields.filter((f) => f.required || f.in === 'path').map((f) => f.name),
        additionalProperties: false,
      },
      annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read, openWorldHint: false },
    };
  });
}

// A tool call's arguments, laid out as the HTTP request the route expects.
export function requestFor(route, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'invalid_args', 'arguments must be an object');
  }
  const args = { ...input };
  // Agents write a repository the way GitHub prints it.
  const takesOwner = route.params.some((p) => p.name === 'owner');
  if (takesOwner && args.owner == null && typeof args.repo === 'string' && args.repo.includes('/')) {
    [args.owner, args.repo] = args.repo.split('/', 2);
  }
  const fields = fieldsOf(route);
  for (const k of Object.keys(args)) {
    if (!fields.some((f) => f.name === k)) {
      throw new ApiError(400, 'unknown_param', `${route.id} does not take ${k}`,
        fields.length ? `It takes ${fields.map((f) => f.name).join(', ')}.` : 'It takes no arguments.');
    }
  }
  let path = route.path;
  const url = new URL('http://mcp');
  const body = {};
  for (const f of fields) {
    const v = args[f.name];
    if (f.in === 'path') {
      if (v == null || v === '') throw new ApiError(400, 'missing_param', `${f.name} is required`, f.description);
      path = path.replace(`{${f.name}}`, encodeURIComponent(String(v)));
    } else if (v != null) {
      if (f.in === 'query') url.searchParams.set(f.name, String(v));
      else body[f.name] = v;
    }
  }
  url.pathname = API_PREFIX + path;
  return { method: route.method, url, body: route.body ? JSON.stringify(body) : '' };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function callTool(params, { principal, signal }, ctx) {
  const route = TOOL_ROUTES.find((r) => r.id === params?.name);
  if (!route) return { error: [-32602, `unknown tool ${params?.name}`] };
  let out;
  try {
    out = await handleApi({ ...requestFor(route, params.arguments ?? {}), principal, signal }, ctx);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    out = { status: err.status, body: { error: { code: err.code, message: err.message, hint: err.hint } } };
  }
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(out.body) }],
      structuredContent: out.body,
      isError: out.status >= 400,
    },
  };
}

async function dispatch(msg, req, ctx) {
  const { method, params } = msg;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'actions-runners-fleet', title: 'Actions Runners fleet', version: VERSION },
          instructions: ctx.instructions?.() ?? INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: tools() } };
    case 'tools/call':
      return callTool(params, req, ctx);
    default:
      return { error: [-32601, `method not found: ${method}`] };
  }
}

// One HTTP request to the MCP endpoint. Returns { status, headers, body }
// with body null for 202 Accepted.
export async function handleMcp({ method, headers = {}, body = '', principal = null, signal = null }, ctx) {
  if (method !== 'POST') {
    return { status: 405, headers: { allow: 'POST' }, body: rpcError(null, -32000, 'this server answers POST only; it opens no event stream') };
  }
  const version = headers['mcp-protocol-version'];
  if (version && !PROTOCOL_VERSIONS.includes(version)) {
    return { status: 400, headers: {}, body: rpcError(null, -32600, `unsupported MCP-Protocol-Version ${version}; supported: ${PROTOCOL_VERSIONS.join(', ')}`) };
  }
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return { status: 400, headers: {}, body: rpcError(null, -32700, 'parse error') };
  }
  if (Array.isArray(msg)) return { status: 400, headers: {}, body: rpcError(null, -32600, 'batches are not supported') };
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { status: 400, headers: {}, body: rpcError(null, -32600, 'not a JSON-RPC 2.0 message') };
  }
  // Notifications and responses need no answer.
  if (msg.id === undefined || msg.method === undefined) return { status: 202, headers: {}, body: null };
  const out = await dispatch(msg, { principal, signal }, ctx);
  if (out.error) return { status: 200, headers: {}, body: rpcError(msg.id, ...out.error) };
  return { status: 200, headers: {}, body: { jsonrpc: '2.0', id: msg.id, result: out.result } };
}
