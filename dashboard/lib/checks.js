// A commit's or a PR's checks as one answer (green, red, pending, pointless),
// and a wait for that answer. The CLI, `cockpit wait` and the MCP tool all
// ask this one question of the daemon instead of each rebuilding it from a
// stream. The incidents behind each rule are named where the rule is, and
// test/checks.test.js holds a case for each. cockpit's Rollup.swift keeps the
// menu bar's own copy of the rollup rules; RollupTests holds the same cases.

const PASSED = new Set(['success', 'skipped', 'neutral']);

export const isActive = (r) => r.status !== 'completed';
// A pass. Only these three: a finished run with any other conclusion proves
// nothing about the commit. Cancelled used to roll up as green (shop-web PR
// #399, 2026-10-02, both checks timed out in the admission wait).
export const passed = (r) => PASSED.has(r.conclusion ?? '');
export const failed = (r) => !isActive(r) && !passed(r);
const cancelled = (r) => r.conclusion === 'cancelled';

export const CANCELLED_HINT =
  'cancelled is not a pass: usually a timeout under load or a newer push. Check the diagnosis, then re-run the failed jobs.';

// Of two rows for one run, the one describing its latest attempt: the higher
// runAttempt, else the later updatedAt; a tie keeps `a`. A re-run keeps the
// run id (jot-ios PR #181, 2026-10-11, where a wait read attempt 2's failure
// while attempt 3 ran).
export function latest(a, b) {
  if (a.runAttempt != null && b.runAttempt != null && a.runAttempt !== b.runAttempt) {
    return b.runAttempt > a.runAttempt ? b : a;
  }
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a;
}

// Shas arrive at different lengths (7 from the glance, 12 for PR heads, 40
// from a caller), so one is a prefix of the other.
export function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function eta(active, queueById) {
  let lo = 0;
  let hi = 0;
  for (const r of active) {
    const q = queueById.get(r.id);
    if (q) {
      if (!Array.isArray(q.etaDoneMs) || q.etaDoneMs.length !== 2) return null;
      lo = Math.max(lo, q.etaDoneMs[0]);
      hi = Math.max(hi, q.etaDoneMs[1]);
    } else if (r.expectedMs != null && r.elapsedMs != null) {
      // expectedMs is the workflow's p95, so it bounds the high end; 60 % of
      // it is a fair "typical" low end.
      lo = Math.max(lo, Math.max(0, r.expectedMs * 0.6 - r.elapsedMs));
      hi = Math.max(hi, Math.max(0, r.expectedMs - r.elapsedMs));
    } else {
      return null;
    }
  }
  return [lo, hi];
}

export function progress(set) {
  const c = set.failed.filter(cancelled).length;
  const f = set.failed.length - c;
  const notPassed = [f ? `${f} failed` : null, c ? `${c} cancelled` : null].filter(Boolean).join(', ');
  if (set.state === 'green') return `${set.total} of ${set.total} green`;
  if (set.state === 'red') return `${notPassed} · ${set.done} of ${set.total} done`;
  if (!set.superseded.length) return `${set.done} of ${set.total} done`;
  return `${set.done} of ${set.total} done; waiting for ${set.superseded.map((r) => r.workflow ?? '?').join(', ')} to run again on this commit`;
}

// Groups active and recent runs by commit (or branch when a run carries no
// sha). Within a commit the newest run of each workflow wins, so a re-run
// that went green replaces the red attempt it retried. Newest is by run id,
// which GitHub only ever increases: by updatedAt, a run cancelled by
// concurrency after its replacement was created beat the replacement.
export function checkSets(g) {
  const byId = new Map();
  for (const r of [...(g.runs ?? []), ...(g.recent ?? [])]) {
    byId.set(r.id, byId.has(r.id) ? latest(byId.get(r.id), r) : r);
  }
  const all = [...byId.values()].sort((a, b) => a.id - b.id);
  const groups = new Map();
  for (const r of all) {
    const key = `${r.repo}@${r.sha ?? r.branch ?? r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // Per PR: its head, and the newest run of each workflow on any commit.
  const heads = new Map();
  const newestInPR = new Map();
  for (const r of all) {
    if (r.prNumber == null) continue;
    if (r.prHead) heads.set(`${r.repo}#${r.prNumber}`, r.prHead);
    newestInPR.set(`${r.repo}#${r.prNumber}|${r.workflow ?? ''}`, r.id);
  }
  const queueById = new Map((g.queue ?? []).map((q) => [q.id, q]));

  const sets = [...groups.entries()].map(([key, runs]) => {
    const byWorkflow = new Map();
    for (const r of runs) byWorkflow.set(r.workflow ?? String(r.id), r);
    const rs = [...byWorkflow.values()].sort((a, b) => (a.workflow ?? '').localeCompare(b.workflow ?? ''));
    const head = rs.find((r) => r.prNumber != null) ?? rs[0];
    // This commit is its PR's head, yet a workflow ran on another of the PR's
    // commits after it last ran here: the branch left and came back (a
    // force-push), so the result here predates the head (site-web PR #79,
    // 2026-10-03).
    const prKey = head.prNumber != null ? `${head.repo}#${head.prNumber}` : null;
    const isHead = prKey && heads.has(prKey) ? sameCommit(heads.get(prKey), head.sha) : false;
    const superseded = !isHead ? [] : rs.filter((r) =>
      !isActive(r) && (newestInPR.get(`${prKey}|${r.workflow ?? ''}`) ?? r.id) > r.id);
    const active = rs.filter(isActive);
    const failedRuns = rs.filter((r) => failed(r) && !superseded.includes(r));
    const state = active.length || superseded.length ? 'pending' : failedRuns.length ? 'red' : 'green';
    const set = {
      id: key,
      repo: head.repo,
      prNumber: head.prNumber ?? null,
      branch: head.branch ?? null,
      sha: head.sha ?? null,
      title: head.title ?? null,
      runs: rs,
      total: rs.length,
      done: rs.length - active.length - superseded.length,
      failed: failedRuns,
      queued: active.map((r) => queueById.get(r.id)).filter(Boolean),
      etaGreenMs: state === 'pending' && !superseded.length ? eta(active, queueById) : null,
      state,
      superseded,
    };
    return { ...set, progress: progress(set) };
  });
  const newest = (s) => Math.max(0, ...s.runs.map((r) => r.updatedAt ?? 0));
  return sets.sort((a, b) => {
    if ((a.state === 'pending') !== (b.state === 'pending')) return a.state === 'pending' ? -1 : 1;
    return newest(b) - newest(a);
  });
}

// A PR's checks are its HEAD commit's checks. Until the head has a run this
// is null (still waiting), never an older commit's result: on site-web PR #79
// a wait read "red" from a commit the branch had been force-pushed off.
// Without a known head, the commit with the newest run stands in for it.
//
// `head` is the head as GitHub names it now (waitForChecks asks). It beats
// the glance's own idea of the head, which is learned from runs and so is the
// PREVIOUS head until the fast loop sees the new commit's first run:
// stream-app PR #5 (2026-10-24) read the old commit's "1 of 1 green" 8 s
// after a push, while run 40116718009 on the new head was still queued.
export function findCheckSet(g, { repo, pr = null, sha = null, branch = null, head = null }) {
  const sets = checkSets(g).filter((s) => sameRepo(s.repo, repo)
    && (pr == null || s.prNumber === pr)
    && (sha == null || sameCommit(sha, s.sha))
    && (branch == null || s.branch === branch));
  if (head) return sets.find((s) => sameCommit(head, s.sha)) ?? null;
  if (pr == null) return sets[0] ?? null;
  const withHead = [...(g.runs ?? []), ...(g.recent ?? [])]
    .filter((r) => sameRepo(r.repo, repo) && r.prNumber === pr && r.prHead)
    .sort((a, b) => b.id - a.id)[0];
  if (withHead) return sets.find((s) => sameCommit(withHead.prHead, s.sha)) ?? null;
  return sets.sort((a, b) => Math.max(...b.runs.map((r) => r.id)) - Math.max(...a.runs.map((r) => r.id)))[0] ?? null;
}

// Verdicts under which no check on any repo can finish.
const INFRA = new Set(['host-down', 'disk-floor', 'blind']);

const NEVER_STARTS = new Set(['runner-down', 'unserved', 'role-unserved', 'label-mismatch', 'github-hosted']);
// A public repo's hosted-runner queue says "waiting for a GitHub-hosted
// runner" in its etaBasis and is worth waiting for.
function neverStarts(q) {
  if (q.etaBasis) return q.etaBasis.includes('will not start');
  return NEVER_STARTS.has(q.cause ?? '');
}

// The repos an account block refused jobs on. A daemon older than the
// `repos` field named them only in the evidence, by short name.
export function refusedRepos(blocked) {
  if (Array.isArray(blocked?.repos)) return blocked.repos;
  const line = (blocked?.evidence ?? []).find((e) => typeof e === 'string' && e.startsWith('Repos: '));
  return line ? line.slice('Repos: '.length).split(',').map((r) => r.trim()).filter(Boolean) : [];
}

const shortName = (r) => String(r ?? '').toLowerCase().split('/').pop();
const repoIn = (repos, repo) => repos.some((r) => sameRepo(r, repo) || shortName(r) === shortName(repo));

// What a wait should do with the fleet as it is now: { state, reason, set }.
// A finished result beats a verdict about the fleet, so green and red are
// decided before anything that makes waiting pointless.
export function decide(g, target) {
  const set = findCheckSet(g, target);
  if (set?.state === 'green' || set?.state === 'red') return { state: set.state, reason: null, set };
  const v = g.verdict ?? {};
  if (INFRA.has(v.id)) return { state: 'pointless', reason: `${v.title}: ${v.sentence ?? ''}`.trim(), set };
  // An account block stops a wait only on a repo GitHub is refusing. The
  // fleet's self-hosted runners and public repos go on running through it
  // (2026-10-24: hosted petcam-* jobs refused, while the kits' self-hosted PR
  // runs were only queued on a busy host and `cockpit wait` gave up on them).
  const blocked = (v.open ?? []).find((o) => o.id === 'account-blocked' && o.blocking === true);
  if (blocked && repoIn(refusedRepos(blocked), target.repo)) {
    return { state: 'pointless', reason: `${blocked.title}: ${shortName(target.repo)}'s jobs are refused before they reach a runner`, set };
  }
  const queue = set ? set.queued : (g.queue ?? []).filter((q) => sameRepo(q.repo, target.repo));
  const stuck = queue.find(neverStarts);
  if (stuck) {
    // A private repo's own run queued for GitHub-hosted runners while the
    // account is refused: that is the block, about to reach this repo too.
    if (blocked && stuck.cause === 'github-hosted') {
      return {
        state: 'pointless',
        reason: `${blocked.title}: ${stuck.workflow ?? 'a check'} is queued for a GitHub-hosted runner, which the account is refusing`,
        set,
      };
    }
    return {
      state: 'pointless',
      reason: `${stuck.workflow ?? 'a check'} is queued with cause ${stuck.cause ?? '?'} — it will not start on its own. ${stuck.recommended ?? ''}`.trim(),
      set,
    };
  }
  const mine = (g.runners ?? []).filter((r) => sameRepo(r.repo, target.repo));
  const dead = mine.find((r) => r.state === 'dead' || r.state === 'offline');
  if (dead && !mine.some((r) => ['idle', 'busy', 'overdue'].includes(r.state))) {
    return { state: 'pointless', reason: `${dead.name} is ${dead.state} and no other runner serves ${target.repo}`, set };
  }
  return { state: 'pending', reason: null, set };
}

// `rows` laid over the glance's runs, each as the latest of its two copies:
// GitHub's answer about a re-run stays in force until the fleet view catches up.
export function overlay(g, rows) {
  if (!rows.length) return g;
  let runs = [...(g.runs ?? [])];
  let recent = [...(g.recent ?? [])];
  for (const f of rows) {
    const held = [...runs, ...recent].find((r) => r.id === f.id);
    const row = held ? latest(held, f) : f;
    runs = runs.filter((r) => r.id !== f.id);
    recent = recent.filter((r) => r.id !== f.id);
    if (isActive(row)) runs.push(row); else recent.unshift(row);
  }
  return { ...g, runs, recent };
}


// ------------------------------------------------------------ GitHub's view

// GitHub's own answer about a head, as fleetd's githubChecksFor builds it with
// parseGitHubChecks:
//   { head, fetchedAt, runs, checks }
//   runs     every workflow run GitHub has for the head commit
//            (actions/runs?head_sha=), each { id, workflowId, workflow, event,
//            status, conclusion, createdAt, updatedAt, url, jobs }. jobs are
//            the latest attempt's { name, status, conclusion, url,
//            completedAt }, or null while unread (fleetd reads them once the
//            run has completed).
//   checks   commit statuses, check runs from other apps, and any Actions
//            check run whose run is missing from `runs`.
// An answer without `runs` (an older source) is judged by its checks alone.

// How long GitHub must have been quiet about a head, as of the moment it was
// asked, before its green is believed. Runs register seconds after a push
// (pull_request and push are separate events), a workflow_run-triggered run
// only after the run it follows completes, and a job behind `needs:` only once
// its needs finish. A finished first wave is not the end.
export const SETTLE_MS = 30_000;

// The newest run of each workflow, as in the fleet's rollup: a re-trigger or
// a concurrency replacement on the same commit wins over the run it replaced.
export function latestRuns(runs) {
  const byWorkflow = new Map();
  for (const r of runs ?? []) {
    const key = r.workflowId ?? r.workflow ?? r.id;
    if (!byWorkflow.has(key) || byWorkflow.get(key).id < r.id) byWorkflow.set(key, r);
  }
  return [...byWorkflow.values()].sort((a, b) => a.id - b.id);
}

// When anything about the head last changed on GitHub, epoch ms (0 if unknown).
function lastChange(gc) {
  const times = [
    ...(gc.runs ?? []).flatMap((r) => [r.createdAt, r.updatedAt, ...(r.jobs ?? []).map((j) => j.completedAt)]),
    ...(gc.checks ?? []).map((c) => c.completedAt),
  ].filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

const names = (rs) => rs.map((r) => r.workflow ?? r.name ?? String(r.id)).join(', ');

// { state: green | red | pending, why }. Green needs every workflow run for
// the head completed, every one of their jobs completed, every other check
// completed, all of them passed, and nothing new for settleMs.
export function githubVerdict(gc, { settleMs = SETTLE_MS } = {}) {
  if (!gc) return { state: 'pending', why: 'GitHub did not answer' };
  const head = gc.head ? String(gc.head).slice(0, 7) : 'the head';
  const runs = latestRuns(gc.runs);
  const checks = gc.checks ?? [];
  if (!runs.length && !checks.length) return { state: 'pending', why: `GitHub has no runs or checks for ${head} yet` };
  const running = runs.filter(isActive);
  if (running.length) return { state: 'pending', why: `GitHub still has ${names(running)} ${String(running[0].status).replace('_', ' ')}` };
  const unread = runs.filter((r) => gc.runs && !Array.isArray(r.jobs));
  if (unread.length) return { state: 'pending', why: `the jobs of ${names(unread)} are not read yet` };
  const jobs = runs.flatMap((r) => r.jobs ?? []);
  const open = [...jobs, ...checks].filter(isActive);
  if (open.length) return { state: 'pending', why: `GitHub still has ${names(open)} running` };
  if (runs.some(failed) || jobs.some(failed) || checks.some(failed)) return { state: 'red', why: null };
  const quietMs = (gc.fetchedAt ?? Date.now()) - lastChange(gc);
  if (quietMs < settleMs) {
    return {
      state: 'pending',
      why: `settling: GitHub's newest run or job for ${head} changed ${Math.max(0, Math.round(quietMs / 1000))} s ago, and a green waits ${Math.round(settleMs / 1000)} s for any run still to register`,
    };
  }
  return { state: 'green', why: null };
}

export const githubState = (gc, opts) => githubVerdict(gc, opts).state;

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

// GitHub's REST answers for one head as `gc`. `actions` holds the workflow
// runs (actions/runs?head_sha=) and, by run id, the jobs of each run read so
// far. Without it, this is the older check-runs-and-statuses answer.
export function parseGitHubChecks(head, checkRuns, combined, actions = null) {
  const runIds = new Set((actions?.runs ?? []).map((r) => r.id));
  const fromCheckRuns = (checkRuns?.check_runs ?? [])
    // An Actions check run is a job of one of `runs`, already counted there.
    .filter((c) => !actions || !runIds.has(runIdFromUrl(c.html_url ?? c.details_url)))
    .map((c) => ({
      name: c.name,
      status: c.status === 'completed' ? 'completed' : (c.status ?? 'queued'),
      conclusion: c.status === 'completed' ? (c.conclusion ?? '') : null,
      url: c.html_url ?? c.details_url ?? null,
      completedAt: ms(c.completed_at),
    }));
  const statuses = (combined?.statuses ?? []).map((s) => {
    const st = String(s.state ?? 'pending').toLowerCase();
    const finished = st !== 'pending' && st !== 'expected';
    return {
      name: s.context ?? 'status',
      status: finished ? 'completed' : 'in_progress',
      conclusion: !finished ? null : st === 'success' ? 'success' : 'failure',
      url: s.target_url ?? null,
      completedAt: finished ? ms(s.updated_at) : null,
    };
  });
  const gc = { head, checks: [...fromCheckRuns, ...statuses] };
  if (!actions) return gc;
  gc.fetchedAt = actions.fetchedAt ?? null;
  gc.runs = (actions.runs ?? []).map((r) => {
    const jobs = actions.jobs?.get(r.id);
    return {
      id: r.id,
      workflowId: r.workflow_id ?? null,
      workflow: r.name ?? null,
      event: r.event ?? null,
      status: r.status === 'completed' ? 'completed' : (r.status ?? 'queued'),
      conclusion: r.status === 'completed' ? (r.conclusion ?? '') : null,
      runAttempt: r.run_attempt ?? null,
      createdAt: ms(r.created_at),
      updatedAt: ms(r.updated_at),
      url: r.html_url ?? null,
      jobs: !jobs ? null : jobs.map((j) => ({
        name: j.name,
        status: j.status === 'completed' ? 'completed' : (j.status ?? 'queued'),
        conclusion: j.status === 'completed' ? (j.conclusion ?? '') : null,
        url: j.html_url ?? null,
        completedAt: ms(j.completed_at),
      })),
    };
  });
  return gc;
}

// What a green from GitHub's side of the check carries: how much it covered.
export function confirmation(gc) {
  if (!gc?.runs) return null;
  const runs = latestRuns(gc.runs);
  return {
    head: gc.head ?? null,
    runs: runs.length,
    jobs: runs.reduce((n, r) => n + (r.jobs?.length ?? 0), 0),
    checks: gc.checks?.length ?? 0,
  };
}

// GitHub's answer as a check set, so it reads exactly like the fleet's: one
// row per job of each run (a run whose jobs are unread is one row), then the
// other checks.
export function githubSet(gc, target, verdict = githubVerdict(gc)) {
  const items = [
    ...latestRuns(gc.runs).flatMap((r) => (r.jobs?.length ? r.jobs : [{ name: r.workflow, status: r.status, conclusion: r.conclusion, url: r.url }])),
    ...(gc.checks ?? []),
  ];
  const runs = items.map((c, i) => ({
    id: -(i + 1), repo: target.repo, workflow: c.name, status: c.status, conclusion: c.conclusion,
    sha: gc.head ? gc.head.slice(0, 12) : null, prNumber: target.pr ?? null, url: c.url,
  }));
  const set = {
    id: `github:${target.repo}@${gc.head ?? '?'}`,
    repo: target.repo,
    prNumber: target.pr ?? null,
    branch: target.branch ?? null,
    sha: gc.head ? gc.head.slice(0, 12) : null,
    title: null,
    runs,
    total: runs.length,
    done: runs.filter((r) => !isActive(r)).length,
    failed: runs.filter(failed),
    queued: [],
    etaGreenMs: null,
    state: verdict.state,
    superseded: [],
  };
  return { ...set, progress: progress(set) };
}

// `…/actions/runs/<id>/job/<job>` → <id>.
export function runIdFromUrl(url) {
  const m = /\/actions\/runs\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------------- waiting

export const MAX_WAIT_S = 300;

const realSleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// Waits up to `waitS` seconds for `target`'s checks to finish.
//
// source: what the daemon reads each time round —
//   glance()             the fleet view (/api/glance)
//   orphans(glance)      orphaned jobs, lib/orphans.js
//   prChecks(target)     GitHub's answer for the target's head, `gc` above
//                        (null when GitHub did not answer)
//   run(repo, id)        one run's latest attempt as a glance row (null likewise)
//
// The rules, each from a wait that once went wrong:
//   - GitHub names the head. The fleet view learns a new head only from its
//     first run, so right after a push it still holds the previous head's
//     result (stream-app PR #5, 2026-10-24: "1 of 1 green" from the old
//     commit 8 s after the push, while the new head's run was queued).
//   - The fleet's green is a rollup of the runs it has seen. It ends the wait
//     only once GitHub agrees (githubVerdict: every run and job for the head
//     completed and passed, and quiet for SETTLE_MS); until then the wait
//     stays pending with GitHub's reason. GitHub not answering is not a yes.
//   - A stale fleet view (the fast loop stopped finishing ticks, shop-ios PR
//     #445, 2026-10-07) or one with no runs for the target is not believed:
//     GitHub is asked every crossStaleMs; otherwise every crossFreshMs,
//     because a view can freeze while ticks still finish. GitHub's finished
//     answer ends the wait; its "pending" never overrides the fleet's red.
//   - Before a red ends the wait, each failed run is asked of GitHub: a
//     re-run keeps the run id and the view can lag it by a tick (jot-ios PR
//     #181, 2026-10-11). A run running again is pending.
//   - An orphaned job among the target's runs ends the wait as pointless,
//     with its recovery (lake-api PR #73, 2026-10-12).
//   - A pointless verdict from a stale view is not a reason to stop.
export async function waitForChecks(target, source, {
  waitS = 0, signal = null, now = Date.now, sleep = realSleep, tickMs = 2000, crossFreshMs = 120_000, crossStaleMs = 30_000,
  confirmMs = 10_000, settleMs = SETTLE_MS,
} = {}) {
  const start = now();
  const deadline = start + Math.min(Math.max(0, waitS), MAX_WAIT_S) * 1000;
  const fresh = new Map();
  let nextCross = start + crossFreshMs;
  let askedAt = null;
  let lastGitHub = null;
  let verdict = null;
  let unread = false; // a verdict not yet weighed against the fleet's pending

  const finish = (state, extra) => ({ state, waitedMs: now() - start, ...extra });
  const askGitHub = async () => {
    askedAt = now();
    const gc = await source.prChecks(target).catch(() => null);
    if (!gc) return null;
    lastGitHub = { ...gc, fetchedAt: gc.fetchedAt ?? askedAt };
    verdict = githubVerdict(lastGitHub, { settleMs });
    unread = true;
    return verdict;
  };
  const githubAnswer = (v, g, d) => {
    const set = githubSet(lastGitHub, target, v);
    return finish(v.state, {
      source: 'github', checks: set, reason: null,
      hint: v.state === 'red' && set.failed.some(cancelled) ? CANCELLED_HINT : null,
      fleetAgeMs: g.ageMs ?? null, fleetSaid: d.set?.progress ?? null,
      verified: v.state === 'green' ? confirmation(lastGitHub) : null,
    });
  };

  // The head first: a fleet answer about the previous head is no answer.
  await askGitHub();

  for (;;) {
    const g = source.glance();
    const t = lastGitHub?.head ? { ...target, head: lastGitHub.head } : target;
    let d = decide(overlay(g, [...fresh.values()]), t);
    let held = null;

    if (d.state === 'red') {
      for (const r of d.set.failed.filter((x) => x.id > 0)) {
        const f = await source.run(target.repo, r.id).catch(() => null);
        if (f) fresh.set(f.id, f);
      }
      d = decide(overlay(g, [...fresh.values()]), t);
    }
    if (d.state === 'red') {
      return finish('red', {
        source: 'fleet', checks: d.set, reason: null,
        hint: d.set.failed.some(cancelled) ? CANCELLED_HINT : null,
        fleetAgeMs: g.ageMs ?? null,
      });
    }
    if (d.state === 'green') {
      if (askedAt === null || now() - askedAt >= confirmMs) await askGitHub();
      // The head moved while we looked: judge the new one.
      if (lastGitHub?.head && !sameCommit(lastGitHub.head, t.head)) continue;
      if (verdict?.state === 'green') {
        return finish('green', {
          source: fresh.size > 0 ? 'github' : 'fleet', checks: d.set, reason: null, hint: null,
          fleetAgeMs: g.ageMs ?? null, verified: confirmation(lastGitHub),
        });
      }
      if (verdict?.state === 'red') return githubAnswer(verdict, g, d);
      held = lastGitHub ? verdict.why : 'GitHub did not answer, and a green is not believed without it';
    }
    if (d.state === 'pointless' && !g.stale) {
      return finish('pointless', { source: 'fleet', checks: d.set, reason: d.reason, hint: null, fleetAgeMs: g.ageMs ?? null });
    }

    const runIds = new Set((d.set?.runs ?? []).filter(isActive).map((r) => r.id));
    for (const r of lastGitHub?.runs ?? []) if (isActive(r)) runIds.add(r.id);
    for (const c of lastGitHub?.checks ?? []) {
      const id = c.status !== 'completed' ? runIdFromUrl(c.url) : null;
      if (id) runIds.add(id);
    }
    const orphans = source.orphans(g).filter((o) => sameRepo(o.repo, target.repo) && runIds.has(o.runId));
    if (orphans.length) {
      return finish('pointless', {
        source: 'fleet', checks: d.set, orphans, hint: null, fleetAgeMs: g.ageMs ?? null,
        reason: orphans.map((o) => o.summary).join('\n'),
      });
    }

    // A held green asks GitHub above, every confirmMs; this is for the rest.
    const eager = g.stale || !d.set || [...fresh.values()].some(isActive);
    if (eager) nextCross = Math.min(nextCross, askedAt === null ? now() : askedAt + crossStaleMs);
    if (!held) {
      if (now() >= nextCross) {
        await askGitHub();
        nextCross = now() + (eager ? crossStaleMs : crossFreshMs);
      }
      // GitHub's finished answer ends a wait the fleet has not finished.
      if (unread && verdict && verdict.state !== 'pending') return githubAnswer(verdict, g, d);
    }
    unread = false;

    if (now() >= deadline || signal?.aborted) {
      const useGitHub = lastGitHub && (g.stale || !d.set || held);
      return finish('pending', {
        source: useGitHub ? 'github' : 'fleet',
        checks: useGitHub ? githubSet(lastGitHub, target, verdict) : d.set,
        reason: held ? `the fleet reads ${d.set.progress}, but ${held}`
          : d.state === 'pointless' ? `${d.reason} (from a stale fleet view)` : null,
        hint: null,
        fleetAgeMs: g.ageMs ?? null,
      });
    }
    await sleep(Math.min(tickMs, Math.max(10, deadline - now())), signal);
  }
}
