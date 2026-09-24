import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HaCoordinator } from '../lib/ha.js';

const url = process.env.TEST_DATABASE_URL;

test('PostgreSQL elects one leader and preserves shared commands/snapshot', {
  skip: !url,
}, async () => {
  process.env.FLEET_DATABASE_SSL = '0';
  const a = new HaCoordinator({ url, replicaId: 'test-a', electionMs: 60_000 });
  const b = new HaCoordinator({ url, replicaId: 'test-b', electionMs: 60_000 });
  await a.start();
  await b.start();
  const leader = a.isLeader ? a : b;
  const standby = a.isLeader ? b : a;
  assert.equal(Number(a.isLeader) + Number(b.isLeader), 1);

  await leader.publishSnapshot({ ts: 1234, runners: [], drift: [] });
  const shared = await standby.loadSnapshot();
  assert.equal(shared.leader_id, leader.replicaId);
  assert.equal(Number(shared.ts), 1234);

  const id = await standby.queueCommand('test-host', 'host.drain', {}, 'test-command');
  assert.ok(id);
  assert.equal((await leader.pendingCommands('test-host')).length, 1);
  assert.equal(await leader.completeCommand(id, true, 'too early'), false);
  assert.equal((await leader.commandById(id)).status, 'pending');
  assert.deepEqual((await leader.claimCommands('test-host')).map((row) => Number(row.id)), [Number(id)]);
  assert.equal(await leader.completeCommand(id, true, 'done'), true);
  assert.equal((await leader.commandById(id)).status, 'done');

  const raceId = await leader.queueCommand('race-host', 'host.drain', {}, 'test-command-race');
  const [claimedA, claimedB] = await Promise.all([
    leader.claimCommands('race-host'),
    standby.claimCommands('race-host'),
  ]);
  assert.equal(claimedA.length + claimedB.length, 1);
  assert.equal(Number((claimedA[0] ?? claimedB[0]).id), Number(raceId));

  await standby.setMeta('setting.groupMin', { __fleetReset: true });
  assert.deepEqual((await leader.loadSettings()).groupMin, { __fleetReset: true });

  await leader.close();
  await standby.elect();
  assert.equal(standby.isLeader, true);

  await standby.pool.query(
    "DELETE FROM fleet_commands WHERE idempotency_key IN ('test-command','test-command-race')"
  );
  await standby.deleteMeta('setting.groupMin');
  await standby.pool.query('DELETE FROM fleet_snapshots WHERE id=1');
  await standby.close();
});
