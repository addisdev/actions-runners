// How a coding agent should use the fleet: the order to ask in, what each
// verdict means for it, and what never to do. One text, rendered for each way
// in: the MCP server's instructions (lib/mcp.js) and the generated blocks of
// the agent skill (scripts/make-skill.mjs), so the two cannot drift apart or
// from the ladder in lib/verdict.js.

import { LADDER, AGENT_GUIDE, NOT_YOUR_CODE } from './verdict.js';
import { ROUTES } from './api.js';

function route(id) {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`guide names route ${id}, which does not exist`);
  return r;
}

const tool = (id) => route(id).id;
const fleet = (id, rest = '') => `fleet ${route(id).cli.name}${rest}`;

// Each step's commands on each surface, first one preferred. The `fleet` names
// come from the route table, so renaming a command updates the skill.
const SURFACES = {
  mcp: {
    label: 'MCP tools',
    status: [tool('fleet_status')],
    why: [tool('diagnose_repo')],
    wait: [tool('wait_for_checks')],
    waitHow: ' with `wait: 300`, asked again while `pending`',
    run: [tool('run_action')],
    confirm: 'calling it again with the `confirm` token',
  },
  fleet: {
    label: '`fleet` (Node)',
    status: [fleet('fleet_status')],
    why: [fleet('diagnose_repo', ' owner/repo')],
    wait: ['fleet wait owner/repo --pr N'],
    run: [fleet('run_action', ' <action>')],
    confirm: '`--yes`',
  },
  cockpit: {
    label: '`cockpit` (macOS)',
    status: ['cockpit status'],
    why: ['cockpit why owner/repo'],
    wait: ['cockpit wait owner/repo --pr N'],
    run: ['cockpit run <action>'],
    confirm: '`--yes`',
  },
};

// The skill speaks to both command lines at once.
const CLI = {
  status: [...SURFACES.fleet.status, ...SURFACES.cockpit.status],
  why: [...SURFACES.fleet.why, ...SURFACES.cockpit.why],
  wait: [...SURFACES.fleet.wait, ...SURFACES.cockpit.wait],
  waitHow: '',
  run: [...SURFACES.fleet.run, ...SURFACES.cockpit.run],
  confirm: '`--yes`',
};

const code = (list) => list.map((c) => `\`${c}\``).join(' or ');
const steps = (surface) => (surface === 'mcp' ? SURFACES.mcp : CLI);

export function order(surface) {
  const s = steps(surface);
  return [
    `${code(s.status)}: the whole-fleet verdict. Read it before anything else.`,
    `${code(s.why)}: one repository's runners, queue with cause and ETA, recent failures, orphaned jobs and checks.`,
    `${code(s.wait)}${s.waitHow}: wait on a PR's checks until green, red, or pointless.`,
  ];
}

export function rules(surface) {
  const s = steps(surface);
  return [
    'Never watch checks with `gh pr checks --watch` or a `gh run view` loop: it waits forever on a check that will never start. '
      + `Use ${code(s.wait.slice(0, 1))}, which says when waiting is pointless and why.`,
    `Never change code or tests for a failure marked not your code (\`notYourCode\`: ${code(NOT_YOUR_CODE).replaceAll(' or ', ', ')}) `
      + 'or for an orphaned job whose work passed (`workPassed`). The host or the account caused it.',
    'Never cancel or force-cancel runs other than the PR you are waiting on, and never cancel fleet-wide: '
      + 'those runs are other sessions\' work. Recover only your own PR\'s orphan.',
    `Actions (${code(s.run)}) preview first. Show the user the preview, and confirm (${s.confirm}) only an action they asked for. `
      + 'If the token lacks the scope (`insufficient_scope`), report it; do not look for another token.',
    'A stale view (`freshness.stale`, "Collector stalled") is the dashboard\'s problem, not the PR\'s: say so.',
  ];
}

export function verdictTable() {
  const rows = LADDER.map((l) => `| \`${l.id}\` | ${AGENT_GUIDE[l.id].meaning} | ${AGENT_GUIDE[l.id].do} |`);
  return ['| Verdict | Meaning | Do |', '|---|---|---|', ...rows].join('\n');
}

export function surfaceTable() {
  const rows = Object.values(SURFACES).map((s) => `| ${s.label} | ${code(s.status)} | ${code(s.why)} | ${code(s.wait)} | ${code(s.run)} |`);
  return ['| Way in | Fleet verdict | One repository | Wait on a PR | Run an action |', '|---|---|---|---|---|', ...rows].join('\n');
}

const bullets = (items) => items.map((s) => `- ${s}`).join('\n');
const numbered = (items) => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

export function instructions() {
  return `Tools for a self-hosted GitHub Actions runner fleet. Ask the fleet before blaming a workflow, a test or the code.

Order:
${numbered(order('mcp'))}

Rules:
${bullets(rules('mcp'))}

What to do for each verdict:
${LADDER.map((l) => `- ${l.id}: ${AGENT_GUIDE[l.id].do}`).join('\n')}`;
}

// The skill's generated blocks, by marker name.
export function skillBlocks() {
  return {
    surfaces: surfaceTable(),
    order: numbered(order('cli')),
    verdicts: verdictTable(),
    rules: bullets(rules('cli')),
  };
}
