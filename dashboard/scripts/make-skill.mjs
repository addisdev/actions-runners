#!/usr/bin/env node
// Fills the generated blocks of the agent skill from lib/guide.js: the table
// of ways in, the order to ask in, the verdict table and the rules. The MCP
// server's instructions come from the same functions, so an agent hears the
// same thing whichever way it connects.
//
//   node scripts/make-skill.mjs            # write
//   node scripts/make-skill.mjs --check    # exit 1 if the skill is out of date
//
// A block is everything between <!-- generated:NAME --> and
// <!-- /generated:NAME -->; the prose around the blocks is edited by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillBlocks } from '../lib/guide.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL = join(HERE, '..', '..', 'cockpit', 'skills', 'fleet-cockpit', 'SKILL.md');

export function render(text, blocks) {
  let out = text;
  for (const [name, body] of Object.entries(blocks)) {
    const open = `<!-- generated:${name} -->`;
    const close = `<!-- /generated:${name} -->`;
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start < 0 || end < start) throw new Error(`${SKILL} has no ${open} … ${close} block`);
    out = `${out.slice(0, start + open.length)}\n${body}\n${out.slice(end)}`;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = readFileSync(SKILL, 'utf8');
  const next = render(current, skillBlocks());
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('cockpit/skills/fleet-cockpit/SKILL.md is out of date: run node dashboard/scripts/make-skill.mjs');
      process.exit(1);
    }
    console.log('skill is up to date');
  } else if (next !== current) {
    writeFileSync(SKILL, next);
    console.log(`wrote ${SKILL}`);
  } else {
    console.log('skill is up to date');
  }
}
