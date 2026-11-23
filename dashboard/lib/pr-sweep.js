// Cancels queued pull_request runs whose PR is already merged or closed.
//
// GitHub does not cancel a PR's runs when the PR closes, and `concurrency:`
// only supersedes a run when a later run of the SAME workflow starts. A later
// push that misses the workflow's `paths:` filter starts nothing, so the old run
// stays queued for good. On 2026-11-23 addisdev/homelake had six queued
// `Public mirror (dry run)` runs for PRs #714, #717, #719, #720, #722 and #723,
// all merged hours earlier, each waiting for a heavy slot on a saturated host.
//
// The fleet's rule is that a session never cancels another session's runs, so
// this is the daemon's job, and it only touches work nobody can still want:
//
//   - status exactly `queued`. Never in_progress, never `waiting` (an
//     environment approval is a person's decision), and the run is fetched again
//     just before the cancel so one that started since the snapshot is left.
//     A cancel GitHub accepted but that left the run `queued` 20 s later is
//     followed by force-cancel, again only while the run is still `queued`.
//   - event exactly `pull_request`.
//   - a repo on the allow-list.
//   - every PR GitHub knows for the run's head branch is closed. One open PR on
//     that branch and the run is left, whichever PR it belongs to.
//   - the run (this attempt) was triggered BEFORE its PR closed. A workflow can
//     listen for `pull_request: types: [closed]`, and a person can re-run a job
//     after the merge; both make runs that start after the close on purpose.
//   - queued for at least minQueuedMs, so a run is never judged in the seconds
//     where GitHub is still settling a merge.
//
// Anything the API cannot answer is `unknown` and left alone.
//
// Off by default, and dry run by default once on (settings sweepClosedPr,
// sweepClosedPrDryRun, sweepClosedPrRepos). Every cancel, and every run a dry
// run would cancel, goes to action_log and from there to /api/timeline.

export const SWEEP_ACTION = 'sweep.closedPrRun';
export const SWEEP_DRY_ACTION = 'sweep.closedPrRun (dry run)';
export const DEFAULT_MIN_QUEUED_MS = 10 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
// How long after a cancel to look again before force-cancelling a run that is
// still queued.
export const DEFAULT_RECHECK_MS = 20 * 1000;
// Below this many API calls left in the hour the sweep waits: the fast loop's
// reads matter more than tidying.
export const MIN_RATE_REMAINING = 500;
// At most this many PR lookups per pass, so a repo with a hundred queued runs
// cannot spend the hour's budget in one go. The rest wait for the next pass.
export const MAX_LOOKUPS_PER_PASS = 20;

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

const repoName = (repo) => String(repo).split('/').pop();

/** Whether a repo is on the allow-list. Entries are bare repo names or owner/name. */
export function repoAllowed(repo, allow) {
  if (!Array.isArray(allow) || !allow.length) return false;
  const name = repoName(repo).toLowerCase();
  const full = String(repo).toLowerCase();
  return allow.some((a) => {
    const v = String(a).toLowerCase();
    return v === name || v === full;
  });
}

/** When this attempt of the run was triggered. */
export function triggeredAt(run) {
  return ms(run.run_started_at) ?? ms(run.created_at);
}

/**
 * The runs worth asking GitHub about: queued pull_request runs in an allowed
 * repo that have waited at least minQueuedMs. No API calls.
 *
 * @param {{repo: string, run: object}[]} runs raw GitHub runs, with their repo
 */
export function sweepCandidates(runs, { allow, now = Date.now(), minQueuedMs = DEFAULT_MIN_QUEUED_MS } = {}) {
  const out = [];
  for (const { repo, run } of runs ?? []) {
    if (!run || run.status !== 'queued') continue;
    if (run.event !== 'pull_request') continue;
    if (!repoAllowed(repo, allow)) continue;
    if (!run.head_branch) continue;
    const at = triggeredAt(run);
    if (at == null || now - at < minQueuedMs) continue;
    out.push({ repo, run });
  }
  return out;
}

/**
 * Decide from the PRs GitHub returned for the run's head branch.
 *
 * @param {object} run raw GitHub run
 * @param {object[]} pulls raw GitHub PRs (state=all) for that head
 * @returns {{verdict: 'closed'|'open'|'unknown', pr: number|null, merged: boolean, reason: string}}
 */
export function judgeRun(run, pulls) {
  const list = (pulls ?? []).filter((p) => p && Number.isInteger(p.number));
  if (!list.length) return { verdict: 'unknown', pr: null, merged: false, reason: 'no PR found for the head branch' };
  const open = list.find((p) => p.state !== 'closed');
  if (open) return { verdict: 'open', pr: open.number, merged: false, reason: `PR #${open.number} is open` };

  // The PR this run was for: the one whose head was this commit, else the one
  // that closed last (the run is from an earlier push to that branch).
  const byClose = [...list].sort((a, b) => (ms(b.closed_at) ?? 0) - (ms(a.closed_at) ?? 0));
  const pr = list.find((p) => p.head?.sha && p.head.sha === run.head_sha) ?? byClose[0];
  const closedAt = ms(pr.closed_at);
  const at = triggeredAt(run);
  if (closedAt == null || at == null) {
    return { verdict: 'unknown', pr: pr.number, merged: Boolean(pr.merged_at), reason: 'no close or trigger time' };
  }
  if (at >= closedAt) {
    return { verdict: 'unknown', pr: pr.number, merged: Boolean(pr.merged_at),
      reason: `run started after PR #${pr.number} closed (a closed-PR workflow or a deliberate re-run)` };
  }
  return { verdict: 'closed', pr: pr.number, merged: Boolean(pr.merged_at),
    reason: `PR #${pr.number} ${pr.merged_at ? 'merged' : 'closed'}` };
}

/**
 * The sweep, holding what it needs between passes.
 *
 * @param {object} o
 * @param {object} o.gh GitHub client: get(), post(), run(), rate
 * @param {number} [o.recheckMs] wait after cancelling before the force-cancel check
 * @param {() => {enabled: boolean, dryRun: boolean, repos: string[]}} o.config read on every pass
 * @param {(entry: object) => void} o.record writes one action_log row
 */
export function createPrSweep({
  gh, config, record = () => {}, log = () => {}, warn = () => {},
  intervalMs = DEFAULT_INTERVAL_MS, minQueuedMs = DEFAULT_MIN_QUEUED_MS,
  maxLookups = MAX_LOOKUPS_PER_PASS, recheckMs = DEFAULT_RECHECK_MS,
  sleep = (t) => new Promise((resolve) => setTimeout(resolve, t)),
}) {
  let lastPassAt = 0;
  let inFlight = null;
  let last = null;
  // Dry run reports a run once, not every pass for as long as it stays queued.
  const reported = new Set();

  const headOwner = (repo, run) => run.head_repository?.owner?.login ?? String(repo).split('/')[0];
  const headKey = (repo, run) => `${repo}|${headOwner(repo, run)}:${run.head_branch}`;

  async function pullsForHead(repo, run, cache) {
    const owner = headOwner(repo, run);
    const key = headKey(repo, run);
    if (cache.has(key)) return cache.get(key);
    const head = encodeURIComponent(`${owner}:${run.head_branch}`);
    const { data } = await gh.get(`repos/${repo}/pulls?state=all&head=${head}&per_page=30`);
    const pulls = Array.isArray(data) ? data : [];
    // run.pull_requests names OPEN PRs matching the head; include any the
    // branch query missed so one of them being open still holds the run.
    const have = new Set(pulls.map((p) => p.number));
    for (const ref of run.pull_requests ?? []) {
      if (!Number.isInteger(ref?.number) || have.has(ref.number)) continue;
      const { data: pr } = await gh.get(`repos/${repo}/pulls/${ref.number}`);
      if (pr) pulls.push(pr);
    }
    cache.set(key, pulls);
    return pulls;
  }

  async function pass(runs, now) {
    const cfg = config();
    const result = { at: now, dryRun: Boolean(cfg.dryRun), repos: cfg.repos ?? [], considered: 0, items: [], skipped: null };
    const remaining = gh.rate?.remaining;
    if (remaining != null && remaining < MIN_RATE_REMAINING) {
      result.skipped = `API headroom low (${remaining} left)`;
      return result;
    }
    // Oldest first: the longest-stuck runs are the ones this exists for.
    const candidates = sweepCandidates(runs, { allow: cfg.repos, now, minQueuedMs })
      .sort((a, b) => triggeredAt(a.run) - triggeredAt(b.run));
    result.considered = candidates.length;
    const cache = new Map();
    const sent = [];
    for (const { repo, run } of candidates) {
      // Counted by head branch looked up, not by run: runs sharing a branch
      // share one answer.
      if (cache.size >= maxLookups && !cache.has(headKey(repo, run))) continue;
      let judged;
      try {
        judged = judgeRun(run, await pullsForHead(repo, run, cache));
      } catch (err) {
        warn(`closed-PR sweep: ${repo} run ${run.id}: PR lookup failed: ${err.message}`);
        continue;
      }
      if (judged.verdict !== 'closed') continue;
      const item = {
        repo, runId: run.id, pr: judged.pr, merged: judged.merged,
        workflow: run.name ?? null, branch: run.head_branch, queuedSince: run.run_started_at ?? run.created_at,
        reason: judged.reason, dryRun: result.dryRun, ok: null, outcome: null,
      };
      const key = `${repo}:${run.id}:${run.run_attempt ?? 1}`;

      if (result.dryRun) {
        item.outcome = 'would cancel';
        item.ok = true;
        result.items.push(item);
        if (!reported.has(key)) {
          reported.add(key);
          record(item);
          log(`closed-PR sweep (dry run): would cancel ${repo} run ${run.id} (PR #${judged.pr}, ${run.name ?? 'workflow'})`);
        }
        continue;
      }

      // Asked again right before acting: the snapshot can be a minute old and
      // GitHub's cancel endpoint cancels running work just as readily.
      try {
        const freshRun = await gh.run(repo, run.id);
        if (freshRun?.status !== 'queued') {
          item.outcome = `left: now ${freshRun?.status ?? 'unknown'}`;
          item.ok = true;
          result.items.push(item);
          continue;
        }
        await gh.post(`repos/${repo}/actions/runs/${run.id}/cancel`);
        item.outcome = 'cancel sent';
        item.ok = true;
        sent.push(item);
      } catch (err) {
        item.outcome = `cancel failed: ${err.message}`;
        item.ok = false;
        warn(`closed-PR sweep: ${repo} run ${run.id}: ${err.message}`);
      }
      result.items.push(item);
      if (!item.ok) record(item);
    }

    // A plain cancel is accepted ("submitted") but does not always land: on
    // 2026-11-23 seven homelake runs waiting for a self-hosted runner were all
    // still `queued` 20 s after it, and force-cancel cleared them in 15 s. So
    // every cancel is checked once after recheckMs, and a run STILL `queued`
    // is force-cancelled. Only queued: force-cancel skips `if: always()` steps,
    // so a run that has started in the meantime is never forced.
    if (sent.length) {
      await sleep(recheckMs);
      for (const item of sent) {
        try {
          const after = await gh.run(item.repo, item.runId);
          if (after?.status === 'completed') {
            item.outcome = `cancelled (${after.conclusion ?? 'completed'})`;
          } else if (after?.status === 'queued') {
            await gh.post(`repos/${item.repo}/actions/runs/${item.runId}/force-cancel`);
            item.outcome = 'force-cancelled (still queued after cancel)';
          } else {
            item.outcome = `cancel sent; now ${after?.status ?? 'unknown'}, not forced`;
          }
          item.ok = true;
          log(`closed-PR sweep: ${item.outcome}: ${item.repo} run ${item.runId} (PR #${item.pr}, ${item.workflow ?? 'workflow'})`);
        } catch (err) {
          item.outcome = `cancel sent; re-check or force-cancel failed: ${err.message}`;
          item.ok = false;
          warn(`closed-PR sweep: ${item.repo} run ${item.runId}: ${err.message}`);
        }
        record(item);
      }
    }
    // Forget dry-run reports for runs no longer queued, so the set stays small.
    const live = new Set((runs ?? []).map(({ repo, run }) => `${repo}:${run?.id}:${run?.run_attempt ?? 1}`));
    for (const k of reported) if (!live.has(k)) reported.delete(k);
    return result;
  }

  return {
    /**
     * Run a pass if the sweep is on and the last pass is older than intervalMs.
     * Never overlaps itself. Resolves to the pass's result, or null when no pass ran.
     */
    async maybeRun(runs, now = Date.now()) {
      const cfg = config();
      if (!cfg.enabled) return null;
      if (inFlight) return null;
      if (now - lastPassAt < intervalMs) return null;
      lastPassAt = now;
      inFlight = pass(runs, now)
        .then((r) => { last = r; return r; })
        .finally(() => { inFlight = null; });
      return inFlight;
    },
    /** What the last pass found, for /api/sweeps/closed-prs. */
    status() {
      const cfg = config();
      return {
        enabled: Boolean(cfg.enabled), dryRun: Boolean(cfg.dryRun), repos: cfg.repos ?? [],
        intervalMs, minQueuedMs, recheckMs, last,
      };
    },
  };
}
