import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HaCoordinator } from '../lib/ha.js';
import {
  createHostToken, hasHostToken, hasHostTokens, hostTokenMatches,
} from '../lib/host-auth.js';

test('HA-disabled coordinator is the single-node leader', async () => {
  const ha = new HaCoordinator({ url: '', replicaId: 'mac-a' });
  await ha.start();
  assert.equal(ha.isLeader, true);
  assert.equal(ha.leaderId, 'mac-a');
  assert.deepEqual(await ha.status(), {
    enabled: false,
    isLeader: true,
    leaderId: 'mac-a',
  });
  await ha.close();
});

test('host-scoped tokens authenticate only their assigned host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-host-token-'));
  try {
    const path = join(dir, 'tokens.json');
    const tokenA = createHostToken(path, 'mac-a');
    const tokenB = createHostToken(path, 'mac-b');
    assert.equal(hasHostTokens(path), true);
    assert.equal(hasHostToken(path, 'mac-a'), true);
    assert.equal(hasHostToken(path, 'mac-c'), false);
    assert.equal(hostTokenMatches(path, 'mac-a', tokenA), true);
    assert.equal(hostTokenMatches(path, 'mac-b', tokenB), true);
    assert.equal(hostTokenMatches(path, 'mac-b', tokenA), false);
    assert.equal(hostTokenMatches(path, 'mac-a', 'wrong'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
