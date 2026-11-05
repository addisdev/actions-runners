import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nightCapConfig, parseWindow, nightWindow, localInstant, decideNightCap, queuedJobs, enforcingNightCap,
  NIGHT_CAP_DEFAULTS, NIGHT_CAP_OWNER,
} from '../lib/night-cap.js';
import { headroom } from '../lib/capacity.js';
import { classifyQueueCause } from '../lib/queue-cause.js';
import { estimateQueue } from '../lib/eta.js';
import { decide, waitForChecks } from '../lib/checks.js';
import { computeVerdict, buildGlance } from '../lib/verdict.js';

const NY = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso) => Date.parse(iso);
const CFG = { ...NIGHT_CAP_DEFAULTS, mode: 'enforce', timeZone: NY };

describe('night cap settings', () => {
  const env = (file, procEnv = {}) => nightCapConfig({ root: '/fleet', env: procEnv, read: () => file });

  test('off by default, 22:00 to 06:00 at 2 busy, in the host\'s zone', () => {
    const c = nightCapConfig({ root: null, env: {} });
    assert.equal(c.mode, 'off');
    assert.equal(c.start, 22 * 60);
    assert.equal(c.end, 6 * 60);
    assert.equal(c.maxBusy, 2);
    assert.equal(c.timeZone, null);
    assert.deepEqual(c.problems, []);
  });

  test('fleet.env wins over the process environment, so an edit there turns it off without a restart', () => {
    const c = env('FLEET_NIGHT_CAP_MODE=off\n', { FLEET_NIGHT_CAP_MODE: 'enforce' });
    assert.equal(c.mode, 'off');
    assert.equal(env('', { FLEET_NIGHT_CAP_MODE: 'enforce' }).mode, 'enforce');
  });

  test('the window, the limit and the zone are settings', () => {
    const c = env('FLEET_NIGHT_CAP_MODE=enforce\nFLEET_NIGHT_CAP_WINDOW="23:30-05:15"\nFLEET_NIGHT_CAP_MAX_BUSY=3\nFLEET_NIGHT_CAP_TZ=Europe/London\n');
    assert.deepEqual([c.mode, c.start, c.end, c.maxBusy, c.timeZone], ['enforce', 23 * 60 + 30, 5 * 60 + 15, 3, 'Europe/London']);
  });

  test('a value that does not parse keeps its default and says so; an unknown mode is off', () => {
    const c = env('FLEET_NIGHT_CAP_MODE=on\nFLEET_NIGHT_CAP_WINDOW=late\nFLEET_NIGHT_CAP_MAX_BUSY=two\nFLEET_NIGHT_CAP_TZ=Mars/Olympus\n');
    assert.equal(c.mode, 'off');
    assert.equal(c.start, 22 * 60);
    assert.equal(c.maxBusy, 2);
    assert.equal(c.timeZone, null);
    assert.equal(c.problems.length, 4);
  });

  test('window syntax', () => {
    assert.deepEqual(parseWindow('22:00-06:00'), { start: 1320, end: 360 });
    assert.deepEqual(parseWindow('1:00 – 5:00'), { start: 60, end: 300 });
    assert.equal(parseWindow('06:00-06:00'), null);
    assert.equal(parseWindow('24:00-06:00'), null);
  });
});

describe('night window, in local time', () => {
  const w = (iso, cfg = CFG) => nightWindow(at(iso), cfg);

  test('in the window and out of it (EST, an ordinary night)', () => {
    assert.equal(w('2026-11-05T02:59:00Z').active, false); // 21:59
    assert.equal(w('2026-11-05T03:00:00Z').active, true); // 22:00
    assert.equal(w('2026-11-05T07:00:00Z').active, true); // 02:00
    assert.equal(w('2026-11-05T10:59:00Z').active, true); // 05:59
    assert.equal(w('2026-11-05T11:00:00Z').active, false); // 06:00
    assert.equal(w('2026-11-05T17:00:00Z').active, false); // 12:00
  });

  test('inside, it ends at the next 06:00; outside, it says when it opens', () => {
    const inside = w('2026-11-05T04:00:00Z');
    assert.equal(inside.endsAt, at('2026-11-05T11:00:00Z'));
    assert.equal(inside.until, '06:00');
    const outside = w('2026-11-05T15:00:00Z');
    assert.equal(outside.startsAt, at('2026-11-06T03:00:00Z'));
    assert.equal(outside.until, null);
  });

  test('DST ends (2026-11-01, New York): a 9-hour night, the repeated 01:30 inside both times', () => {
    const open = w('2026-11-01T02:00:00Z'); // 22:00 EDT on 10-31
    assert.equal(open.active, true);
    assert.equal(open.endsAt, at('2026-11-01T11:00:00Z')); // 06:00 EST
    assert.equal(open.endsAt - at('2026-11-01T02:00:00Z'), 9 * HOUR);
    assert.equal(w('2026-11-01T05:30:00Z').active, true); // 01:30 EDT
    assert.equal(w('2026-11-01T06:30:00Z').active, true); // 01:30 EST
    assert.equal(w('2026-11-01T10:59:00Z').active, true);
    assert.equal(w('2026-11-01T11:00:00Z').active, false);
    assert.equal(w('2026-11-01T01:59:00Z').active, false); // 21:59 EDT
  });

  test('DST starts (2027-03-14, New York): a 7-hour night across the missing hour', () => {
    const open = w('2027-03-14T03:00:00Z'); // 22:00 EST on 03-13
    assert.equal(open.active, true);
    assert.equal(open.endsAt, at('2027-03-14T10:00:00Z')); // 06:00 EDT
    assert.equal(open.endsAt - at('2027-03-14T03:00:00Z'), 7 * HOUR);
    assert.equal(w('2027-03-14T07:30:00Z').active, true); // 03:30 EDT
    assert.equal(w('2027-03-14T10:00:00Z').active, false);
    assert.equal(w('2027-03-14T10:00:00Z').startsAt, at('2027-03-15T02:00:00Z')); // 22:00 EDT
  });

  test('a boundary inside the missing hour opens when the clock jumps past it', () => {
    assert.equal(localInstant(2027, 3, 14, 2 * 60 + 30, NY), at('2027-03-14T07:00:00Z')); // 03:00 EDT
    const c = { ...CFG, start: 2 * 60 + 30, end: 5 * 60 };
    assert.equal(w('2027-03-14T06:59:00Z', c).active, false); // 01:59 EST
    assert.equal(w('2027-03-14T07:00:00Z', c).active, true); // 03:00 EDT
  });

  test('a boundary in the repeated hour counts its first showing only', () => {
    assert.equal(localInstant(2026, 11, 1, 90, NY), at('2026-11-01T05:30:00Z')); // 01:30 EDT
    const c = { ...CFG, start: 22 * 60, end: 90 };
    assert.equal(w('2026-11-01T05:29:00Z', c).active, true);
    assert.equal(w('2026-11-01T05:30:00Z', c).active, false);
    assert.equal(w('2026-11-01T06:10:00Z', c).active, false); // 01:10 EST: not reopened
  });

  test('a window inside one day', () => {
    const c = { ...CFG, start: 60, end: 300 };
    assert.equal(w('2026-11-05T05:59:00Z', c).active, false); // 00:59
    assert.equal(w('2026-11-05T06:00:00Z', c).active, true); // 01:00
    assert.equal(w('2026-11-05T10:00:00Z', c).active, false); // 05:00
  });

  test('another zone is its own wall clock', () => {
    const c = { ...CFG, timeZone: 'Europe/London' };
    assert.equal(w('2026-11-05T22:30:00Z', c).active, true);
    assert.equal(w('2026-11-05T22:30:00Z', c).until, '06:00');
    assert.equal(w('2026-11-05T21:30:00Z', c).active, false);
  });
});

// ---- the controller ---------------------------------------------------------

const NIGHT = at('2026-11-05T04:00:00Z'); // 23:00 EST
const DAY = at('2026-11-05T15:00:00Z'); // 10:00 EST
const win = (now) => nightWindow(now, CFG);
const BASE = ['self-hosted', 'macOS', 'ARM64'];

function runner(repo, n = 1, extra = {}) {
  const short = repo.split('/').pop();
  const dir = `${short}${n > 1 ? `-${n}` : ''}`;
  return {
    name: `ultra-${dir}`, dirName: dir, repo, labels: [...BASE, 'ci'], ghStatus: 'online', ghUnknown: false,
    workingLocally: false, ghBusy: false, drainState: null, drainBy: null, ephemeral: false, ...extra,
  };
}
const busy = (r) => ({ ...r, workingLocally: true, ghBusy: true });
const parked = (r) => ({ ...r, drainState: 'drained', drainBy: NIGHT_CAP_OWNER, ghStatus: 'offline' });
const job = (runId, repo, ageMin, extra = {}) => ({ key: `${runId}/1`, runId, repo, labels: [...BASE, 'ci'], queuedSinceMs: ageMin * MIN, cause: null, ...extra });

const step = (runners, { now = NIGHT, jobs = [], config = CFG, state = null, hostOff = false } = {}) =>
  decideNightCap({ config, window: nightWindow(now, config), now, state, runners, jobs, hostOff }).decision;
const acts = (d) => Object.fromEntries(d.actions.map((a) => [a.name, a.action]));

describe('night cap controller', () => {
  test('outside the window it touches nothing, and resumes only what it parked', () => {
    const rs = [runner('o/web'), parked(runner('o/api')), { ...runner('o/ios'), drainState: 'drained', drainBy: null }, { ...runner('o/db'), drainState: 'drained', drainBy: 'tiers' }];
    const d = step(rs, { now: DAY });
    assert.equal(d.active, false);
    assert.deepEqual(acts(d), { 'ultra-api': 'resume' });
    assert.match(d.actions[0].reason, /night window ended at 06:00/);
  });

  test('switched off, it resumes what it parked, inside the window too', () => {
    const d = step([parked(runner('o/api')), runner('o/web')], { config: { ...CFG, mode: 'off' } });
    assert.deepEqual(acts(d), { 'ultra-api': 'resume' });
    assert.equal(d.applied, true);
  });

  test('in the window, idle runners with no slot are parked; busy ones under the cap are left alone', () => {
    const rs = [busy(runner('o/web')), runner('o/web', 2), runner('o/api'), runner('o/ios')];
    const d = step(rs);
    assert.equal(d.active, true);
    assert.equal(d.busy, 1);
    assert.equal(d.slots, 1);
    assert.deepEqual(acts(d), { 'ultra-web-2': 'drain', 'ultra-api': 'drain', 'ultra-ios': 'drain' });
    assert.match(d.actions[0].reason, /at most 2 busy until 06:00/);
  });

  test('free slots go to the oldest queued jobs, an online runner first, else a parked one', () => {
    const rs = [busy(runner('o/web')), runner('o/api'), parked(runner('o/ios')), runner('o/db')];
    // Two busy would be the cap: one slot, for the oldest job (ios, 30 min).
    let d = step(rs, { jobs: [job(10, 'o/api', 5), job(11, 'o/ios', 30)] });
    assert.deepEqual(d.slotted, { 'ultra-ios': '11/1' });
    assert.deepEqual(acts(d), { 'ultra-ios': 'resume', 'ultra-api': 'drain', 'ultra-db': 'drain' });
    assert.deepEqual(d.held, [10]);
    // With api's job the oldest, its online runner keeps the slot: nothing to resume.
    d = step(rs, { jobs: [job(10, 'o/api', 50), job(11, 'o/ios', 30)] });
    assert.deepEqual(d.slotted, { 'ultra-api': '10/1' });
    assert.equal(acts(d)['ultra-api'], undefined);
    assert.equal(acts(d)['ultra-ios'], undefined); // already parked: left parked
  });

  test('a queued job of a run already in progress gets a slot like any other', () => {
    const active = [{
      id: 7, repo: 'o/web', status: 'in_progress', createdAt: new Date(NIGHT - 20 * MIN).toISOString(),
      jobs: [{ id: 1, status: 'in_progress', labels: [...BASE, 'ci'] }, { id: 2, status: 'queued', labels: [...BASE, 'ci'] }],
    }, { id: 8, repo: 'o/api', status: 'queued', createdAt: new Date(NIGHT - 5 * MIN).toISOString(), jobs: [] }];
    const jobs = queuedJobs(active, NIGHT);
    assert.deepEqual(jobs.map((j) => j.key), ['7/2', '8']);
    const d = step([runner('o/web'), runner('o/api')], { jobs });
    assert.deepEqual(d.slotted, { 'ultra-web': '7/2', 'ultra-api': '8' });
    assert.deepEqual(d.actions, []);
  });

  test('at the cap, no slot: every idle runner is parked and every queued run is held', () => {
    const rs = [busy(runner('o/web')), busy(runner('o/api')), runner('o/ios'), runner('o/web', 2)];
    const d = step(rs, { jobs: [job(1, 'o/ios', 10), job(2, 'o/web', 3)] });
    assert.equal(d.slots, 0);
    assert.deepEqual(acts(d), { 'ultra-ios': 'drain', 'ultra-web-2': 'drain' });
    assert.deepEqual(d.held, [1, 2]);
  });

  test('running jobs are never touched: under or at the cap no action names a busy runner', () => {
    const rs = [busy(runner('o/web')), busy(runner('o/api')), runner('o/ios')];
    for (const now of [NIGHT, DAY]) {
      const d = step(rs, { now, jobs: [job(1, 'o/web', 10)] });
      for (const a of d.actions) assert.ok(!['ultra-web', 'ultra-api'].includes(a.name), `${a.name} ${a.action}`);
    }
  });

  test('over the cap (the window opened on a busy host) busy runners are drained to stop after their job, never stopped', () => {
    const rs = [busy(runner('o/web')), busy(runner('o/api')), busy(runner('o/ios')),
      // GitHub has handed it a job and its Worker is not up yet: left until it is.
      { ...runner('o/db'), ghBusy: true }];
    const d = step(rs);
    assert.equal(d.busy, 4);
    assert.deepEqual(acts(d), { 'ultra-web': 'drain', 'ultra-api': 'drain', 'ultra-ios': 'drain' });
    assert.ok(d.actions.every((a) => a.action === 'drain' && /stops after its current job/.test(a.reason)));
    // The only verbs there are: drain-runner.sh --drain lets a busy runner finish.
    assert.ok(d.actions.every((a) => ['drain', 'resume'].includes(a.action)));
  });

  test('never a runner someone else drained, an ephemeral one, or one that is offline', () => {
    const rs = [
      { ...runner('o/web'), drainState: 'drained', drainBy: null },
      { ...runner('o/api'), drainState: 'drained', drainBy: 'tiers' },
      { ...runner('o/eph'), ephemeral: true },
      { ...runner('o/ios'), ghStatus: 'offline' },
    ];
    assert.deepEqual(step(rs, { jobs: [job(1, 'o/web', 9), job(2, 'o/api', 9)] }).actions, []);
    assert.deepEqual(step(rs, { now: DAY }).actions, []);
  });

  test('a job GitHub holds for a concurrency group, or labels nothing has, takes no slot', () => {
    const d = step([runner('o/web'), runner('o/api')], {
      jobs: [job(1, 'o/web', 30, { cause: 'concurrency-block' }), job(2, 'o/api', 10, { labels: ['gpu'] }), job(3, 'o/api', 5)],
    });
    assert.deepEqual(d.slotted, { 'ultra-api': '3/1' });
    assert.deepEqual(acts(d), { 'ultra-web': 'drain' });
  });

  test('a cap of 0 parks everything idle', () => {
    const d = step([runner('o/web'), runner('o/api')], { config: { ...CFG, maxBusy: 0 }, jobs: [job(1, 'o/web', 9)] });
    assert.deepEqual(acts(d), { 'ultra-web': 'drain', 'ultra-api': 'drain' });
  });

  test('observe decides and applies nothing; switched off the host gets no command at all', () => {
    const rs = [runner('o/web'), runner('o/api')];
    const o = step(rs, { config: { ...CFG, mode: 'observe' } });
    assert.equal(o.applied, false);
    assert.equal(o.actions.length, 2);
    assert.equal(enforcingNightCap(o), null);
    const off = step(rs, { hostOff: true });
    assert.deepEqual(off.actions, []);
    assert.equal(off.deferred.length, 2);
  });

  test('an action is not sent again while it is on its way', () => {
    const rs = [runner('o/web')];
    const first = decideNightCap({ config: CFG, window: win(NIGHT), now: NIGHT, state: null, runners: rs, jobs: [] });
    assert.equal(first.decision.actions.length, 1);
    const again = decideNightCap({ config: CFG, window: win(NIGHT + MIN), now: NIGHT + MIN, state: first.state, runners: rs, jobs: [] });
    assert.equal(again.decision.actions.length, 0);
    const later = decideNightCap({ config: CFG, window: win(NIGHT + 4 * MIN), now: NIGHT + 4 * MIN, state: first.state, runners: rs, jobs: [] });
    assert.equal(later.decision.actions.length, 1);
  });
});

// ---- the headroom gate, the queue and the cockpit's words -------------------

const CTX = { active: true, until: '06:00', maxBusy: 2, window: '22:00-06:00', busy: 2, host: 'ultra', hostId: 'ultra', endsAt: NIGHT + 7 * HOUR };

describe('night cap: headroom, queue cause and ETA', () => {
  test('the headroom gate refuses a new runner while the cap holds', () => {
    const hr = headroom({ host: { cores: 30, load1: 1, diskFreeGb: 500 }, runners: [], limits: {}, nightCap: CTX });
    assert.equal(hr.ok, false);
    assert.match(hr.reasons[0], /night cap allows at most 2 busy CI runners until 06:00/);
    assert.equal(headroom({ host: { cores: 30, load1: 1, diskFreeGb: 500 }, runners: [], limits: {} }).ok, true);
  });

  const run = { id: 1, repo: 'o/web', status: 'queued', createdAt: new Date(NIGHT - 30 * MIN).toISOString(), jobs: [] };
  const fleetRunner = (extra) => ({ ...runner('o/web'), registered: true, launchdState: 'stopped', hostId: 'ultra', ...extra });

  test('a run whose runner the cap parked is night-cap, not runner-down, and says until when', () => {
    const c = classifyQueueCause({ run, runners: [fleetRunner({ drainState: 'drained', drainBy: 'night-cap', ghStatus: 'offline' })], capacity: { ok: false, reasons: [] }, nightCap: CTX });
    assert.equal(c.cause, 'night-cap');
    assert.equal(c.confidence, 'high');
    assert.match(c.recommended, /Held by the night cap until 06:00/);
    assert.match(c.recommended, /Not your code/);
    assert.ok(c.evidence.some((e) => /parked by the night cap until 06:00/.test(e)));
  });

  test('a run behind busy runners while the cap holds is night-cap too', () => {
    const c = classifyQueueCause({ run, runners: [fleetRunner({ launchdState: 'running', workingLocally: true, ghBusy: true })], capacity: { ok: false, reasons: [] }, nightCap: CTX });
    assert.equal(c.cause, 'night-cap');
    const day = classifyQueueCause({ run, runners: [fleetRunner({ launchdState: 'running', workingLocally: true, ghBusy: true })], capacity: { ok: true, reasons: [] } });
    assert.equal(day.cause, 'repo-capacity');
  });

  test('between 06:00 and the resume tick a parked runner is still night-cap, never runner-down', () => {
    const c = classifyQueueCause({ run, runners: [fleetRunner({ drainState: 'drained', drainBy: 'night-cap', ghStatus: 'offline' })], capacity: { ok: true, reasons: [] } });
    assert.equal(c.cause, 'night-cap');
  });

  const EMPTY = { byWorkflow: new Map(), byRepo: new Map(), fleet: { expectedMs: null } };
  test('its ETA runs from the next job to finish to the end of the window', () => {
    const etas = estimateQueue({
      queue: [{ id: 1, repo: 'o/web', workflowName: 'ci', cause: 'night-cap', queuedSinceMs: 0 }],
      active: [], baselines: { p50: EMPTY, p90: EMPTY }, now: NIGHT, nightCap: CTX,
    });
    const e = etas.get(1);
    assert.deepEqual(e.etaStartMs, [0, 7 * HOUR]);
    assert.match(e.basis, /held by the night cap until 06:00/);
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../cockpit/Sources/CockpitCore/Fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const NC = { mode: 'enforce', active: true, inWindow: true, window: '22:00-06:00', host: 'ultra', maxBusy: 2, busy: 2, until: '06:00', held: [4], parked: 5 };

function glanceWith({ nightCap = NC, queue = [] } = {}) {
  return {
    ...fixture('quiet'),
    runs: [
      { id: 4, repo: 'acme/comet-web', workflow: 'e2e', status: 'queued', sha: 'abc1234', prNumber: 96, prHead: 'abc1234', updatedAt: 1 },
      { id: 3, repo: 'acme/comet-web', workflow: 'ci', status: 'completed', conclusion: 'success', sha: 'abc1234', prNumber: 96, prHead: 'abc1234', updatedAt: 1 },
    ],
    recent: [],
    queue,
    ...(nightCap ? { nightCap } : {}),
  };
}
const target = { repo: 'acme/comet-web', pr: 96 };

describe('night cap: what a wait and `cockpit why` say', () => {
  test('a pending check the cap holds is named, until when, and not your code', () => {
    const d = decide(glanceWith(), target);
    assert.equal(d.state, 'pending');
    assert.equal(d.heldBy, 'night-cap');
    assert.match(d.reason, /^held by the night cap until 06:00: ultra runs at most 2 CI jobs from 22:00 to 06:00/);
    assert.match(d.reason, /Not your code: keep waiting\./);
  });

  test('a queued row with cause night-cap is enough, and it is never pointless', () => {
    const q = { id: 4, repo: 'acme/comet-web', workflow: 'e2e', queuedMs: 60_000, cause: 'night-cap', confidence: 'high', prNumber: 96 };
    const d = decide(glanceWith({ nightCap: { ...NC, held: [] }, queue: [q] }), target);
    assert.equal(d.state, 'pending');
    assert.equal(d.heldBy, 'night-cap');
  });

  test('no cap, or a cap that is not holding this PR: an ordinary pending', () => {
    assert.equal(decide(glanceWith({ nightCap: null }), target).reason, null);
    assert.equal(decide(glanceWith({ nightCap: { ...NC, held: [99] } }), target).reason, null);
    assert.equal(decide(glanceWith({ nightCap: { ...NC, active: false } }), target).reason, null);
  });

  test('wait_for_checks answers pending with the reason, heldBy and notYourCode', async () => {
    let t = 1_000_000_000;
    const out = await waitForChecks(target, {
      glance: () => glanceWith(), orphans: () => [], prChecks: async () => null, run: async () => null,
    }, { waitS: 5, now: () => t, sleep: async (ms) => { t += ms; } });
    assert.equal(out.state, 'pending');
    assert.equal(out.heldBy, 'night-cap');
    assert.equal(out.notYourCode, true);
    assert.match(out.reason, /held by the night cap until 06:00/);
  });

  test('the glance carries the cap only while it is configured, and the parked runner says why', () => {
    const snapshot = {
      ts: NIGHT,
      host: {},
      fleetRunners: [{ ...runner('acme/comet-web'), drainState: 'drained', drainBy: 'night-cap', registered: true }],
      queue: [{ id: 4, repo: 'acme/comet-web', workflowName: 'e2e', queuedSinceMs: 60_000, cause: 'night-cap', confidence: 'high', evidence: [], recommended: 'x' }],
      nightCap: { ...NC, ts: NIGHT, endsAt: NIGHT + 7 * HOUR },
    };
    const result = computeVerdict(snapshot, {}, { now: NIGHT });
    assert.equal(result.runners.get('ultra-comet-web').detail, 'parked by the night cap until 06:00');
    assert.ok(result.verdict.evidence.some((e) => /^Night cap until 06:00: at most 2 busy CI runners on ultra/.test(e)));
    const g = buildGlance(snapshot, result, { now: NIGHT });
    assert.equal(g.nightCap.active, true);
    assert.equal(g.nightCap.until, '06:00');
    assert.deepEqual(g.nightCap.held, [4]);
    assert.equal(g.queue[0].notYourCode, true);
    const off = buildGlance({ ...snapshot, nightCap: { ...snapshot.nightCap, mode: 'off' } }, result, { now: NIGHT });
    assert.equal('nightCap' in off, false);
    // Observe decides but holds nothing, so nothing is named as held.
    const obs = buildGlance({ ...snapshot, nightCap: { ...snapshot.nightCap, mode: 'observe' } }, result, { now: NIGHT });
    assert.equal(obs.nightCap.active, false);
    assert.deepEqual(obs.nightCap.held, []);
  });
});
