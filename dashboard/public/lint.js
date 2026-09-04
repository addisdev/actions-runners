// The lint view: static analysis over every workflow file in every repo.

import { chartEl as h } from './charts.js';

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

let data = null;
let loading = false;
let advice = null;

const RULES = {
  'no-timeout': 'Missing timeout-minutes',
  'unmatched-label': 'No runner matches runs-on',
  unserved: 'No runner for the repo',
  'no-cancel-in-progress': 'PR runs are not superseded',
  'hosted-macos': 'GitHub-hosted macOS (10x)',
  unparsed: 'Not fully readable',
  'lint-error': 'Linter bug',
};

// Which branches a finding is on.
//
// Silent when it applies to every branch checked — that is the ordinary case and
// naming the branches would just be noise on every row. The line only appears
// when a finding is on some branches and not others, because that is a different
// problem with a different fix: the file is already correct somewhere, and the
// branch is what is behind. Reading only the default branch cannot see this at
// all, which is how a fix that already existed on main stayed reported for weeks.
function refNote(f) {
  const on = f.refs ?? [];
  const checked = f.refsChecked ?? [];
  if (!on.length || checked.length < 2) return null;
  if (on.length === checked.length) {
    return h('span', { class: 'drift-hint', text: `on all ${checked.length} branches checked` });
  }
  const clean = checked.filter((r) => !on.includes(r));
  return h('span', { class: 'drift-hint ref-note' },
    `on ${on.join(', ')} — but not on ${clean.join(', ')}, `
    + 'so the file is already right there and this branch is behind.');
}

export async function loadLint() {
  loading = true;
  render();
  // Fetched together but settled independently: the advisor is the newer and
  // more speculative of the two, and a failure in it must not blank a lint
  // report that was perfectly good.
  const [lintRes, adviceRes] = await Promise.allSettled([
    fetch('/api/lint').then((r) => r.json()),
    fetch('/api/concurrency').then((r) => r.json()),
  ]);
  data = lintRes.status === 'fulfilled' ? lintRes.value : { error: lintRes.reason?.message ?? 'lint failed' };
  advice = adviceRes.status === 'fulfilled' ? adviceRes.value : null;
  loading = false;
  render();
}

// Recommended YAML for each advisor rule. Shown rather than applied: this
// dashboard has no write access to a repository, and the right fix for a
// declared parallelism problem is sometimes to add runners rather than to cap
// the matrix — a decision the operator makes, not the advisor.
const SNIPPETS = {
  'matrix-exceeds-runners': 'strategy:\n  max-parallel: 2   # ≤ the repo\'s runner count\n  matrix:\n    ...',
  'matrix-unbounded': 'strategy:\n  max-parallel: 2   # cap it, since the size is not knowable statically\n  matrix:\n    ...',
  'concurrency-collision': 'concurrency:\n  group: ${{ github.workflow }}-${{ github.job }}-${{ github.ref }}',
  'cross-file-concurrency-collision': 'concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}',
  'parallelism-exceeds-cap': '# Either cap the workflow:\nstrategy:\n  max-parallel: 2\n# or raise the cap in the Capacity tab, if the host can take it.',
};

function advisorPanel() {
  const findings = advice?.findings ?? [];
  if (advice?.error) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Concurrency advisor' })),
      h('div', { class: 'empty', text: `Advisor failed: ${advice.error}` }));
  }

  const actionable = findings.filter((f) => f.severity !== 'info');
  const notes = findings.filter((f) => f.severity === 'info');

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Concurrency advisor' }),
      h('span', { class: 'count', text: actionable.length ? `${actionable.length} to consider` : 'nothing to flag' })
    ),
    h('div', { class: 'panel-sub' },
      'Findings that need more than one file to see: a matrix bigger than the repo has runners for, ' +
      'a concurrency group two workflows share, declared parallelism above the host ceiling. ' +
      'Nothing here is applied automatically — the snippets are suggestions to copy.'),
    actionable.length
      ? h('div', { class: 'drift-list' },
          actionable.map((f) =>
            h('div', { class: `drift-item ${f.severity}` },
              h('span', { class: 'drift-sev', text: f.severity }),
              h('span', { class: 'drift-subject', text: `${f.repo.split('/').pop()} · ${String(f.path).split('/').pop()}` }),
              h('span', { class: 'drift-detail' },
                f.job ? `${f.job}: ${f.message}` : f.message,
                f.hint ? h('span', { class: 'drift-hint', text: f.hint }) : null,
                f.confidence && f.confidence !== 'high'
                  ? h('span', { class: 'drift-hint', text: `${f.confidence} confidence` })
                  : null,
                SNIPPETS[f.rule] ? h('pre', { class: 'snippet', text: SNIPPETS[f.rule] }) : null
              )
            )
          )
        )
      : h('div', { class: 'all-clear' }, h('b', { text: '✓' }),
          ' No cross-file concurrency problems. Every matrix fits its runners and no two workflows ' +
          'share a static concurrency group.'),
    notes.length
      ? h('table', { class: 'mini-table' },
          h('tbody', {}, notes.map((f) =>
            h('tr', {},
              h('td', { class: 'mono', text: `${f.repo.split('/').pop()} · ${String(f.path).split('/').pop()}` }),
              h('td', { text: f.message })
            )
          ))
        )
      : null
  );
}

export function render() {
  const root = document.querySelector('#view-lint');
  if (!root) return;

  const head = h('div', { class: 'section-head' },
    h('h2', { text: 'Workflow lint' }),
    h('span', { class: 'count', text: data?.files
      ? `${data.files} files across ${data.repos} repos`
        + (data.checks && data.checks !== data.files ? `, ${data.checks} file/branch pairs` : '')
      : '' })
  );

  if (loading && !data) return mount(root, head, h('div', { class: 'empty', text: 'Loading…' }));
  if (!data) return mount(root, head, h('div', { class: 'empty', text: 'Not loaded.' }));
  if (data.error) return mount(root, head, h('div', { class: 'empty', text: `Lint failed: ${data.error}` }));

  const findings = data.findings ?? [];
  const actionable = findings.filter((f) => f.severity !== 'info');

  const bySeverity = { critical: 0, serious: 0, warning: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  const explain = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: 'What this checks' })),
    h('div', { class: 'panel-sub' },
      'Every rule here corresponds to something that actually went wrong on this fleet, not to a ' +
      'style preference. The YAML is parsed properly rather than grepped — a shell script inside ' +
      'a run: | block can contain anything, including lines that look like job definitions.'),
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Rule' }), h('th', { text: 'Why it matters' }), h('th', { class: 'num', text: 'Found' })
      )),
      h('tbody', {},
        [
          ['unmatched-label', 'The job queues until something cancels it. This is what the abandoned `ollama` label did for months.'],
          ['unserved', 'The repo has self-hosted jobs and no runner registered anywhere.'],
          ['no-timeout', "A hung job holds its runner forever. GitHub's 6-hour default never applied to self-hosted."],
          ['hosted-macos', 'Bills at 10x against the included allowance — exhausting it once blocked Actions account-wide.'],
          ['no-cancel-in-progress', 'Every push to a PR starts another run while the last one is still going, and they queue.'],
          ['unparsed', 'The parser would not guess. Nothing was checked for that file or job.'],
        ].map(([rule, why]) =>
          h('tr', {},
            h('td', { class: 'mono', text: rule }),
            h('td', { text: why }),
            h('td', { class: `num ${findings.filter((f) => f.rule === rule).length ? '' : ''}`,
              text: String(findings.filter((f) => f.rule === rule).length) })
          )
        )
      )
    )
  );

  const list = actionable.length
    ? h('div', { class: 'drift-list' },
        actionable.map((f) =>
          h('div', { class: `drift-item ${f.severity}` },
            h('span', { class: 'drift-sev', text: f.severity }),
            h('span', { class: 'drift-subject', text: `${f.repo.split('/').pop()} · ${f.path.split('/').pop()}` }),
            h('span', { class: 'drift-detail' },
              f.job ? `${f.job}: ${f.message}` : f.message,
              h('span', { class: 'drift-hint', text: f.hint ?? '' }),
              refNote(f)
            )
          )
        )
      )
    : h('div', { class: 'all-clear' }, h('b', { text: '✓' }),
        ` Nothing to fix across ${data.files} workflow files. Every self-hosted job has a timeout, ` +
        'every runs-on matches a live runner, and every PR workflow supersedes its own runs.');

  const info = findings.filter((f) => f.severity === 'info');
  const infoPanel = info.length
    ? h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', { text: 'Skipped' })),
        h('div', { class: 'panel-sub', text: 'Files or jobs the parser would not guess about. Nothing was checked for these.' }),
        h('table', { class: 'mini-table' },
          h('tbody', {}, info.map((f) =>
            h('tr', {},
              h('td', { class: 'mono', text: `${f.repo.split('/').pop()} · ${f.path.split('/').pop()}` }),
              h('td', { text: f.job ? `${f.job}: ${f.message}` : f.message })
            )
          ))
        )
      )
    : null;

  mount(root, head,
    h('section', { class: 'kpis' },
      ['critical', 'serious', 'warning', 'info'].map((sev) =>
        h('div', { class: 'kpi' },
          h('div', { class: 'kpi-label', text: sev }),
          h('div', { class: `kpi-value ${bySeverity[sev] ? sev : 'good'}`, text: String(bySeverity[sev] ?? 0) }),
          h('div', { class: 'kpi-sub', text: sev === 'info' ? 'skipped, not checked' : 'findings' })
        )
      )
    ),
    list,
    advisorPanel(),
    infoPanel,
    explain
  );
}
