import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSets, findCheckSet, decide, refusedRepos, waitForChecks, parseGitHubChecks, githubState, githubVerdict, githubSet, runIdFromUrl,
} from '../lib/checks.js';

// The same cases as cockpit's RollupTests.swift, against the same glance
// fixtures, so the daemon's answer and the Mac app's cannot drift apart.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../cockpit/Sources/CockpitCore/Fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

function run(id, wf, {
  status = 'completed', conclusion = 'success', sha = 'abc1234', pr = 96, updated = 1000,
  elapsed = null, expected = null, repo = 'acme/comet-web', head = null, attempt = null,
} = {}) {
  return {
    id, repo, workflow: wf, status, conclusion: status === 'completed' ? conclusion : null,
    branch: 'fix-login', sha, prNumber: pr, event: 'pull_request', title: 'Fix login', url: null,
    startedAt: null, updatedAt: updated, elapsedMs: elapsed, expectedMs: expected, prHead: head, runAttempt: attempt,
  };
}

function glance({ runs = [], recent = [], queue = [] } = {}, base = 'quiet') {
  return { ...fixture(base), runs, recent, queue };
}

function queued(id, cause, done = null) {
  return {
    id, repo: 'acme/comet-web', workflow: 'e2e', queuedMs: 60000, cause, confidence: 'high',
    recommended: 'Run health.sh --repair.', prNumber: 96, etaDoneMs: done, etaBasis: null,
  };
}

const target = { repo: 'acme/comet-web', pr: 96 };

describe('PR rollup', () => {
  test('pending, with an ETA from the slowest check', () => {
    const g = glance({
      runs: [run(3, 'e2e', { status: 'in_progress', elapsed: 60000, expected: 600000 }), run(4, 'lint', { status: 'queued' })],
      recent: [run(1, 'ci'), run(2, 'build')],
      queue: [queued(4, 'repo-capacity', [300000, 900000])],
    });
    const s = checkSets(g)[0];
    assert.equal(s.state, 'pending');
    assert.equal(s.total, 4);
    assert.equal(s.done, 2);
    assert.equal(s.progress, '2 of 4 done');
    assert.deepEqual(s.etaGreenMs, [300000, 900000]);
  });

  test('a green re-run replaces the red attempt', () => {
    const g = glance({ recent: [run(1, 'ci', { conclusion: 'failure', updated: 1000 }), run(2, 'ci', { updated: 2000 })] });
    assert.equal(checkSets(g)[0].state, 'green');
  });

  test('an in-progress re-run of a failed attempt is pending, whichever list each copy is in', () => {
    const failedRow = run(38163415231, 'tests', { conclusion: 'failure', updated: 1000, attempt: 2 });
    const rerun = run(38163415231, 'tests', { status: 'in_progress', updated: 2000, attempt: 3 });
    for (const g of [glance({ runs: [rerun], recent: [failedRow] }), glance({ recent: [failedRow, rerun] }), glance({ recent: [rerun, failedRow] })]) {
      const s = checkSets(g)[0];
      assert.equal(s.state, 'pending');
      assert.equal(s.total, 1);
      assert.equal(s.done, 0);
      assert.equal(s.runs[0].runAttempt, 3);
    }
    assert.equal(checkSets(glance({ runs: [rerun], recent: [{ ...failedRow, updatedAt: 3000 }] }))[0].state, 'pending');
  });

  test('red when any latest check failed', () => {
    const s = checkSets(glance({ recent: [run(1, 'ci'), run(2, 'e2e', { conclusion: 'failure' })] }))[0];
    assert.equal(s.state, 'red');
    assert.deepEqual(s.failed.map((r) => r.workflow), ['e2e']);
  });

  test('cancelled checks are red, not green', () => {
    const s = checkSets(glance({ recent: [run(1, 'QA Tests', { conclusion: 'cancelled' }), run(2, 'Web E2E', { conclusion: 'cancelled' })] }))[0];
    assert.equal(s.state, 'red');
    assert.equal(s.progress, '2 cancelled · 2 of 2 done');
  });

  test('a mix of failed and cancelled says both', () => {
    const g = glance({ recent: [run(1, 'ci', { conclusion: 'failure' }), run(2, 'e2e', { conclusion: 'cancelled' }), run(3, 'lint')] });
    assert.equal(checkSets(g)[0].progress, '1 failed, 1 cancelled · 3 of 3 done');
  });

  test('skipped and neutral pass; other conclusions do not', () => {
    assert.equal(checkSets(glance({ recent: [run(1, 'ci'), run(2, 'deploy', { conclusion: 'skipped' }), run(3, 'lint', { conclusion: 'neutral' })] }))[0].state, 'green');
    for (const c of ['action_required', 'stale', 'something_new']) {
      assert.equal(checkSets(glance({ recent: [run(1, 'ci', { conclusion: c })] }))[0].state, 'red', c);
    }
  });

  test('find matches sha prefixes, case-insensitive repos, and not another PR', () => {
    const g = glance({ recent: [run(1, 'ci', { sha: 'abc1234' })] });
    assert.ok(findCheckSet(g, { repo: 'Acme/Comet-Web', sha: 'abc1234def' }));
    assert.equal(findCheckSet(g, { repo: 'acme/comet-web', pr: 97 }), null);
    assert.equal(findCheckSet(g, { repo: 'other/comet-web', sha: 'abc1234' }), null);
  });
});

describe('wait decision', () => {
  test('green and red end the wait; cancelled is red', () => {
    assert.equal(decide(glance({ recent: [run(1, 'ci')] }), target).state, 'green');
    assert.equal(decide(glance({ recent: [run(1, 'ci', { conclusion: 'failure' })] }), target).state, 'red');
    assert.equal(decide(glance({ recent: [run(1, 'ci', { conclusion: 'cancelled' })] }), target).state, 'red');
  });

  test('a disk-floor hold makes waiting pointless, but a finished result beats it', () => {
    const d = decide(glance({ runs: [run(1, 'ci', { status: 'queued' })] }, 'diskHold'), target);
    assert.equal(d.state, 'pointless');
    assert.match(d.reason, /^Disk floor is holding jobs/);
    assert.equal(decide(glance({ recent: [run(1, 'ci')] }, 'diskHold'), target).state, 'green');
  });

  test('a structural queue cause is pointless; a hosted public-repo queue is not', () => {
    const g = glance({ runs: [run(4, 'e2e', { status: 'queued' })], queue: [queued(4, 'runner-down')] });
    assert.match(decide(g, target).reason, /runner-down/);
    const hosted = { ...queued(4, 'github-hosted'), etaBasis: 'waiting for a GitHub-hosted runner (public repo)' };
    assert.equal(decide(glance({ runs: [run(4, 'e2e', { status: 'queued' })], queue: [hosted] }), target).state, 'pending');
  });

  test('a storage quota is not a block, a billing block on this repo is', () => {
    const runs = [run(1, 'ci', { status: 'in_progress', elapsed: 1, expected: 10 })];
    assert.equal(decide(glance({ runs }, 'live'), target).state, 'pending');
    const ion = { repo: 'acme/ion', pr: 96 };
    const d = decide(glance({ runs: [run(1, 'ci', { status: 'queued', repo: 'acme/ion' })] }, 'accountBlocked'), ion);
    assert.equal(d.state, 'pointless');
    assert.match(d.reason, /^GitHub is refusing jobs on 2 repos: ion's jobs are refused/);
    assert.equal(decide(glance({ runs: [] }, 'accountBlocked'), { repo: 'ion', pr: 96 }).state, 'pointless', 'a short name matches');
  });

  // taylab-launch-kit #279 and taylab-agent-kit #21, 2026-10-24: hosted
  // petcam-* and enjoyable-languages-site jobs were refused, and both kit
  // waits exited 2 while their self-hosted runs were only queued on ultra.
  test('a billing block on other repos does not stop a self-hosted wait', () => {
    const g = glance({
      runs: [run(1, 'ci', { status: 'queued' })],
      queue: [{ ...queued(1, 'host-saturation'), etaBasis: 'every runner for this repo is busy' }],
    }, 'accountBlocked');
    const d = decide(g, target);
    assert.equal(d.state, 'pending');
    assert.equal(d.reason, null);
  });

  test('a billing block stops a wait whose own run is queued for a hosted runner', () => {
    const hosted = { ...queued(1, 'github-hosted'), etaBasis: 'github-hosted: will not start on its own' };
    const d = decide(glance({ runs: [run(1, 'e2e', { status: 'queued' })], queue: [hosted] }, 'accountBlocked'), target);
    assert.equal(d.state, 'pointless');
    assert.match(d.reason, /e2e is queued for a GitHub-hosted runner, which the account is refusing/);
    const pub = { ...hosted, etaBasis: 'waiting for a GitHub-hosted runner (public repo)' };
    assert.equal(decide(glance({ runs: [run(1, 'e2e', { status: 'queued' })], queue: [pub] }, 'accountBlocked'), target).state,
      'pending', 'a public repo\'s hosted runs are not refused');
  });

  test('an older daemon names the refused repos only in the evidence', () => {
    const blocked = { id: 'account-blocked', blocking: true, title: 'GitHub is refusing jobs on 3 repos',
      evidence: ['87 jobs refused', 'Repos: enjoyable-languages-site, petcam-android, petcam-nvr'] };
    assert.deepEqual(refusedRepos(blocked), ['enjoyable-languages-site', 'petcam-android', 'petcam-nvr']);
    const g = glance({ runs: [run(1, 'ci', { status: 'queued' })] });
    g.verdict = { ...g.verdict, open: [blocked] };
    assert.equal(decide(g, target).state, 'pending');
    assert.equal(decide(g, { repo: 'addisdev/petcam-nvr', pr: 96 }).state, 'pointless');
  });

  test('a dead runner with nothing else serving the repo is pointless', () => {
    const g = glance({ runs: [run(1, 'ci', { status: 'queued' })] });
    g.runners = [{ name: 'host-comet-web', repo: 'acme/comet-web', host: 'h', state: 'dead' }];
    assert.match(decide(g, target).reason, /host-comet-web is dead and no other runner serves acme\/comet-web/);
    g.runners.push({ name: 'host-comet-web-2', repo: 'acme/comet-web', host: 'h', state: 'idle' });
    assert.equal(decide(g, target).state, 'pending');
  });
});

describe('PR head and re-pushes (site-web PR #79)', () => {
  const head = '16c0536773bc';
  const repo = 'addisdev/site-web';
  const cancelledFirst = run(37124998303, 'kit-ci', { conclusion: 'cancelled', sha: '16c0536', pr: 79, updated: 1000, head, repo });
  const failedOnTop = run(37125005925, 'kit-ci', { conclusion: 'failure', sha: 'caf600e', pr: 79, updated: 2000, head, repo });
  const pr = { repo, pr: 79 };
  const headSha = { repo, sha: '16c0536773bcd1c6cb6aa99ac3aeb6a0d269114c' };

  test('a wait on the PR does not read an older commit\'s red', () => {
    const d = decide(glance({ recent: [cancelledFirst, failedOnTop] }), pr);
    assert.equal(d.state, 'pending');
    assert.equal(d.set.sha, '16c0536');
    assert.equal(d.set.progress, '0 of 1 done; waiting for kit-ci to run again on this commit');
    assert.equal(decide(glance({ recent: [cancelledFirst, failedOnTop] }), headSha).state, 'pending');
  });

  test('the new run on the head decides', () => {
    const running = run(37125411032, 'kit-ci', { status: 'in_progress', sha: '16c0536', pr: 79, updated: 3000, head, repo });
    const d = decide(glance({ runs: [running], recent: [cancelledFirst, failedOnTop] }), pr);
    assert.equal(d.state, 'pending');
    assert.equal(d.set.progress, '0 of 1 done');
    const passedRow = { ...running, status: 'completed', conclusion: 'success', updatedAt: 4000 };
    assert.equal(decide(glance({ recent: [cancelledFirst, failedOnTop, passedRow] }), pr).state, 'green');
    assert.equal(decide(glance({ recent: [cancelledFirst, failedOnTop, passedRow] }), headSha).state, 'green');
  });

  test('a new head with no run yet is still waiting, with no set', () => {
    const d = decide(glance({ recent: [run(1, 'ci', { conclusion: 'failure', sha: 'aaaaaaa', pr: 79, head: 'bbbbbbbbbbbb', repo })] }), pr);
    assert.equal(d.state, 'pending');
    assert.equal(d.set, null);
  });

  test('a commit the branch moved past keeps its cancel', () => {
    const g = glance({
      recent: [run(1, 'ci', { conclusion: 'cancelled', sha: 'aaaaaaa', pr: 79, head: 'bbbbbbbbbbbb', repo }),
        run(2, 'ci', { status: 'in_progress', sha: 'bbbbbbb', pr: 79, head: 'bbbbbbbbbbbb', repo })],
    });
    assert.equal(decide(g, { repo, sha: 'aaaaaaa' }).state, 'red');
    assert.equal(decide(g, pr).state, 'pending');
  });

  test('a run cancelled after its replacement started does not win', () => {
    const g = glance({ runs: [run(2, 'ci', { status: 'in_progress', updated: 2000 })], recent: [run(1, 'ci', { conclusion: 'cancelled', updated: 3000 })] });
    assert.equal(checkSets(g)[0].state, 'pending');
  });

  test('without a head, the newest commit is the PR', () => {
    const g = glance({ recent: [run(5, 'ci', { sha: 'bbbbbbb', updated: 1000 }), run(4, 'ci', { conclusion: 'failure', sha: 'aaaaaaa', updated: 9000 })] });
    assert.equal(findCheckSet(g, target).sha, 'bbbbbbb');
  });
});

describe('GitHub\'s checks', () => {
  test('check runs and commit statuses become one list', () => {
    const gc = parseGitHubChecks('abc', {
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/a/b/actions/runs/9/job/1' },
        { name: 'e2e', status: 'in_progress', conclusion: null },
      ],
    }, { statuses: [{ context: 'ci/legacy', state: 'failure', target_url: 'x' }] });
    assert.deepEqual(gc.checks.map((c) => [c.name, c.status, c.conclusion]), [
      ['build', 'completed', 'success'], ['e2e', 'in_progress', null], ['ci/legacy', 'completed', 'failure'],
    ]);
    assert.equal(githubState(gc), 'pending');
  });

  test('an empty rollup is pending, not green', () => {
    assert.equal(githubState({ head: 'abc', checks: [] }), 'pending');
  });

  test('run ids come out of check URLs', () => {
    assert.equal(runIdFromUrl('https://github.com/addisdev/lake-api/actions/runs/38331315807/job/115081447989'), 38331315807);
    assert.equal(runIdFromUrl('https://github.com/addisdev/lake-api/pull/73'), null);
  });
});

// A clock the loop advances itself, so a five-minute wait takes no real time.
const T0 = 1_000_000_000;
function clock() {
  let t = T0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// One workflow run as GitHub has it (the shape parseGitHubChecks makes): its
// jobs once it has completed, none while it runs.
function ghRun(id, workflow, {
  status = 'completed', conclusion = 'success', jobs = ['build'], created = T0 - 600_000, updated = T0 - 300_000,
} = {}) {
  const done = status === 'completed';
  return {
    id, workflowId: `wf-${workflow}`, workflow, event: 'pull_request', status, conclusion: done ? conclusion : null,
    createdAt: created, updatedAt: updated, url: `https://github.com/acme/comet-web/actions/runs/${id}`,
    jobs: done ? jobs.map((j) => (typeof j === 'string'
      ? { name: j, status: 'completed', conclusion: 'success', url: null, completedAt: updated }
      : { url: null, completedAt: updated, ...j })) : null,
  };
}
const ghAnswer = (head, runs, checks = []) => ({ head, runs, checks });

function source(g, extra = {}) {
  return { glance: () => g, orphans: () => [], prChecks: async () => null, run: async () => null, ...extra };
}

describe('GitHub\'s verdict', () => {
  test('every run completed and passed, quiet for the settle window: green', () => {
    const gc = { ...ghAnswer('abc1234', [ghRun(1, 'ci', { jobs: ['guard', 'changes', 'web-e2e'] })]), fetchedAt: T0 };
    assert.deepEqual(githubVerdict(gc), { state: 'green', why: null });
    assert.equal(githubSet(gc, target).progress, '3 of 3 green');
  });

  // stream-app PR #5, 2026-10-24: guard and changes had passed; the six
  // jobs behind `needs: changes` did not exist yet, so every check GitHub
  // listed was green while run 40116718009 was still in progress.
  test('a run still in progress is pending, however green its first jobs are', () => {
    const gc = parseGitHubChecks('d42a20fa8be5e24c477004b82a8c2194eacd6493', {
      check_runs: ['guard', 'changes'].map((name, i) => ({
        name, status: 'completed', conclusion: 'success', completed_at: '2026-10-24T17:34:46Z',
        html_url: `https://github.com/acme/stream-app/actions/runs/40116718009/job/12093940475${i}`,
      })),
    }, { statuses: [] }, {
      runs: [{ id: 40116718009, workflow_id: 7, name: 'ci', event: 'pull_request', status: 'in_progress', conclusion: null,
        created_at: '2026-10-24T17:34:12Z', updated_at: '2026-10-24T17:34:46Z', html_url: 'https://github.com/acme/stream-app/actions/runs/40116718009' }],
      jobs: new Map(),
      fetchedAt: Date.parse('2026-10-24T17:36:00Z'),
    });
    // The check-only rule this replaces read the same answer as green.
    assert.equal(githubState({ head: gc.head, checks: [{ name: 'guard', status: 'completed', conclusion: 'success' }, { name: 'changes', status: 'completed', conclusion: 'success' }] }), 'green');
    assert.equal(gc.checks.length, 0, 'the run\'s own check runs are its jobs, not extra checks');
    assert.deepEqual(githubVerdict(gc), { state: 'pending', why: 'GitHub still has ci in progress' });
    assert.equal(githubSet(gc, target).progress, '0 of 1 done');
  });

  test('a green that just finished waits out the settle window', () => {
    const gc = ghAnswer('abc1234', [ghRun(1, 'ci', { updated: T0 - 5_000 })]);
    const early = githubVerdict({ ...gc, fetchedAt: T0 });
    assert.equal(early.state, 'pending');
    assert.match(early.why, /settling: .* changed 5 s ago, and a green waits 30 s/);
    assert.equal(githubVerdict({ ...gc, fetchedAt: T0 + 25_000 }).state, 'green');
    assert.equal(githubVerdict({ ...gc, fetchedAt: T0 + 25_000 }, { settleMs: 60_000 }).state, 'pending');
  });

  test('a completed run whose jobs are unread, or a job still running, is pending', () => {
    assert.equal(githubVerdict({ ...ghAnswer('abc', [{ ...ghRun(1, 'ci'), jobs: null }]), fetchedAt: T0 }).state, 'pending');
    const stuck = ghRun(1, 'ci', { jobs: ['build', { name: 'deploy', status: 'in_progress', conclusion: null }] });
    assert.deepEqual(githubVerdict({ ...ghAnswer('abc', [stuck]), fetchedAt: T0 }), { state: 'pending', why: 'GitHub still has deploy running' });
  });

  test('a failed or cancelled job is red; skipped and neutral pass', () => {
    const at = (jobs) => githubVerdict({ ...ghAnswer('abc', [ghRun(1, 'ci', { jobs })]), fetchedAt: T0 }).state;
    assert.equal(at(['build', { name: 'e2e', status: 'completed', conclusion: 'failure' }]), 'red');
    assert.equal(at([{ name: 'e2e', status: 'completed', conclusion: 'cancelled' }]), 'red');
    assert.equal(at([{ name: 'e2e', status: 'completed', conclusion: 'skipped' }, { name: 'n', status: 'completed', conclusion: 'neutral' }]), 'green');
    assert.equal(githubVerdict({ ...ghAnswer('abc', [ghRun(1, 'ci', { conclusion: 'startup_failure', jobs: [] })]), fetchedAt: T0 }).state, 'red');
  });

  test('the newest run of a workflow wins over the one it replaced on the same commit', () => {
    const replaced = ghRun(1, 'ci', { conclusion: 'cancelled', jobs: [{ name: 'build', status: 'completed', conclusion: 'cancelled' }] });
    assert.equal(githubVerdict({ ...ghAnswer('abc', [replaced, ghRun(2, 'ci')]), fetchedAt: T0 }).state, 'green');
    assert.equal(githubVerdict({ ...ghAnswer('abc', [replaced, ghRun(2, 'ci', { status: 'queued' })]), fetchedAt: T0 }).state, 'pending');
  });

  test('another app\'s check, a status, and a check of a run GitHub did not list still count', () => {
    const gc = parseGitHubChecks('abc', {
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/a/b/actions/runs/9/job/1' },
        { name: 'other-run', status: 'in_progress', html_url: 'https://github.com/a/b/actions/runs/10/job/2' },
        { name: 'codecov', status: 'completed', conclusion: 'success', details_url: 'https://codecov.io/x', completed_at: '2026-10-24T17:00:00Z' },
      ],
    }, { statuses: [{ context: 'ci/legacy', state: 'success', updated_at: '2026-10-24T17:00:00Z' }] }, {
      runs: [{ id: 9, workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'success', created_at: '2026-10-24T16:50:00Z', updated_at: '2026-10-24T17:00:00Z' }],
      jobs: new Map([[9, [{ name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-24T17:00:00Z' }]]]),
      fetchedAt: Date.parse('2026-10-24T18:00:00Z'),
    });
    assert.deepEqual(gc.checks.map((c) => c.name), ['other-run', 'codecov', 'ci/legacy']);
    assert.equal(githubVerdict(gc).state, 'pending');
  });

  test('nothing on GitHub yet, or no answer, is pending', () => {
    assert.equal(githubVerdict({ head: 'abc', runs: [], checks: [], fetchedAt: T0 }).state, 'pending');
    assert.equal(githubVerdict(null).state, 'pending');
  });
});

describe('waiting', () => {
  test('a finished fleet green ends the wait once GitHub agrees, and says what GitHub covered', async () => {
    let asked = 0;
    const out = await waitForChecks(target, source(glance({ recent: [run(1, 'ci')] }), {
      prChecks: async () => { asked++; return ghAnswer('abc1234def', [ghRun(1, 'ci', { jobs: ['a', 'b'] })]); },
    }), { waitS: 60 });
    assert.equal(out.state, 'green');
    assert.equal(out.source, 'fleet');
    assert.equal(asked, 1);
    assert.deepEqual(out.verified, { head: 'abc1234def', runs: 1, jobs: 2, checks: 0 });
  });

  test('a fleet green GitHub cannot confirm is not a green', async () => {
    const c = clock();
    const out = await waitForChecks(target, source(glance({ recent: [run(1, 'ci')] })), { waitS: 60, now: c.now, sleep: c.sleep });
    assert.equal(out.state, 'pending');
    assert.match(out.reason, /^the fleet reads 1 of 1 green, but GitHub did not answer/);
  });

  // stream-app PR #5, 2026-10-24, replayed: the wait began 8 s after the
  // push. The fleet still knew only the old head (8c2d77c, green) and had not
  // seen run 40116718009 on the new one (d42a20f, queued), and returned the old
  // head's "1 of 1 green" at once. Now GitHub names the head, and the green
  // comes after the new run's nine jobs pass and GitHub stays quiet 30 s.
  test('right after a push, the old head\'s green does not end the wait (stream-app PR #5)', async () => {
    const c = clock();
    const repo = 'acme/stream-app';
    const pr5 = { repo, pr: 5 };
    const oldHead = run(40112490807, 'ci', { repo, pr: 5, sha: '8c2d77c', head: '8c2d77c18879', updated: T0 - 120_000 });
    const jobs = ['guard', 'changes', 'typescript', 'firetv-core', 'roku-offdevice', 'tvos-core', 'sql', 'web-e2e', 'ci-success'];
    const finishedAt = T0 + 160_000;
    const newHead = 'd42a20fa8be5e24c477004b82a8c2194eacd6493';
    let asks = 0;
    const out = await waitForChecks(pr5, {
      glance: () => glance({
        // The fleet catches up with the new run 40 s in.
        runs: c.now() < T0 + 40_000 ? []
          : c.now() < finishedAt ? [run(40116718009, 'ci', { repo, pr: 5, sha: 'd42a20f', head: 'd42a20fa8be5', status: 'in_progress' })] : [],
        recent: [oldHead, ...(c.now() >= finishedAt ? [run(40116718009, 'ci', { repo, pr: 5, sha: 'd42a20f', head: 'd42a20fa8be5', updated: finishedAt })] : [])],
      }),
      orphans: () => [],
      run: async () => null,
      prChecks: async () => {
        asks++;
        const status = c.now() < T0 + 30_000 ? 'queued' : c.now() < finishedAt ? 'in_progress' : 'completed';
        return ghAnswer(newHead, [ghRun(40116718009, 'ci', { status, jobs, created: T0 - 8_000, updated: status === 'completed' ? finishedAt : T0 })]);
      },
    }, { waitS: 300, now: c.now, sleep: c.sleep });
    assert.equal(out.state, 'green');
    assert.ok(out.waitedMs >= 190_000, `green after ${out.waitedMs} ms: before the run finished and settled`);
    assert.equal(out.checks.sha, 'd42a20f');
    assert.deepEqual(out.verified, { head: newHead, runs: 1, jobs: 9, checks: 0 });
    assert.ok(asks < 40, `asked GitHub ${asks} times`);
  });

  test('wait=0 right after a push reads pending, not the old head\'s green', async () => {
    const repo = 'acme/stream-app';
    const oldHead = run(40112490807, 'ci', { repo, pr: 5, sha: '8c2d77c', head: '8c2d77c18879' });
    const out = await waitForChecks({ repo, pr: 5 }, source(glance({ recent: [oldHead] }), {
      prChecks: async () => ghAnswer('d42a20fa8be5e24c477004b82a8c2194eacd6493', [ghRun(40116718009, 'ci', { status: 'queued' })]),
    }), { waitS: 0 });
    assert.equal(out.state, 'pending');
    assert.equal(out.source, 'github');
    assert.equal(out.checks.progress, '0 of 1 done');
  });

  // A workflow_run workflow is created only after the run it follows
  // completes: the first run's green is not the commit's.
  test('a second run registering after the first finished keeps the wait open', async () => {
    const c = clock();
    const first = ghRun(11, 'ci', { updated: T0 - 2_000 });
    const out = await waitForChecks(target, source(glance({ recent: [run(11, 'ci')] }), {
      prChecks: async () => {
        const t = c.now();
        if (t < T0 + 15_000) return ghAnswer('abc1234def', [first]);
        const status = t < T0 + 100_000 ? 'in_progress' : 'completed';
        return ghAnswer('abc1234def', [first, ghRun(12, 'deploy-preview', { status, created: T0 + 12_000, updated: status === 'completed' ? T0 + 100_000 : T0 + 12_000 })]);
      },
    }), { waitS: 300, now: c.now, sleep: c.sleep });
    assert.equal(out.state, 'green');
    assert.ok(out.waitedMs >= 130_000, `green after ${out.waitedMs} ms`);
    assert.equal(out.verified.runs, 2);
  });

  test('a run the fleet has not seen that failed on GitHub turns its green red', async () => {
    const out = await waitForChecks(target, source(glance({ recent: [run(11, 'ci')] }), {
      prChecks: async () => ghAnswer('abc1234def', [ghRun(11, 'ci'), ghRun(12, 'lint', { conclusion: 'cancelled', jobs: [{ name: 'lint', status: 'completed', conclusion: 'cancelled' }] })]),
    }), { waitS: 60 });
    assert.equal(out.state, 'red');
    assert.equal(out.source, 'github');
    assert.deepEqual(out.checks.failed.map((r) => r.workflow), ['lint']);
    assert.match(out.hint, /cancelled is not a pass/);
  });

  test('wait=0 on a fresh, pending view answers pending from the fleet', async () => {
    let asked = 0;
    const g = glance({ runs: [run(1, 'ci', { status: 'in_progress', elapsed: 1, expected: 10 })] });
    const out = await waitForChecks(target, source(g, { prChecks: async () => { asked++; return null; } }), { waitS: 0 });
    assert.equal(out.state, 'pending');
    assert.equal(out.source, 'fleet');
    assert.equal(out.checks.progress, '0 of 1 done');
    assert.equal(asked, 1, 'once, for the head');
  });

  test('a stale view asks GitHub, and GitHub\'s green ends the wait', async () => {
    const g = { ...glance({ runs: [run(1, 'ci', { status: 'in_progress' })] }), stale: true };
    const out = await waitForChecks(target, source(g, {
      prChecks: async () => ghAnswer('abc1234def', [ghRun(1, 'ci', { jobs: ['ci'] })]),
    }), { waitS: 0 });
    assert.equal(out.state, 'green');
    assert.equal(out.source, 'github');
    assert.equal(out.fleetSaid, '0 of 1 done');
    assert.equal(out.verified.jobs, 1);
  });

  test('GitHub\'s pending never overrides the fleet; the wait times out pending', async () => {
    const c = clock();
    let asked = 0;
    const g = { ...glance({ runs: [run(1, 'ci', { status: 'in_progress' })] }), stale: true };
    const out = await waitForChecks(target, source(g, {
      prChecks: async () => { asked++; return ghAnswer('abc', [ghRun(1, 'ci', { status: 'in_progress' })]); },
    }), { waitS: 90, now: c.now, sleep: c.sleep, tickMs: 1000 });
    assert.equal(out.state, 'pending');
    assert.equal(out.source, 'github');
    assert.ok(asked >= 3 && asked <= 5, `asked ${asked} times in 90 s`);
  });

  test('a red is asked of GitHub first, and a re-run in progress keeps it pending', async () => {
    const c = clock();
    const failedRow = run(38163415231, 'tests', { conclusion: 'failure', updated: 1000, attempt: 2 });
    let ran = 0;
    const out = await waitForChecks(target, source(glance({ recent: [failedRow] }), {
      run: async (repo, id) => { ran++; return { ...failedRow, id, status: 'in_progress', conclusion: null, runAttempt: 3, updatedAt: 2000 }; },
    }), { waitS: 5, now: c.now, sleep: c.sleep, tickMs: 1000 });
    assert.equal(out.state, 'pending');
    assert.equal(out.checks.runs[0].runAttempt, 3);
    assert.equal(ran, 1);
  });

  test('a red GitHub confirms ends the wait red, with the cancelled hint when one was cancelled', async () => {
    const row = run(1, 'ci', { conclusion: 'cancelled' });
    const out = await waitForChecks(target, source(glance({ recent: [row] }), { run: async () => row }), { waitS: 5 });
    assert.equal(out.state, 'red');
    assert.match(out.hint, /cancelled is not a pass/);
  });

  test('a red of the commit GitHub names as the head, not of the one before it', async () => {
    const c = clock();
    const before = run(1, 'ci', { conclusion: 'failure', sha: 'aaaaaaa', head: 'aaaaaaaaaaaa' });
    const out = await waitForChecks(target, source(glance({ recent: [before] }), {
      prChecks: async () => ghAnswer('bbbbbbbbbbbbbbbb', [ghRun(2, 'ci', { status: 'queued' })]),
    }), { waitS: 5, now: c.now, sleep: c.sleep });
    assert.equal(out.state, 'pending');
  });

  test('an orphan among the target\'s runs ends the wait as pointless, with its recovery', async () => {
    const g = glance({ runs: [run(38318681067, 'docs', { status: 'in_progress' })] });
    const orphan = { repo: 'acme/comet-web', runId: 38318681067, summary: 'build: orphaned by a draining runner — not your code.', recovery: ['x'] };
    const other = { ...orphan, runId: 1 };
    const out = await waitForChecks(target, source(g, { orphans: () => [other, orphan] }), { waitS: 5 });
    assert.equal(out.state, 'pointless');
    assert.deepEqual(out.orphans.map((o) => o.runId), [38318681067]);
    assert.match(out.reason, /not your code/);
  });

  test('a pointless verdict from a stale view does not stop the wait', async () => {
    const c = clock();
    const g = { ...glance({ runs: [run(1, 'ci', { status: 'queued' })] }, 'diskHold'), stale: true };
    const out = await waitForChecks(target, source(g), { waitS: 10, now: c.now, sleep: c.sleep, tickMs: 1000 });
    assert.equal(out.state, 'pending');
    assert.match(out.reason, /from a stale fleet view/);
  });

  test('the wait is capped at five minutes', async () => {
    const c = clock();
    const g = glance({ runs: [run(1, 'ci', { status: 'in_progress', elapsed: 1, expected: 10 })] });
    const out = await waitForChecks(target, source(g), { waitS: 3600, now: c.now, sleep: c.sleep, tickMs: 5000 });
    assert.equal(out.waitedMs, 300_000);
  });
});
