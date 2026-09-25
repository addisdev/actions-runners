// The whole client. No framework, no build step — see ../README.md for why.
// The daemon pushes a complete snapshot over SSE; this file only renders it.

import { loadAnalytics, setRepoOpener } from './analytics.js';
import * as control from './control.js';
import * as alerts from './alerts.js';
import * as lint from './lint.js';
import * as capacity from './capacity.js';
import * as hosts from './hosts.js';
import { barChart, fmtMs } from './charts.js';
import './tip.js';

const $ = (sel) => document.querySelector(sel);
let snap = null;
let streamConnected = false;
let everConnected = false;
let view = 'fleet';
let analyticsLoaded = false;
let accessCtx = null;       // /api/access context
let bannerDismissed = sessionStorage.getItem('fleet-access-banner-dismissed') === '1';
let alertsPollingTimer = null;

function startAlertsPolling() {
  stopAlertsPolling();
  alertsPollingTimer = setInterval(() => {
    if (view === 'alerts') alerts.loadAlerts();
  }, 30000);
}
function stopAlertsPolling() {
  clearInterval(alertsPollingTimer);
  alertsPollingTimer = null;
}
let lintLoaded = false;
let firstKpiPaint = true;
let lastDrawerFocus = null;
let drawerCloseTimer = null;
// Matches fleetd CONFIG.collectorStaleMs default; /api/health is authoritative when polled.
const COLLECTOR_STALE_MS = 240_000;
let collectorHealth = null;
let remediation = null;
let autofixStatus = null;
let remediationLoading = false;
let remediationFetched = false;

// ------------------------------------------------------------------ helpers

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

// replaceChildren is the raw DOM API: it does not flatten arrays and does not
// skip nulls — it stringifies them, so a list of elements renders as
// "[object HTMLDivElement],[object HTMLDivElement]" and an absent item renders
// as the word "null". h() flattens because it is ours; this makes the two
// behave the same way at every mount point.
const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

function emptyState({ asset, eyebrow, title, copy, loading = false, compact = false }) {
  return h('div', {
    class: `empty-state${loading ? ' is-loading' : ''}${compact ? ' is-compact' : ''}`,
    role: loading ? 'status' : null,
  },
  h('div', { class: 'empty-visual' },
    h('img', { src: asset, alt: '' }),
    loading ? h('i', { class: 'scan-line', 'aria-hidden': 'true' }) : null
  ),
  h('div', {},
    eyebrow ? h('span', { class: 'empty-eyebrow', text: eyebrow }) : null,
    h('strong', { text: title }),
    h('p', { text: copy })
  ));
}

function dur(msValue) {
  if (msValue == null || !Number.isFinite(msValue)) return '–';
  const s = Math.max(0, Math.round(msValue / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const hr = Math.floor(m / 60);
  return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
}

function ago(iso) {
  if (!iso) return '–';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const gb = (n) => (n == null ? '–' : n >= 100 ? Math.round(n) : n.toFixed(1));

function localHostId(s = snap) {
  return s?.control?.replicaId
    ?? (s?.hosts ?? []).find((host) => host.local)?.id
    ?? '__local__';
}

function isFederated(s) {
  return Boolean(s?.federation?.enabled);
}

function hostSummaryMap(s) {
  const map = new Map();
  for (const h of s.hosts ?? []) map.set(h.id, h);
  return map;
}

function runnerHostLookup(s) {
  const map = new Map();
  for (const r of s.fleetRunners ?? s.runners ?? []) map.set(r.name, r);
  return map;
}

function hostAttributionChip(r, { localOk = false } = {}) {
  if (!r?.hostName && !r?.hostId) return null;
  if (!localOk && (!r.hostId || r.hostId === localHostId())) return null;
  const label = r.hostName ?? r.hostId;
  return h('span', {
    class: `chip host-attrib${r.hostStale ? ' is-stale-host' : ''}`,
    text: label,
    title: r.hostStale
      ? `${label} — heartbeat stale; state may be outdated`
      : `Runner on ${label}`,
  });
}

// Severity of a fraction, so the meters and their labels always agree.
function bandFor(frac, { warn = 0.7, serious = 0.85, critical = 0.95 } = {}) {
  if (frac >= critical) return 'critical';
  if (frac >= serious) return 'serious';
  if (frac >= warn) return 'warning';
  return 'good';
}

function queueCauseMap(s) {
  const map = new Map();
  for (const q of s.queue ?? []) {
    if (q.id != null) map.set(q.id, q);
  }
  return map;
}

const QUEUE_CAUSE_LABELS = {
  'concurrency-block': 'probable GitHub-side hold',
};
// SSE snapshots replace the rendered queue every collector tick. Native
// <details> state lives on the element, so without keeping it separately an
// evidence panel closes as soon as the next snapshot replaces that element.
const openQueueEvidence = new Set();

function queueCauseLabel(cause) {
  return QUEUE_CAUSE_LABELS[cause] ?? String(cause ?? '').replace(/-/g, ' ');
}

function queueDiagnosisPanel(d) {
  if (!d?.cause) return null;
  const causeLabel = queueCauseLabel(d.cause);
  const conf = d.confidence ? `${d.confidence} confidence` : null;
  const remediation = d.remediation;
  const canAct = control.hasToken();
  const evidenceKey = `${d.repo ?? 'unknown'}:${d.id ?? 'unknown'}:${d.cause}`;
  return h('div', { class: 'queue-diagnosis' },
    h('div', { class: 'queue-diagnosis-head' },
      h('span', { class: `queue-cause cause-${d.cause}`, text: causeLabel }),
      conf ? h('span', { class: `queue-confidence ${d.confidence}`, text: conf }) : null,
      d.actionEligible ? h('span', { class: 'chip good', text: 'autoscale eligible' }) : null,
      remediation ? h('button', {
        class: 'btn tiny warn',
        text: remediation.label,
        disabled: canAct ? null : 'disabled',
        title: canAct ? remediation.label : 'Unlock the Control tab to run this action',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = 'Cancelling…';
          const res = await control.act(remediation.action, { repo: d.repo, runId: d.id });
          if (!res?.ok) {
            button.disabled = false;
            button.textContent = remediation.label;
            window.alert('Failed: ' + (res?.error || res?.output || 'unknown error'));
          } else {
            button.textContent = 'Cancellation requested';
          }
        },
      }) : null
    ),
    d.recommended
      ? h('p', { class: 'queue-recommend', text: d.recommended })
      : null,
    d.evidence?.length
      ? h('details', {
          class: 'queue-evidence',
          open: openQueueEvidence.has(evidenceKey) ? '' : null,
          ontoggle: (event) => {
            if (event.currentTarget.open) openQueueEvidence.add(evidenceKey);
            else openQueueEvidence.delete(evidenceKey);
          },
        },
          h('summary', { text: `${d.evidence.length} evidence item${d.evidence.length === 1 ? '' : 's'}` }),
          h('ul', {}, d.evidence.map((e) => h('li', { text: e })))
        )
      : null
  );
}

function liveRunState(r) {
  const jobs = Array.isArray(r.jobs) ? r.jobs : [];
  const running = jobs.filter((j) => j.status === 'in_progress').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;

  // GitHub can call a workflow run "queued" until every matrix cell has
  // dispatched, even while sibling jobs are executing. Reporting that raw
  // run-level status hid the work consuming the host and made saturation look
  // impossible. Job state is the authoritative live picture.
  if (running > 0) {
    return {
      status: 'in_progress',
      label: running === 1 ? 'running' : `${running} running`,
      running,
      queued,
    };
  }
  return {
    status: r.status === 'completed' ? r.conclusion ?? 'completed' : r.status,
    label: (r.status === 'completed' ? r.conclusion ?? 'completed' : r.status).replace('_', ' '),
    running,
    queued,
  };
}

function queuedJobCount(runs) {
  return runs.reduce((total, r) => {
    if (Array.isArray(r.jobs) && r.jobs.length > 0) {
      return total + r.jobs.filter((j) => j.status === 'queued').length;
    }
    // Preserve a useful count when the per-run jobs request failed this tick.
    return total + (r.status === 'queued' ? 1 : 0);
  }, 0);
}

function longRunningIndicator(r) {
  if (liveRunState(r).status !== 'in_progress') return null;
  const expected = r.expectedDurationMs ?? r.expectedMs ?? r.p95DurationMs ?? r.durationP95Ms;
  const flagged = r.longRunning || r.isLongRunning || r.slow;
  if (!flagged && expected == null) return null;
  const elapsed = Date.now() - new Date(r.startedAt).getTime();
  const over = expected != null && elapsed > expected;
  if (!flagged && !over) return null;
  const title = expected != null
    ? `Running ${dur(elapsed)} — historical p95 is ${dur(expected)}`
    : 'This job is flagged as long-running';
  return h('span', {
    class: `chip ${over || flagged ? 'long-running' : ''}`,
    text: over ? `over p95 · ${dur(elapsed)}` : 'long-running',
    title,
  });
}

function snapshotAgeMs() {
  return snap?.ts ? Date.now() - snap.ts : null;
}

function isSnapshotStale() {
  if (collectorHealth?.stale != null) return collectorHealth.stale;
  const age = snapshotAgeMs();
  return age != null && age > COLLECTOR_STALE_MS;
}

function updateConnectionIndicator() {
  const dot = $('#conn-dot');
  const label = $('#conn-label');
  const brand = $('.brand-symbol');
  const age = snapshotAgeMs();
  const stale = isSnapshotStale();

  // Distinct states so the operator can tell their network, the stream, and
  // the collector apart.
  if (!navigator.onLine) {
    dot.className = 'dot is-dead';
    label.textContent = snap ? 'Offline — showing last update' : 'Offline';
    label.className = 'conn-offline';
    brand?.classList.remove('is-connecting');
    brand?.classList.add('is-offline');
  } else if (snap && !streamConnected) {
    dot.className = 'dot is-stale';
    label.textContent = everConnected ? 'Reconnecting…' : 'Connecting…';
    label.className = 'conn-stale';
    brand?.classList.remove('is-offline');
    brand?.classList.add('is-connecting');
  } else if (stale) {
    dot.className = 'dot is-stale';
    const collectorDown = collectorHealth?.ok === false;
    label.textContent = collectorDown ? 'Collector stalled' : 'Stale';
    label.className = 'conn-stale';
    brand?.classList.remove('is-connecting');
    brand?.classList.add('is-offline');
  } else if (snap) {
    dot.className = 'dot is-live';
    label.textContent = 'Live';
    label.className = 'conn-live';
    brand?.classList.remove('is-offline', 'is-connecting');
  } else {
    dot.className = 'dot is-dead';
    label.textContent = "Can't reach dashboard";
    label.className = 'conn-offline';
    brand?.classList.remove('is-connecting');
    brand?.classList.add('is-offline');
  }

  const staleEl = $('#stale');
  if (staleEl) {
    staleEl.textContent = stale && age != null
      ? `stale — last update ${dur(age)} ago`
      : '';
  }
}

async function pollHealth() {
  try {
    collectorHealth = await (await fetch('/api/health')).json();
  } catch {
    collectorHealth = null;
  }
  updateConnectionIndicator();
}

async function loadRemediation() {
  remediationLoading = true;
  const [candidates, status] = await Promise.allSettled([
    fetch('/api/remediation-candidates').then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    fetch('/api/autofix/status').then(async (res) => {
      const body = await res.json();
      if (!res.ok && body.available !== false) throw new Error(`HTTP ${res.status}`);
      return body;
    }),
  ]);
  remediation = candidates.status === 'fulfilled' ? candidates.value : null;
  autofixStatus = status.status === 'fulfilled' ? status.value : { available: false };
  remediationFetched = candidates.status === 'fulfilled';
  remediationLoading = false;
  if (view === 'fleet' || view === 'runs') render();
}

function remediationSection() {
  if (remediationLoading && !remediationFetched) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Remediation' })),
      h('div', { class: 'panel-sub muted', text: 'Loading autofix candidates…' })
    );
  }
  if (!remediationFetched) return null;
  const list = Array.isArray(remediation) ? remediation : [];
  const bridgeAvailable = autofixStatus?.available !== false;
  const bridgePaused = bridgeAvailable && autofixStatus?.fleet?.actionable === false;
  const escalationDisabled = bridgeAvailable && autofixStatus?.escalation?.enabled === false;
  const bridgeState = !bridgeAvailable
    ? h('div', { class: 'callout warn', text: 'Autofix bridge is not reachable; candidates remain visible but no automated action is confirmed.' })
    : bridgePaused
      ? h('div', { class: 'callout warn', text:
          `Autofix paused because fleet data is stale${autofixStatus.fleet.lastError ? `: ${autofixStatus.fleet.lastError}` : '.'}` })
      : escalationDisabled
        ? h('div', { class: 'callout warn', text: 'Autofix is running, but escalation is disabled or its credential is unavailable.' })
        : h('div', { class: 'callout good', text:
            `Autofix active${autofixStatus.dryRun ? ' in dry-run mode' : ''}; `
            + `${autofixStatus.reruns?.usedLast24h ?? 0}/${autofixStatus.reruns?.dailyCap ?? '–'} reruns and `
            + `${autofixStatus.fixes?.usedLast24h ?? 0}/${autofixStatus.fixes?.dailyCap ?? '–'} fixes used in 24h.` });
  if (!list.length) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('h3', { text: 'Remediation' }),
        h('span', { class: 'flag good', text: 'nothing pending' })),
      bridgeState,
      h('div', { class: 'panel-sub muted', text:
        'No recent failures are waiting for autofix. The bridge reads this list every minute.' })
    );
  }
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Remediation' }),
      h('span', { class: 'count warn', text: `${list.length} candidate${list.length === 1 ? '' : 's'}` })),
    h('div', { class: 'panel-sub', text:
      'Recently failed runs the autofix bridge may rerun or send to escalation. '
      + 'Dismissed alerts still repair — this list is independent of notification.' }),
    bridgeState,
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Repo' }), h('th', { scope: 'col', text: 'Workflow' }),
        h('th', { scope: 'col', text: 'Strategy' }), h('th', { scope: 'col', text: 'Branch' })
      )),
      h('tbody', {}, list.slice(0, 12).map((c) =>
        h('tr', {},
          h('td', { class: 'mono', text: c.repo?.split('/').pop() ?? '–' }),
          h('td', {}, c.url
            ? h('a', { href: c.url, target: '_blank', rel: 'noreferrer', text: c.workflowName ?? 'run' })
            : (c.workflowName ?? '–')),
          h('td', {}, h('span', { class: `strategy ${c.strategy}`, text: c.strategy ?? '–' })),
          h('td', { class: 'mono', text: c.branch ?? '–' })
        )
      ))
    )
  );
}

// ------------------------------------------------------------------- header

function renderFederationSummary(s) {
  const el = $('#federation-summary');
  if (!el) return;
  const fed = s.federation;
  const controlPlane = s.control;
  if (!fed?.enabled && !controlPlane?.enabled) {
    el.classList.add('is-hidden');
    el.setAttribute('aria-hidden', 'true');
    mount(el);
    return;
  }
  el.classList.remove('is-hidden');
  el.setAttribute('aria-hidden', 'false');
  const fleet = fed ?? {
    totalHosts: 1, runnersOnline: (s.runners ?? []).filter((r) => r.ghStatus === 'online').length,
    runnersBusy: (s.runners ?? []).filter((r) => r.ghBusy || r.workingLocally).length,
    fleetCapacityOk: s.capacity?.ok, staleHosts: 0,
  };
  const cap = fleet.fleetCapacityOk ? 'fleet headroom available' : 'no fleet headroom now';
  mount(el,
    h('div', { class: 'federation-summary-inner', role: 'status' },
      h('span', { class: 'fed-count', text: `${fleet.totalHosts} hosts` }),
      controlPlane?.enabled
        ? h('span', {
            class: `flag ${controlPlane.role === 'leader' ? 'good' : 'warning'}`,
            text: `${controlPlane.role} · ${controlPlane.replicaId}`,
          })
        : null,
      h('span', { class: 'fed-sep', 'aria-hidden': 'true', text: '·' }),
      h('span', { class: 'fed-count', text: `${fleet.runnersOnline} runners online` }),
      h('span', { class: 'fed-sep', 'aria-hidden': 'true', text: '·' }),
      h('span', { class: 'fed-count', text: `${fleet.runnersBusy} building` }),
      h('span', { class: 'fed-sep', 'aria-hidden': 'true', text: '·' }),
      h('span', { class: `fed-cap ${fleet.fleetCapacityOk ? 'good' : 'warn'}`, text: cap }),
      fleet.staleHosts
        ? h('span', { class: 'fed-stale flag critical', text: `${fleet.staleHosts} stale host${fleet.staleHosts === 1 ? '' : 's'}` })
        : null,
      h('button', {
        class: 'btn tiny',
        text: 'Hosts',
        'aria-label': 'Open the Hosts tab for federation details',
        onclick: () => setView('hosts'),
      })
    )
  );
}

// Access banner — shown to non-local viewers until they have a device token
function renderAccessBanner() {
  const existing = $('#access-banner');
  if (bannerDismissed || !accessCtx || accessCtx.via === 'local' || control.hasToken()) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  // tailscaleUser comes from a proxy header, so it is set as text, never HTML.
  const via = accessCtx.via === 'tailscale'
    ? `Tailscale${accessCtx.tailscaleUser ? ` as ${accessCtx.tailscaleUser}` : ''}`
    : accessCtx.via === 'proxy' ? 'a proxy' : 'LAN';
  const banner = h('div', { id: 'access-banner', class: 'access-banner', role: 'status' },
    h('span', {},
      h('b', { text: `Viewing over ${via}` }),
      ' — controls are locked. ',
      h('a', {
        href: '#/control',
        text: 'Pair this device',
        onclick: (e) => { e.preventDefault(); setView('control'); },
      }),
      ' to enable them.'),
    h('button', {
      type: 'button',
      class: 'access-dismiss',
      'aria-label': 'Dismiss',
      title: 'Dismiss',
      text: '×',
      onclick: () => {
        bannerDismissed = true;
        sessionStorage.setItem('fleet-access-banner-dismissed', '1');
        banner.remove();
      },
    }));
  $('#main-content')?.prepend(banner);
}

function renderHeader(s) {
  const host = s.host ?? {};
  const fed = s.federation;
  $('#host-name').textContent = fed?.enabled
    ? `fleet · ${host.hostname ?? 'coordinator'}`
    : (host.hostname ?? 'fleet');
  const parts = [];
  if (host.cores) {
    parts.push(`${host.cores} cores · ${Math.round((host.memTotalMb ?? 0) / 1024)} GB · ${host.platform} · up ${dur((host.uptimeSec ?? 0) * 1000)}`);
  }
  if (fed?.enabled) {
    parts.push(`${fed.totalHosts} host${fed.totalHosts === 1 ? '' : 's'} · ${fed.runnersOnline} online fleet-wide`);
    if (fed.staleHosts) parts.push(`${fed.staleHosts} stale`);
  }
  $('#host-meta').textContent = parts.join(' · ');

  const badge = (selector, count, label) => {
    const el = $(selector);
    el.hidden = !count;
    el.textContent = count > 99 ? '99+' : String(count);
    el.setAttribute('aria-label', `${count} ${label}`);
  };
  badge('#runs-badge', (s.active ?? []).length, 'active or queued runs');
  badge('#alerts-badge', s.collector?.alerts?.open ?? 0, 'open alerts');
}

function statTile({ label, value, unit, sub, tone, meter, onclick }) {
  const tag = onclick ? 'button' : 'div';
  const attrs = { class: 'kpi' };
  if (onclick) attrs.onclick = onclick;
  return h(tag, attrs,
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: `kpi-value ${tone ?? ''}` }, String(value), unit ? h('span', { class: 'unit', text: unit }) : null),
    sub ? h('div', { class: 'kpi-sub', text: sub }) : null,
    meter ? h('div', { class: `meter ${meter.tone}` }, h('i', { style: `width:${Math.min(100, meter.pct)}%` })) : null
  );
}

function renderKpis(s) {
  const host = s.host ?? {};
  const federated = isFederated(s);
  const runners = federated ? (s.fleetRunners ?? s.runners ?? []) : (s.runners ?? []);
  // This tile has to abstain on the same terms the drift rules do. They already
  // refuse to judge a runner whose GitHub state could not be fetched; if the
  // tile still counted those as "not online" it would show a red 0/16 during
  // exactly the API blackout the abstain logic exists to ride out — the tile
  // contradicting the rules directly beneath it.
  const unread = runners.filter((r) => r.ghUnknown).length;
  const registered = runners.filter((r) => r.registered !== false && !r.ghUnknown);
  const online = registered.filter((r) => r.ghStatus === 'online').length;
  const allUnread = runners.length > 0 && unread === runners.length;
  const busy = federated && s.federation?.runnersBusy != null
    ? s.federation.runnersBusy
    : runners.filter((r) => r.workingLocally || r.ghBusy).length;
  const queued = queuedJobCount(s.active ?? []);
  const problems = (s.drift ?? []).filter((d) => d.severity !== 'info');

  const swapinRate = host.swapinsPerSec ?? 0;
  const diskFrac = host.diskTotalGb ? 1 - host.diskFreeGb / host.diskTotalGb : 0;
  const loadFrac = host.cores ? host.load1 / host.cores : 0;

  mount($('#kpis'),
    statTile({
      label: 'Runners online',
      value: allUnread ? '—' : registered.length ? `${online}/${registered.length}` : '—',
      sub: allUnread
        ? 'GitHub state unread this tick — not a fault'
        : !runners.length
          ? federated ? 'no registered runners in the fleet' : 'no runners installed on this host'
          : online === registered.length
            ? `${federated ? 'fleet-wide · ' : ''}all registered runners up${unread ? ` · ${unread} unread` : ''}`
            : `${registered.length - online} not reporting${unread ? ` · ${unread} unread` : ''}${federated ? ' · fleet-wide' : ''}`,
      // Unread is muted, never red: not knowing is not the same as being down.
      tone: allUnread || !registered.length
        ? undefined
        : online === registered.length ? 'good' : 'critical',
      onclick: kpiNav('fleet', '#fleet'),
    }),
    statTile({
      label: 'Building now',
      value: busy,
      sub: busy ? 'runners at work' : 'nothing building',
      tone: busy ? 'busy' : undefined,
      onclick: kpiNav('runs', '#active'),
    }),
    statTile({
      label: 'Queued',
      value: queued,
      sub: queued ? (queued === 1 ? '1 job waiting' : `${queued} jobs waiting`) : 'queue empty',
      tone: queued ? 'warning' : undefined,
      onclick: kpiNav('fleet', '#fleet-queue'),
    }),
    statTile({
      label: 'Open alerts',
      value: s.collector?.alerts?.open ?? 0,
      sub: (s.collector?.alerts?.open ?? 0) ? 'see the Alerts tab' : 'nothing firing',
      tone: (s.collector?.alerts?.open ?? 0) ? 'warning' : 'good',
      onclick: kpiNav('alerts'),
    }),
    statTile({
      label: 'Drift',
      value: problems.length,
      sub: problems.length ? problems[0].kind.replace(/-/g, ' ') : 'fleet and GitHub agree',
      tone: problems.length ? problems[0].severity : 'good',
      onclick: kpiNav('fleet', '#drift'),
    }),
    // Memory pressure, NOT swap level. Swap used on macOS is an accumulator the
    // kernel never reclaims: this host sat at 84% swap with 71% memory free,
    // load 1.0 and zero swap I/O. A tile that goes orange on that teaches you to
    // ignore it. What predicts an actual stall is the kernel's pressure level
    // and the rate of swap-INs — a page being read back is a thread waiting.
    statTile({
      label: 'Memory pressure',
      value: host.memPressure ? host.memPressure : '–',
      unit: host.memFreePct != null ? `${host.memFreePct}% free` : undefined,
      sub: swapinRate > 0.5
        ? `swapping in ${swapinRate.toFixed(0)} pages/s`
        : `no swap activity · ${Math.round((host.swapUsedMb ?? 0) / 1024)} GB parked in swap`,
      tone: host.memPressure === 'critical' ? 'critical'
        : host.memPressure === 'warning' ? 'warning'
        : swapinRate > 50 ? 'warning'
        : 'good',
      // The meter tracks swap-in activity against a "this is thrashing" ceiling,
      // so it is flat at zero on a healthy machine no matter how full swap is.
      meter: {
        pct: Math.min(100, (swapinRate / 200) * 100),
        tone: swapinRate > 100 ? 'critical' : swapinRate > 50 ? 'serious' : swapinRate > 5 ? 'warning' : 'good',
      },
      onclick: kpiNav('capacity'),
    }),
    statTile({
      label: 'Load',
      value: (host.load1 ?? 0).toFixed(2),
      unit: `of ${host.cores ?? '?'}`,
      sub: `5m ${(host.load5 ?? 0).toFixed(2)} · 15m ${(host.load15 ?? 0).toFixed(2)}`,
      meter: { pct: loadFrac * 100, tone: bandFor(loadFrac) },
      onclick: kpiNav('capacity'),
    }),
    statTile({
      label: 'Disk free',
      value: gb(host.diskFreeGb),
      unit: 'GB',
      sub: `of ${gb(host.diskTotalGb)} GB · ${runners.length} runners, ${Math.round(host.totalRssMb ?? 0)} MB resident`,
      meter: { pct: diskFrac * 100, tone: bandFor(diskFrac, { warn: 0.8, serious: 0.9, critical: 0.95 }) },
      onclick: kpiNav('capacity'),
    })
  );
  if (firstKpiPaint) {
    const root = $('#kpis');
    root.classList.add('is-first-paint');
    setTimeout(() => root.classList.remove('is-first-paint'), 700);
    firstKpiPaint = false;
  }
}

// -------------------------------------------------------------------- drift

function renderDrift(s) {
  const items = s.drift ?? [];
  const el = $('#drift');
  if (!items.length) {
    mount(el,
      h('div', { class: 'all-clear' }, h('b', { text: '✓' }), ' No drift — launchd, GitHub and this machine agree on every runner.')
    );
    return;
  }
  mount(el,
    h('div', { class: 'section-head' },
      h('h2', { text: 'Drift' }),
      h('span', { class: 'count', text: `${items.filter((d) => d.severity !== 'info').length} to act on` })
    ),
    h('div', { class: 'drift-list' },
      items.map((d) =>
        h('div', { class: `drift-item ${d.severity}` },
          h('span', { class: 'drift-sev', text: d.severity }),
          h('span', { class: 'drift-subject', text: d.subject }),
          h('span', { class: 'drift-detail' },
            d.detail,
            d.hint ? h('span', { class: 'drift-hint', text: d.hint }) : null,
            // What the classifier actually saw. Shown because a diagnosis with
            // no evidence behind it is just a different opinion, and the reader
            // needs to be able to disagree with it.
            d.evidence?.length
              ? h('ul', { class: 'drift-evidence' },
                  d.evidence.map((e) => h('li', { text: e })),
                  d.confidence ? h('li', { class: 'muted', text: `${d.confidence} confidence` }) : null
                )
              : null
          ),
          // Offered for exactly one diagnosis: every runner for the repo is busy
          // and the host has room for another. For a label mismatch this button
          // would clone the mismatch, which is how one idle runner became two.
          d.capacityShortage && d.repo && control.hasToken()
            ? h('button', {
                class: 'btn tiny', text: 'Add a runner',
                onclick: async () => {
                  const sib = (s.runners ?? []).find((x) => x.repo === d.repo);
                  if (!sib) return alert('No existing runner for this repo to copy.');
                  await capacity.addRunner(sib.name);
                },
              })
            : null
        )
      )
    )
  );
}

// --------------------------------------------------------------- fleet view

function runnerState(r) {
  // Unknown is not orphan: the fetch failed, so GitHub state is simply unread.
  if (r.ghUnknown) return 'unknown';
  if (!r.registered) return 'orphan';
  if (r.drainState === 'drained') return 'drained';
  if (r.drainState === 'draining') return 'draining';
  if (r.launchdState === 'dead' || r.launchdState === 'not-loaded') return 'dead';
  if (r.ghStatus === 'offline') return 'offline';
  if (r.workingLocally || r.ghBusy) return 'busy';
  return 'idle';
}

const STATE_WORD = { idle: 'idle', busy: 'building', offline: 'offline', dead: 'dead', orphan: 'orphan', unknown: 'unknown', drained: 'drained', draining: 'draining' };

function currentJobFor(s, r) {
  for (const run of s.active ?? []) {
    for (const j of run.jobs ?? []) {
      if (j.runnerName === r.name && j.status === 'in_progress') return { run, job: j };
    }
  }
  return null;
}

function runnerTile(s, r, { showHost = false } = {}) {
  const state = runnerState(r);
  const current = currentJobFor(s, r);
  const hostChip = showHost ? hostAttributionChip(r) : null;
  return h('button', {
    class: `runner state-${state}${r.hostStale ? ' is-stale-host' : ''}`,
    onclick: () => openDrawer(r.name),
    'aria-label': `${r.name} on ${r.hostName ?? 'this host'} — ${STATE_WORD[state]}`,
  },
    h('div', { class: 'runner-top' },
      h('span', { class: 'runner-name', text: r.name.replace(/^[^-]+-/, '') }),
      hostChip,
      h('span', { class: 'runner-badge', text: STATE_WORD[state] })
    ),
    h('div', { class: 'runner-repo linkish', text: r.repo,
      onclick: (e) => { e.stopPropagation(); openRepoDrawer(r.repo); } }),
    current
      ? h('div', { class: 'runner-job' },
          h('span', { class: 'jobname', text: `${current.run.workflowName} · ${current.job.name}` }),
          h('span', { class: 'elapsed', text: dur(Date.now() - new Date(current.job.startedAt).getTime()) })
        )
      : null,
    h('div', { class: 'runner-facts' },
      r.extraLabels.length ? r.extraLabels.map((l) => h('span', { class: 'chip', text: l })) : null,
      h('span', { text: r.pid ? `pid ${r.pid}` : 'no pid' }),
      r.rssMb != null ? h('span', { text: `${r.rssMb} MB` }) : null,
      r.uptime ? h('span', { text: `up ${r.uptime}` }) : null
    )
  );
}

function projectGroups(runners, order) {
  const groups = new Map();
  for (const r of runners) {
    const project = r.project ?? 'other';
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(r);
  }
  const keys = [...groups.keys()].sort((a, b2) => {
    const ia = order.indexOf(a), ib = order.indexOf(b2);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map((k) => {
    const list = groups.get(k).sort((a, b2) => a.name.localeCompare(b2.name));
    const busy = list.filter((r) => r.workingLocally || r.ghBusy).length;
    return h('div', { class: 'project' },
      h('div', { class: 'project-head' },
        k,
        busy ? h('span', { class: 'busy-badge', text: `${busy} building` }) : null,
        h('span', { class: 'rule' })
      ),
      h('div', { class: 'grid runner-grid' }, list.map((r) => runnerTile(s, r)))
    );
  });
}

function hostSection(s, hostId, hostInfo, runners, summaries) {
  const summary = summaries.get(hostId);
  const vitals = summary?.host ?? {};
  const cap = summary?.capacity ?? {};
  const busy = runners.filter((r) => r.workingLocally || r.ghBusy).length;
  const head = h('div', { class: `host-block-head${summary?.stale ? ' is-stale' : ''}` },
    h('h3', { class: 'host-block-name', text: hostInfo.name ?? hostId }),
    summary?.stale
      ? h('span', { class: 'flag critical', text: `stale · last heard ${ago(summary.lastHeartbeat)}` })
      : h('span', { class: 'flag good', text: 'live' }),
    summary?.drained ? h('span', { class: 'flag warning', text: 'drained' }) : null,
    h('span', { class: 'host-block-meta muted', text:
      `${runners.length} runner${runners.length === 1 ? '' : 's'}${busy ? ` · ${busy} building` : ''}`
      + (vitals.load1 != null && vitals.cores
        ? ` · load ${vitals.load1.toFixed(1)}/${vitals.cores}`
        : '')
      + (vitals.memFreePct != null ? ` · ${vitals.memFreePct}% mem free` : '')
      + (vitals.diskFreeGb != null ? ` · ${gb(vitals.diskFreeGb)} GB disk free` : '')
      + (cap.ok != null ? ` · ${cap.ok ? 'headroom' : 'at ceiling'}` : '') }),
    hostId !== localHostId(s)
      ? h('button', {
          class: 'btn tiny',
          text: 'Hosts tab',
          'aria-label': `View ${hostInfo.name ?? hostId} on the Hosts tab`,
          onclick: () => setView('hosts'),
        })
      : null
  );
  return h('section', { class: 'host-block', id: `host-${hostId}` }, head,
    ...projectGroups(runners, s.projects ?? ['other']));
}

// Quick glance card shown at top of Fleet on narrow screens
// Counted the same way as the KPI row, so the two never disagree on one screen.
function renderGlanceCard(s) {
  const el = $('#glance-card');
  if (!el) return;
  const federated = isFederated(s);
  const runners = federated ? (s.fleetRunners ?? s.runners ?? []) : (s.runners ?? []);
  const working = (r) => r.workingLocally || r.ghBusy;
  const busy = federated && s.federation?.runnersBusy != null
    ? s.federation.runnersBusy
    : runners.filter(working).length;
  const idle = runners.filter((r) => r.registered !== false && !r.ghUnknown
    && r.ghStatus === 'online' && !working(r)).length;
  const queued = queuedJobCount(s.active ?? []);
  const alertCount = s.collector?.alerts?.open ?? 0;
  const item = (value, label, tone, target) => h('button', {
    type: 'button',
    class: `glance-item${value ? ` ${tone}` : ''}`,
    'aria-label': `${value} ${label.toLowerCase()} — open ${target}`,
    onclick: () => setView(target),
  },
  h('span', { class: 'glance-value', text: String(value) }),
  h('span', { class: 'glance-label', text: label }));
  mount(el,
    item(busy, 'Busy', 'is-busy', 'runs'),
    item(idle, 'Idle', 'is-good', 'hosts'),
    item(queued, 'Queued', 'is-warn', 'runs'),
    item(alertCount, 'Alerts', 'is-bad', 'alerts'));
}

function renderFleet(s) {
  const federated = isFederated(s);
  const localRunners = s.runners ?? [];
  const fleetRunners = federated ? (s.fleetRunners ?? localRunners) : localRunners;
  const summaries = hostSummaryMap(s);
  const order = s.projects ?? ['other'];

  let runnerMount;
  if (federated) {
    const byHost = new Map();
    for (const r of fleetRunners) {
      const hid = r.hostId ?? localHostId(s);
      if (!byHost.has(hid)) {
        byHost.set(hid, {
          name: r.hostName ?? summaries.get(hid)?.name ?? hid,
          runners: [],
        });
      }
      byHost.get(hid).runners.push(r);
    }
    const hostKeys = [...byHost.keys()].sort((a, b) => {
      if (a === localHostId(s)) return -1;
      if (b === localHostId(s)) return 1;
      return String(byHost.get(a).name).localeCompare(String(byHost.get(b).name));
    });
    runnerMount = hostKeys.length
      ? hostKeys.map((hid) => hostSection(s, hid, byHost.get(hid), byHost.get(hid).runners, summaries))
      : s.starting
        ? [emptyState({
            asset: '/assets/empty-fleet.svg',
            eyebrow: 'Starting collector',
            title: 'Reading the fleet',
            copy: 'Connecting local runners, GitHub state, and host telemetry.',
            loading: true,
          })]
        : [emptyState({
            asset: '/assets/empty-fleet.svg',
            eyebrow: 'Federated fleet',
            title: 'No runners reported',
            copy: 'Agents and this coordinator have not reported any runners yet.',
          })];
  } else {
    const groups = new Map();
    for (const r of localRunners) {
      if (!groups.has(r.project)) groups.set(r.project, []);
      groups.get(r.project).push(r);
    }
    const keys = [...groups.keys()].sort((a, b2) => {
      const ia = order.indexOf(a), ib = order.indexOf(b2);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    runnerMount = keys.length
      ? keys.map((k) => {
          const list = groups.get(k).sort((a, b2) => a.name.localeCompare(b2.name));
          const busy = list.filter((r) => r.workingLocally || r.ghBusy).length;
          return h('div', { class: 'project' },
            h('div', { class: 'project-head' },
              k,
              busy ? h('span', { class: 'busy-badge', text: `${busy} building` }) : null,
              h('span', { class: 'rule' })
            ),
            h('div', { class: 'grid runner-grid' }, list.map((r) => runnerTile(s, r)))
          );
        })
      : s.starting
        ? [emptyState({
            asset: '/assets/empty-fleet.svg',
            eyebrow: 'Starting collector',
            title: 'Reading the fleet',
            copy: 'Connecting local runners, GitHub state, and host telemetry.',
            loading: true,
          })]
        : [emptyState({
            asset: '/assets/empty-fleet.svg',
            eyebrow: 'Remote view',
            title: 'No runners on this host',
            copy: `No runner directories under ${s.host?.root ?? '~/actions-runners'}. Runs below are still live from GitHub.`,
          })];
  }

  const fleetNames = new Set(fleetRunners.map((r) => r.name));
  const unknownElsewhere = federated
    ? (s.elsewhere ?? []).filter((e) => !e.ephemeral && !fleetNames.has(e.name))
    : (s.elsewhere ?? []).filter((e) => !e.ephemeral);

  mount($('#fleet'),
    h('div', { class: 'section-head' },
      h('h2', { text: 'Runners' }),
      h('span', { class: 'count', text: federated
        ? `${fleetRunners.length} fleet-wide on ${s.federation?.totalHosts ?? summaries.size} host(s)`
        : `${localRunners.length} on this host` })
    ),
    ...runnerMount,
    // Ephemeral runners are split out from "registered elsewhere". They are on
    // this machine, under .ephemeral where disk discovery does not look, so
    // grouping them with runners on other hosts would send somebody hunting for a
    // machine that does not exist — or tempt them into cleaning up a live runner.
    (s.elsewhere ?? []).filter((e) => e.ephemeral).length
      ? h('div', { class: 'project' },
          h('div', { class: 'project-head' }, 'ephemeral (one job, then gone)', h('span', { class: 'rule' })),
          h('div', { class: 'rows' },
            s.elsewhere.filter((e) => e.ephemeral).map((e) =>
              h('div', { class: 'row' },
                h('span', { class: `status ${e.ghStatus}`, text: e.ghStatus }),
                h('span', { class: 'repo', text: e.repo.split('/').pop() }),
                h('span', { class: 'wf', text: e.name }),
                h('span', { class: 'branch', text: e.extraLabels.join(' ') }),
                h('span', { class: 'time', text: e.ghBusy ? 'busy' : 'waiting for a job' }),
                h('span', { class: 'where', text: 'removes itself when done' })
              )
            )
          )
        )
      : null,
    unknownElsewhere.length
      ? h('div', { class: 'project' },
          h('div', { class: 'project-head' }, 'registered elsewhere', h('span', { class: 'rule' })),
          h('div', { class: 'rows' },
            unknownElsewhere.map((e) =>
              h('div', { class: 'row' },
                h('span', { class: `status ${e.ghStatus}`, text: e.ghStatus }),
                h('span', { class: 'repo', text: e.repo.split('/').pop() }),
                h('span', { class: 'wf', text: e.name }),
                h('span', { class: 'branch', text: e.extraLabels.join(' ') }),
                h('span', { class: 'time', text: e.ghBusy ? 'busy' : '' }),
                h('span', { class: 'where', text: federated ? 'host unknown — no agent report' : 'no directory here' })
              )
            )
          )
        )
      : null
  );

  // Queued runs with label/age context
  const queued = s.queue ?? [];
  if (queued.length) {
    mount($('#fleet-queue'),
      h('div', { class: 'section-head' },
        h('h2', { text: 'Queued' }),
        h('span', { class: 'count', text: `${queued.length} waiting` })
      ),
      h('div', { class: 'rows' },
        queued.map((q) => {
          const waitMs = q.queuedSinceMs ?? 0;
          const labels = [...new Set(q.labels ?? [])].filter((l) => !['self-hosted', 'macos', 'x64', 'arm64', 'linux', 'windows'].includes(l));
          const row = h('div', { class: `row ${waitMs > 5 * 60 * 1000 ? 'is-queued' : ''}` },
            h('span', { class: 'status queued', text: 'queued' }),
            h('span', { class: 'repo', text: q.repo.split('/').pop() }),
            h('span', { class: 'wf', text: q.workflowName }),
            h('span', { class: 'branch' },
              labels.map((l) => h('span', { class: 'chip', text: l }))),
            h('span', { class: 'time', text: dur(waitMs) }),
            h('span', { class: 'where', text: queueCauseLabel(q.cause) })
          );
          const diag = queueDiagnosisPanel(q);
          return diag ? h('div', { class: 'row-stack' }, row, diag) : row;
        })
      )
    );
  } else {
    mount($('#fleet-queue'));
  }

  let remEl = $('#remediation');
  if (!remEl) {
    remEl = document.createElement('section');
    remEl.id = 'remediation';
    $('#view-fleet')?.appendChild(remEl);
  }
  mount(remEl, remediationSection());

  const unserved = (s.repos ?? []).filter((r) => !r.hasRunner && r.workflows > 0);
  mount($('#unserved'),
    ...(unserved.length
      ? [
          h('div', { class: 'section-head' },
            h('h2', { text: 'Repos with workflows and no runner here' }),
            h('span', { class: 'count', text: `${unserved.length}` })
          ),
          h('div', { class: 'rows' },
            unserved.map((r) =>
              h('div', { class: 'row' },
                h('span', { class: 'status queued', text: 'unserved' }),
                h('span', { class: 'repo', text: r.name }),
                h('span', { class: 'wf', text: `${r.workflows} active workflow${r.workflows === 1 ? '' : 's'}` }),
                h('span', { class: 'branch', text: r.private ? 'private' : 'public' }),
                h('span', { class: 'time', text: ago(r.pushedAt) }),
                h('span', { class: 'where', text: './register.sh ' + r.fullName })
              )
            )
          ),
        ]
      : [])
  );
}

// ---------------------------------------------------------------- runs view

function runRow(r, { live, diagnosis, hostLabel }) {
  const liveState = live ? liveRunState(r) : null;
  const status = liveState?.status ?? (r.status === 'completed' ? r.conclusion ?? 'completed' : r.status);
  const statusLabel = liveState?.label ?? status.replace('_', ' ');
  const elapsed = live
    ? Date.now() - new Date(status === 'queued' ? r.createdAt : r.startedAt).getTime()
    : r.durationMs;
  // Prefer displayTitle (GitHub's own label) then headCommitMsg; fall back to workflowName.
  const title = r.displayTitle || r.headCommitMsg || r.workflowName;
  const subtitle = title !== r.workflowName ? r.workflowName : null;
  const longRun = live ? longRunningIndicator(r) : null;
  const row = h('div', { class: `row ${status === 'queued' ? 'is-queued' : status === 'in_progress' ? 'is-running' : ''}` },
    h('span', { class: `status ${status}`, text: statusLabel }),
    h('span', { class: 'repo' },
      h('a', { href: r.url, target: '_blank', rel: 'noreferrer', text: r.repo.split('/').pop() }),
      ' ',
      h('span', { class: 'linkish', title: 'repo detail', text: '›',
        onclick: () => openRepoDrawer(r.repo) })),
    h('span', { class: 'wf', title: subtitle ?? title },
      subtitle ? h('span', { class: 'run-subtitle', text: subtitle + ' · ' }) : null,
      title),
    h('span', { class: 'branch' },
      r.prNumber ? h('a', { href: `${r.url?.replace(/\/actions\/runs\/.*/, '')}/pull/${r.prNumber}`,
        target: '_blank', rel: 'noreferrer', text: `#${r.prNumber}` }) : (r.branch ?? ''),
      r.runAttempt > 1 ? h('span', { class: 'chip', text: `attempt ${r.runAttempt}` }) : null,
      liveState?.queued
        ? h('span', { class: 'chip', text: `${liveState.queued} queued` })
        : null,
      longRun),
    h('span', { class: 'time', text: dur(elapsed) }),
    h('span', { class: 'where' },
      live
        ? (r.runnerName
          ? (hostLabel ? `${r.runnerName} · ${hostLabel}` : r.runnerName)
          : 'unassigned')
        : `${ago(r.updatedAt)} ago`,
      control.hasToken()
        ? h('button', {
            class: 'btn tiny',
            text: live ? 'cancel' : 're-run',
            title: live ? 'Cancel this run' : 'Re-run this workflow',
            onclick: async (e) => {
              e.stopPropagation();
              const res = await control.confirmAct(live ? 'run.cancel' : 'run.rerun',
                { repo: r.repo, runId: r.id });
              if (res && !res.ok) alert('Failed: ' + (res.error || res.output));
            },
          })
        : null
    )
  );
  const diag = live && r.status === 'queued' && diagnosis ? queueDiagnosisPanel(diagnosis) : null;
  return diag ? h('div', { class: 'row-stack' }, row, diag) : row;
}

function runHostLabel(s, runnerName) {
  if (!runnerName) return null;
  const runner = runnerHostLookup(s).get(runnerName);
  if (!runner) return null;
  if (!isFederated(s) && runner.hostId === localHostId(s)) return null;
  return runner.hostName ?? runner.hostId ?? null;
}

function renderRuns(s) {
  const active = s.active ?? [];
  const causes = queueCauseMap(s);
  mount($('#active'),
    h('div', { class: 'section-head' },
      h('h2', { text: 'Active' }),
      h('span', { class: 'count', text: `${active.length} running or queued` })
    ),
    active.length
      ? h('div', { class: 'rows' }, active.map((r) => runRow(r, {
        live: true,
        diagnosis: causes.get(r.id),
        hostLabel: runHostLabel(s, r.runnerName),
      })))
      : emptyState({
          asset: '/assets/empty-runs.svg',
          eyebrow: 'Fleet at rest',
          title: 'Nothing is building',
          copy: 'All runners are available and no workflow is waiting in the queue.',
          compact: true,
        })
  );

  const recent = s.recent ?? [];
  mount($('#recent'),
    h('div', { class: 'section-head' },
      h('h2', { text: 'Recent' }),
      h('span', { class: 'count', text: `last ${recent.length} completed, all repos` })
    ),
    h('div', { class: 'rows' }, recent.map((r) => runRow(r, { live: false, diagnosis: null })))
  );

  let remEl = $('#remediation-runs');
  if (!remEl) {
    remEl = document.createElement('section');
    remEl.id = 'remediation-runs';
    $('#view-runs')?.appendChild(remEl);
  }
  mount(remEl, remediationSection());
}

// ------------------------------------------------------------------ drawer

// An open drawer owns one history entry (same URL, state.drawer), so the
// phone's Back gesture closes the drawer instead of leaving the tab.
let drawerOpen = false;

function openDrawerShell(label) {
  const drawer = $('#drawer');
  const panel = drawer.querySelector('.drawer-panel');
  if (!drawerOpen) {
    lastDrawerFocus = document.activeElement;
    drawerOpen = true;
    if (!history.state?.drawer) history.pushState({ ...(history.state ?? {}), drawer: true }, '', location.href);
  }
  clearTimeout(drawerCloseTimer);
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  panel.setAttribute('aria-label', label);
  document.body.classList.add('drawer-open');
  requestAnimationFrame(() => {
    drawer.classList.add('is-open');
    panel.focus({ preventScroll: true });
  });
}

function closeDrawer({ fromHistory = false } = {}) {
  const drawer = $('#drawer');
  if (!drawerOpen) return;
  drawerOpen = false;
  if (!fromHistory && history.state?.drawer) history.back();
  drawer.classList.remove('is-open');
  if (lastDrawerFocus?.isConnected) lastDrawerFocus.focus({ preventScroll: true });
  lastDrawerFocus = null;
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  clearTimeout(drawerCloseTimer);
  drawerCloseTimer = setTimeout(() => {
    drawer.hidden = true;
  }, 280);
}

async function openDrawer(name) {
  openDrawerShell(`Runner detail: ${name}`);
  mount($('#drawer-body'), emptyState({
    asset: '/assets/empty-fleet.svg',
    eyebrow: 'Runner detail',
    title: 'Loading runner',
    copy: 'Reading process state, recent jobs, and diagnostics.',
    loading: true,
    compact: true,
  }));
  let data;
  try {
    const response = await fetch(`/api/runner?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch {
    mount($('#drawer-body'),h('div', { class: 'empty', text: 'could not load runner detail' }));
    return;
  }
  const r = data.runner;
  const fleetRunner = snap ? runnerHostLookup(snap).get(r.name) : null;
  mount($('#drawer-body'),
    h('h3', { text: r.name }),
    h('div', { class: 'sub', text: `${r.repo} · ${STATE_WORD[runnerState(r)]}` }),
    fleetRunner?.hostName || fleetRunner?.hostId
      ? h('div', { class: 'sub host-attrib-line' },
          'Host ',
          hostAttributionChip(fleetRunner, { localOk: isFederated(snap) }) ?? h('span', { text: fleetRunner.hostName ?? fleetRunner.hostId }))
      : null,
    h('dl', { class: 'kv' },
      fleetRunner?.hostName
        ? [h('dt', { text: 'host' }), h('dd', { text: `${fleetRunner.hostName}${fleetRunner.hostStale ? ' (stale heartbeat)' : ''}` })]
        : null,
      h('dt', { text: 'launchd' }), h('dd', { text: `${r.launchdState}${r.lastExit != null ? ` (last exit ${r.lastExit})` : ''}` }),
      h('dt', { text: 'label' }), h('dd', { text: r.launchdLabel ?? '–' }),
      h('dt', { text: 'github' }), h('dd', { text: r.registered ? `${r.ghStatus}${r.ghBusy ? ' · busy' : ''} (id ${r.ghId})` : 'not registered' }),
      h('dt', { text: 'labels' }), h('dd', { text: r.labels.join(', ') || '–' }),
      h('dt', { text: 'pid / memory' }), h('dd', { text: `${r.pid ?? '–'} / ${r.rssMb ?? '–'} MB` }),
      h('dt', { text: 'uptime' }), h('dd', { text: r.uptime ?? '–' }),
      // Version, with the fleet context that makes it meaningful. A version on
      // its own is a number; "2.340.0, and this is the only runner on it" is the
      // thing worth knowing after an update breaks something.
      data.versions?.active ? h('dt', { text: 'runner version' }) : null,
      data.versions?.active
        ? h('dd', {},
            data.versions.active,
            data.versions.stagedUpdate
              ? h('span', { class: 'drift-hint', text: `${data.versions.stagedUpdate} is downloaded and starts on next restart` })
              : null,
            data.versions.aloneOnVersion
              ? h('span', { class: 'drift-hint warn', text: 'the only runner on this version — check it first if something changed' })
              : null,
            data.versions.differsFromInstall
              ? h('span', { class: 'drift-hint', text: `register.sh installs ${data.versions.installVersion} — GitHub auto-updated this one` })
              : null,
            data.versions.lastUpdate
              ? h('span', { class: 'drift-hint', text: `last change ${ago(data.versions.lastUpdate.ts)} ago: ${data.versions.lastUpdate.detail}` })
              : null
          )
        : null,
      // Errors the runner itself logged, as a count. The verbatim tail is lower
      // down; this is the part you read before deciding to.
      data.diagSummary
        ? h('dt', { text: 'log errors' })
        : null,
      data.diagSummary
        ? h('dd', { class: data.diagSummary.errors ? 'warn' : '' },
            `${data.diagSummary.errors} error(s), ${data.diagSummary.warnings} warning(s) in the last ${data.diagSummary.linesScanned} lines`,
            data.diagSummary.lastError
              ? h('span', { class: 'drift-hint mono', text: data.diagSummary.lastError })
              : null
          )
        : null,
      r.drainState ? h('dt', { text: 'drain state' }) : null,
      r.drainState
        ? h('dd', { class: 'warn' },
            r.drainState,
            h('span', { class: 'drift-hint',
              text: 'Drain is best-effort: GitHub has no per-runner disable, so this runner may still '
                + 'appear online there until it misses enough heartbeats.' })
          )
        : null,
      h('dt', { text: 'directory' }), h('dd', { text: r.dir ?? 'reported by remote host' }),
      data.utilization?.workKb != null
        ? [h('dt', { text: 'work dir' }), h('dd', { text: `${(data.utilization.workKb / 1024).toFixed(1)} MB` })]
        : null,
    ),
    (() => {
      const u = data.utilization;
      if (!u || !u.jobCount) return null;
      const successRate = u.jobCount > 0 ? Math.round(((u.jobCount - u.failureCount) / u.jobCount) * 100) : null;
      const avgMs = u.totalMs && u.jobCount ? u.totalMs / u.jobCount : null;
      return h('div', { class: 'utilization-summary' },
        h('h4', { text: `7-day utilization` }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'jobs run' }), h('dd', { text: String(u.jobCount) }),
          h('dt', { text: 'success rate' }), h('dd', { text: successRate != null ? `${successRate}%` : '–' }),
          h('dt', { text: 'avg duration' }), h('dd', { text: avgMs != null ? dur(avgMs) : '–' }),
          h('dt', { text: 'last job' }), h('dd', { text: u.lastJobAt ? ago(u.lastJobAt) + ' ago' : '–' }),
        )
      );
    })(),
    control.hasToken()
      ? h('div', { class: 'row-actions' },
          r.drainState
            ? h('button', {
                class: 'btn warn', text: 'Resume',
                title: `Runner is ${r.drainState}. Click to restart it.`,
                onclick: async () => {
                  const res = await control.confirmAct('runner.resume', { name: r.name });
                  if (res) { alert(res.ok ? 'Resumed.\n\n' + (res.output || '') : 'Failed: ' + (res.error || res.output)); openDrawer(r.name); }
                },
              })
            : h('button', {
                class: 'btn warn', text: 'Restart',
                onclick: async () => {
                  const res = await control.confirmAct('runner.restart', { name: r.name });
                  if (res) { alert(res.ok ? 'Restarted.\n\n' + (res.output || '') : 'Failed: ' + (res.error || res.output)); openDrawer(r.name); }
                },
              }),
          r.drainState
            ? null
            : h('button', {
                class: 'btn', text: 'Drain',
                title: 'Stop after current job completes. Does not deregister from GitHub.',
                onclick: async () => {
                  const res = await control.confirmAct('runner.drain', { name: r.name });
                  if (res) { alert(res.ok ? (res.output || 'Drain initiated.') : 'Failed: ' + (res.error || res.output)); openDrawer(r.name); }
                },
              }),
          h('button', {
            class: 'btn', text: 'Duplicate',
            onclick: async () => {
              await capacity.addRunner(r.name);
              openDrawer(r.name);
            },
          }),
          h('button', {
            class: 'btn', text: 'Preview removal',
            onclick: async () => {
              const res = await control.confirmAct('runner.deregisterPreview', { name: r.name });
              if (res) alert(res.output || res.error || '(no output)');
            },
          }),
          h('button', {
            class: 'btn danger', text: 'Remove',
            onclick: async () => {
              const res = await control.confirmAct('runner.deregister', { name: r.name });
              if (res) { alert(res.ok ? 'Removed.\n\n' + (res.output || '') : 'Failed: ' + (res.error || res.output)); closeDrawer(); }
            },
          }),
          // Fetched rather than linked, because the endpoint needs the token
          // header and an <a href> cannot carry one. Contents are allowlisted and
          // redacted — see dashboard/lib/bundle.js.
          data.remote
            ? null
            : h('button', {
                class: 'btn', text: 'Diagnostics',
                title: 'Download a redacted diagnostic bundle. Credentials and _work are never included.',
                onclick: async () => {
                  try {
                    const resp = await fetch(`/api/runner/bundle?name=${encodeURIComponent(r.name)}`, {
                      headers: control.authHeaders(),
                    });
                    if (!resp.ok) return alert(`Could not build a bundle: ${resp.status}`);
                    const text = await resp.text();
                    const name = /filename="([^"]+)"/.exec(resp.headers.get('content-disposition') ?? '')?.[1]
                      ?? `bundle-${r.name}.txt`;
                    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
                    const a = Object.assign(document.createElement('a'), { href: url, download: name });
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (err) {
                    alert(`Could not build a bundle: ${err.message}`);
                  }
                },
              })
        )
      : null,

    h('h4', { text: 'Recent jobs on this runner' }),
    data.jobs?.length
      ? h('div', { class: 'mini' },
          h('ul', {}, data.jobs.map((j) => {
            const state = j.conclusion ?? j.status ?? 'unknown';
            // A running job has no duration yet — show how long it has been at it.
            const took = j.duration_ms != null
              ? dur(j.duration_ms)
              : j.started_at ? `${dur(Date.now() - new Date(j.started_at).getTime())} so far` : '–';
            return h('li', {}, `${state.replace('_', ' ')} · `,
              h('a', { href: j.html_url, target: '_blank', rel: 'noreferrer', text: j.name }),
              ` · ${took} · ${ago(j.started_at)} ago`);
          }))
        )
      : h('div', { class: 'empty', text: 'No jobs recorded yet — history starts when the collector does.' }),
    h('h4', { text: 'State changes' }),
    data.events?.length
      ? h('div', { class: 'mini' },
          h('ul', {}, data.events.map((e) => h('li', { text: `${new Date(e.ts).toLocaleString()} — ${e.detail}` })))
        )
      : h('div', { class: 'empty', text: 'No transitions recorded.' }),
    h('h4', { text: 'Latest _diag' }),
    data.diag
      ? h('pre', { class: 'diag', text: data.diag.tail })
      : h('div', { class: 'empty', text: 'no _diag log found' })
  );
}

// Repo detail: the same drawer, opened from a repo name anywhere in the UI.
async function openRepoDrawer(repo) {
  openDrawerShell(`Repository detail: ${repo}`);
  mount($('#drawer-body'), emptyState({
    asset: '/assets/empty-runs.svg',
    eyebrow: 'Repository detail',
    title: 'Loading run history',
    copy: 'Comparing job duration, queue time, and recent outcomes.',
    loading: true,
    compact: true,
  }));
  let d;
  try {
    d = await (await fetch(`/api/repo?name=${encodeURIComponent(repo)}`)).json();
  } catch {
    mount($('#drawer-body'), h('div', { class: 'empty', text: 'could not load repo detail' }));
    return;
  }

  const jobRows = d.jobs.filter((j) => j.p50 != null).slice(0, 10).map((j) => ({
    label: `${j.workflow} · ${j.name}`,
    value: j.p50,
    marker: j.p95,
    title: `${j.samples} runs · p50 ${fmtMs(j.p50)} · p95 ${fmtMs(j.p95)}`,
    note: j.p50Queue ? `queue ${fmtMs(j.p50Queue)}` : '',
  }));

  const steps = d.stepBreakdown?.steps?.filter((s) => s.p50 != null).slice(0, 12) ?? [];
  const stepRows = steps.map((s) => ({
    label: s.name,
    value: s.p50,
    marker: s.p95,
    title: `${s.samples} samples · p50 ${fmtMs(s.p50)} · p95 ${fmtMs(s.p95)}`,
  }));

  mount($('#drawer-body'),
    h('h3', { text: repo }),
    h('div', { class: 'sub', text: `${d.runs.length} recent runs · ${d.jobs.length} distinct jobs in the last 30 days` }),

    h('h4', { text: 'Job durations (p50, tick at p95)' }),
    jobRows.length
      ? barChart(jobRows, { markerLabel: 'p95' })
      : h('div', { class: 'empty', text: 'No job detail captured yet for this repo.' }),

    d.stepBreakdown && stepRows.length
      ? [
          h('h4', { text: `Inside the slowest job — ${d.stepBreakdown.job}` }),
          barChart(stepRows, { markerLabel: 'p95' }),
        ]
      : null,

    h('h4', { text: 'Recent runs' }),
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Result' }), h('th', { scope: 'col', text: 'Workflow' }),
        h('th', { scope: 'col', text: 'Branch' }), h('th', { scope: 'col', class: 'num', text: 'Took' }),
        h('th', { scope: 'col', text: 'When' })
      )),
      h('tbody', {}, d.runs.slice(0, 20).map((r) =>
        h('tr', {},
          h('td', {}, h('span', { class: `status ${r.conclusion ?? r.status}`, text: (r.conclusion ?? r.status ?? '–').replace('_', ' ') })),
          h('td', {}, h('a', { href: r.html_url, target: '_blank', rel: 'noreferrer', text: r.workflow_name })),
          h('td', { class: 'mono', text: r.head_branch ?? '–' }),
          h('td', { class: 'num', text: r.conclusion === 'cancelled' ? '–' : fmtMs(r.duration_ms) }),
          h('td', { text: `${ago(r.run_started_at)} ago` })
        )
      ))
    )
  );
}
setRepoOpener(openRepoDrawer);
control.setSnapshotSource(() => snap ?? { runners: [], repos: [] });
alerts.setSnapshotSource(() => snap);
capacity.setSnapshotSource(() => snap);

// Fetched at startup, not when the Control tab is first opened. The action
// catalogue carries the confirmation text, and confirmAct cannot show a dialog
// for an action it has never heard of — so without this, the destructive buttons
// on the Fleet tab would act with no confirmation for anyone who had not visited
// Control first. Read-only, and needs no token.
control.loadCatalogue().then(renderAccessBanner);

fetch('/api/access').then((r) => r.json()).then((d) => {
  accessCtx = d;
  renderAccessBanner();
}).catch(() => {});

window.addEventListener('fleet:paired', () => {
  renderAccessBanner();
  setView('control');
});

for (const el of document.querySelectorAll('[data-close]')) {
  el.addEventListener('click', () => closeDrawer());
}
window.addEventListener('popstate', () => {
  if (drawerOpen && !history.state?.drawer) closeDrawer({ fromHistory: true });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#more-sheet')?.classList.contains('is-open')) {
    e.preventDefault();
    closeMoreSheet();
    return;
  }
  const drawer = $('#drawer');
  if (drawer.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = [...drawer.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// -------------------------------------------------------------------- shell

function render() {
  if (!snap) return;
  updateConnectionIndicator();
  renderHeader(snap);
  renderFederationSummary(snap);
  // The live KPI row and drift list belong to the operational tabs. Analytics
  // brings its own KPIs for the selected window; showing both stacks two
  // different meanings of "runs" on one screen.
  const live = view === 'fleet' || view === 'runs';
  $('#kpis').classList.toggle('is-hidden', !live);
  $('#drift').classList.toggle('is-hidden', !live);
  if (live) {
    renderKpis(snap);
    renderDrift(snap);
    if (view === 'fleet') { renderGlanceCard(snap); renderFleet(snap); }
    else renderRuns(snap);
  } else if (view === 'control') {
    control.render();
  } else if (view === 'alerts') {
    alerts.render();
  } else if (view === 'capacity') {
    capacity.render();
  } else if (view === 'hosts') {
    hosts.render();
  }
  renderFooter(snap);
  syncNavBadges();
  renderAccessBanner();
}

function renderFooter(s) {
  const c = s.collector ?? {};
  const api = s.api ?? {};
  mount($('#footer'),
    h('span', { text: `collector ${c.durationMs ?? '?'}ms · every ${Math.round((c.fastMs ?? 0) / 1000)}s` }),
    h('span', { text: `api ${api.remaining ?? '?'}/${api.limit ?? '?'} left` }),
    h('span', { text: `token ${c.tokenSource ?? 'none'}` }),
    h('span', { text: `roster ${c.lastSlow ? ago(new Date(c.lastSlow).toISOString()) + ' ago' : 'pending'}` }),
    // Retries are information, not a problem: GitHub 503s occasionally and the
    // client absorbs it. Showing the count keeps that visible without dressing
    // a recovered blip up as an error.
    c.transientRetries ? h('span', { text: `${c.transientRetries} retried` }) : null,
    c.lastError ? h('span', { class: 'err', text: c.lastError }) : null
  );
}

function setView(name, { fromHistory = false } = {}) {
  const changed = view !== name;
  view = name;
  // The hash makes the tab bookmarkable and gives Back something to return to.
  // A drawer open over the old tab gives up its history entry to the new tab
  // rather than leaving a dead "close the drawer" step behind it. Navigation
  // that came from history (Back, a typed hash) must not push, or it would
  // wipe the forward stack.
  const hashTarget = `#/${name}`;
  if (drawerOpen) closeDrawer({ fromHistory: true });
  if (!fromHistory && location.hash !== hashTarget) {
    if (history.state?.drawer) history.replaceState(null, '', hashTarget);
    else history.pushState(null, '', hashTarget);
  }
  if (changed) window.scrollTo({ top: 0 });
  for (const t of document.querySelectorAll('.tab')) {
    const active = t.dataset.view === name;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
  }
  for (const n of ['fleet', 'runs', 'analytics', 'lint', 'alerts', 'capacity', 'control', 'hosts']) {
    const panel = $(`#view-${n}`);
    const active = name === n;
    panel.classList.toggle('is-hidden', !active);
    panel.setAttribute('aria-hidden', String(!active));
  }
  const activePanel = $(`#view-${name}`);
  activePanel.classList.remove('is-entering');
  // Restart only on navigation, never on the 15-second SSE refresh.
  void activePanel.offsetWidth;
  activePanel.classList.add('is-entering');
  setTimeout(() => activePanel.classList.remove('is-entering'), 320);
  // Analytics is a 30-day aggregate, so it is fetched the first time it is
  // opened rather than pushed with every live snapshot.
  if (name === 'analytics' && !analyticsLoaded) {
    analyticsLoaded = true;
    loadAnalytics();
  }
  if (name === 'control') control.loadCatalogue().then(() => control.render());
  // The catalogue too, because the sizing panel's Add button goes through
  // confirmAct and needs the action's confirm text to show a dialog.
  if (name === 'capacity') {
    Promise.all([capacity.loadSettings(), control.loadCatalogue()]).then(() => capacity.render());
  }
  if (name === 'alerts') {
    alerts.loadAlerts();
    startAlertsPolling();
  } else {
    stopAlertsPolling();
  }
  if (name === 'lint' && !lintLoaded) { lintLoaded = true; lint.loadLint(); }
  // Reloaded on every visit rather than cached: the whole point of this view is
  // heartbeat freshness, and a cached copy of it would be self-defeating.
  if (name === 'hosts') hosts.setActive(true);
  else hosts.setActive(false);
  syncBottomNav(name);
  render();
}

// Navigate to a tab from a KPI card. If already on the target tab only scroll;
// otherwise switch the tab and then scroll. Focus moves to the tab button so
// keyboard users have a consistent landmark after activation.
function kpiNav(tabName, scrollTarget) {
  return () => {
    if (view !== tabName) setView(tabName);
    $(`#tab-${tabName}`)?.focus();
    if (scrollTarget) {
      requestAnimationFrame(() => {
        const el = $(scrollTarget);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  };
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}

// ---------------------------------------------------------------- bottom nav
// Mirrors the top tabs on small screens. The More button opens a sheet that
// shows the secondary tabs (Analytics, Lint, Capacity, Control).

function syncBottomNav(viewName) {
  const primaryViews = ['fleet', 'runs', 'alerts', 'hosts'];
  for (const btn of document.querySelectorAll('#bottom-nav .bnav-btn')) {
    const v = btn.dataset.view;
    const active = v === viewName || (v === 'more' && !primaryViews.includes(viewName));
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const btn of document.querySelectorAll('.more-sheet-btn')) {
    btn.classList.toggle('is-active', btn.dataset.view === viewName);
  }
}

function closeMoreSheet() {
  const sheet = $('#more-sheet');
  if (sheet) sheet.classList.remove('is-open');
}

// Bottom nav button clicks
document.querySelectorAll('#bottom-nav .bnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'more') {
      const sheet = $('#more-sheet');
      if (sheet) sheet.classList.toggle('is-open');
    } else {
      closeMoreSheet();
      setView(btn.dataset.view);
    }
  });
});

// More sheet secondary tab buttons
document.querySelectorAll('.more-sheet-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    closeMoreSheet();
    setView(btn.dataset.view);
  });
});

$('#more-sheet-scrim')?.addEventListener('click', closeMoreSheet);

// Sync bottom nav badge counts with top nav badges
function syncNavBadges() {
  const runsBadge   = $('#runs-badge');
  const alertsBadge = $('#alerts-badge');
  const bnavRuns    = $('#bnav-runs-badge');
  const bnavAlerts  = $('#bnav-alerts-badge');
  if (bnavRuns && runsBadge) {
    bnavRuns.textContent = runsBadge.textContent;
    bnavRuns.hidden = runsBadge.hidden;
  }
  if (bnavAlerts && alertsBadge) {
    bnavAlerts.textContent = alertsBadge.textContent;
    bnavAlerts.hidden = alertsBadge.hidden;
  }
}

// The tablist remains fully usable without a pointer. Arrow keys move and
// activate together, matching the dashboard's immediate (non-destructive) tabs.
$('.tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.tab')];
  const at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? tabs.length - 1
      : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
});

function syncThemeToggle() {
  const explicit = document.documentElement.getAttribute('data-theme');
  const dark = explicit === 'dark'
    || (!explicit && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const mode = explicit || `system ${dark ? 'dark' : 'light'}`;
  const label = `Theme: ${mode}. Switch to ${dark ? 'light' : 'dark'}`;
  $('#theme-toggle').title = label;
  $('#theme-toggle').setAttribute('aria-label', label);
}

$('#theme-toggle').addEventListener('click', () => {
  const explicit = document.documentElement.getAttribute('data-theme');
  const dark = explicit === 'dark'
    || (!explicit && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('fleet-theme', next);
  syncThemeToggle();
});
const savedTheme = localStorage.getItem('fleet-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeToggle);
syncThemeToggle();

// ---------------------------------------------------------------- hash routing
// #/runs, #/alerts, #/hosts … are bookmarkable and restored on refresh.
// setView() pushes one entry per tab change; an open drawer adds one more
// (see openDrawerShell) so Back closes it first.

const VIEWS = ['fleet', 'runs', 'analytics', 'lint', 'alerts', 'capacity', 'hosts', 'control'];

function viewFromHash() {
  const name = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(name) ? name : 'fleet';
}

function applyHash() {
  const name = viewFromHash();
  if (name !== view) setView(name, { fromHistory: true });
}

window.addEventListener('hashchange', applyHash);
applyHash();

// ---------------------------------------------------------------- SSE connect
// Exponential backoff on reconnect (1s → 2 → 4 → 8 → 16 → 30s cap, jittered
// so a restarted daemon is not hit by every phone in the same second).
// The last snapshot stays on screen through an outage, labelled as such —
// blanking the page tells the operator less than showing what we last knew.

let activeEs = null;
let sseBackoffMs = 1000;
let sseReconnectTimer = null;
let elapsedTimerPaused = false;

function acceptSnapshot(next) {
  if (!next || typeof next !== 'object') return;
  // A cached or slow /api/state response must not overwrite a newer SSE push.
  if (snap?.ts && next.ts && next.ts < snap.ts) return;
  snap = next;
  render();
}

function refreshState() {
  return fetch('/api/state', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then(acceptSnapshot)
    .catch(() => {});
}

function connect() {
  clearTimeout(sseReconnectTimer);
  if (activeEs) { activeEs.close(); activeEs = null; }
  const es = new EventSource('/api/stream');
  activeEs = es;
  es.onopen = () => {
    sseBackoffMs = 1000;
    streamConnected = true;
    everConnected = true;
    updateConnectionIndicator();
  };
  es.onmessage = (e) => {
    streamConnected = true;
    try { acceptSnapshot(JSON.parse(e.data)); } catch { /* partial frame — the next push replaces it */ }
  };
  es.onerror = () => {
    streamConnected = false;
    updateConnectionIndicator();
    es.close();
    if (activeEs === es) activeEs = null;
    sseReconnectTimer = setTimeout(connect, sseBackoffMs * (0.75 + Math.random() * 0.5));
    sseBackoffMs = Math.min(sseBackoffMs * 2, 30000);
  };
}

// iOS and Android freeze background tabs, often leaving an EventSource that
// looks open but will never deliver again. On return, reconnect only when the
// stream is actually suspect, so flicking between apps does not churn it.
function resumeIfStale() {
  const age = snapshotAgeMs();
  const fastMs = snap?.collector?.fastMs ?? 15000;
  const suspect = !activeEs || activeEs.readyState !== EventSource.OPEN
    || age == null || age > fastMs * 3;
  if (suspect) {
    sseBackoffMs = 1000;
    connect();
    refreshState();
  }
  pollHealth();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    elapsedTimerPaused = false;
    resumeIfStale();
  } else {
    elapsedTimerPaused = true;
  }
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) resumeIfStale();
});
window.addEventListener('online', resumeIfStale);
window.addEventListener('offline', updateConnectionIndicator);

// Elapsed timers must tick between snapshots, or a build that started two
// minutes ago reads "15s" for as long as the fleet stays quiet.
// Paused when tab is hidden to save battery.
setInterval(() => {
  if (elapsedTimerPaused) return;
  if (snap && (snap.active ?? []).length) render();
}, 1000);

// Staleness is its own signal: a dashboard that silently stops updating is
// worse than one that says it has. /api/health is polled for the authoritative
// collector-stalled verdict; snapshot age fills in between polls.
setInterval(updateConnectionIndicator, 5000);
setInterval(pollHealth, 30000);
pollHealth();

connect();
// Paints before the first SSE push arrives, and — through the service worker's
// cached copy — gives an offline launch something to show.
refreshState();
loadRemediation();
setInterval(loadRemediation, 120_000);
control.maybeExchangePairCode();

// Every table gets a horizontal scroll container, so a wide one scrolls inside
// its panel instead of widening the whole page on a phone. Done once here
// rather than at each of the many places a table is built.
function wrapTables(root) {
  const tables = root.tagName === 'TABLE' ? [root] : root.querySelectorAll('table');
  for (const table of tables) {
    if (!table.parentElement || table.parentElement.classList.contains('table-scroll')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) if (node.nodeType === 1) wrapTables(node);
  }
}).observe(document.body, { childList: true, subtree: true });
wrapTables(document.body);

// Register service worker only on secure contexts (localhost or HTTPS/Tailscale).
// Plain LAN HTTP will not get a service worker — see docs/remote-access.md.
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
