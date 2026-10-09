#!/usr/bin/env node
// Print which runners this host should register to share the coordinator's
// repos. The logic is lib/mirror.js; this reads the inputs and prints one line
// per runner, tab-separated, for scripts/mirror-runners.sh to act on:
//
//   register <owner/repo> <instance> <labels,comma,separated|-> <source runner>
//   present  <owner/repo> <instance> <labels|->                  <source runner>
//   skip     <owner/repo> -          <labels|->                  <reason>
//
//   node dashboard/scripts/mirror-plan.mjs --coordinator http://host:7878 \
//     [--root ~/actions-runners] [--only repo,repo]
//
// Host facts come from fleet.env through the environment: FLEET_HOST_LABELS,
// FLEET_SIMULATOR_RUNNERS, FLEET_MIRROR_SKIP_REPOS. Xcode is detected, not
// configured, because a host that says it has Xcode and does not fails builds.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planMirror } from '../lib/mirror.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (s) => String(s ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

const coordinator = (arg('coordinator') ?? process.env.FLEET_COORDINATOR ?? '').replace(/\/$/, '');
if (!coordinator) {
  console.error('mirror-plan: --coordinator (or FLEET_COORDINATOR) is required');
  process.exit(2);
}
const root = arg('root', process.env.FLEET_ROOT ?? process.cwd());

let hasXcode = false;
try {
  execFileSync('xcodebuild', ['-version'], { stdio: 'ignore', timeout: 20000 });
  hasXcode = true;
} catch { /* command line tools only, or none */ }

const res = await fetch(`${coordinator}/api/state`);
if (!res.ok) {
  console.error(`mirror-plan: ${coordinator}/api/state answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const state = await res.json();

const existing = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, '.runner')))
    .map((d) => d.name)
  : [];

const plan = planMirror({
  // The coordinator's own runners only: `elsewhere` are runners GitHub knows and
  // no reporting host claims, and copying those would copy the Mini's release
  // runners, which exist for the signing identities only the Mini holds.
  runners: state.runners ?? [],
  hostLabels: list(process.env.FLEET_HOST_LABELS),
  hasXcode,
  simulatorPatterns: list(process.env.FLEET_SIMULATOR_RUNNERS),
  skipRepos: list(process.env.FLEET_MIRROR_SKIP_REPOS),
  onlyRepos: list(arg('only')),
  existing,
});

const labels = (l) => (l.length ? l.join(',') : '-');
for (const r of plan.register) console.log(['register', r.repo, r.instance, labels(r.labels), r.source].join('\t'));
for (const r of plan.present) console.log(['present', r.repo, r.instance, labels(r.labels), r.source].join('\t'));
for (const r of plan.skipped) console.log(['skip', r.repo, '-', labels(r.labels), r.reason].join('\t'));
console.error(`mirror-plan: ${plan.register.length} to register, ${plan.present.length} present, `
  + `${plan.skipped.length} skipped (xcode: ${hasXcode ? 'yes' : 'no'})`);
