import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBundle, redact, ALLOWLIST } from '../lib/bundle.js';
import { runnerVersions, diagSummary } from '../lib/local.js';
import { makeRunner, makeHost } from './fixtures/index.js';

// A fake runner directory containing exactly the things a real one contains,
// including the two files that must never be read.
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-bundle-'));

  writeFileSync(join(dir, '.runner'),
    '{"agentName":"host-app-ios","gitHubUrl":"https://github.com/testowner/app-ios"}');
  writeFileSync(join(dir, '.env'),
    'PATH=/opt/homebrew/bin:/usr/bin\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345\n');
  writeFileSync(join(dir, '.path'), '/opt/homebrew/bin:/usr/bin');

  // The things that must not appear in a bundle, whatever else changes.
  writeFileSync(join(dir, '.credentials'),
    '{"scheme":"OAuth","data":{"clientId":"abc","authorizationUrl":"https://example.invalid"}}');
  writeFileSync(join(dir, '.credentials_rsaparams'),
    '{"d":"SUPERSECRETPRIVATEKEYMATERIALTHATMUSTNEVERLEAKANYWHEREATALL","p":"alsosecret"}');

  mkdirSync(join(dir, '_work', 'app-ios', 'app-ios'), { recursive: true });
  writeFileSync(join(dir, '_work', 'app-ios', 'app-ios', 'secrets.txt'),
    'API_KEY=PRIVATEREPOCONTENTTHATMUSTNOTBEBUNDLED');

  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'runner.version'), '2.336.0\n');
  mkdirSync(join(dir, 'bin.2.340.0'), { recursive: true });

  mkdirSync(join(dir, '_diag'), { recursive: true });
  writeFileSync(join(dir, '_diag', 'Runner_20260904-120000-utc.log'), [
    '[2026-09-04 12:00:00Z INFO  Listener] Listening for Jobs',
    '[2026-09-04 12:01:00Z WARN  Listener] Retrying connection',
    '[2026-09-04 12:02:00Z ERR   Listener] Failed to reach GitHub',
    '[2026-09-04 12:03:00Z INFO  Worker] Job completed, error count was 3 in the build output',
  ].join('\n'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

const bundleFor = (overrides = {}) => buildBundle({
  runner: makeRunner({ dir, ...overrides }),
  host: makeHost(),
});

describe('the allowlist itself', () => {
  test('does not name the credential files', () => {
    assert.ok(!ALLOWLIST.has('.credentials'));
    assert.ok(!ALLOWLIST.has('.credentials_rsaparams'));
  });

  test('does not name _work', () => {
    assert.ok(!ALLOWLIST.has('_work'));
  });
});

describe('a built bundle', () => {
  test('never contains private key material', () => {
    const { text } = bundleFor();
    assert.ok(!text.includes('SUPERSECRETPRIVATEKEYMATERIAL'),
      'private key material from .credentials_rsaparams reached the bundle');
  });

  test('never contains repository content from _work', () => {
    const { text } = bundleFor();
    assert.ok(!text.includes('PRIVATEREPOCONTENTTHATMUSTNOTBEBUNDLED'),
      '_work content reached the bundle');
  });

  test('redacts a token that was sitting in an allowlisted file', () => {
    // .env IS allowlisted, and somebody put a token in it. This is the case the
    // redactor exists for.
    const { text, included } = bundleFor();
    assert.ok(included.includes('.env'), 'expected .env to be included');
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'),
      'a GitHub token in .env survived redaction');
    // The useful part of the same file must survive.
    assert.ok(text.includes('/opt/homebrew/bin'), 'PATH was lost to redaction');
  });

  test('includes the allowlisted files', () => {
    const { included } = bundleFor();
    for (const f of ['.runner', '.env', '.path']) {
      assert.ok(included.includes(f), `${f} should be included`);
    }
  });

  test('names what it excluded, so the reader can see the filter ran', () => {
    const { excluded } = bundleFor();
    const joined = excluded.join(' ');
    assert.match(joined, /\.credentials/);
    assert.match(joined, /_work/);
  });

  test('reports runner and host state', () => {
    const { text } = bundleFor();
    assert.match(text, /host-app-ios/);
    assert.match(text, /testowner\/app-ios/);
    assert.match(text, /test-host/);
  });

  test('has a filename safe to save', () => {
    const { filename } = bundleFor();
    assert.match(filename, /^bundle-[\w.-]+\.txt$/);
    assert.ok(!filename.includes(':'));
  });

  test('survives a runner directory that does not exist', () => {
    const { text, included } = buildBundle({
      runner: makeRunner({ dir: '/nonexistent/path/xyz' }),
      host: makeHost(),
    });
    assert.deepEqual(included, []);
    assert.match(text, /DIAGNOSTIC BUNDLE/);
  });

  test('includes recent events and jobs when given them', () => {
    const { text } = buildBundle({
      runner: makeRunner({ dir }),
      host: makeHost(),
      events: [{ ts: Date.now(), kind: 'drain', detail: 'none -> drained' }],
      jobs: [{ name: 'build', status: 'completed', conclusion: 'success',
               started_at: new Date().toISOString(), duration_ms: 60000 }],
    });
    assert.match(text, /none -> drained/);
    assert.match(text, /build/);
  });
});

describe('redact', () => {
  test('handles the GitHub token formats', () => {
    assert.ok(!redact('ghp_abcdefghijklmnopqrstuvwxyz012345').includes('ghp_abcdef'));
    assert.ok(!redact('ghs_abcdefghijklmnopqrstuvwxyz012345').includes('ghs_abcdef'));
    assert.ok(!redact('github_pat_11ABCDEFG0abcdefghijkl_XYZ').includes('github_pat_11ABCDEFG'));
  });

  test('redacts by key name, whatever the value looks like', () => {
    for (const key of ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'MY_AUTH']) {
      const out = redact(`${key}=hunter2`);
      assert.ok(!out.includes('hunter2'), `${key}=... was not redacted`);
    }
  });

  test('redacts credential-ish JSON values', () => {
    const out = redact('{"clientSecret": "abc123def456", "name": "keep-me"}');
    assert.ok(!out.includes('abc123def456'));
    assert.ok(out.includes('keep-me'), 'a harmless value was redacted');
  });

  test('collapses a PEM private key', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef\n-----END RSA PRIVATE KEY-----';
    const out = redact(pem);
    assert.ok(!out.includes('MIIabc'));
    assert.match(out, /<redacted-private-key>/);
  });

  test('redacts Bearer headers', () => {
    assert.ok(!redact('Authorization: Bearer abcdefghijklmnopqrst').includes('abcdefghijklmnopqrst'));
  });

  test('leaves ordinary text alone', () => {
    const plain = 'launchd state: running\nload: 1.42\npath: /opt/homebrew/bin';
    assert.equal(redact(plain), plain);
  });

  test('handles null and undefined without throwing', () => {
    assert.equal(redact(null), '');
    assert.equal(redact(undefined), '');
  });
});

describe('runnerVersions', () => {
  test('reads the active version from the runner\'s own file', () => {
    assert.equal(runnerVersions(dir).active, '2.336.0');
  });

  test('finds a staged side-by-side update', () => {
    const v = runnerVersions(dir);
    assert.ok(v.sideBySide.includes('2.340.0'));
    // Newer than active, so it is staged and takes effect on restart.
    assert.equal(v.stagedUpdate, '2.340.0');
  });

  test('reports no staged update when the side-by-side copy is older', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-ver-'));
    mkdirSync(join(d, 'bin'), { recursive: true });
    writeFileSync(join(d, 'bin', 'runner.version'), '2.340.0\n');
    mkdirSync(join(d, 'bin.2.336.0'), { recursive: true });
    assert.equal(runnerVersions(d).stagedUpdate, null);
    rmSync(d, { recursive: true, force: true });
  });

  test('falls back to the newest bin.N directory when no version file exists', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-ver-'));
    mkdirSync(join(d, 'bin.2.330.0'), { recursive: true });
    mkdirSync(join(d, 'bin.2.341.0'), { recursive: true });
    assert.equal(runnerVersions(d).active, '2.341.0');
    rmSync(d, { recursive: true, force: true });
  });

  test('returns null rather than guessing when there is nothing to read', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-ver-'));
    assert.equal(runnerVersions(d).active, null);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('diagSummary', () => {
  test('counts errors and warnings from the log level, not the word', () => {
    const s = diagSummary(dir);
    assert.equal(s.errors, 1);
    assert.equal(s.warnings, 1);
    // The INFO line mentioning "error count" in a build's own output must not
    // be counted as a runner error.
    assert.match(s.lastError, /Failed to reach GitHub/);
  });

  test('returns null when there is no _diag directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-diag-'));
    assert.equal(diagSummary(d), null);
    rmSync(d, { recursive: true, force: true });
  });
});
