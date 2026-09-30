import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// runner_state accumulated forever: it was only ever INSERTed and UPDATEd, and
// nothing removed a runner that had been taken off the machine. Those rows feed
// the repo roster and the runner-unused alert, so eight deleted repos were still being polled (404 on every roster
// refresh) and still raising "runner idle for over 7 days" for runners with no
// directory, no LaunchAgent and no process.
//
// This pins the prune's contract, including the guard that matters most: an
// empty discovery pass must delete nothing.

function db() {
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  const d = new DatabaseSync(join(dir, 't.db'));
  d.exec(`CREATE TABLE runner_state (
    name TEXT PRIMARY KEY, repo TEXT, dir TEXT, updated_at INTEGER)`);
  return { d, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ROOT = '/fleet';
const NOW = 1_790_713_000_000;
const OLD = NOW - 14 * 24 * 60 * 60 * 1000;

function seed(d) {
  const ins = d.prepare('INSERT INTO runner_state (name, repo, dir, updated_at) VALUES (?,?,?,?)');
  ins.run('RL-app-web', 'testowner/app-web', `${ROOT}/app-web`, NOW);
  ins.run('RL-app-ios', 'testowner/app-ios', `${ROOT}/app-ios`, NOW);
  ins.run('RL-gone-ios', 'testowner/gone-ios', `${ROOT}/gone-ios`, OLD);
  ins.run('RL-gone-web', 'testowner/gone-web', `${ROOT}/gone-web`, OLD);
  // A remote agent's runner: different root, must never be touched from here.
  ins.run('MAC2-app-ios', 'testowner/app-ios', '/other-fleet/app-ios', OLD);
}

// The statement exactly as fleetd.js prepares it.
const prune = (d, root, now) =>
  d.prepare('DELETE FROM runner_state WHERE dir LIKE ? AND updated_at < ?').run(`${root}%`, now).changes;

describe('runner_state prune', () => {
  test('forgets local runners discovery no longer sees', () => {
    const { d, cleanup } = db();
    try {
      seed(d);
      assert.equal(prune(d, ROOT, NOW), 2);
      const left = d.prepare('SELECT name FROM runner_state ORDER BY name').all().map((r) => r.name);
      assert.deepEqual(left, ['MAC2-app-ios', 'RL-app-ios', 'RL-app-web']);
    } finally { cleanup(); }
  });

  test('never touches a runner rooted on another host', () => {
    const { d, cleanup } = db();
    try {
      seed(d);
      prune(d, ROOT, NOW);
      assert.ok(d.prepare("SELECT 1 FROM runner_state WHERE name='MAC2-app-ios'").get());
    } finally { cleanup(); }
  });

  test('a pass that discovered nothing must delete nothing', () => {
    // The dangerous case: launchctl fails or the fleet root is unmounted and
    // discovery returns []. fleetd guards with `if (runners.length)`; without
    // it, one broken read would wipe the whole table.
    const { d, cleanup } = db();
    try {
      seed(d);
      const discovered = [];
      if (discovered.length) prune(d, ROOT, NOW);
      assert.equal(d.prepare('SELECT COUNT(*) c FROM runner_state').get().c, 5);
    } finally { cleanup(); }
  });

  test('is idempotent on a healthy fleet', () => {
    const { d, cleanup } = db();
    try {
      seed(d);
      prune(d, ROOT, NOW);
      assert.equal(prune(d, ROOT, NOW), 0, 'a second pass must find nothing to remove');
    } finally { cleanup(); }
  });
});
