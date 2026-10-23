// A job's admission lane, from how long it has been running lately.
//
// hooks/job-started.sh puts every job in a lane (FLEET_ADMIT_LANES): `light`
// jobs are short and cheap and get many slots, `heavy` ones (Xcode, Gradle,
// Playwright, pytest + dbt) few. A pattern in fleet.env decides first; for the
// rest the hook asks here, with the repo and GITHUB_JOB, the job's YAML id.
//
// The history that matches that key exactly is the hook's own: every release
// line in the admission log carries the repo, the job id and ran_s, how long
// the job held its slot, which leaves the admission hold out. GitHub's job rows
// carry the display name instead ("ci / test", "Migration filenames"), which
// for a reusable workflow ends in the id and otherwise may share nothing with
// it, and their duration includes the hold. So the admission log is read
// first, and the jobs table only when it has too few releases (a job new to
// the hook, or a display name passed by hand), matched on the whole name or
// its last " / " part.
//
// Too few samples either way is `unknown`, which the hook treats as heavy: a
// heavy job let into the light lane is what overloads the host.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULTS = { minSamples: 5, maxSamples: 30, windowDays: 14, cacheMs: 60_000, shortJobS: 90 };

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {() => number} [opts.now]
 * @param {() => number} [opts.shortJobS] - the host's FLEET_ADMIT_SHORT_JOB_S,
 *   used when the hook does not send its own.
 */
export function createJobClass({ db, now = () => Date.now(), shortJobS = () => DEFAULTS.shortJobS, ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const stmt = {
    released: db.prepare(`
      SELECT ran_s FROM admission_events
      WHERE event = 'released' AND repo = ? AND job = ? AND ts >= ? AND ran_s IS NOT NULL
      ORDER BY ts DESC LIMIT ?`),
    jobs: db.prepare(`
      SELECT duration_ms FROM jobs
      WHERE repo = ? AND (name = ? OR name LIKE ? ESCAPE '\\')
        AND conclusion = 'success' AND duration_ms IS NOT NULL AND started_at >= ?
      ORDER BY started_at DESC LIMIT ?`),
  };
  const cache = new Map();

  return {
    /**
     * @returns {{ repo: string, job: string, class: 'light'|'heavy'|'unknown',
     *             p50Ms: number|null, n: number, source: string, shortJobS: number }}
     * @throws {Error} with .status 400 for a malformed query
     */
    lookup({ repo, job, shortS } = {}) {
      repo = String(repo ?? '');
      job = String(job ?? '').trim();
      if (!REPO.test(repo) || !job || job.length > 200) {
        throw Object.assign(new Error('repo (owner/name) and job required'), { status: 400 });
      }
      const threshold = /^[0-9]{1,5}$/.test(String(shortS ?? '')) && Number(shortS) > 0
        ? Number(shortS) : shortJobS();
      const key = `${repo}\n${job}\n${threshold}`;
      const at = now();
      const hit = cache.get(key);
      if (hit && at - hit.at < cfg.cacheMs) return hit.value;

      // A display name like "ci / test" ends in the id the hook would send.
      const id = job.includes(' / ') ? job.split(' / ').pop().trim() : job;
      const since = at - cfg.windowDays * 86_400_000;
      let samples = stmt.released.all(repo, id, since, cfg.maxSamples).map((r) => Number(r.ran_s) * 1000);
      let source = 'admission';
      if (samples.length < cfg.minSamples) {
        const fromJobs = stmt.jobs
          .all(repo, job, `% / ${likeEscape(id)}`, new Date(since).toISOString(), cfg.maxSamples)
          .map((r) => Number(r.duration_ms));
        if (fromJobs.length > samples.length) {
          samples = fromJobs;
          source = 'jobs';
        }
      }
      const n = samples.length;
      const p50Ms = median(samples);
      const cls = n < cfg.minSamples ? 'unknown' : p50Ms < threshold * 1000 ? 'light' : 'heavy';
      const value = { repo, job, class: cls, p50Ms, n, source: n ? source : 'none', shortJobS: threshold };
      cache.set(key, { at, value });
      if (cache.size > 2000) cache.clear();
      return value;
    },
  };
}
