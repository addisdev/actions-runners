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
if (check && stale) {
  console.error('run: node dashboard/scripts/make-glance-fixtures.mjs');
  process.exit(1);
}
