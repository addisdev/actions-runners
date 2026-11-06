// The billing guard (lib/billing-guard.js): usage items in the shape GitHub's
// /users/{u}/settings/billing/usage returns (recorded 2026-11-05), holdings,
// and the verdict.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateUsage, evaluateHoldings, verdict, statusEntry, windowDays, monthsFor, guardDue, guardAccount,
  runBillingGuard, usageErrorText, GUARD_EVERY_MS, GUARD_RETRY_MS,
} from '../lib/billing-guard.js';

const NOW = Date.parse('2026-11-05T18:00:00Z');
const item = (date, sku, quantity, repositoryName, unitType = sku === 'Actions storage' ? 'GigabyteHours' : 'Minutes') => ({
  date, product: 'actions', sku, quantity, unitType, pricePerUnit: 0.006, grossAmount: 0, discountAmount: 0, netAmount: 0, repositoryName,
});

// November 2026 as GitHub reported it, trimmed.
const NOVEMBER = [
  item('2026-11-02T15:04:45Z', 'Actions Linux', 147, 'copilot-suite'),
  item('2026-11-02T21:52:57Z', 'Actions Linux', 42, 'actions-runners'),
  item('2026-11-02T22:48:13Z', 'Actions Windows', 22, 'fleet-runner'),
  item('2026-11-04T00:00:00Z', 'Actions storage', 47.646660905, 'homelake'),
  item('2026-11-04T00:00:00Z', 'Actions storage', 1.044683693, 'fleet-runner'),
  item('2026-11-05T00:00:00Z', 'Actions storage', 230.999123566, 'homelake'),
  item('2026-11-05T01:00:00Z', 'Actions storage', 5.828188414, 'petcam-android'),
  item('2026-11-05T00:00:00Z', 'Actions storage', 0.000309245, 'kitproof'),
  item('2026-11-05T00:00:00Z', 'Actions storage', 0.649159478, 'actions-runners'),
  item('2026-11-05T03:42:07Z', 'Actions Linux', 15, 'actions-runners'),
  item('2026-11-05T03:45:12Z', 'Actions macOS 3-core', 19, 'actions-runners'),
];

describe('window', () => {
  test('two UTC days by default, ending today', () => {
    assert.deepEqual(windowDays(NOW), ['2026-11-04', '2026-11-05']);
    assert.deepEqual(windowDays(NOW, 1), ['2026-11-05']);
  });

  test('a window across the 1st asks for both months', () => {
    assert.deepEqual(monthsFor(Date.parse('2026-12-01T05:00:00Z')), [{ year: 2026, month: 11 }, { year: 2026, month: 12 }]);
    assert.deepEqual(monthsFor(NOW), [{ year: 2026, month: 11 }]);
  });
});

describe('usage', () => {
  test('storage over the floor names each repo and the SKU, largest first', () => {
    const u = evaluateUsage(NOVEMBER, { now: NOW });
    const storage = u.findings.filter((f) => f.kind === 'storage');
    assert.deepEqual(storage.map((f) => [f.repo, f.date]), [['homelake', '2026-11-04'], ['homelake', '2026-11-05'], ['petcam-android', '2026-11-05']]);
    assert.equal(storage[1].sku, 'Actions storage');
    assert.match(storage[1].detail, /homelake: 231 GB-hours of Actions storage on 2026-11-05/);
    assert.ok(!storage.some((f) => f.repo === 'kitproof'), 'a crumb under 0.01 GB-h is not named');
  });

  test('the exempt repos neither go red nor count toward the storage floor', () => {
    const u = evaluateUsage(NOVEMBER, { now: NOW });
    assert.ok(!u.findings.some((f) => f.repo === 'actions-runners' || f.repo === 'fleet-runner'));
    assert.deepEqual(u.exempt.minutes.map((m) => [m.repo, m.sku, m.minutes]),
      [['actions-runners', 'Actions Linux', 15], ['actions-runners', 'Actions macOS 3-core', 19]]);
    assert.equal(u.storageDays.find((d) => d.date === '2026-11-04').gbh, 47.647);
  });

  test('hosted minutes outside the window are history, not today', () => {
    const u = evaluateUsage(NOVEMBER, { now: NOW });
    assert.ok(!u.findings.some((f) => f.kind === 'hosted-minutes'), 'copilot-suite ran on 11-02');
    const month = evaluateUsage(NOVEMBER, { now: NOW, days: 5 });
    const mins = month.findings.filter((f) => f.kind === 'hosted-minutes');
    assert.deepEqual(mins.map((f) => [f.repo, f.sku, f.amount]), [['copilot-suite', 'Actions Linux', 147]]);
    assert.match(mins[0].detail, /copilot-suite: 147 GitHub-hosted minutes \(Actions Linux\) on 2026-11-02/);
  });

  test('a hosted minute in any other repo is red, however small', () => {
    const u = evaluateUsage([item('2026-11-05T10:00:00Z', 'Actions Linux', 1, 'worklake')], { now: NOW });
    assert.deepEqual(u.findings.map((f) => [f.kind, f.repo, f.sku]), [['hosted-minutes', 'worklake', 'Actions Linux']]);
  });

  test('storage under the floor is quiet, and the floor is a setting', () => {
    const small = [item('2026-11-05T00:00:00Z', 'Actions storage', 0.4, 'jerv'), item('2026-11-05T00:00:00Z', 'Actions storage', 0.5, 'agents')];
    assert.equal(evaluateUsage(small, { now: NOW }).findings.length, 0);
    assert.equal(evaluateUsage(small, { now: NOW, storageFloorGbh: 0.5 }).findings.length, 2);
  });

  test('the exempt list is a setting, compared case-insensitively', () => {
    const u = evaluateUsage([item('2026-11-05T10:00:00Z', 'Actions Linux', 3, 'Worklake')], { now: NOW, exempt: ['worklake'] });
    assert.equal(u.findings.length, 0);
  });
});

describe('holdings', () => {
  test('a private repo with artifacts or caches is red; public and exempt repos are not', () => {
    const f = evaluateHoldings([
      { repo: 'addisdev/radiator', private: true, caches: { count: 7, bytes: 9.7 * 1024 ** 3 }, artifacts: { count: 2, bytes: 1048576 } },
      { repo: 'addisdev/jerv', private: true, caches: { count: 0, bytes: 0 }, artifacts: { count: 0, bytes: 0 } },
      { repo: 'addisdev/fleet-runner', private: true, caches: { count: 3, bytes: 1 }, artifacts: null },
      { repo: 'addisdev/public-site', private: false, caches: { count: 3, bytes: 1 }, artifacts: { count: 1, bytes: 1 } },
    ]);
    assert.deepEqual(f.map((x) => [x.kind, x.repo, x.sku]), [['artifacts', 'radiator', 'Actions storage'], ['caches', 'radiator', 'Actions cache']]);
    assert.match(f[1].detail, /gh cache delete --all -R addisdev\/radiator/);
  });
});

describe('verdict', () => {
  test('red names the repos; green says what was checked', () => {
    const red = verdict({ account: 'addisdev', usage: NOVEMBER, holdings: [], now: NOW });
    assert.equal(red.state, 'red');
    assert.match(red.summary, /^GitHub is running or keeping something for 2 repos: homelake/);
    const green = verdict({ account: 'addisdev', usage: [], holdings: [], now: NOW });
    assert.equal(green.state, 'green');
    assert.match(green.summary, /0 hosted minutes outside actions-runners and fleet-runner/);
  });

  test('an unreadable billing API is unavailable, never green, and red still wins', () => {
    const blind = verdict({ account: 'addisdev', usage: null, usageError: 'no scope', holdings: [], now: NOW });
    assert.equal(blind.state, 'unavailable');
    assert.match(blind.summary, /Cannot read addisdev's Actions billing: no scope/);
    const holding = verdict({
      account: 'addisdev', usage: null, usageError: 'no scope', now: NOW,
      holdings: [{ repo: 'addisdev/tvloop', private: true, caches: { count: 2, bytes: 10 }, artifacts: null }],
    });
    assert.equal(holding.state, 'red');
  });

  test('the Homelab Map reads it as a product check', () => {
    assert.deepEqual(statusEntry({ state: 'red', checkedAt: NOW, summary: 's' }), { state: 'failed', at: '2026-11-05T18:00:00.000Z', detail: 's' });
    assert.equal(statusEntry({ state: 'green', checkedAt: NOW }).state, 'ok');
    assert.equal(statusEntry({ state: 'unavailable', checkedAt: NOW }).state, 'warn');
  });
});

describe('schedule and account', () => {
  test('daily, or hourly while the billing API is unreadable', () => {
    assert.equal(guardDue(null, NOW), true);
    assert.equal(guardDue({ checkedAt: NOW - 1000, state: 'red' }, NOW), false);
    assert.equal(guardDue({ checkedAt: NOW - GUARD_EVERY_MS, state: 'green' }, NOW), true);
    assert.equal(guardDue({ checkedAt: NOW - GUARD_RETRY_MS, state: 'unavailable' }, NOW), true);
    assert.equal(guardDue({ checkedAt: NOW - GUARD_RETRY_MS, state: 'green' }, NOW), false);
  });

  test('the account is the setting, else the one owner of the fleet\'s repos', () => {
    assert.equal(guardAccount('someone', []), 'someone');
    assert.equal(guardAccount('', [{ fullName: 'addisdev/a' }, { fullName: 'addisdev/b' }]), 'addisdev');
    assert.equal(guardAccount('', [{ fullName: 'addisdev/a' }, { fullName: 'acme/b' }]), null);
    assert.equal(guardAccount('', []), null);
  });

  test('a 404 from the billing API says which scope is missing', () => {
    assert.match(usageErrorText({ status: 404 }, 'addisdev'), /needs the `user` scope.*gh auth refresh -h github\.com -s user/);
  });
});

describe('runBillingGuard', () => {
  function fakeGh(routes) {
    const calls = [];
    return {
      calls,
      get: async (path) => {
        calls.push(path);
        for (const [pattern, answer] of routes) {
          if (pattern.test(path)) {
            if (answer instanceof Error) throw answer;
            return { data: answer };
          }
        }
        throw Object.assign(new Error(`${path}: 404`), { status: 404 });
      },
    };
  }

  const repos = [
    { fullName: 'addisdev/homelake', private: true, archived: false },
    { fullName: 'addisdev/old', private: true, archived: true },
    { fullName: 'addisdev/actions-runners', private: false, archived: false },
    { fullName: 'acme/other', private: true, archived: false },
  ];

  test('reads usage for the month and holdings for each private repo of the account', async () => {
    const gh = fakeGh([
      [/settings\/billing\/usage\?year=2026&month=11$/, { usageItems: NOVEMBER }],
      [/homelake\/actions\/cache\/usage/, { active_caches_count: 0, active_caches_size_in_bytes: 0 }],
      [/homelake\/actions\/artifacts/, { total_count: 3, artifacts: [{ expired: false, size_in_bytes: 10 }, { expired: true, size_in_bytes: 99 }] }],
    ]);
    const r = await runBillingGuard({ gh, account: 'addisdev', repos, now: NOW });
    assert.equal(r.state, 'red');
    assert.deepEqual(gh.calls.filter((c) => c.startsWith('repos/')).sort(),
      ['repos/addisdev/homelake/actions/artifacts?per_page=100', 'repos/addisdev/homelake/actions/cache/usage']);
    const art = r.findings.find((f) => f.kind === 'artifacts');
    assert.equal(art.amount, 1, 'expired artifacts are not counted');
    assert.equal(r.reposChecked, 1);
  });

  test('a token without the user scope comes back unavailable, with the fix', async () => {
    const gh = fakeGh([
      [/settings\/billing\/usage/, Object.assign(new Error('Not Found'), { status: 404 })],
      [/cache\/usage/, { active_caches_count: 0 }],
      [/artifacts/, { total_count: 0, artifacts: [] }],
    ]);
    const r = await runBillingGuard({ gh, account: 'addisdev', repos, now: NOW });
    assert.equal(r.state, 'unavailable');
    assert.match(r.usageError, /user` scope/);
  });
});
