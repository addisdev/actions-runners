// The Hosts view: every machine in the fleet, local and remote alike.
//
// The organising idea is that a stale host must never be mistaken for a healthy
// one. A coordinator's picture of a remote host is only as fresh as its last
// heartbeat, and a runner list from four minutes ago rendered exactly like a live
// one is worse than no view at all — it invites decisions based on state that has
// already changed. So staleness is the most prominent thing on the page, and a
// stale host's runners are visibly held at arm's length rather than dropped.

import { chartEl as h } from './charts.js';

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

let data = null;
let loading = false;

const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

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
      'FLEET_COORDINATOR=http://this-host:7878 \\\n'
      + 'FLEET_AGENT_TOKEN=<./fleetctl.sh token> \\\n'
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

function hostCard(host) {
  const cap = host.capacity ?? {};
  return h('div', { class: `host-card ${host.stale ? 'is-stale' : ''}` },
    h('div', { class: 'host-head' },
      h('span', { class: 'host-name', text: host.name }),
      host.stale
        ? h('span', { class: 'flag critical', text: `stale — last heard ${ago(host.lastHeartbeat)}` })
        : h('span', { class: 'flag good', text: `live · ${ago(host.lastHeartbeat)}` }),
      host.drained ? h('span', { class: 'flag warning', text: 'drained' }) : null
    ),
    // Said in full rather than implied by the greying, because the consequence
    // matters: these numbers are a snapshot from the past, and acting on them is
    // acting on history.
    host.stale
      ? h('div', { class: 'note warn' },
          'No heartbeat for '
          + `${Math.round((host.staleForMs ?? 0) / 1000)}s. Everything below is from the last report `
          + 'and may no longer be true. Its runners keep taking jobs from GitHub regardless — they do '
          + 'not depend on this dashboard — so this is a reporting problem until proven otherwise.')
      : null,
    h('dl', { class: 'host-stats' },
      h('dt', { text: 'runners' }),
      h('dd', { text: `${host.runnerCount} (${host.busyCount} busy)` }),
      h('dt', { text: 'headroom' }),
      h('dd', { class: cap.ok ? 'good' : 'warn' },
        cap.ok == null ? 'unknown' : cap.ok ? 'room for another runner' : (cap.reasons ?? []).join('; ') || 'none'),
      host.labels?.length ? h('dt', { text: 'labels' }) : null,
      host.labels?.length ? h('dd', { class: 'mono', text: host.labels.join(', ') }) : null,
      host.version ? h('dt', { text: 'agent' }) : null,
      host.version ? h('dd', { text: `v${host.version}` }) : null
    )
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
      class: 'btn tiny', text: loading ? 'loading…' : 'Refresh',
      disabled: loading, onclick: () => loadHosts(),
    })
  );

  if (loading && !data) return mount(root, head, h('div', { class: 'empty', text: 'Loading…' }));
  if (!data) return mount(root, head, h('div', { class: 'empty', text: 'Not loaded.' }));
  if (data.error) return mount(root, head, h('div', { class: 'empty', text: `Could not load hosts: ${data.error}` }));

  const hosts = data.hosts ?? [];

  mount(root, head,
    // Led with, not buried: a fleet view that is substantially stale is not a
    // view of the fleet, and the reader needs to know that before reading it.
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
    h('div', { class: 'host-grid' }, hosts.map(hostCard)),
    data.federated === false ? notFederatedPanel() : null
  );
}
