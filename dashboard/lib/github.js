// GitHub API access.
//
// Two things here are not obvious and are the reason this is a module rather
// than a couple of fetch calls.
//
// 1. AUTH. `gh` on the runner host keeps its token in the login keychain, which
//    a non-login session cannot read — `gh auth status` reports an invalid
//    token over SSH while working fine in the GUI session. LaunchAgents *do*
//    get keychain access, which is why health.sh works from launchd. So the
//    token is resolved once at startup by shelling out to `gh auth token`, and
//    everything after that is plain fetch. One subprocess per process lifetime
//    instead of one per API call.
//
// 2. ETAGS. The fast loop polls every repo every 15s. A conditional request
//    that comes back 304 does not count against the 5000/hr limit, so the ETag
//    cache is what makes a 15-second cadence affordable at all. Without it the
//    idle fleet alone would burn most of the hourly budget doing nothing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const API = 'https://api.github.com';

// Statuses that mean "try again", not "something is wrong with your request".
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const RETRY_BACKOFF_MS = [300, 900];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Workflow-run statuses that mean work is still live on GitHub's side. Kept as
// a set so fleetd can filter consistently and tests can assert without HTTP.
export const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'pending',
  'requested',
]);

/** @param {string|null|undefined} status */
export function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(String(status ?? '').toLowerCase());
}

/**
 * @param {object[]} runs
 * @returns {object[]}
 */
export function filterActiveRuns(runs) {
  return (runs ?? []).filter((r) => isActiveRunStatus(r.status));
}

/**
 * Merge paginated workflow-run pages, deduping by run id.
 *
 * @param {object[][]} pages
 * @returns {object[]}
 */
export function mergeRunPages(pages) {
  const byId = new Map();
  for (const page of pages ?? []) {
    for (const run of page ?? []) {
      if (run?.id != null) byId.set(run.id, run);
    }
  }
  return [...byId.values()];
}

/**
 * Build the REST paths used to collect every queued and in-progress run for one
 * repo. Split by status because GitHub paginates per query and a single
 * `per_page=12` slice is how older collector ticks missed deep queues.
 *
 * @param {string} repo
 * @param {{ perPage?: number, maxPages?: number, statuses?: string[] }} [opts]
 * @returns {{ path: string, status: string }[]}
 */
export function activeRunQueryPaths(repo, { perPage = 100, maxPages = 5, statuses = null } = {}) {
  const wanted = statuses ?? ['queued', 'in_progress', 'waiting'];
  const paths = [];
  for (const status of wanted) {
    for (let page = 1; page <= maxPages; page++) {
      paths.push({
        status,
        path: `repos/${repo}/actions/runs?status=${status}&per_page=${perPage}&page=${page}`,
      });
    }
  }
  return paths;
}

export class GitHub {
  constructor({ log }) {
    this.token = null;
    this.log = log;
    this.etags = new Map();
    this.cache = new Map();
    this.rate = { remaining: null, limit: null, resetAt: null };
    this.backoffUntil = 0;
    // Counter only. There is deliberately no shared `lastError` field: the fast
    // loop fans out across every repo at once, so a single mutable "last error"
    // is written by whichever request happened to finish last. Errors are thrown
    // and the caller aggregates them per tick.
    this.transientRetries = 0;
  }

  async resolveToken() {
    const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (fromEnv) {
      this.token = fromEnv.trim();
      this.tokenSource = 'env';
      return this.token;
    }
    try {
      // PATH is set explicitly in the LaunchAgent; if gh is missing this throws
      // and the message below is the one that actually helps.
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 15000 });
      this.token = stdout.trim();
      this.tokenSource = 'gh-keychain';
      return this.token;
    } catch (err) {
      throw new Error(
        'could not obtain a GitHub token. `gh auth token` failed: ' +
          (err.stderr || err.message).trim() +
          '\nThis is expected over SSH — gh keeps its token in the login keychain. ' +
          'Run under launchd (which has keychain access), or set GH_TOKEN.'
      );
    }
  }

  // Returns { data, notModified, status }. `data` is the cached body on a 304,
  // so callers never have to care which one they got.
  //
  // Transient failures are retried here rather than surfaced. GitHub returns
  // 503 "No server is currently available to service your request" now and
  // then, and the correct response to it is to resubmit — its own error text
  // says so. Reporting a one-off blip as a dashboard error just trains people
  // to ignore the error line.
  //
  // 429 and 403 are deliberately NOT retried: those are rate limiting, they need
  // backoff on a timescale of minutes, and retrying immediately makes it worse.
  async get(path, { etag = true, attempts = 3 } = {}) {
    if (Date.now() < this.backoffUntil) {
      throw Object.assign(
        new Error(`${path}: GitHub rate-limit backoff until ${new Date(this.backoffUntil).toISOString()}`),
        { status: 429, rateLimited: true }
      );
    }
    if (!this.token) await this.resolveToken();

    const url = path.startsWith('http') ? path : `${API}/${path.replace(/^\//, '')}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fleet-dashboard',
      Authorization: `Bearer ${this.token}`,
    };
    const prior = this.etags.get(url);
    if (etag && prior) headers['If-None-Match'] = prior;

    let lastProblem = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        this.transientRetries++;
        await sleep(RETRY_BACKOFF_MS[attempt - 2] ?? 900);
      }

      let res;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      } catch (err) {
        // A timeout or a dropped connection is exactly as transient as a 503.
        lastProblem = new Error(`${path}: ${err.message}`);
        continue;
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null) {
        this.rate = {
          remaining: Number(remaining),
          limit: Number(res.headers.get('x-ratelimit-limit')),
          resetAt: Number(res.headers.get('x-ratelimit-reset')) * 1000,
        };
      }

      if (res.status === 304) {
        return { data: this.cache.get(url), notModified: true, status: 304 };
      }

      if (res.status === 401) {
        // A rotated or expired token: drop it so the next call re-resolves rather
        // than every subsequent request failing identically until a restart.
        this.token = null;
        throw new Error(`${path}: 401 unauthorized (token dropped, will re-resolve)`);
      }

      if (res.status === 429 || (res.status === 403 && this.rate.remaining === 0)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const resetAt = this.rate.resetAt ?? 0;
        this.backoffUntil = Number.isFinite(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter * 1000
          : Math.max(Date.now() + 60_000, resetAt);
        const body = await res.text().catch(() => '');
        throw Object.assign(
          new Error(`${path}: ${res.status} rate limited; backing off until ${new Date(this.backoffUntil).toISOString()} ${body.slice(0, 120)}`),
          { status: res.status, rateLimited: true, resetAt: this.backoffUntil }
        );
      }

      if (TRANSIENT_STATUS.has(res.status)) {
        const body = await res.text().catch(() => '');
        lastProblem = Object.assign(new Error(`${path}: ${res.status} ${body.slice(0, 160)}`),
          { status: res.status, transient: true });
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`${path}: ${res.status} ${body.slice(0, 200)}`), { status: res.status });
      }

      const data = await res.json();
      const newEtag = res.headers.get('etag');
      if (etag && newEtag) {
        this.etags.set(url, newEtag);
        this.cache.set(url, data);
      }
      return { data, notModified: false, status: res.status };
    }

    // Every attempt was transient. Now it is worth telling someone about.
    throw lastProblem ?? new Error(`${path}: failed after ${attempts} attempts`);
  }

  // Mutations. Separate from get() because these must never be retried blindly
  // and must never consult the ETag cache — a cached 304 on a POST is nonsense.
  async post(path, body) {
    if (!this.token) await this.resolveToken();
    const url = `${API}/${path.replace(/^\//, '')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fleet-dashboard',
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    // Note: no retry on POST. A mutation that timed out may or may not have
    // applied, and re-running "cancel this run" or "dispatch this workflow"
    // blindly is worse than reporting the failure.
    return text ? JSON.parse(text) : null;
  }

  async runs(repo, perPage = 12) {
    const { data } = await this.get(`repos/${repo}/actions/runs?per_page=${perPage}`);
    return data?.workflow_runs ?? [];
  }

  /**
   * Paginate one status query until a short page or maxPages.
   *
   * @returns {Promise<object[]>}
   */
  async runsPaginated(repo, { status = null, perPage = 100, maxPages = 5 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const q = status ? `&status=${encodeURIComponent(status)}` : '';
      const { data } = await this.get(
        `repos/${repo}/actions/runs?per_page=${perPage}&page=${page}${q}`
      );
      const runs = data?.workflow_runs ?? [];
      out.push(...runs);
      if (runs.length < perPage) break;
    }
    return out;
  }

  /**
   * Every queued and in-progress run for a repo, paginated and deduped.
   * Suitable for fleetd's fast tick once it replaces the single-page `runs()`.
   *
   * @returns {Promise<object[]>}
   */
  async activeRuns(repo, { perPage = 100, maxPages = 5 } = {}) {
    const pages = await Promise.all(['queued', 'in_progress', 'waiting'].map((status) =>
      this.runsPaginated(repo, { status, perPage, maxPages })
    ));
    return mergeRunPages(pages);
  }

  async jobsForRun(repo, runId) {
    // Job lists change while a run is active, but GitHub changes their ETag with
    // the representation. A 304 therefore means the cached body is still the
    // current answer and saves the fleet's largest source of fast-loop calls.
    const { data } = await this.get(`repos/${repo}/actions/runs/${runId}/jobs`);
    return data?.jobs ?? [];
  }

  async runners(repo) {
    const { data } = await this.get(`repos/${repo}/actions/runners?per_page=100`);
    return data?.runners ?? [];
  }

  // Short-lived registration token for one repo. Tokens expire in about an
  // hour, so this is always fetched fresh when needed rather than cached. The
  // coordinator calls this immediately before queuing a runner.register command
  // so the token is as new as possible when the agent consumes it.
  async registrationToken(repo) {
    const data = await this.post(`repos/${repo}/actions/runners/registration-token`);
    if (!data?.token) throw new Error(`registrationToken: no token in response for ${repo}`);
    return data.token;
  }

  async removalToken(repo) {
    const data = await this.post(`repos/${repo}/actions/runners/remove-token`);
    if (!data?.token) throw new Error(`removalToken: no token in response for ${repo}`);
    return data.token;
  }

  async ownedRepos() {
    const out = [];
    for (let page = 1; page <= 4; page++) {
      const { data } = await this.get(
        `user/repos?affiliation=owner&sort=pushed&per_page=100&page=${page}`
      );
      if (!Array.isArray(data) || data.length === 0) break;
      out.push(...data);
      if (data.length < 100) break;
    }
    return out;
  }

  async workflowList(repo) {
    const { data } = await this.get(`repos/${repo}/actions/workflows?per_page=100`);
    return (data?.workflows ?? []).filter((w) => w.state === 'active');
  }

  // The contents API returns base64 with embedded newlines, which Buffer handles.
  //
  // `ref` matters more than it looks: with no ref this returns the default
  // branch, and GitHub runs the copy on whatever branch was pushed. On this
  // fleet the default branch is develop everywhere while main is where PRs
  // merge, so reading no ref meant linting a file that was not the one running.
  async fileContent(repo, path, ref = null) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const { data } = await this.get(`repos/${repo}/contents/${path}${q}`);
    if (!data?.content) return null;
    return { sha: data.sha, content: Buffer.from(data.content, 'base64').toString('utf8') };
  }

  // Failure-level annotation messages for one job — the only place GitHub
  // records *why* a job failed. See lib/failures.js for what this is for.
  //
  // Not ETag'd: each job is fetched once, ever, and caching payloads to serve
  // 304s nobody will ask for is the same waste as in jobsFor. Returns [] rather
  // than throwing on a 404, because annotations expire with the run logs and a
  // failure old enough to have lost them is a normal state, not an error.
  async failureAnnotations(repo, jobId) {
    try {
      const { data } = await this.get(`repos/${repo}/check-runs/${jobId}/annotations`, {
        etag: false,
      });
      if (!Array.isArray(data)) return [];
      return data
        .filter((a) => a?.annotation_level === 'failure')
        .map((a) => String(a.message ?? '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async workflowCount(repo) {
    const { data } = await this.get(`repos/${repo}/actions/workflows?per_page=100`);
    return (data?.workflows ?? []).filter((w) => w.state === 'active').length;
  }

  // Optional consolidated billing usage. Requires the enhanced-billing scope
  // (`admin:billing:read` in newer apps, or an enterprise PAT with billing
  // visibility). A 403 or 404 is not an error: it means the token does not have
  // the scope or the billing plan does not expose the endpoint. The caller
  // treats null as "unavailable" rather than "zero".
  //
  // Uses the newer /orgs/{org}/settings/billing/usage endpoint rather than the
  // retired product-specific /settings/billing/actions one. Falls back to user-
  // level billing if an org slug is not available.
  async billingUsage(orgOrUser) {
    try {
      // Try org first; fall back to user endpoint if 404.
      let res;
      try {
        res = await this.get(`orgs/${encodeURIComponent(orgOrUser)}/settings/billing/usage`, { etag: true });
      } catch (err) {
        if (err.status === 404) {
          res = await this.get(`users/${encodeURIComponent(orgOrUser)}/settings/billing/actions`, { etag: true });
        } else {
          throw err;
        }
      }
      if (res.notModified && res.data) return { data: res.data, cached: true };
      return { data: res.data, cached: false };
    } catch (err) {
      // 403 = no billing scope, 404 = endpoint not available on this plan.
      // Both are expected and are treated as "not available" rather than errors.
      if (err.status === 403 || err.status === 404 || err.status === 422) {
        return { data: null, unavailable: true, reason: `${err.status}` };
      }
      throw err;
    }
  }
}
