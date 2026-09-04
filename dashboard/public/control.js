// The control tab.
//
// The token lives in localStorage and is pasted in once — the daemon never
// serves it to the page. So a browser that can see the dashboard cannot act on
// it until someone deliberately unlocks this tab.

import { chartEl as h } from './charts.js';

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

const TOKEN_KEY = 'fleet-control-token';
let catalogue = null;
let settingsData = null;
let autoscaleData = null;
let lastResult = null;
let busy = null;
let getSnapshot = () => ({ runners: [], repos: [] });

export function setSnapshotSource(fn) { getSnapshot = fn; }

export const hasToken = () => Boolean(localStorage.getItem(TOKEN_KEY));

// For the token-gated GET endpoints — currently the diagnostic bundle — which
// are fetched rather than linked, because an <a href> cannot carry a header.
export const authHeaders = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
};

export async function act(action, args = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return { ok: false, error: 'no control token set — open the Control tab and unlock' };
  busy = action;
  render();
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, args }),
    });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    lastResult = { action, args, status: res.status, ...body, at: Date.now() };
    return lastResult;
  } catch (err) {
    lastResult = { action, args, ok: false, error: err.message, at: Date.now() };
    return lastResult;
  } finally {
    busy = null;
    await loadCatalogue();
    render();
  }
}

// Confirmation is the UI's job, not the daemon's — but the daemon still refuses
// anything it considers unsafe regardless of what the UI sent.
export async function confirmAct(action, args = {}) {
  const def = catalogue?.actions?.find((a) => a.id === action);
  if (def?.confirm && !window.confirm(`${def.label}\n\n${def.confirm}\n\nProceed?`)) return null;
  return act(action, args);
}

export async function loadCatalogue() {
  try {
    catalogue = await (await fetch('/api/actions')).json();
  } catch {
    catalogue = null;
  }
  try {
    settingsData = await (await fetch('/api/settings')).json();
  } catch {
    settingsData = null;
  }
  try {
    autoscaleData = await (await fetch('/api/autoscale')).json();
  } catch {
    autoscaleData = null;
  }
}

function tokenPanel() {
  const set = hasToken();
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: set ? 'Control unlocked' : 'Locked' })),
    h('div', { class: 'panel-sub' },
      set
        ? 'This browser holds the control token. Actions below will run on the runner host.'
        : 'Actions need the control token. Run ./fleetctl.sh token on the runner host and paste it here — ' +
          'it is stored in this browser only, and the daemon never sends it to the page.'
    ),
    h('div', { class: 'row-actions' },
      set
        ? h('button', { class: 'btn', text: 'Forget token', onclick: () => { localStorage.removeItem(TOKEN_KEY); render(); } })
        : h('button', {
            class: 'btn primary', text: 'Enter token',
            onclick: () => {
              const t = window.prompt('Paste the control token (./fleetctl.sh token)');
              if (t && t.trim()) localStorage.setItem(TOKEN_KEY, t.trim());
              render();
            },
          })
    )
  );
}

function actionButton(id, { variant = '', argsFn } = {}) {
  const def = catalogue?.actions?.find((a) => a.id === id);
  if (!def) return null;
  const disabled = !hasToken() || busy != null;
  return h('button', {
    class: `btn ${variant || (def.danger === 'high' ? 'danger' : def.danger === 'medium' ? 'warn' : '')}`,
    text: busy === id ? `${def.label}…` : def.label,
    disabled: disabled ? 'disabled' : null,
    title: def.confirm ?? def.label,
    onclick: () => confirmAct(id, argsFn ? argsFn() : {}),
  });
}

function fleetPanel() {
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: 'Fleet' })),
    h('div', { class: 'panel-sub' },
      'These run the scripts in ~/actions-runners directly. Preview before applying anything destructive — ' +
        'cleanup and teardown are separate actions from their dry runs on purpose.'),
    h('div', { class: 'row-actions' },
      actionButton('fleet.status'),
      actionButton('fleet.health'),
      actionButton('fleet.healthRepair'),
      actionButton('fleet.preflight'),
      actionButton('fleet.cleanupPreview'),
      actionButton('fleet.cleanupApply')
    )
  );
}

function registerPanel() {
  const snap = getSnapshot();
  const repos = [...new Set([
    ...(snap.repos ?? []).map((r) => r.fullName),
    ...(snap.runners ?? []).map((r) => r.repo),
  ])].sort();

  const repoSel = h('select', { class: 'input', id: 'reg-repo' },
    repos.map((r) => h('option', { value: r, text: r })));
  const labelIn = h('input', { class: 'input', id: 'reg-label', placeholder: 'extra label (optional)' });
  const instSel = h('select', { class: 'input', id: 'reg-instance' },
    [1, 2, 3].map((n) => h('option', { value: String(n), text: n === 1 ? 'first runner' : `instance ${n}` })));

  // Mirror the daemon's own rule back to the operator as they choose, so the
  // constraint is visible before the button rather than only in the error.
  const hint = h('div', { class: 'panel-sub', text: '' });
  const updateHint = () => {
    const repo = repoSel.value;
    const siblings = (snap.runners ?? []).filter((r) => r.repo === repo && r.registered);
    const inst = Number(instSel.value);
    if (inst > 1 && siblings.length) {
      const labels = siblings[0].extraLabels ?? [];
      hint.textContent =
        `The existing runner carries [${labels.join(', ') || 'no extra labels'}]. A second runner must carry ` +
        `the same or it will never match the same runs-on:.`;
    } else if (siblings.length) {
      hint.textContent = `${repo} already has ${siblings.length} runner${siblings.length === 1 ? '' : 's'} on this host.`;
    } else {
      hint.textContent = `${repo} has no runner on this host.`;
    }
  };
  repoSel.addEventListener('change', updateHint);
  instSel.addEventListener('change', updateHint);
  setTimeout(updateHint, 0);

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: 'Register a runner' })),
    h('div', { class: 'panel-sub' },
      'Runs ./register.sh on the host. A second runner only helps a repo whose workflows have more than ' +
        'one job — check the Analytics verdict first.'),
    h('div', { class: 'form-row' }, repoSel, labelIn, instSel,
      actionButton('runner.register', {
        argsFn: () => ({
          repo: repoSel.value,
          label: labelIn.value.trim() || null,
          instance: Number(instSel.value),
        }),
      })
    ),
    hint
  );
}

function settingsPanel() {
  const sd = settingsData;
  if (!sd) return null;

  async function saveSetting(key, value) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { alert('Enter the control token first.'); return; }
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ key, value }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await loadCatalogue();
      render();
    } catch (err) {
      alert(`Could not save ${key}: ${err.message}`);
    }
  }

  async function resetSetting(key) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { alert('Enter the control token first.'); return; }
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ key, reset: true }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await loadCatalogue();
      render();
    } catch (err) {
      alert(`Could not reset ${key}: ${err.message}`);
    }
  }

  const envOnly = sd.envOnly ?? [];
  const rows = (sd.settings ?? []).filter((s) => !envOnly.includes(s.key));

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Settings' }),
      h('span', { class: 'count', text: sd.readOnly ? 'read-only mode' : '' })
    ),
    h('div', { class: 'panel-sub' },
      'These take effect immediately — no restart needed. Values set here override the LaunchAgent ' +
        'environment; "reset" removes the override and lets the environment or default apply again.'),
    h('table', { class: 'mini-table settings-table' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Setting' }), h('th', { text: 'Value' }),
        h('th', { text: 'Source' }), h('th', { text: '' })
      )),
      h('tbody', {}, rows.map((s) => {
        const input = h('input', {
          class: 'input input-sm',
          value: Array.isArray(s.value) ? s.value.join(', ') : String(s.value ?? ''),
          disabled: sd.readOnly || !hasToken() ? 'disabled' : null,
        });
        return h('tr', {},
          h('td', {}, h('span', { text: s.label }), h('div', { class: 'panel-sub', text: s.key })),
          h('td', {}, input),
          h('td', {}, h('span', { class: `flag ${s.source === 'setting' ? 'good' : 'muted'}`, text: s.source })),
          h('td', {},
            !sd.readOnly && hasToken()
              ? h('div', { class: 'row-actions' },
                  h('button', {
                    class: 'btn tiny', text: 'Set',
                    onclick: () => saveSetting(s.key, input.value),
                  }),
                  s.source !== 'default'
                    ? h('button', {
                        class: 'btn tiny', text: 'Reset',
                        onclick: () => resetSetting(s.key),
                      })
                    : null
                )
              : null
          )
        );
      }))
    )
  );
}

function autoscalePanel() {
  const snap = getSnapshot();
  const cap = autoscaleData?.capacity ?? snap.capacity ?? {};
  const sizing = autoscaleData?.sizing ?? snap.sizing ?? [];
  const decisions = autoscaleData?.decisions ?? [];

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Autoscaling readiness' }),
      h('span', { class: `flag ${cap.ok ? 'good' : 'warning'}`, text: cap.ok ? 'headroom available' : 'no headroom' })
    ),
    h('div', { class: 'panel-sub' },
      cap.ok
        ? `Host can accept more runners: ${cap.busy ?? 0} busy, ${cap.ceiling ?? 0} ceiling.`
        : `Scale-up blocked: ${(cap.reasons ?? []).join('; ') || 'unknown reason'}`
    ),
    sizing.length
      ? [
          h('h4', { text: 'Per-repo sizing (from job history)' }),
          h('table', { class: 'mini-table' },
            h('thead', {}, h('tr', {},
              h('th', { text: 'Repo' }), h('th', { class: 'num', text: 'Have' }),
              h('th', { class: 'num', text: 'Want' }), h('th', { text: 'Reason' })
            )),
            h('tbody', {}, sizing.map((s) =>
              h('tr', {},
                h('td', { class: 'mono', text: s.repo.split('/').pop() }),
                h('td', { class: 'num', text: String(s.have) }),
                h('td', { class: `num ${s.delta > 0 ? 'serious' : 'good'}`, text: String(s.want) }),
                h('td', { text: s.reason })
              )
            ))
          ),
        ]
      : null,
    decisions.length
      ? [
          h('h4', { text: 'Recent dry-run decisions' }),
          h('table', { class: 'mini-table' },
            h('thead', {}, h('tr', {},
              h('th', { text: 'When' }), h('th', { text: 'Repo' }),
              h('th', { text: 'Decision' }), h('th', { text: 'Reason' })
            )),
            h('tbody', {}, decisions.slice(0, 10).map((d) =>
              h('tr', {},
                h('td', { text: new Date(d.ts).toLocaleString() }),
                h('td', { class: 'mono', text: d.repo.split('/').pop() }),
                h('td', {}, h('span', { class: `flag ${d.action === 'proposed' ? 'good' : 'muted'}`, text: d.action })),
                h('td', { text: d.reason })
              )
            ))
          ),
        ]
      : h('div', { class: 'empty', text: 'No autoscaling decisions recorded yet. They appear when a run has been queued longer than the threshold.' })
  );
}

function resultPanel() {
  if (!lastResult) return null;
  const r = lastResult;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: r.ok ? 'Result' : 'Failed' }),
      h('span', { class: `flag ${r.ok ? '' : 'serious'}`, text: r.ok ? `exit ${r.code ?? 0}` : `HTTP ${r.status ?? '–'}` })
    ),
    h('div', { class: 'panel-sub', text: r.command ?? r.action }),
    h('pre', { class: 'diag', text: r.output || r.error || '(no output)' })
  );
}

function logPanel() {
  const rows = catalogue?.recent ?? [];
  if (!rows.length) return null;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: 'Recent actions' })),
    h('div', { class: 'panel-sub', text: 'Every action this daemon has run, successful or not.' }),
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'When' }), h('th', { text: 'Action' }),
        h('th', { text: 'Command' }), h('th', { class: 'num', text: 'Exit' })
      )),
      h('tbody', {}, rows.map((x) =>
        h('tr', {},
          h('td', { text: new Date(x.ts).toLocaleString() }),
          h('td', { class: 'mono', text: x.action }),
          h('td', { class: 'mono', text: (x.command ?? '–').slice(0, 70) }),
          h('td', { class: `num ${x.ok ? '' : 'fail'}`, text: x.ok ? '0' : String(x.exit_code ?? 'err') })
        )
      ))
    )
  );
}

export function render() {
  const root = document.querySelector('#view-control');
  if (!root) return;
  if (catalogue?.readOnly) {
    return mount(root,
      h('div', { class: 'section-head' }, h('h2', { text: 'Control' })),
      h('div', { class: 'empty', text: 'This daemon is running read-only (FLEET_READ_ONLY=1). No actions are available.' })
    );
  }
  mount(root,
    h('div', { class: 'section-head' },
      h('h2', { text: 'Control' }),
      h('span', { class: 'count', text: hasToken() ? 'unlocked' : 'locked' })
    ),
    tokenPanel(),
    autoscalePanel(),
    settingsPanel(),
    fleetPanel(),
    registerPanel(),
    resultPanel(),
    logPanel()
  );
}
