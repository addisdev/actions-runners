// Run status for held admission hooks.
//
// A job held by hooks/job-started.sh polls GitHub for its run's status, so a
// run that is cancelled or finishes while the job waits lets the runner go. The
// hook cannot do that itself: every runner's LaunchAgent sets SessionCreate, so
// its jobs run in a fresh security session without the login keychain, and `gh`
// there has no token. It falls back to anonymous requests, which cannot see a
// private repo and run into the anonymous rate limit. Measured 2026-10-05: no
// held job had ever logged `cancelled`, and waits for runs that had ended hours
// earlier filled the queue. The daemon resolved its token under launchd without
// SessionCreate, so it answers for them.
//
// Answers are cached per run for ttlMs. A dozen held hooks polling every 30 s
// then cost GitHub one request per run per window, not one per hook. Only repos
// this fleet serves are looked up, so a job cannot use the daemon's token to
// read other repositories.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN = /^\d{1,20}$/;
const MAX_ENTRIES = 500;

export class RunStatus {
  constructor({ fetchRun, knownRepo, ttlMs = 20_000, now = () => Date.now() }) {
    this.fetchRun = fetchRun;
    this.knownRepo = knownRepo;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = new Map();
  }

  // Returns { status, conclusion } or throws an Error with a numeric .status.
  async lookup(repo, runId) {
    if (!REPO.test(repo ?? '') || !RUN.test(runId ?? '')) throw httpError(400, 'repo and run required');
    if (!this.knownRepo(repo)) throw httpError(404, 'repo is not served by this fleet');
    const key = `${repo}#${runId}`;
    const at = this.now();
    const hit = this.cache.get(key);
    if (hit && at - hit.at < this.ttlMs) return hit.value;
    if (hit?.pending) return hit.pending;
    const pending = this.fetchRun(repo, runId).then(
      (run) => {
        const value = { status: run?.status ?? null, conclusion: run?.conclusion ?? null };
        this.cache.set(key, { at: this.now(), value });
        this.prune();
        return value;
      },
      (err) => {
        this.cache.delete(key);
        throw err;
      },
    );
    this.cache.set(key, { at: -Infinity, pending });
    return pending;
  }

  prune() {
    if (this.cache.size <= MAX_ENTRIES) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.cache) {
      if (!entry.pending && entry.at < cutoff) this.cache.delete(key);
    }
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
