#!/usr/bin/env node
// Turn a live /api/state snapshot into a fixture that is safe to commit.
//
//   node scripts/scrub-snapshot.mjs live.json test/fixtures/snapshots/x.json --map ~/scrub-map.json
//
// The map is a JSON object of { "real": "replacement" } pairs, applied longest
// first to every string in the snapshot. It deliberately lives OUTSIDE the repo:
// a scrub list committed next to the fixtures would publish exactly the names it
// exists to hide. Free text a person wrote — commit messages, run titles, actor
// names, alert bodies quoting paths — is replaced wholesale rather than mapped,
// because no list can anticipate what is in it.
//
// After scrubbing, the fixture is checked for the shapes that leak regardless of
// the map: home directories other than /Users/ci, GitHub URLs for any owner but
// the replacement one, and e-mail addresses. A failure prints the offending
// strings and writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';

const [,, input, output, ...rest] = process.argv;
const mapPath = rest[rest.indexOf('--map') + 1];
if (!input || !output || !mapPath || rest.indexOf('--map') < 0) {
  console.error('usage: scrub-snapshot.mjs <in.json> <out.json> --map <map.json>');
  process.exit(2);
}

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
const owner = map.__owner ?? 'acme';
delete map.__owner;

const FREE_TEXT = new Set(['headCommitMsg', 'displayTitle', 'actor', 'body', 'output', 'command']);

function scrubString(s) {
  let out = s;
  for (const [real, fake] of pairs) {
    if (real.startsWith('__')) continue;
    out = out.split(real).join(fake);
  }
  return out;
}

function walk(v, key) {
  if (typeof v === 'string') return FREE_TEXT.has(key) ? `(${key} removed)` : scrubString(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
    return o;
  }
  return v;
}

const scrubbed = walk(JSON.parse(readFileSync(input, 'utf8')));
const text = JSON.stringify(scrubbed, null, 1);

const leaks = [
  ...text.matchAll(/\/Users\/(?!ci\b)[^/"\s]+/g),
  ...text.matchAll(new RegExp(`github\\.com/(?!${owner}\\b)[A-Za-z0-9-]+/`, 'g')),
  ...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g),
].map((m) => m[0]);
if (leaks.length) {
  console.error('refusing to write — still identifying:\n  ' + [...new Set(leaks)].join('\n  '));
  process.exit(1);
}
writeFileSync(output, text + '\n');
console.log(`wrote ${output} (${text.length} bytes)`);
