// Static contract for the periodic health-repair LaunchAgent installer.
// Same approach as kpi-nav.test.js: source checks, no launchd, no browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ctl = readFileSync(join(ROOT, 'healthctl.sh'), 'utf8');
const wrapper = readFileSync(join(ROOT, 'scripts', 'health-repair-launchd.sh'), 'utf8');

describe('healthctl.sh contract', () => {
  test('bash syntax is valid', () => {
    execFileSync('bash', ['-n', join(ROOT, 'healthctl.sh')]);
  });

  test('documents install/uninstall/status/logs subcommands', () => {
    for (const sub of ['install', 'uninstall', 'status', 'logs', 'restart', 'run']) {
      assert.match(ctl, new RegExp(`\\b${sub}\\b`));
    }
  });

  test('generates StartInterval and RunAtLoad without a KeepAlive plist key', () => {
    assert.match(ctl, /<key>StartInterval<\/key>/);
    assert.match(ctl, /<key>RunAtLoad<\/key><true\/>/);
    assert.doesNotMatch(ctl, /<key>KeepAlive<\/key>/);
  });

  test('uses absolute wrapper path and launchd-safe PATH/HOME', () => {
    assert.match(ctl, /WRAPPER="\$ROOT\/scripts\/health-repair-launchd\.sh"/);
    assert.match(ctl, /<key>PATH<\/key>/);
    assert.match(ctl, /<key>HOME<\/key>/);
    assert.match(ctl, /FLEET_ROOT/);
  });

  test('defaults interval to 60 seconds via FLEET_HEALTH_INTERVAL', () => {
    assert.match(ctl, /FLEET_HEALTH_INTERVAL:-60/);
  });

  test('labels under FLEET_LABEL_PREFIX and does not mention runner plists', () => {
    assert.match(ctl, /\.fleet-health/);
    assert.doesNotMatch(ctl, /actions\.runner\./);
  });
});

describe('health-repair-launchd.sh contract', () => {
  test('bash syntax is valid', () => {
    execFileSync('bash', ['-n', join(ROOT, 'scripts', 'health-repair-launchd.sh')]);
  });

  test('serialises runs and delegates repair to health.sh', () => {
    assert.match(wrapper, /LOCKDIR/);
    assert.match(wrapper, /skip — previous repair still running/);
    assert.match(wrapper, /health\.sh.*--repair/);
  });

  test('does not restart drained runners itself', () => {
    assert.doesNotMatch(wrapper, /svc\.sh start/);
    assert.doesNotMatch(wrapper, /--resume/);
  });
});
