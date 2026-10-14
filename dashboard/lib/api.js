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

function freshness(g) {
  return { generatedAt: g.generatedAt ?? null, ageMs: g.ageMs ?? null, stale: Boolean(g.stale) };
}

export const ROUTES = [
  {
    id: 'fleet_status',
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
    method: 'GET',
    path: '/repos/{owner}/{repo}/diagnosis',
    scope: 'read',
    summary: 'Why one repository\'s CI is queued, slow or red',
    description:
      'Everything the fleet knows about one repository: its runners and their states, its queued runs with '
      + 'the classified cause and ETA, its active and recently finished runs, its recent failures (each '
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
      if (!runners.length && !queue.length && !runs.length && !recent.length && !failures.length) {
        throw new ApiError(404, 'unknown_repo',
          `the fleet has no runner, queued run, recent run or failure for ${full}`,
          'Repositories are owner/repo and match GitHub. GET /api/v1/runners lists the ones the fleet serves.');
      }
      // Incident keys name a repository in full (newfail:owner/repo:…) or a
      // runner (runner:unused:<name>). A bare repository name would match
      // every incident about a repo whose name contains it.
      const needles = [full, ...runners.map((r) => r.name)].map((s) =>
        new RegExp(`(^|[^a-z0-9_.-])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-z0-9_.-])`));
      const incidents = (g.incidents ?? []).filter((i) => {
        const hay = `${i.key ?? ''} ${i.title ?? ''}`.toLowerCase();
        return needles.some((n) => n.test(hay));
      });
      return {
        repo: runners[0]?.repo ?? queue[0]?.repo ?? runs[0]?.repo ?? recent[0]?.repo ?? failures[0]?.repo,
        verdict: g.verdict,
        runners, queue, runs, recent, failures,
        orphans: byRepo(ctx.orphans(g), full),
        incidents,
        freshness: freshness(g),
      };
    },
  },
  {
    id: 'list_queue',
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
    method: 'GET',
    path: '/actions',
    scope: 'read',
    summary: 'The actions the dashboard can perform',
    description:
      'The action catalogue: id, label, danger (none, medium, high) and the confirmation text a person sees. '
      + 'Listing an action does not grant the right to run it.',
    params: [],
    handler: (ctx) => ctx.actions(),
  },
  {
    id: 'openapi',
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
    if (!/^-?\d+$/.test(raw)) throw new ApiError(400, 'invalid_param', `${spec.name} must be an integer`);
    value = Number(raw);
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
export async function handleApi({ method, url }, ctx) {
  const headers = { 'fleet-api-version': String(API_VERSION) };
  try {
    const { route, params } = matchRoute(method, url);
    let glance = null;
    const once = { ...ctx, glance: () => (glance ??= ctx.glance()) };
    return { status: 200, headers, body: await route.handler(once, params) };
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
  };
}

export function openApi() {
  const paths = {};
  for (const r of ROUTES) {
    const key = API_PREFIX + r.path;
    paths[key] ??= {};
    paths[key][r.method.toLowerCase()] = {
      operationId: r.id,
      summary: r.summary,
      description: r.description,
      'x-fleet-scope': r.scope,
      parameters: r.params.map((s) => ({
        name: s.name, in: s.in, required: Boolean(s.required || s.in === 'path'),
        description: s.description, schema: schemaOf(s),
      })),
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
