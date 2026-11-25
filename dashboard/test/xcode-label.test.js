// xcode-* runner labels against the Xcode each host gives its jobs
// (lib/xcode-label.js; the rule is scripts/xcode-label.sh).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchesLabel, isXcodeLabel, parseFacts, createXcodeFacts, xcodeLabelDrift,
} from '../lib/xcode-label.js';
import { computeVerdict } from '../lib/verdict.js';
import { SCENARIOS, LIVE_TS } from './fixtures/scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = readFileSync(join(HERE, '..', '..', 'scripts', 'xcode-label-cases.tsv'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));

describe('the rule, from the table the shell test reads', () => {
  test('the table is there', () => assert.ok(CASES.length >= 15, `${CASES.length} cases`));
  for (const [label, version, expect] of CASES) {
    test(`${label} against ${version}: ${expect}`, () => {
      assert.equal(matchesLabel(label, version === '-' ? null : version), expect);
      assert.equal(isXcodeLabel(label), expect !== 'ignored');
    });
  }
});

const FACTS = 'selected\t/Applications/Xcode.app/Contents/Developer\t27.2\n'
  + 'runner\tkit-old\t/Applications/Xcode-26.6.app/Contents/Developer\t26.6\n';

describe('parseFacts', () => {
  test('reads the selected Xcode and runners with their own DEVELOPER_DIR', () => {
    const f = parseFacts(FACTS, 5);
    assert.deepEqual(f, {
      checkedAt: 5,
      selected: { developerDir: '/Applications/Xcode.app/Contents/Developer', version: '27.2' },
      runners: { 'kit-old': { developerDir: '/Applications/Xcode-26.6.app/Contents/Developer', version: '26.6' } },
    });
  });
  test('xcodebuild missing is a fact: no version', () => {
    assert.equal(parseFacts('selected\t\t\n').selected.version, null);
  });
  test('output with no selected line is unknown, not "no Xcode"', () => {
    assert.equal(parseFacts(''), null);
  });
});

describe('createXcodeFacts', () => {
  test('runs once, then again only when a day has passed, never twice at once', async () => {
    let t = 0;
    let calls = 0;
    const sample = createXcodeFacts({
      root: '/fleet', script: '/x.sh', everyMs: 1000, now: () => t,
      run: async (script, args) => { calls += 1; assert.deepEqual(args, ['facts', '--root', '/fleet']); return FACTS; },
    });
    assert.equal((await sample()).selected.version, '27.2', 'the first call waits for the answer');
    t = 999;
    await sample();
    assert.equal(calls, 1, 'not again within the period');
    t = 1000;
    await sample();
    await sample();
    assert.equal(calls, 2, 'once more when due, not once per tick while it runs');
  });
  test('a failed run is unknown, and is retried a period later', async () => {
    let t = 0;
    let fail = true;
    const errors = [];
    const sample = createXcodeFacts({
      root: '/fleet', everyMs: 10, now: () => t, onError: (e) => errors.push(e.message),
      run: async () => { if (fail) throw new Error('no bash'); return FACTS; },
    });
    assert.equal(await sample(), null);
    assert.deepEqual(errors, ['no bash']);
    fail = false;
    t = 10;
    await sample(); // refresh in the background
    await new Promise((r) => setImmediate(r));
    assert.equal((await sample()).selected.version, '27.2');
  });
});

const host = (patch = {}) => ({
  name: 'ultra',
  labels: ['ci', 'ui-web', 'homelake'],
  xcode: parseFacts(FACTS),
  runners: [],
  ...patch,
});

describe('xcodeLabelDrift', () => {
  test("a host label that names an Xcode the host does not select (ultra's xcode-26, 11-19)", () => {
    const d = xcodeLabelDrift([host({ labels: ['ci', 'healer', 'xcode-26'] })]);
    assert.equal(d.length, 1);
    assert.equal(d[0].kind, 'xcode-label');
    assert.equal(d[0].host, 'ultra');
    assert.deepEqual(d[0].labels, ['xcode-26']);
    assert.match(d[0].subject, /ultra: host label xcode-26, Xcode 27\.2 is selected/);
    assert.match(d[0].hint, /xcode-27/);
  });
  test('runner labels: a true one is quiet, a stale one is drift', () => {
    const d = xcodeLabelDrift([host({
      runners: [
        { name: 'ultra-jerv-release', dirName: 'jerv-release', labels: ['self-hosted', 'macOS', 'apple-release', 'xcode-27'] },
        { name: 'ultra-kit', dirName: 'kit', labels: ['self-hosted', 'xcode-26.6'] },
        { name: 'ultra-ci', dirName: 'ci', labels: ['self-hosted', 'ci'] },
      ],
    })]);
    assert.deepEqual(d.map((x) => x.runner), ['ultra-kit']);
    assert.match(d[0].detail, /ultra-kit on ultra carries xcode-26\.6 but Xcode 27\.2 is selected/);
  });
  test("a runner's own DEVELOPER_DIR is the Xcode its label must name", () => {
    const d = xcodeLabelDrift([host({
      runners: [
        { name: 'ultra-kit-old', dirName: 'kit-old', labels: ['xcode-26.6'] },
        { name: 'ultra-kit-old-wrong', dirName: 'kit-old', labels: ['xcode-27'] },
      ],
    })]);
    assert.deepEqual(d.map((x) => x.runner), ['ultra-kit-old-wrong']);
    assert.match(d[0].detail, /DEVELOPER_DIR \(\/Applications\/Xcode-26\.6\.app\/Contents\/Developer\) is Xcode 26\.6/);
  });
  test('no Xcode on the host: every xcode label is drift, other labels are not', () => {
    const d = xcodeLabelDrift([host({
      xcode: parseFacts('selected\t\t\n'),
      labels: ['ci'],
      runners: [{ name: 'r1', dirName: 'r1', labels: ['ci', 'xcode-27'] }, { name: 'r2', dirName: 'r2', labels: ['ci'] }],
    })]);
    assert.deepEqual(d.map((x) => x.runner), ['r1']);
    assert.match(d[0].subject, /no Xcode answers/);
  });
  test('unknown facts abstain (an older agent, or the script failed)', () => {
    assert.deepEqual(xcodeLabelDrift([host({ xcode: null, labels: ['xcode-26'] })]), []);
  });
  test('no xcode labels anywhere: nothing', () => {
    assert.deepEqual(xcodeLabelDrift([host({ runners: [{ name: 'r', dirName: 'r', labels: ['ci', 'release'] }] })]), []);
  });
});

describe('the verdict', () => {
  test('an xcode-label finding opens config-drift with the host and label in its evidence', () => {
    const s = SCENARIOS.quiet();
    s.snapshot.drift = xcodeLabelDrift([host({ labels: ['ci', 'xcode-26'] })]);
    const r = computeVerdict(s.snapshot, s.facts, { now: LIVE_TS });
    assert.equal(r.verdict.id, 'config-drift');
    assert.ok(r.verdict.evidence.some((e) => /^xcode-label: ultra: host label xcode-26, Xcode 27\.2 is selected$/.test(e)),
      r.verdict.evidence.join(' | '));
  });
  test('it does not mark a runner misconfigured or dead: its jobs still run', () => {
    const s = SCENARIOS.quiet();
    const name = [...computeVerdict(s.snapshot, s.facts, { now: LIVE_TS }).runners.keys()][0];
    const before = computeVerdict(s.snapshot, s.facts, { now: LIVE_TS }).runners.get(name).state;
    s.snapshot.drift = xcodeLabelDrift([host({ runners: [{ name, dirName: name, labels: ['xcode-26'] }] })]);
    assert.equal(computeVerdict(s.snapshot, s.facts, { now: LIVE_TS }).runners.get(name).state, before);
  });
});
