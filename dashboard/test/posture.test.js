// Posture checks against a scripted shell: what each probe's answer turns into.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkPosture } from '../lib/posture.js';

const scripted = (answers) => async (cmd, args) => {
  const key = `${cmd.split('/').pop()} ${args.join(' ')}`;
  for (const [pattern, out] of answers) if (key.includes(pattern)) return out;
  return '';
};
const snapshot = {
  admission: { hooks: { installed: 48, total: 48 } },
  runners: [{ version: '2.337.0' }, { version: '2.337.0' }],
  api: { remaining: 4200, limit: 5000 },
};
const byId = (r) => Object.fromEntries(r.items.map((i) => [i.id, i]));

describe('checkPosture', () => {
  test('the host as measured on 2026-09-30: Spotlight indexing _work, no auto-login', async () => {
    const r = await checkPosture({
      sh: scripted([
        ['mdfind', '71636\n'], ['mdutil', '/:\n\tIndexing enabled.\n'],
        ['defaults read', ''], ['pmset', ' sleep                0 (sleep prevented by powerd)\n'],
        ['launchctl', '-\t0\tcom.addisdev.fleet-health\n'], ['git', '0\n'],
      ]),
      root: '/Users/ci/actions-runners', snapshot, labelPrefix: 'com.addisdev',
      lint: [{ rule: 'hosted-macos', repo: 'acme/atlas-ios' }],
    });
    const i = byId(r);
    assert.equal(i.spotlight.ok, false);
    assert.match(i.spotlight.detail, /71,636 package\.json/);
    assert.equal(i.spotlight.who, 'owner');
    assert.equal(i['auto-login'].ok, false);
    assert.equal(i.sleep.ok, true);
    assert.equal(i.hooks.ok, true);
    assert.equal(i.versions.ok, true);
    assert.equal(i['health-agent'].ok, true);
    assert.equal(i['hosted-runners'].ok, false);
    assert.equal(i.behind.ok, true);
    assert.equal(r.open, 3);
  });

  test('a healthy host is all clear, and a silent probe is unknown rather than fine', async () => {
    const r = await checkPosture({
      sh: scripted([['mdfind', '0\n'], ['defaults read', 'ci\n'], ['pmset', ' sleep 0\n'],
        ['launchctl', 'com.runner-fleet.runner-health'], ['git', '0\n']]),
      root: '/r', snapshot,
    });
    assert.equal(r.open, 0);
    const silent = await checkPosture({ sh: async () => '', root: '/r', snapshot: {} });
    assert.equal(byId(silent).spotlight.ok, null);
    assert.equal(byId(silent).sleep.ok, null);
  });

  test('drift worth fixing: sleep, missing hooks, split versions, stale checkout', async () => {
    const r = await checkPosture({
      sh: scripted([['mdfind', '0\n'], ['defaults read', 'ci\n'], ['pmset', ' sleep 10\n'], ['git', '3\n']]),
      root: '/r',
      snapshot: { ...snapshot, admission: { hooks: { installed: 40, total: 48 } }, runners: [{ version: '2.337.0' }, { version: '2.336.0' }] },
    });
    const i = byId(r);
    assert.match(i.sleep.title, /sleeps after 10 minutes/);
    assert.match(i.hooks.title, /missing on 8/);
    assert.equal(i.versions.ok, false);
    assert.match(i.behind.title, /3 commit/);
    assert.equal(i['health-agent'].ok, false);
  });
});
