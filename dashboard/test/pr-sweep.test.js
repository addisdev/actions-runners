// The closed-PR sweep: only queued pull_request runs whose PR already merged or
// closed are cancelled; open PRs, push events and running work are left alone.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPrSweep, sweepCandidates, judgeRun, repoAllowed,
  SWEEP_ACTION, SWEEP_DRY_ACTION, MIN_RATE_REMAINING,
} from '../lib/pr-sweep.js';
import { openDb } from '../lib/db.js';
import { timeline } from '../lib/timeline.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-23T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const REPO = 'addisdev/homelake';

let nextId = 1000;
function run({ status = 'queued', event = 'pull_request', branch = 'feat/x', sha = `sha-${branch}`,
  createdAt = NOW - 3 * HOUR, startedAt = null, attempt = 1, name = 'Public mirror (dry run)', prRefs = [] } = {}) {
  return {
    id: nextId++, status, event, name, head_branch: branch, head_sha: sha,
    created_at: iso(createdAt), run_started_at: iso(startedAt ?? createdAt), run_attempt: attempt,
    head_repository: { owner: { login: 'addisdev' } }, pull_requests: prRefs,
  };
}
function pr({ number, state = 'closed', merged = true, sha, closedAt = NOW - 2 * HOUR }) {
  return {
    number, state, head: { sha },
    closed_at: state === 'closed' ? iso(closedAt) : null,
    merged_at: state === 'closed' && merged ? iso(closedAt) : null,
  };
}

// A fake GitHub: PRs by head ("owner:branch"), runs by id (what a fresh fetch
// answers; default queued), and a record of every POST. A cancel completes the
// run unless the run is in `sticky` (GitHub accepted the cancel and left it
// queued, as it did for runs waiting on a self-hosted runner); a force-cancel
// always completes it.
function fakeGh({ pulls = {}, runs = {}, remaining = 5000, failHeads = [], sticky = [] } = {}) {
  const calls = { gets: [], posts: [] };
  const state = new Map(Object.entries(runs).map(([id, r]) => [Number(id), r]));
  return {
    calls,
    rate: { remaining },
    async get(path) {
      calls.gets.push(path);
      const m = path.match(/pulls\?state=all&head=([^&]+)/);
      if (m) {
        const head = decodeURIComponent(m[1]);
        if (failHeads.includes(head)) throw new Error('502 bad gateway');
        return { data: pulls[head] ?? [] };
      }
      const one = path.match(/pulls\/(\d+)$/);
      if (one) {
        const all = Object.values(pulls).flat();
        return { data: all.find((p) => p.number === Number(one[1])) ?? null };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async run(repo, id) { return state.get(id) ?? { id, status: 'queued' }; },
    async post(path) {
      calls.posts.push(path);
      const m = path.match(/runs\/(\d+)\/(cancel|force-cancel)$/);
      if (m) {
        const id = Number(m[1]);
        if (m[2] === 'force-cancel' || !sticky.includes(id)) {
          state.set(id, { id, status: 'completed', conclusion: 'cancelled' });
        }
      }
      return null;
    },
  };
}

function sweepWith(gh, cfg = {}) {
  const records = [];
  const sweep = createPrSweep({
    gh,
    config: () => ({ enabled: true, dryRun: false, repos: ['homelake'], ...cfg }),
    record: (item) => records.push(item),
    sleep: async () => {},
  });
  return { sweep, records };
}

describe('repoAllowed', () => {
  test('matches a bare name or owner/name, nothing when the list is empty', () => {
    assert.equal(repoAllowed(REPO, ['homelake']), true);
    assert.equal(repoAllowed(REPO, ['addisdev/homelake']), true);
    assert.equal(repoAllowed(REPO, ['HomeLake']), true);
    assert.equal(repoAllowed(REPO, ['agents']), false);
    assert.equal(repoAllowed(REPO, []), false);
    assert.equal(repoAllowed(REPO, undefined), false);
  });
});

describe('sweepCandidates', () => {
  const allow = ['homelake'];
  test('only queued pull_request runs in allowed repos past the minimum age', () => {
    const keep = run();
    const runs = [
      { repo: REPO, run: keep },
      { repo: REPO, run: run({ status: 'in_progress' }) },
      { repo: REPO, run: run({ status: 'waiting' }) },
      { repo: REPO, run: run({ event: 'push' }) },
      { repo: REPO, run: run({ event: 'pull_request_target' }) },
      { repo: REPO, run: run({ createdAt: NOW - 2 * MIN }) },
      { repo: 'addisdev/agents', run: run() },
    ];
    const got = sweepCandidates(runs, { allow, now: NOW });
    assert.deepEqual(got.map((c) => c.run.id), [keep.id]);
  });
});

describe('judgeRun', () => {
  test('merged PR whose head is the run: closed', () => {
    const r = run({ sha: 'abc' });
    const j = judgeRun(r, [pr({ number: 714, sha: 'abc' })]);
    assert.equal(j.verdict, 'closed');
    assert.equal(j.pr, 714);
    assert.equal(j.merged, true);
  });
  test('closed without merging: closed, not merged', () => {
    const j = judgeRun(run({ sha: 'abc' }), [pr({ number: 9, sha: 'abc', merged: false })]);
    assert.equal(j.verdict, 'closed');
    assert.equal(j.merged, false);
  });
  test('any open PR on the branch holds the run', () => {
    const j = judgeRun(run({ sha: 'abc' }), [pr({ number: 1, sha: 'abc' }), pr({ number: 2, state: 'open', sha: 'def' })]);
    assert.equal(j.verdict, 'open');
  });
  test('no PR found: unknown', () => {
    assert.equal(judgeRun(run(), []).verdict, 'unknown');
  });
  test('a run triggered after the close (closed-type workflow, re-run) is left', () => {
    const r = run({ sha: 'abc', createdAt: NOW - HOUR });
    const j = judgeRun(r, [pr({ number: 3, sha: 'abc', closedAt: NOW - 2 * HOUR })]);
    assert.equal(j.verdict, 'unknown');
  });
  test('a re-run attempt started after the close is left even if the first attempt was before', () => {
    const r = run({ sha: 'abc', createdAt: NOW - 3 * HOUR, startedAt: NOW - HOUR, attempt: 2 });
    assert.equal(judgeRun(r, [pr({ number: 3, sha: 'abc' })]).verdict, 'unknown');
  });
  test('an earlier push on a closed PR branch matches the PR that closed last', () => {
    const r = run({ sha: 'old' });
    const j = judgeRun(r, [
      pr({ number: 4, sha: 'new', closedAt: NOW - 2 * HOUR }),
      pr({ number: 2, sha: 'older', closedAt: NOW - 30 * HOUR }),
    ]);
    assert.equal(j.verdict, 'closed');
    assert.equal(j.pr, 4);
  });
});

describe('createPrSweep', () => {
  test('cancels only the closed and merged PRs\' queued runs; open, push and in-progress are left', async () => {
    const merged = run({ branch: 'feat/merged', sha: 'm1' });
    const closed = run({ branch: 'feat/closed', sha: 'c1' });
    const open = run({ branch: 'feat/open', sha: 'o1', prRefs: [{ number: 30 }] });
    const push = run({ branch: 'feat/merged', sha: 'm1', event: 'push' });
    const running = run({ branch: 'feat/merged', sha: 'm1', status: 'in_progress' });
    const gh = fakeGh({
      pulls: {
        'addisdev:feat/merged': [pr({ number: 714, sha: 'm1' })],
        'addisdev:feat/closed': [pr({ number: 715, sha: 'c1', merged: false })],
        'addisdev:feat/open': [pr({ number: 30, state: 'open', sha: 'o1' })],
      },
    });
    const { sweep, records } = sweepWith(gh);
    const runs = [merged, closed, open, push, running].map((r) => ({ repo: REPO, run: r }));
    const res = await sweep.maybeRun(runs, NOW);

    assert.deepEqual(gh.calls.posts.sort(), [
      `repos/${REPO}/actions/runs/${merged.id}/cancel`,
      `repos/${REPO}/actions/runs/${closed.id}/cancel`,
    ].sort());
    assert.equal(res.considered, 3);
    assert.deepEqual(records.map((r) => [r.runId, r.pr, r.repo, r.outcome]).sort(), [
      [merged.id, 714, REPO, 'cancelled (cancelled)'],
      [closed.id, 715, REPO, 'cancelled (cancelled)'],
    ].sort());
  });

  test('a cancel that leaves the run queued is followed by force-cancel', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 720, sha: 'abc' })] }, sticky: [r.id] });
    const { sweep, records } = sweepWith(gh);
    await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.deepEqual(gh.calls.posts, [
      `repos/${REPO}/actions/runs/${r.id}/cancel`,
      `repos/${REPO}/actions/runs/${r.id}/force-cancel`,
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0].ok, true);
    assert.match(records[0].outcome, /^force-cancelled/);
  });

  test('a cancel that landed needs no force-cancel', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 722, sha: 'abc' })] } });
    const { sweep } = sweepWith(gh);
    await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.deepEqual(gh.calls.posts, [`repos/${REPO}/actions/runs/${r.id}/cancel`]);
  });

  test('a run that started between the cancel and the re-check is never forced', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 723, sha: 'abc' })] }, sticky: [r.id] });
    const post = gh.post;
    gh.post = async (path) => {
      await post(path);
      // GitHub handed the run to a runner just as the cancel was accepted.
      if (path.endsWith('/cancel')) gh.run = async (repo, id) => ({ id, status: 'in_progress' });
    };
    const { sweep, records } = sweepWith(gh);
    await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(gh.calls.posts.filter((p) => p.endsWith('/force-cancel')).length, 0);
    assert.match(records[0].outcome, /now in_progress, not forced/);
  });

  test('the re-check waits once for the whole pass, not once per run', async () => {
    const a = run({ branch: 'feat/a', sha: 'a1' });
    const b = run({ branch: 'feat/b', sha: 'b1' });
    const gh = fakeGh({ pulls: {
      'addisdev:feat/a': [pr({ number: 1, sha: 'a1' })],
      'addisdev:feat/b': [pr({ number: 2, sha: 'b1' })],
    }, sticky: [a.id, b.id] });
    const waits = [];
    const sweep = createPrSweep({
      gh, config: () => ({ enabled: true, dryRun: false, repos: ['homelake'] }),
      sleep: async (t) => { waits.push(t); },
    });
    await sweep.maybeRun([a, b].map((r) => ({ repo: REPO, run: r })), NOW);
    assert.deepEqual(waits, [20_000]);
    assert.equal(gh.calls.posts.filter((p) => p.endsWith('/force-cancel')).length, 2);
  });

  test('a run that started since the snapshot is not cancelled', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({
      pulls: { 'addisdev:feat/x': [pr({ number: 717, sha: 'abc' })] },
      runs: { [r.id]: { id: r.id, status: 'in_progress' } },
    });
    const { sweep, records } = sweepWith(gh);
    const res = await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(gh.calls.posts.length, 0);
    assert.equal(records.length, 0);
    assert.match(res.items[0].outcome, /left: now in_progress/);
  });

  test('dry run lists what it would cancel, posts nothing, and records each run once', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 719, sha: 'abc' })] } });
    const { sweep, records } = sweepWith(gh, { dryRun: true });
    const first = await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(gh.calls.posts.length, 0);
    assert.equal(first.items[0].outcome, 'would cancel');
    assert.equal(records.length, 1);
    assert.equal(records[0].dryRun, true);
    // The next pass still lists it but does not log it again.
    const second = await sweep.maybeRun([{ repo: REPO, run: r }], NOW + 6 * MIN);
    assert.equal(second.items.length, 1);
    assert.equal(records.length, 1);
  });

  test('off by default does nothing; an empty allow-list touches nothing', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 720, sha: 'abc' })] } });
    const off = sweepWith(gh, { enabled: false });
    assert.equal(await off.sweep.maybeRun([{ repo: REPO, run: r }], NOW), null);
    const none = sweepWith(gh, { repos: [] });
    const res = await none.sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(res.considered, 0);
    assert.equal(gh.calls.gets.length, 0);
    assert.equal(gh.calls.posts.length, 0);
  });

  test('runs at most once per interval', async () => {
    const gh = fakeGh();
    const { sweep } = sweepWith(gh);
    assert.ok(await sweep.maybeRun([], NOW));
    assert.equal(await sweep.maybeRun([], NOW + MIN), null);
    assert.ok(await sweep.maybeRun([], NOW + 6 * MIN));
  });

  test('waits when API headroom is low', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ remaining: MIN_RATE_REMAINING - 1, pulls: { 'addisdev:feat/x': [pr({ number: 722, sha: 'abc' })] } });
    const { sweep } = sweepWith(gh);
    const res = await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.match(res.skipped, /headroom/);
    assert.equal(gh.calls.posts.length, 0);
  });

  test('a failed PR lookup leaves the run', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ failHeads: ['addisdev:feat/x'] });
    const { sweep } = sweepWith(gh);
    await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(gh.calls.posts.length, 0);
  });

  test('an open PR named on the run but missed by the branch query still holds it', async () => {
    const r = run({ sha: 'abc', prRefs: [{ number: 40 }] });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 723, sha: 'abc' })], 'other:feat/x': [pr({ number: 40, state: 'open', sha: 'abc' })] } });
    const { sweep } = sweepWith(gh);
    await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(gh.calls.posts.length, 0);
  });

  test('a cancel that fails is recorded as failed', async () => {
    const r = run({ sha: 'abc' });
    const gh = fakeGh({ pulls: { 'addisdev:feat/x': [pr({ number: 714, sha: 'abc' })] } });
    gh.post = async () => { throw new Error('409 Cannot cancel a workflow run that is completed.'); };
    const { sweep, records } = sweepWith(gh);
    await sweep.maybeRun([{ repo: REPO, run: r }], NOW);
    assert.equal(records.length, 1);
    assert.equal(records[0].ok, false);
    assert.match(records[0].outcome, /cancel failed: 409/);
  });
});

describe('timeline sweeps', () => {
  const dirs = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  test('cancels and dry-run reports from action_log come back with run id, repo and PR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-sweep-'));
    dirs.push(dir);
    const db = openDb(join(dir, 't.db'));
    const ins = db.prepare('INSERT INTO action_log (ts, action, args, command, exit_code, ok, output, caller) VALUES (?,?,?,?,?,?,?,?)');
    const now = Date.now();
    ins.run(now - HOUR, SWEEP_ACTION, JSON.stringify({ repo: REPO, runId: 11, pr: 714, merged: true, workflow: 'Public mirror (dry run)' }),
      'POST …/cancel', null, 1, 'cancelled: PR #714 merged', 'fleetd');
    ins.run(now - 2 * HOUR, SWEEP_DRY_ACTION, JSON.stringify({ repo: REPO, runId: 12, pr: 717, merged: true }),
      'POST …/cancel', null, 1, 'would cancel: PR #717 merged', 'fleetd');
    ins.run(now - HOUR, 'runner.restart', '{}', 'x', 0, 1, '', 'ui');
    const t = timeline(db, { days: 1, now });
    assert.deepEqual(t.sweeps.map((s) => [s.runId, s.repo, s.pr, s.dryRun]), [
      [11, REPO, 714, false],
      [12, REPO, 717, true],
    ]);
    db.close();
  });
});

describe('settings', () => {
  test('the sweep ships off, dry run, with no repos allowed', async () => {
    const { SCHEMA } = await import('../lib/settings.js');
    assert.equal(SCHEMA.sweepClosedPr.default, false);
    assert.equal(SCHEMA.sweepClosedPrDryRun.default, true);
    assert.deepEqual(SCHEMA.sweepClosedPrRepos.default, []);
  });
});
