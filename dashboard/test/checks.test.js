import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSets, findCheckSet, decide, waitForChecks, parseGitHubChecks, githubState, runIdFromUrl,
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

  test('a storage quota is not a block, a billing block is', () => {
    const runs = [run(1, 'ci', { status: 'in_progress', elapsed: 1, expected: 10 })];
    assert.equal(decide(glance({ runs }, 'live'), target).state, 'pending');
    assert.equal(decide(glance({ runs }, 'accountBlocked'), target).state, 'pointless');
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
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function source(g, extra = {}) {
  return { glance: () => g, orphans: () => [], prChecks: async () => null, run: async () => null, ...extra };
}

describe('waiting', () => {
  test('a finished result answers at once, without asking GitHub', async () => {
    let asked = 0;
    const out = await waitForChecks(target, source(glance({ recent: [run(1, 'ci')] }), { prChecks: async () => { asked++; return null; } }), { waitS: 60 });
    assert.equal(out.state, 'green');
    assert.equal(out.source, 'fleet');
    assert.equal(asked, 0);
  });

  test('wait=0 on a fresh, pending view answers pending without asking GitHub', async () => {
    let asked = 0;
    const g = glance({ runs: [run(1, 'ci', { status: 'in_progress', elapsed: 1, expected: 10 })] });
    const out = await waitForChecks(target, source(g, { prChecks: async () => { asked++; return null; } }), { waitS: 0 });
    assert.equal(out.state, 'pending');
    assert.equal(out.checks.progress, '0 of 1 done');
    assert.equal(asked, 0);
  });

  test('a stale view asks GitHub, and GitHub\'s green ends the wait', async () => {
    const g = { ...glance({ runs: [run(1, 'ci', { status: 'in_progress' })] }), stale: true };
    const out = await waitForChecks(target, source(g, {
      prChecks: async () => ({ head: 'abc1234def', checks: [{ name: 'ci', status: 'completed', conclusion: 'success', url: null }] }),
    }), { waitS: 0 });
    assert.equal(out.state, 'green');
    assert.equal(out.source, 'github');
    assert.equal(out.fleetSaid, '0 of 1 done');
  });

  test('GitHub\'s pending never overrides the fleet; the wait times out pending', async () => {
    const c = clock();
    let asked = 0;
    const g = { ...glance({ runs: [run(1, 'ci', { status: 'in_progress' })] }), stale: true };
    const out = await waitForChecks(target, source(g, {
      prChecks: async () => { asked++; return { head: 'abc', checks: [{ name: 'ci', status: 'in_progress', conclusion: null }] }; },
    }), { waitS: 90, now: c.now, sleep: c.sleep, tickMs: 1000 });
    assert.equal(out.state, 'pending');
    assert.equal(out.source, 'github');
    assert.ok(asked >= 3 && asked <= 4, `asked ${asked} times in 90 s`);
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
