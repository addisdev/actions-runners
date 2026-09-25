// The Hosts view: every machine in the fleet, local and remote alike.
//
// The organising idea is that a stale host must never be mistaken for a healthy
// one. A coordinator's picture of a remote host is only as fresh as its last
// heartbeat, and a runner list from four minutes ago rendered exactly like a live
// one is worse than no view at all — it invites decisions based on state that has
// already changed. So staleness is the most prominent thing on the page, and a
// stale host's runners are visibly held at arm's length rather than dropped.

import { chartEl as h } from './charts.js';
import * as control from './control.js';

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

const REFRESH_MS = 30_000;

let data = null;
let loading = false;
let active = false;
let refreshTimer = null;

const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const gb = (n) => (n == null ? '–' : n >= 100 ? Math.round(n) : n.toFixed(1));

export async function loadHosts() {
  loading = true;
  render();
  try {
    data = await (await fetch('/api/hosts')).json();
  } catch (err) {
    data = { error: err.message };
  }
  loading = false;
  render();
}

export function setActive(on) {
  active = on;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (!on) return;
  loadHosts();
  refreshTimer = setInterval(() => {
    if (active && !loading) loadHosts();
  }, REFRESH_MS);
}

// Explains what this tab is for on a fleet that has only one machine, which is
// the state most installations are in and is not a problem to be fixed.
function notFederatedPanel() {
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: 'One host' })),
    h('div', { class: 'panel-sub' },
      'This fleet is a single machine, which is the normal case and needs nothing here. '
      + 'To add another Mac, run the agent on it — it reports outbound to this dashboard, so '
      + 'the new host needs no open ports and no inbound firewall rule:'),
    h('pre', { class: 'snippet', text:
      '# On this coordinator: ./fleetctl.sh agent-token --host mac-studio\n'
      + 'FLEET_COORDINATOR=http://this-host:7878 \\\n'
      + 'FLEET_AGENT_TOKEN=<host-scoped-token> \\\n'
      + 'FLEET_HOST_ID=mac-studio \\\n'
      + 'FLEET_HOST_NAME=mac-studio \\\n'
      + '  node dashboard/agent.js' }),
    h('div', { class: 'panel-sub muted' },
      'The agent reports only, until you set FLEET_AGENT_ALLOW_COMMANDS=1. Joining a fleet '
      + 'should not silently grant remote execution, so that is a separate decision.'),
    h('div', { class: 'panel-sub muted' },
      'This dashboard binds to loopback by default, so set FLEET_HOST=0.0.0.0 on the '
      + 'coordinator — or tunnel — before another machine can reach it.')
  );
}

function fleetCapacityPanel(data) {
  const hosts = data.hosts ?? [];
  if (!hosts.length) return null;
  const eligible = hosts.filter((host) => !host.stale && !host.drained && host.capacity?.ok);
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Fleet-wide capacity' }),
      h('span', { class: `flag ${eligible.length ? 'good' : 'warning'}`,
        text: eligible.length ? `${eligible.length} host(s) with headroom` : 'no headroom now' }),
    ),
    h('div', { class: 'panel-sub', text:
      eligible.length
        ? 'At least one connected host can accept another runner — autoscale may place on an agent.'
        : 'Every live host is at its ceiling or stale. Scale-up will be refused until load drops.' }),
    h('ul', { class: 'fleet-cap-list' },
      hosts.map((host) => {
        const cap = host.capacity ?? {};
        const state = host.stale ? 'stale — unknown'
          : host.drained ? 'drained'
            : cap.ok ? 'room for another runner'
              : (cap.reasons ?? ['at ceiling']).join('; ');
        return h('li', {},
          h('span', { class: 'host-name', text: host.name }),
          h('span', { class: host.stale ? 'critical' : cap.ok ? 'good' : 'warn', text: state })
        );
      })
    )
  );
}

function placementsPanel(placements) {
  if (!placements?.length) return null;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Recent placements' }),
      h('span', { class: 'count', text: `last ${placements.length}` }),
    ),
    h('div', { class: 'panel-sub muted', text:
      'Why autoscale chose or refused a host for runner.register. Dry-run rows logged a decision only.' }),
    h('table', { class: 'mini-table', 'aria-label': 'Recent autoscale placement decisions' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'When' }), h('th', { scope: 'col', text: 'Repo' }),
        h('th', { scope: 'col', text: 'Host' }), h('th', { scope: 'col', text: 'Outcome' })
      )),
      h('tbody', {}, placements.slice(0, 10).map((p) =>
        h('tr', {},
          h('td', { text: ago(p.ts) }),
          h('td', { class: 'mono', text: p.repo?.split('/').pop() ?? p.repo ?? '–' }),
          h('td', { class: 'mono', text: p.host_id ?? 'none' }),
          h('td', { class: 'mini', text:
            p.host_id
              ? `${p.dry_run ? 'dry run · ' : ''}placed on ${p.host_id}`
              : (p.reason ?? 'refused') })
        )
      ))
    )
  );
}

function pendingCommandsPanel(commands) {
  if (!commands?.length) return null;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Pending commands' }),
      h('span', { class: 'count warn', text: `${commands.length} in flight` }),
    ),
    h('div', { class: 'panel-sub muted', text:
      'Commands queued for remote agents. They ride back on the next heartbeat.' }),
    h('table', { class: 'mini-table', 'aria-label': 'Pending remote host commands' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Host' }), h('th', { scope: 'col', text: 'Action' }),
        h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Queued' })
      )),
      h('tbody', {}, commands.slice(0, 10).map((c) =>
        h('tr', {},
          h('td', { class: 'mono', text: c.host_id ?? '–' }),
          h('td', { text: c.action ?? '–' }),
          h('td', {}, h('span', { class: `status ${c.status}`, text: c.status ?? '–' })),
          h('td', { text: ago(c.ts) })
        )
      ))
    )
  );
}

function hostActions(host) {
  const canAct = control.hasToken() && !host.stale;
  if (!canAct && !control.hasToken()) {
    return h('p', { class: 'note muted', text: 'Unlock the Control tab to drain, resume, or repair hosts.' });
  }
  return h('div', { class: 'host-actions', role: 'group', 'aria-label': `Actions for ${host.name}` },
    h('button', {
          class: 'btn tiny',
          text: 'Health repair',
          'aria-label': `Run health check and repair on ${host.name}`,
          disabled: canAct ? null : 'disabled',
          onclick: async () => {
            const res = await control.confirmAct('fleet.healthRepair', { hostId: host.id });
            if (res) alert(res.ok ? (res.output || 'Repair finished.') : `Failed: ${res.error || res.output}`);
            if (active) loadHosts();
          },
        }),
    host.drained
      ? h('button', {
          class: 'btn tiny warn',
          text: 'Resume host',
          'aria-label': `Resume runner placement on ${host.name}`,
          disabled: canAct ? null : 'disabled',
          onclick: async () => {
            const res = await control.confirmAct('host.resume', { hostId: host.id });
            if (res) alert(res.ok ? (res.output || 'Resume queued.') : `Failed: ${res.error || res.output}`);
            if (active) loadHosts();
          },
        })
      : h('button', {
          class: 'btn tiny warn',
          text: 'Drain host',
          'aria-label': `Stop new runner placement on ${host.name}`,
          disabled: canAct ? null : 'disabled',
          onclick: async () => {
            const res = await control.confirmAct('host.drain', { hostId: host.id });
            if (res) alert(res.ok ? (res.output || 'Drain queued.') : `Failed: ${res.error || res.output}`);
            if (active) loadHosts();
          },
        })
  );
}

function hostCard(host) {
  const cap = host.capacity ?? {};
  const v = host.host ?? {};
  const loadLine = v.load1 != null && v.cores
    ? `${v.load1.toFixed(2)} / ${v.cores} cores (5m ${(v.load5 ?? 0).toFixed(2)})`
    : '–';
  const memLine = v.memFreePct != null
    ? `${v.memFreePct}% free${v.memTotalMb ? ` · ${Math.round(v.memTotalMb / 1024)} GB total` : ''}`
    : '–';
  const diskLine = v.diskFreeGb != null
    ? `${gb(v.diskFreeGb)} GB free${v.diskTotalGb ? ` of ${gb(v.diskTotalGb)} GB` : ''}`
    : '–';

  return h('article', {
    class: `host-card ${host.stale ? 'is-stale' : ''}`,
    'aria-label': `${host.name}${host.stale ? ', stale heartbeat' : ', live'}`,
  },
    h('div', { class: 'host-head' },
      h('span', { class: 'host-name', text: host.name }),
      host.stale
        ? h('span', { class: 'flag critical', text: `stale — last heard ${ago(host.lastHeartbeat)}` })
        : h('span', { class: 'flag good', text: `live · ${ago(host.lastHeartbeat)}` }),
      host.drained ? h('span', { class: 'flag warning', text: 'drained' }) : null
    ),
    host.stale
      ? h('div', { class: 'note warn' },
          'No heartbeat for '
          + `${Math.round((host.staleForMs ?? 0) / 1000)}s. Everything below is from the last report `
          + 'and may no longer be true. Its runners keep taking jobs from GitHub regardless — they do '
          + 'not depend on this dashboard — so this is a reporting problem until proven otherwise.')
      : null,
    h('dl', { class: 'host-stats' },
      h('dt', { text: 'load' }),
      h('dd', { text: loadLine }),
      h('dt', { text: 'memory' }),
      h('dd', { text: memLine }),
      h('dt', { text: 'disk' }),
      h('dd', { text: diskLine }),
      h('dt', { text: 'runners' }),
      h('dd', { text: `${host.runnerCount} (${host.busyCount} busy)` }),
      h('dt', { text: 'headroom' }),
      h('dd', { class: cap.ok ? 'good' : 'warn' },
        cap.ok == null ? 'unknown' : cap.ok ? 'room for another runner' : (cap.reasons ?? []).join('; ') || 'none'),
      host.labels?.length ? h('dt', { text: 'labels' }) : null,
      host.labels?.length ? h('dd', { class: 'mono', text: host.labels.join(', ') }) : null,
      host.version ? h('dt', { text: 'agent' }) : null,
      host.version ? h('dd', { text: `v${host.version}` }) : null
    ),
    hostActions(host)
  );
}

export function render() {
  const root = document.querySelector('#view-hosts');
  if (!root) return;

  const head = h('div', { class: 'section-head' },
    h('h2', { text: 'Hosts' }),
    h('span', { class: 'count', text: data?.totalHosts
      ? `${data.totalHosts} host(s)${data.staleHosts ? `, ${data.staleHosts} stale` : ''}`
      : '' }),
    h('button', {
      class: 'btn tiny',
      text: loading ? 'loading…' : 'Refresh',
      'aria-label': 'Refresh host list',
      disabled: loading,
      onclick: () => loadHosts(),
    })
  );

  if (loading && !data) return mount(root, head, h('div', { class: 'empty', text: 'Loading…' }));
  if (!data) return mount(root, head, h('div', { class: 'empty', text: 'Not loaded.' }));
  if (data.error) return mount(root, head, h('div', { class: 'empty', text: `Could not load hosts: ${data.error}` }));

  const hosts = data.hosts ?? [];

  mount(root, head,
    data.staleHosts > 0
      ? h('div', { class: 'drift-item serious' },
          h('span', { class: 'drift-sev', text: 'serious' }),
          h('span', { class: 'drift-subject', text: `${data.staleHosts} of ${data.totalHosts} hosts are stale` }),
          h('span', { class: 'drift-detail' },
            `No heartbeat in over ${Math.round((data.staleHeartbeatMs ?? 120000) / 1000)}s. `
            + 'Their runners are still working — a runner takes jobs straight from GitHub and does not '
            + 'need this dashboard — so check the agent process and the network before the runners.')
        )
      : null,
    fleetCapacityPanel(data),
    h('div', { class: 'host-grid' }, hosts.map(hostCard)),
    placementsPanel(data.recentPlacements),
    pendingCommandsPanel(data.pendingCommands),
    data.federated === false ? notFederatedPanel() : null
  );
}
