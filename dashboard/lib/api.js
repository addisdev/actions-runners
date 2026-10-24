// The /api/v1 route table: the one description of the dashboard's API that
// programs are built against. The OpenAPI document and the request
// validation are both read from it, and the CLI and MCP tools must be too,
// so that none of them can disagree about what a route takes. The unversioned
// routes in fleetd.js belong to the browser UI and may change with it.
//
// Rules every route follows:
//   - A repository is always `{owner}/{repo}` in the path, never a bare name:
//     two owners can hold a repo of the same name, and guessing which one was
//     meant is how a diagnosis gets attributed to the wrong project.
//   - Lists come back as `{ items: [...] }`, so a field can be added beside
//     them without breaking a reader.
//   - Errors are `{ error: { code, message, hint } }`. `code` is for programs,
//     `message` for people, `hint` says what to do next.
//   - An unknown query parameter is a 400 rather than ignored: `?repository=`
//     silently returning the whole fleet is a wrong answer that looks right.
//   - Every response carries `fleet-api-version`.
//   - `cli` names the route's command in bin/fleet.mjs, which builds itself
//     from the OpenAPI document; `positional` says which parameters it takes
//     in order ('owner/repo' is the two path parameters as GitHub writes them),
//     and `confirms` marks the route that answers a preview to be confirmed.

import { grants, parseScopes } from './scopes.js';
import { checkSets } from './checks.js';

export const API_VERSION = 1;
export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message, hint = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const repoQuery = {
  name: 'repo', in: 'query', type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
  description: 'Only this repository, as owner/repo.',
};
const repoPath = [
  { name: 'owner', in: 'path', type: 'string', required: true, pattern: NAME.source, description: 'Repository owner.' },
  { name: 'repo', in: 'path', type: 'string', required: true, pattern: NAME.source, description: 'Repository name.' },
];

// GitHub treats owner and repository names case-insensitively, and so does
// every comparison here.
function sameRepo(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function byRepo(list, full) {
  return full ? (list ?? []).filter((x) => sameRepo(x.repo, full)) : (list ?? []);
}

// The daemon answers only for repositories it serves: its GitHub token must
// not become a way to read any repository the token can see.
function knownRepo(g, full) {
  const sections = [g.runners, g.queue, g.runs, g.recent, g.failures];
  if (!sections.some((list) => (list ?? []).some((x) => sameRepo(x.repo, full)))) {
    throw new ApiError(404, 'unknown_repo',
      `the fleet has no runner, queued run, recent run or failure for ${full}`,
      'Repositories are owner/repo and match GitHub. GET /api/v1/runners lists the ones the fleet serves.');
  }
}

function freshness(g) {
  return { generatedAt: g.generatedAt ?? null, ageMs: g.ageMs ?? null, stale: Boolean(g.stale) };
}

export const ROUTES = [
  {
    id: 'fleet_status',
    cli: { name: 'status' },
    method: 'GET',
    path: '/status',
    scope: 'read',
    summary: 'The fleet verdict',
    description:
      'One verdict for the whole fleet, from an ordered ladder (cannot read GitHub, host down, disk floor, '
      + 'dead service, shm low, saturated, account blocked, config drift, waiting, clear), with its evidence '
      + 'and one next move; the counts; standing risks; and how fresh the view is. Read this before '
      + 'diagnosing any self-hosted CI problem: the first rung that matches makes the ones below it meaningless.',
    params: [],
    handler: (ctx) => {
      const g = ctx.glance();
      return { verdict: g.verdict, counts: g.counts ?? null, posture: g.posture ?? null, freshness: freshness(g) };
    },
  },
  {
    id: 'diagnose_repo',
    cli: { name: 'why', positional: ['owner/repo'] },
    method: 'GET',
    path: '/repos/{owner}/{repo}/diagnosis',
    scope: 'read',
    summary: 'Why one repository\'s CI is queued, slow or red',
    description:
      'Everything the fleet knows about one repository: its runners and their states, its queued runs with '
      + 'the classified cause and ETA, its active and recently finished runs, the checks of its latest '
      + 'commits as green, red or pending, its recent failures (each '
      + 'marked notYourCode when the host or the account caused it), jobs orphaned by a runner that went '
      + 'away while they were finishing, and open incidents that mention it, beside the fleet verdict. '
      + 'A failure with notYourCode true, or an orphan with workPassed true, is never fixed by changing code.',
    params: repoPath,
    handler: (ctx, p) => {
      const full = `${p.owner}/${p.repo}`;
      const g = ctx.glance();
      const runners = byRepo(g.runners, full);
      const queue = byRepo(g.queue, full);
      const runs = byRepo(g.runs, full);
      const recent = byRepo(g.recent, full);
      const failures = byRepo(g.failures, full);
      knownRepo(g, full);
      // Incident keys name a repository in full (newfail:owner/repo:…) or a
      // runner (runner:unused:<name>). A bare repository name would match
      // every incident about a repo whose name contains it.
      const needles = [full, ...runners.map((r) => r.name)].map((s) =>
        new RegExp(`(^|[^a-z0-9_.-])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-z0-9_.-])`));
      const incidents = (g.incidents ?? []).filter((i) => {
        const hay = `${i.key ?? ''} ${i.title ?? ''}`.toLowerCase();
        return needles.some((n) => n.test(hay));
      });
      const checks = checkSets(g).filter((s) => sameRepo(s.repo, full)).slice(0, 5).map((s) => ({
        prNumber: s.prNumber, branch: s.branch, sha: s.sha, title: s.title,
        state: s.state, progress: s.progress, etaGreenMs: s.etaGreenMs,
      }));
      return {
        repo: runners[0]?.repo ?? queue[0]?.repo ?? runs[0]?.repo ?? recent[0]?.repo ?? failures[0]?.repo,
        verdict: g.verdict,
        runners, queue, runs, recent, failures, checks,
        orphans: byRepo(ctx.orphans(g), full),
        incidents,
        freshness: freshness(g),
      };
    },
  },
  {
    id: 'wait_for_checks',
    cli: { name: 'checks', positional: ['owner/repo'] },
    method: 'GET',
    path: '/repos/{owner}/{repo}/checks',
    scope: 'read',
    summary: 'A PR\'s or commit\'s checks as green, red, pending or pointless, optionally waiting',
    description:
      'The checks of a PR (its head commit only, never an older commit\'s result), a commit or a branch, '
      + 'rolled up as green, red, pending or pointless. With wait=N the request is held open up to N seconds '
      + '(at most 300) until the checks finish; pending means the wait ran out, so ask again. pointless means '
      + 'waiting cannot end well: the host is down, the disk floor is holding jobs, GitHub is refusing this repo\'s jobs, '
      + 'a queued check will never start, or a job was orphaned; reason says which, and orphans carry their '
      + 'recovery. Cancelled is red, not green. Green means GitHub itself has every workflow run for the head '
      + 'completed with all of its jobs passed, and nothing new for 30 s (verified says what it covered): runs '
      + 'and needs-gated jobs register after a push, so a green first wave is not the end. '
      + 'Use this instead of polling gh pr checks. A client that gives '
      + 'up on slow calls should use a shorter wait and ask again.',
    params: [
      ...repoPath,
      { name: 'pr', in: 'query', type: 'integer', min: 1, description: 'Pull request number.' },
      { name: 'sha', in: 'query', type: 'string', pattern: '^[0-9a-fA-F]{7,40}$', description: 'Commit SHA, 7 to 40 hex digits.' },
      { name: 'branch', in: 'query', type: 'string', pattern: '^[A-Za-z0-9._/-]{1,200}$', description: 'Branch name.' },
      { name: 'wait', in: 'query', type: 'integer', min: 0, max: 300, description: 'Seconds to wait for the checks to finish (0 to 300, default 0).' },
    ],
    handler: async (ctx, p, req) => {
      const full = `${p.owner}/${p.repo}`;
      const g = ctx.glance();
      knownRepo(g, full);
      if ([p.pr, p.sha, p.branch].filter((x) => x != null).length > 1) {
        throw new ApiError(400, 'invalid_param', 'give one of pr, sha or branch', 'A PR\'s checks are its head commit\'s; pr alone is enough.');
      }
      const target = { repo: full, pr: p.pr ?? null, sha: p.sha ?? null, branch: p.branch ?? null };
      const out = await ctx.waitForChecks(target, { waitS: p.wait ?? 0, signal: req?.signal ?? null });
      return { target, ...out };
    },
  },
  {
    id: 'list_queue',
    cli: { name: 'queue' },
    method: 'GET',
    path: '/queue',
    scope: 'read',
    summary: 'Queued runs, each with why it is waiting',
    description:
      'Every queued run with its classified cause, confidence, the evidence the classifier used, and '
      + 'estimated start and finish ranges. A queue is not a stall: `waiting`-class causes clear on their own.',
    params: [repoQuery],
    handler: (ctx, p) => ({ items: byRepo(ctx.glance().queue, p.repo) }),
  },
  {
    id: 'list_orphans',
    cli: { name: 'orphans' },
    method: 'GET',
    path: '/orphans',
    scope: 'read',
    summary: 'Jobs whose runner went away while they were finishing',
    description:
      'Jobs GitHub still shows in progress although every work step completed, because the runner was '
      + 'drained or lost during "Complete job". Waiting on them never ends: they need a force-cancel, then '
      + 'a re-run about a minute later (each orphan lists the commands under recovery). workPassed true '
      + 'means the result was lost, not failed.',
    params: [repoQuery],
    handler: (ctx, p) => ({ items: byRepo(ctx.orphans(ctx.glance()), p.repo) }),
  },
  {
    id: 'list_runners',
    cli: { name: 'runners' },
    method: 'GET',
    path: '/runners',
    scope: 'read',
    summary: 'Every runner and its state',
    description: 'One row per runner across every host: repository, host, state, and the job it is running.',
    params: [
      repoQuery,
      { name: 'host', in: 'query', type: 'string', pattern: NAME.source, description: 'Only runners on this host id.' },
      { name: 'state', in: 'query', type: 'string', pattern: '^[a-z-]{1,32}$', description: 'Only runners in this state, such as idle, busy, held, draining, drained, dead or offline.' },
    ],
    handler: (ctx, p) => ({
      items: byRepo(ctx.glance().runners, p.repo)
        .filter((r) => !p.host || r.host === p.host)
        .filter((r) => !p.state || r.state === p.state),
    }),
  },
  {
    id: 'list_hosts',
    cli: { name: 'hosts' },
    method: 'GET',
    path: '/hosts',
    scope: 'read',
    summary: 'Every host and its vitals',
    description:
      'One row per Mac: whether it is reporting (stale), switched off or paused (off, drained), and its '
      + 'load, memory pressure, disk and shared memory.',
    params: [],
    handler: (ctx) => ({ items: ctx.glance().hosts ?? [] }),
  },
  {
    id: 'list_actions',
    cli: { name: 'actions' },
    method: 'GET',
    path: '/actions',
    scope: 'read',
    summary: 'The actions the dashboard can perform',
    description:
      'The action catalogue: id, label, danger (none, medium, high), the scope a token needs to run it '
      + '(act or act:danger), the arguments it takes, and what it does (confirm). Listing an action does not '
      + 'grant the right to run it.',
    params: [],
    handler: (ctx) => ctx.actions(),
  },
  {
    id: 'run_action',
    cli: { name: 'run', positional: ['id'], confirms: true },
    method: 'POST',
    path: '/actions/{id}',
    scope: 'act',
    summary: 'Preview an action, then run it with the confirmation the preview returned',
    description:
      'Two calls. The first, without confirm, changes nothing: it validates the arguments and returns the '
      + 'exact command, what it will do, and a single-use confirm token valid for 5 minutes for this caller, '
      + 'action and arguments. The second, with the same args and that confirm, runs it. Show the preview to '
      + 'the person you are working for before confirming anything they did not ask for. dryRun: true returns '
      + 'the preview without a token. Needs a token with the action\'s scope: act for checks, previews, drain, '
      + 'resume, re-run, cancel and orphan recovery; act:danger for everything else.',
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, pattern: '^[a-zA-Z]+\\.[a-zA-Z]+$', description: 'Action id from GET /api/v1/actions, e.g. runner.drain.' },
    ],
    body: [
      { name: 'args', type: 'object', description: 'The action\'s arguments, as GET /api/v1/actions lists them.' },
      { name: 'confirm', type: 'string', description: 'The confirm token from the preview; runs the action.' },
      { name: 'dryRun', type: 'boolean', description: 'Preview only; no confirm token is issued.' },
    ],
    handler: async (ctx, p, req) => {
      const def = ctx.actionInfo(p.id);
      if (!def) {
        throw new ApiError(404, 'unknown_action', `no action ${p.id}`, 'GET /api/v1/actions lists them.');
      }
      if (ctx.readOnly()) throw new ApiError(403, 'read_only', 'this daemon is running read-only');
      requireScope(req.principal, def.scope);
      const args = validateArgs(def, req.body.args ?? {});
      const command = await ctx.previewAction(p.id, args);
      const preview = {
        action: p.id, label: def.label, danger: def.danger, scope: def.scope, args, command, effect: def.confirm,
      };
      if (req.body.dryRun) return { status: 'preview', ...preview };
      const caller = req.principal.id;
      if (!req.body.confirm) {
        const c = ctx.confirmations.issue({ action: p.id, args, caller });
        return {
          status: 'confirm_required', ...preview, confirm: c.token, expiresAt: c.expiresAt,
          hint: 'Nothing has run. Send the same args again with this confirm to run it.',
        };
      }
      const why = ctx.confirmations.consume(req.body.confirm, { action: p.id, args, caller });
      if (why) throw new ApiError(409, 'confirmation_invalid', why);
      const result = await ctx.runAction(p.id, args, req.principal);
      return { status: result.ok ? 'done' : 'failed', action: p.id, args, ...result };
    },
  },
  {
    id: 'whoami',
    cli: { name: 'me' },
    method: 'GET',
    path: '/me',
    scope: 'read',
    tool: false,
    summary: 'Who this token is and what it may do',
    description: 'The caller\'s name and scopes; authenticated false without a token.',
    params: [],
    handler: (ctx, p, req) => ({
      authenticated: Boolean(req.principal),
      caller: req.principal?.name ?? null,
      kind: req.principal?.kind ?? null,
      scopes: req.principal?.scopes ?? [],
      readOnly: ctx.readOnly(),
    }),
  },
  {
    id: 'create_token',
    cli: { name: 'token', positional: ['name'] },
    method: 'POST',
    path: '/tokens',
    scope: 'act:danger',
    tool: false,
    summary: 'Issue a named token with chosen scopes',
    description:
      'For an agent or a script: a token that holds only the scopes named. Shown once; the daemon keeps its '
      + 'hash. Revoke it like a paired device. Needs act:danger, so a scoped token cannot mint a wider one.',
    params: [],
    body: [
      { name: 'name', type: 'string', required: true, description: 'Who will hold it, e.g. "claude code on laptop".' },
      { name: 'scopes', type: 'string', required: true, description: 'Comma-separated: read, act, act:danger.' },
    ],
    handler: (ctx, p, req) => {
      if (ctx.readOnly()) throw new ApiError(403, 'read_only', 'this daemon is running read-only');
      requireScope(req.principal, 'act:danger');
      const name = String(req.body.name ?? '').trim();
      if (!name || name.length > 64) throw new ApiError(400, 'invalid_param', 'name must be 1 to 64 characters');
      const scopes = parseScopes(req.body.scopes);
      if (!scopes) throw new ApiError(400, 'invalid_param', 'scopes must be a comma-separated list of read, act, act:danger');
      const t = ctx.issueToken({ name, scopes });
      return {
        token: t.token, name: t.name, key: t.key, scopes,
        hint: `Shown once. Revoke with: ./dashboard/fleetctl.sh revoke ${t.key}`,
      };
    },
  },
  {
    id: 'openapi',
    cli: { name: 'openapi' },
    method: 'GET',
    path: '/openapi.json',
    scope: 'read',
    tool: false,
    summary: 'This API, as OpenAPI 3.1',
    description: 'Generated from the same route table that validates requests.',
    params: [],
    handler: () => openApi(),
  },
];

// --------------------------------------------------------------------- auth

// principal is { id, name, kind, scopes } for a valid token, null for none.
// A bad token never reaches here: fleetd answers 401/403 first.
function requireScope(principal, needed) {
  if (!principal) {
    throw new ApiError(401, 'missing_token', `this needs a token with the ${needed} scope`,
      'Send Authorization: Bearer <token>. ./dashboard/fleetctl.sh api-token <name> --scopes read,act issues one.');
  }
  if (!grants(principal.scopes, needed)) {
    throw new ApiError(403, 'insufficient_scope',
      `${principal.name} holds ${principal.scopes.join(', ') || 'no scopes'}; this needs ${needed}`,
      needed === 'act:danger' ? 'Ask the person you work for to run it, or to issue a token with act:danger.' : null);
  }
}

const ARG_TYPES = {
  string: (v) => typeof v === 'string' && v.length <= 200,
  integer: (v) => Number.isInteger(v) || (typeof v === 'string' && /^\d{1,15}$/.test(v)),
  boolean: (v) => typeof v === 'boolean',
};

// Only the arguments the action declares, of the declared types. The action
// itself still checks each value against what the daemon knows (a runner it
// discovered, a repo it polls).
function validateArgs(def, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ApiError(400, 'invalid_args', 'args must be an object');
  }
  const spec = def.args ?? [];
  const names = spec.map((s) => s.name);
  for (const k of Object.keys(args)) {
    if (!names.includes(k)) {
      throw new ApiError(400, 'invalid_args', `${def.id} does not take ${k}`,
        names.length ? `It takes ${names.join(', ')}.` : 'It takes no arguments.');
    }
  }
  const out = {};
  for (const s of spec) {
    const v = args[s.name];
    if (v === undefined || v === null || v === '') {
      if (s.required) throw new ApiError(400, 'invalid_args', `${s.name} is required`, s.description);
      continue;
    }
    if (!ARG_TYPES[s.type](v)) throw new ApiError(400, 'invalid_args', `${s.name} must be a ${s.type}`, s.description);
    out[s.name] = s.type === 'integer' ? Number(v) : v;
  }
  return out;
}

function parseBody(route, text) {
  if (!route.body) return {};
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, 'malformed_json', 'the request body is not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'malformed_json', 'the body must be a JSON object');
  const names = route.body.map((s) => s.name);
  for (const k of Object.keys(body)) {
    if (!names.includes(k)) throw new ApiError(400, 'unknown_field', `${route.id} does not take ${k}`, `It takes ${names.join(', ')}.`);
  }
  return body;
}

// ------------------------------------------------------------------ matching

function compile(route) {
  const names = [];
  const source = route.path.replace(/[.]/g, '\\.').replace(/\{(\w+)\}/g, (_, n) => {
    names.push(n);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${API_PREFIX}${source}$`), names };
}

const COMPILED = ROUTES.map((r) => ({ route: r, ...compile(r) }));

function coerce(spec, raw) {
  let value = raw;
  if (spec.type === 'integer') {
    if (!/^-?\d{1,15}$/.test(raw)) throw new ApiError(400, 'invalid_param', `${spec.name} must be an integer`);
    value = Number(raw);
    if ((spec.min != null && value < spec.min) || (spec.max != null && value > spec.max)) {
      throw new ApiError(400, 'invalid_param',
        `${spec.name} must be ${spec.max != null ? `between ${spec.min ?? '-∞'} and ${spec.max}` : `at least ${spec.min}`}`);
    }
  } else if (spec.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new ApiError(400, 'invalid_param', `${spec.name} must be true or false`);
    value = raw === 'true';
  } else if (spec.pattern && !new RegExp(spec.pattern).test(raw)) {
    throw new ApiError(400, 'invalid_param', `${spec.name} is not valid: ${JSON.stringify(raw)}`, spec.description);
  }
  if (spec.enum && !spec.enum.includes(value)) {
    throw new ApiError(400, 'invalid_param', `${spec.name} must be one of ${spec.enum.join(', ')}`);
  }
  return value;
}

export function matchRoute(method, url) {
  const hits = COMPILED.map((c) => ({ c, m: c.re.exec(url.pathname) })).filter((x) => x.m);
  if (!hits.length) {
    throw new ApiError(404, 'not_found', `no route ${url.pathname}`,
      `GET ${API_PREFIX}/openapi.json lists every route.`);
  }
  const hit = hits.find((x) => x.c.route.method === method);
  if (!hit) {
    const allow = hits.map((x) => x.c.route.method).join(', ');
    const err = new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${url.pathname}`, `Use ${allow}.`);
    err.allow = allow;
    throw err;
  }
  const { route, names } = hit.c;
  const params = {};
  names.forEach((n, i) => {
    let raw;
    try {
      raw = decodeURIComponent(hit.m[i + 1]);
    } catch {
      throw new ApiError(400, 'invalid_param', `${n} is not valid URL encoding`);
    }
    params[n] = coerce(route.params.find((s) => s.name === n), raw);
  });
  const known = route.params.filter((s) => s.in === 'query');
  for (const key of url.searchParams.keys()) {
    if (!known.some((s) => s.name === key)) {
      throw new ApiError(400, 'unknown_param', `${route.id} does not take ?${key}`,
        known.length ? `It takes ${known.map((s) => s.name).join(', ')}.` : 'It takes no query parameters.');
    }
  }
  for (const spec of known) {
    const raw = url.searchParams.get(spec.name);
    if (raw === null || raw === '') {
      if (spec.required) throw new ApiError(400, 'missing_param', `${spec.name} is required`, spec.description);
      continue;
    }
    params[spec.name] = coerce(spec, raw);
  }
  return { route, params };
}

// ctx supplies what the handlers read: glance() (the /api/glance payload),
// orphans(glance) and actions() (the catalogue). They are functions so a
// route that does not need the glance does not pay for building it.
export async function handleApi({ method, url, signal = null, principal = null, body = '' }, ctx) {
  const headers = { 'fleet-api-version': String(API_VERSION) };
  try {
    const { route, params } = matchRoute(method, url);
    if (route.scope === 'read' && principal) requireScope(principal, 'read');
    const parsed = parseBody(route, body);
    let glance = null;
    const once = { ...ctx, glance: () => (glance ??= ctx.glance()) };
    return { status: 200, headers, body: await route.handler(once, params, { signal, principal, body: parsed }) };
  } catch (err) {
    if (!(err instanceof ApiError)) {
      return { status: 500, headers, body: { error: { code: 'internal', message: err.message, hint: 'Check the daemon log: ./fleetctl.sh logs' } } };
    }
    if (err.allow) headers.allow = err.allow;
    return { status: err.status, headers, body: { error: { code: err.code, message: err.message, hint: err.hint } } };
  }
}

// ------------------------------------------------------------------- OpenAPI

function schemaOf(spec) {
  return {
    type: spec.type,
    ...(spec.pattern ? { pattern: spec.pattern } : {}),
    ...(spec.enum ? { enum: spec.enum } : {}),
    ...(spec.min != null ? { minimum: spec.min } : {}),
    ...(spec.max != null ? { maximum: spec.max } : {}),
  };
}

export function bodySchema(fields) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(fields.map((s) => [s.name, { type: s.type, description: s.description }])),
    required: fields.filter((s) => s.required).map((s) => s.name),
  };
}

export function openApi() {
  const paths = {};
  for (const r of ROUTES) {
    const key = API_PREFIX + r.path;
    paths[key] ??= {};
    paths[key][r.method.toLowerCase()] = {
      operationId: r.id,
      'x-fleet-cli': r.cli,
      summary: r.summary,
      description: r.description,
      'x-fleet-scope': r.scope,
      parameters: r.params.map((s) => ({
        name: s.name, in: s.in, required: Boolean(s.required || s.in === 'path'),
        description: s.description, schema: schemaOf(s),
      })),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: bodySchema(r.body) } } } } : {}),
      security: r.scope === 'read' ? [{}, { bearer: [] }] : [{ bearer: [] }],
      responses: {
        200: { description: r.summary, content: { 'application/json': { schema: { type: 'object' } } } },
        default: { description: 'An error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Actions Runners fleet API',
      version: String(API_VERSION),
      description: 'The read and control surface of the fleet dashboard. See docs/api.md.',
    },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'The control token, a paired-device token, or a scoped token from POST /api/v1/tokens.' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                hint: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  };
}
