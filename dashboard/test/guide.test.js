import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LADDER, AGENT_GUIDE, NOT_YOUR_CODE } from '../lib/verdict.js';
import { instructions, skillBlocks, rules, order } from '../lib/guide.js';
import { INSTRUCTIONS, TOOL_ROUTES } from '../lib/mcp.js';
import { render, SKILL } from '../scripts/make-skill.mjs';

describe('agent guide', () => {
  test('every rung of the ladder says what an agent should do, and nothing else does', () => {
    assert.deepEqual(Object.keys(AGENT_GUIDE).sort(), LADDER.map((l) => l.id).sort());
    for (const [id, g] of Object.entries(AGENT_GUIDE)) {
      assert.ok(g.meaning && g.do, id);
      assert.doesNotMatch(`${g.meaning} ${g.do}`, /\|/, `${id} would break the table`);
    }
  });

  test('the MCP instructions are the guide, and name only tools that exist', () => {
    assert.equal(INSTRUCTIONS, instructions());
    const steps = order('mcp').map((s) => /^`([a-z_]+)`/.exec(s)?.[1]);
    assert.deepEqual(steps, ['fleet_status', 'diagnose_repo', 'wait_for_checks']);
    for (const name of [...steps, 'run_action']) {
      assert.ok(TOOL_ROUTES.some((r) => r.id === name), name);
      assert.ok(INSTRUCTIONS.includes(`\`${name}\``), name);
    }
  });

  test('the rules cover the things an agent must never do, on both surfaces', () => {
    for (const surface of ['mcp', 'cli']) {
      const text = rules(surface).join('\n');
      assert.match(text, /gh pr checks --watch/);
      assert.match(text, /workPassed/);
      assert.match(text, /force-cancel/);
      for (const c of NOT_YOUR_CODE) assert.ok(text.includes(c), `${surface} names ${c}`);
    }
    assert.match(rules('cli').join('\n'), /--yes/);
    assert.match(rules('mcp').join('\n'), /confirm/);
  });
});

describe('skill', () => {
  test('its generated blocks are up to date (node scripts/make-skill.mjs)', () => {
    const current = readFileSync(SKILL, 'utf8');
    assert.equal(render(current, skillBlocks()), current);
  });

  test('a missing block is an error, not a silent skip', () => {
    assert.throws(() => render('no markers here', { verdicts: 'x' }), /generated:verdicts/);
  });

  test('replacing a block keeps the prose around it', () => {
    const out = render('a\n<!-- generated:rules -->\nold\n<!-- /generated:rules -->\nb', { rules: 'new' });
    assert.equal(out, 'a\n<!-- generated:rules -->\nnew\n<!-- /generated:rules -->\nb');
  });
});
