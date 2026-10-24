#!/usr/bin/env node
// Writes one /api/glance payload per scenario in test/fixtures/scenarios.js
// into the cockpit's bundled fixtures, so the Swift decoder and presenter are
// tested against exactly what this daemon produces for each recorded incident.
//
//   node scripts/make-glance-fixtures.mjs            # write
//   node scripts/make-glance-fixtures.mjs --check    # exit 1 if any is out of date
//
// CI runs --check: a change to verdict.js that alters the contract without
// regenerating the fixtures fails here rather than in the menu bar.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVerdict, buildGlance } from '../lib/verdict.js';
import { SCENARIOS } from '../test/fixtures/scenarios.js';
import { handleApi } from '../lib/api.js';
import { waitForChecks } from '../lib/checks.js';
import { classifyJob } from '../lib/orphans.js';
import { ACTION_ARGS } from '../lib/actions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'cockpit', 'Sources', 'CockpitCore', 'Fixtures');
const check = process.argv.includes('--check');

mkdirSync(OUT, { recursive: true });
let stale = 0;
for (const [name, make] of Object.entries(SCENARIOS)) {
  const s = make();
  const floorGb = s.floorGb ?? 40;
  const result = computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb });
  const glance = buildGlance(s.snapshot, result, {
    now: s.now, staleMs: 240000, floorGb, localHostId: 'build-host', failures: s.facts.recentFailures ?? [], posture: s.posture,
  });
  const text = JSON.stringify(glance, null, 1) + '\n';
  const path = join(OUT, `${name}.json`);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      console.error(`out of date: ${path}`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`${name.padEnd(14)} ${glance.verdict.id.padEnd(16)} ${text.length} bytes`);
  }
}
// /api/v1 responses, made by handleApi itself, for the cockpit's v1 decoders.
// The waiting scenario has a pending commit and a green one; a red one and an
// orphan are derived from it, the orphan being lake-api PR #73's real job.
const V1 = join(OUT, 'v1');
mkdirSync(V1, { recursive: true });
const s = SCENARIOS.waiting();
const floorGb = s.floorGb ?? 40;
const g = buildGlance(s.snapshot, computeVerdict(s.snapshot, s.facts, { now: s.now, floorGb }), {
  now: s.now, staleMs: 240000, floorGb, localHostId: 'build-host', failures: s.facts.recentFailures ?? [], posture: s.posture,
});
const repo = 'acme/comet-web';
const pendingRun = g.runs.find((r) => r.repo === repo && r.sha === '8c10c20');
const red = structuredClone(g);
for (const r of red.recent) if (r.repo === repo && r.sha === 'ec99782') r.conclusion = 'failure';
const recorded = JSON.parse(readFileSync(join(OUT, 'orphaned-jobs.json'), 'utf8')).docsBuild1;
const orphan = classifyJob({ ...recorded, run_id: pendingRun.id }, {
  repo, runner: { name: recorded.runner_name, state: 'draining' }, now: Date.parse(recorded.steps.at(-1).started_at) + 600_000,
});
const drain = { id: 'runner.drain', label: 'Drain runner', danger: 'medium', confirm: 'Stops the runner after its current job.', scope: 'act', args: ACTION_ARGS['runner.drain'] };
// GitHub's answer for a commit, made from the view's own rows: each run with
// one job, as long ago as the view says it finished.
const githubFor = (view) => async (target) => {
  const rows = [...view.runs, ...view.recent].filter((r) => r.repo === target.repo && r.sha === target.sha);
  if (!rows.length) return null;
  return {
    head: `${target.sha}${'0'.repeat(40 - target.sha.length)}`,
    fetchedAt: s.now,
    checks: [],
    runs: rows.map((r) => ({
      id: r.id, workflowId: r.workflow, workflow: r.workflow, event: r.event, status: r.status, conclusion: r.conclusion ?? null,
      createdAt: r.startedAt, updatedAt: r.updatedAt, url: r.url,
      jobs: r.status !== 'completed' ? null
        : [{ name: r.workflow, status: 'completed', conclusion: r.conclusion, url: r.url, completedAt: r.updatedAt }],
    })),
  };
};
const ctx = (view, orphans = []) => ({
  glance: () => view,
  orphans: () => orphans,
  waitForChecks: (target, opts) => waitForChecks(target, {
    glance: () => view, orphans: () => orphans, prChecks: githubFor(view), run: async () => null,
  }, { ...opts, now: () => s.now }),
  readOnly: () => false,
  actionInfo: (id) => (id === drain.id ? drain : null),
  previewAction: async (id, a) => `./scripts/drain-runner.sh ${a.name} --drain`,
  confirmations: { issue: () => ({ token: 'fixture-confirm', expiresAt: s.now + 300_000 }), consume: () => null },
  runAction: async () => ({ ok: true, code: 0, command: './scripts/drain-runner.sh build-host-comet-web-1 --drain', output: 'drain flag set', durationMs: 412 }),
});
const master = { id: 'master', name: 'master token', kind: 'master', scopes: ['read', 'act', 'act:danger'] };
const call = async (c, method, path, body = null) =>
  (await handleApi({ method, url: new URL(path, 'http://localhost'), principal: master, body: body ? JSON.stringify(body) : '' }, c)).body;
const checksAt = (sha) => `/api/v1/repos/${repo}/checks?sha=${sha}`;
const V1_FIXTURES = {
  diagnosis: await call(ctx(g, [orphan]), 'GET', `/api/v1/repos/${repo}/diagnosis`),
  'checks-green': await call(ctx(g), 'GET', checksAt('ec99782')),
  'checks-pending': await call(ctx(g), 'GET', checksAt('8c10c20')),
  'checks-red': await call(ctx(red), 'GET', checksAt('ec99782')),
  'checks-orphaned': await call(ctx(g, [orphan]), 'GET', checksAt('8c10c20')),
  'action-preview': await call(ctx(g), 'POST', '/api/v1/actions/runner.drain', { args: { name: 'build-host-comet-web-1' } }),
  'action-done': await call(ctx(g), 'POST', '/api/v1/actions/runner.drain', { args: { name: 'build-host-comet-web-1' }, confirm: 'fixture-confirm' }),
  'error-unknown-repo': await call(ctx(g), 'GET', '/api/v1/repos/someone/else/diagnosis'),
};
for (const [name, body] of Object.entries(V1_FIXTURES)) {
  const text = JSON.stringify(body, null, 1) + '\n';
  const path = join(V1, `${name}.json`);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      console.error(`out of date: ${path}`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`v1/${name.padEnd(20)} ${body.state ?? body.status ?? body.error?.code ?? ''} ${text.length} bytes`);
  }
}

if (check && stale) {
  console.error('run: node dashboard/scripts/make-glance-fixtures.mjs');
  process.exit(1);
}
