// Whether a held job belongs to a priority PR, for hooks/job-started.sh.
//
// ultra, 2026-11-05: 40-odd jobs queued, most of them PRs that parallel Claude
// sessions opened under the owner's account, and the owner's own PR waited
// behind them for hours. A PR carrying the priority label (`cockpit priority
// <repo> <pr>` adds it) gets the next free slot in its admission lane; the
// hook does the ordering (see PRIORITY LANE in hooks/common.sh), and asks here
// whether its run is one: like /api/run-status, a job's own `gh` has no token
// (SessionCreate), and the daemon has one.
//
// Only a job that has to wait asks, then every 30 s while it waits, so a label
// added to a PR whose job is already held takes effect within that. Answers are
// cached: a run's PR never changes (cached for good, up to MAX_ENTRIES), and a
// PR's labels are read at most once per ttlMs however many of its jobs ask.
// Only repos this fleet serves are looked up, as in run-status.js.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN = /^\d{1,20}$/;
// GitHub allows 50 characters and nearly anything in a label name; a hook
// sends the one in fleet.env. Refusing control characters is enough here.
const LABEL = /^[^\x00-\x1f\x7f]{1,50}$/;
const MAX_ENTRIES = 500;

export const DEFAULT_PRIORITY_LABEL = 'priority';

export class JobPriority {
  /**
   * @param {object} opts
   * @param {(repo: string, runId: string) => Promise<object>} opts.fetchRun - GitHub's run
   * @param {(repo: string, pr: number) => Promise<string[]>} opts.fetchLabels - the PR's label names
   * @param {(repo: string) => boolean} opts.knownRepo
   */
  constructor({ fetchRun, fetchLabels, knownRepo, ttlMs = 30_000, now = () => Date.now() }) {
    this.fetchRun = fetchRun;
    this.fetchLabels = fetchLabels;
    this.knownRepo = knownRepo;
    this.ttlMs = ttlMs;
    this.now = now;
    this.prOfRun = new Map();
    this.labels = new Map();
  }

  /**
   * @returns {Promise<{priority: boolean, pr: number|null, label: string}>}
   *   or throws an Error with a numeric .status
   */
  async lookup(repo, runId, label = DEFAULT_PRIORITY_LABEL) {
    if (!REPO.test(repo ?? '') || !RUN.test(runId ?? '')) throw httpError(400, 'repo and run required');
    const want = label == null || label === '' ? DEFAULT_PRIORITY_LABEL : String(label);
    if (!LABEL.test(want)) throw httpError(400, 'bad label');
    if (!this.knownRepo(repo)) throw httpError(404, 'repo is not served by this fleet');
    const pr = await this.prFor(repo, runId);
    if (pr == null) return { priority: false, pr: null, label: want };
    const names = await this.labelsFor(repo, pr);
    const lower = want.toLowerCase();
    return { priority: names.some((n) => String(n).toLowerCase() === lower), pr, label: want };
  }

  async prFor(repo, runId) {
    const key = `${repo}#${runId}`;
    const hit = this.prOfRun.get(key);
    if (hit) return hit.pending ?? hit.value;
    const pending = this.fetchRun(repo, runId).then(
      (run) => {
        const value = prOfRun(run, repo);
        this.prOfRun.set(key, { value });
        prune(this.prOfRun);
        return value;
      },
      (err) => {
        this.prOfRun.delete(key);
        throw err;
      },
    );
    this.prOfRun.set(key, { pending });
    return pending;
  }

  async labelsFor(repo, pr) {
    const key = `${repo}#${pr}`;
    const at = this.now();
    const hit = this.labels.get(key);
    if (hit && !hit.pending && at - hit.at < this.ttlMs) return hit.value;
    if (hit?.pending) return hit.pending;
    const pending = this.fetchLabels(repo, pr).then(
      (names) => {
        const value = Array.isArray(names) ? names : [];
        this.labels.set(key, { at: this.now(), value });
        prune(this.labels);
        return value;
      },
      (err) => {
        this.labels.delete(key);
        throw err;
      },
    );
    this.labels.set(key, { at: -Infinity, pending });
    return pending;
  }
}

/**
 * The PR number a run belongs to, or null. GitHub fills `pull_requests` for a
 * pull_request run whose head is in the same repository (every PR here: one
 * account, no forks), and for a push to such a PR's branch. One whose PR's
 * base is another repository is not this repo's PR.
 */
export function prOfRun(run, repo) {
  const prs = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  const want = String(repo ?? '').toLowerCase();
  for (const p of prs) {
    const base = p?.base?.repo?.name && p?.base?.repo?.url
      ? String(p.base.repo.url).toLowerCase().endsWith(`/repos/${want}`)
      : true;
    if (base && Number.isInteger(p?.number)) return p.number;
  }
  return null;
}

function prune(map) {
  if (map.size <= MAX_ENTRIES) return;
  // Oldest first: Map iterates in insertion order.
  for (const key of map.keys()) {
    if (map.size <= MAX_ENTRIES) break;
    if (!map.get(key)?.pending) map.delete(key);
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
