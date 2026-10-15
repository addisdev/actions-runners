import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile, admissionSettings, admissionBlocker, admissionReport } from '../lib/admit-gate.js';

const fileOf = (text) => () => text;
const noFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

describe('parseEnvFile', () => {
  test('reads plain, quoted and exported assignments; skips comments and the rest', () => {
    const env = parseEnvFile([
      '# comment',
      'FLEET_ADMIT_MODE=enforce',
      'export FLEET_ADMIT_MIN_FREE_DISK_GB="100"',
      "FLEET_X='a b'",
      'FLEET_Y=7   # trailing',
      'not an assignment',
      '',
    ].join('\n'));
    assert.deepEqual(env, { FLEET_ADMIT_MODE: 'enforce', FLEET_ADMIT_MIN_FREE_DISK_GB: '100', FLEET_X: 'a b', FLEET_Y: '7' });
  });
});

describe('admissionSettings', () => {
  test('defaults match hooks/common.sh: off, 40 GB, 15 GB', () => {
    assert.deepEqual(admissionSettings({ root: '/r', env: {}, read: noFile }), { mode: 'off', minFreeDiskGb: 40, minPlainFreeGb: 15 });
  });

  test('fleet.env is sourced over the environment, as the hook sources it', () => {
    const s = admissionSettings({
      root: '/r',
      env: { FLEET_ADMIT_MODE: 'observe', FLEET_ADMIT_MIN_FREE_DISK_GB: '50', FLEET_ADMIT_MIN_PLAIN_FREE_GB: '20' },
      read: fileOf('FLEET_ADMIT_MODE=enforce\nFLEET_ADMIT_MIN_FREE_DISK_GB=100\n'),
    });
    assert.deepEqual(s, { mode: 'enforce', minFreeDiskGb: 100, minPlainFreeGb: 20 });
  });

  test('a typo is the default, never the most expensive reading', () => {
    const s = admissionSettings({ root: '/r', env: {}, read: fileOf('FLEET_ADMIT_MODE=enforec\nFLEET_ADMIT_MIN_FREE_DISK_GB=1OO\n') });
    assert.deepEqual(s, { mode: 'off', minFreeDiskGb: 40, minPlainFreeGb: 15 });
  });
});

describe('admissionBlocker', () => {
  const enforce = { mode: 'enforce', minFreeDiskGb: 100, minPlainFreeGb: 15 };

  test('usable disk under the floor blocks, in the hook\'s own words', () => {
    // ultra, 2026-10-15: 96.9 GB usable against a 100 GB floor.
    const b = admissionBlocker({ diskFreeGb: 96.9, diskPlainFreeGb: 70.4 }, enforce);
    assert.deepEqual(b, { kind: 'disk', freeGb: 96, floorGb: 100, reason: '96 GB disk free, below the 100 GB floor' });
  });

  test('whole gigabytes, like the hook: 100.4 is not under 100, 99.9 is', () => {
    assert.equal(admissionBlocker({ diskFreeGb: 100.4, diskPlainFreeGb: 80 }, enforce), null);
    assert.equal(admissionBlocker({ diskFreeGb: 99.9, diskPlainFreeGb: 80 }, enforce).freeGb, 99);
  });

  test('plain free under the hard floor blocks even with purgeable space', () => {
    const b = admissionBlocker({ diskFreeGb: 140, diskPlainFreeGb: 12.2 }, enforce);
    assert.equal(b.kind, 'plain-disk');
    assert.equal(b.reason, '12 GB plain disk free, below the 15 GB hard floor');
  });

  test('observe and off never hold a job, so never block', () => {
    for (const mode of ['observe', 'off']) {
      assert.equal(admissionBlocker({ diskFreeGb: 1, diskPlainFreeGb: 1 }, { ...enforce, mode }), null);
    }
  });

  test('an unread disk is not a blocker', () => {
    assert.equal(admissionBlocker({}, enforce), null);
    assert.equal(admissionBlocker({ diskFreeGb: null, diskPlainFreeGb: null }, enforce), null);
  });

  test('admissionReport carries the settings beside the blocker', () => {
    const r = admissionReport({ diskFreeGb: 120, diskPlainFreeGb: 90 }, enforce);
    assert.deepEqual(r, { ...enforce, blocked: null });
  });
});
