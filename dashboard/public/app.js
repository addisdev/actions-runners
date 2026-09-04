// The whole client. No framework, no build step — see ../README.md for why.
// The daemon pushes a complete snapshot over SSE; this file only renders it.

import { loadAnalytics, setRepoOpener } from './analytics.js';
import * as control from './control.js';
import * as alerts from './alerts.js';
import * as lint from './lint.js';
import * as capacity from './capacity.js';
import * as hosts from './hosts.js';
import { barChart, fmtMs } from './charts.js';

const $ = (sel) => document.querySelector(sel);
let snap = null;
let view = 'fleet';
let analyticsLoaded = false;
let lintLoaded = false;
let firstKpiPaint = true;
let lastDrawerFocus = null;
let drawerCloseTimer = null;

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

// Severity of a fraction, so the meters and their labels always agree.
function bandFor(frac, { warn = 0.7, serious = 0.85, critical = 0.95 } = {}) {
  if (frac >= critical) return 'critical';
  if (frac >= serious) return 'serious';
  if (frac >= warn) return 'warning';
  return 'good';
}

// ------------------------------------------------------------------- header

function renderHeader(s) {
  const host = s.host ?? {};
  $('#host-name').textContent = host.hostname ?? 'fleet';
  $('#host-meta').textContent = host.cores
    ? `${host.cores} cores · ${Math.round((host.memTotalMb ?? 0) / 1024)} GB · ${host.platform} · up ${dur((host.uptimeSec ?? 0) * 1000)}`
    : '';

  const badge = (selector, count, label) => {
    const el = $(selector);
    el.hidden = !count;
    el.textContent = count > 99 ? '99+' : String(count);
    el.setAttribute('aria-label', `${count} ${label}`);
  };
  badge('#runs-badge', (s.active ?? []).length, 'active or queued runs');
  badge('#alerts-badge', s.collector?.alerts?.open ?? 0, 'open alerts');
}

function statTile({ label, value, unit, sub, tone, meter }) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: `kpi-value ${tone ?? ''}` }, String(value), unit ? h('span', { class: 'unit', text: unit }) : null),
    sub ? h('div', { class: 'kpi-sub', text: sub }) : null,
    meter ? h('div', { class: `meter ${meter.tone}` }, h('i', { style: `width:${Math.min(100, meter.pct)}%` })) : null
  );
}

function renderKpis(s) {
  const host = s.host ?? {};
  const runners = s.runners ?? [];
  // This tile has to abstain on the same terms the drift rules do. They already
  // refuse to judge a runner whose GitHub state could not be fetched; if the
  // tile still counted those as "not online" it would show a red 0/16 during
  // exactly the API blackout the abstain logic exists to ride out — the tile
  // contradicting the rules directly beneath it.
  const unread = runners.filter((r) => r.ghUnknown).length;
  const registered = runners.filter((r) => r.registered && !r.ghUnknown);
  const online = registered.filter((r) => r.ghStatus === 'online').length;
  const allUnread = runners.length > 0 && unread === runners.length;
  const busy = runners.filter((r) => r.workingLocally || r.ghBusy).length;
  const queued = (s.active ?? []).filter((r) => r.status === 'queued').length;
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
          ? 'no runners installed on this host'
          : online === registered.length
            ? `all registered runners up${unread ? ` · ${unread} unread` : ''}`
            : `${registered.length - online} not reporting${unread ? ` · ${unread} unread` : ''}`,
      // Unread is muted, never red: not knowing is not the same as being down.
      tone: allUnread || !registered.length
        ? undefined
        : online === registered.length ? 'good' : 'critical',
    }),
    statTile({
      label: 'Building now',
      value: busy,
      sub: queued ? `${queued} queued` : 'nothing queued',
      tone: busy ? 'busy' : undefined,
    }),
    statTile({
      label: 'Open alerts',
      value: s.collector?.alerts?.open ?? 0,
      sub: (s.collector?.alerts?.open ?? 0) ? 'see the Alerts tab' : 'nothing firing',
      tone: (s.collector?.alerts?.open ?? 0) ? 'warning' : 'good',
    }),
    statTile({
      label: 'Drift',
      value: problems.length,
      sub: problems.length ? problems[0].kind.replace(/-/g, ' ') : 'fleet and GitHub agree',
      tone: problems.length ? problems[0].severity : 'good',
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
    }),
    statTile({
      label: 'Load',
      value: (host.load1 ?? 0).toFixed(2),
      unit: `of ${host.cores ?? '?'}`,
      sub: `5m ${(host.load5 ?? 0).toFixed(2)} · 15m ${(host.load15 ?? 0).toFixed(2)}`,
      meter: { pct: loadFrac * 100, tone: bandFor(loadFrac) },
    }),
    statTile({
      label: 'Disk free',
      value: gb(host.diskFreeGb),
      unit: 'GB',
      sub: `of ${gb(host.diskTotalGb)} GB · ${runners.length} runners, ${Math.round(host.totalRssMb ?? 0)} MB resident`,
      meter: { pct: diskFrac * 100, tone: bandFor(diskFrac, { warn: 0.8, serious: 0.9, critical: 0.95 }) },
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

function runnerTile(s, r) {
  const state = runnerState(r);
  const current = currentJobFor(s, r);
  return h('button', { class: `runner state-${state}`, onclick: () => openDrawer(r.name) },
    h('div', { class: 'runner-top' },
      h('span', { class: 'runner-name', text: r.name.replace(/^[^-]+-/, '') }),
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

function renderFleet(s) {
  const groups = new Map();
  for (const r of s.runners ?? []) {
    if (!groups.has(r.project)) groups.set(r.project, []);
    groups.get(r.project).push(r);
  }
  const order = s.projects ?? ['other'];
  const keys = [...groups.keys()].sort((a, b2) => {
    const ia = order.indexOf(a), ib = order.indexOf(b2);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  // Per-project busy counts for the heading lines
  const busyByProject = new Map();
  for (const r of s.runners ?? []) {
    if (r.workingLocally || r.ghBusy) {
      busyByProject.set(r.project, (busyByProject.get(r.project) ?? 0) + 1);
    }
  }

  mount($('#fleet'),
    h('div', { class: 'section-head' },
      h('h2', { text: 'Runners' }),
      h('span', { class: 'count', text: `${(s.runners ?? []).length} on this host` })
    ),
    keys.length
      ? keys.map((k) => {
          const list = groups.get(k).sort((a, b2) => a.name.localeCompare(b2.name));
          const busy = busyByProject.get(k) ?? 0;
          return h('div', { class: 'project' },
            h('div', { class: 'project-head' },
              k,
              busy ? h('span', { class: 'busy-badge', text: `${busy} building` }) : null,
              h('span', { class: 'rule' })
            ),
            h('div', { class: 'grid' }, list.map((r) => runnerTile(s, r)))
          );
        })
      : s.starting
        ? emptyState({
            asset: '/assets/empty-fleet.svg',
            eyebrow: 'Starting collector',
            title: 'Reading the fleet',
            copy: 'Connecting local runners, GitHub state, and host telemetry.',
            loading: true,
          })
        : emptyState({
            asset: '/assets/empty-fleet.svg',
            eyebrow: 'Remote view',
            title: 'No runners on this host',
            copy: `No runner directories under ${s.host?.root ?? '~/actions-runners'}. Runs below are still live from GitHub.`,
          }),
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
    (s.elsewhere ?? []).filter((e) => !e.ephemeral).length
      ? h('div', { class: 'project' },
          h('div', { class: 'project-head' }, 'registered elsewhere', h('span', { class: 'rule' })),
          h('div', { class: 'rows' },
            s.elsewhere.filter((e) => !e.ephemeral).map((e) =>
              h('div', { class: 'row' },
                h('span', { class: `status ${e.ghStatus}`, text: e.ghStatus }),
                h('span', { class: 'repo', text: e.repo.split('/').pop() }),
                h('span', { class: 'wf', text: e.name }),
                h('span', { class: 'branch', text: e.extraLabels.join(' ') }),
                h('span', { class: 'time', text: e.ghBusy ? 'busy' : '' }),
                h('span', { class: 'where', text: 'no directory here' })
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
          return h('div', { class: `row ${waitMs > 5 * 60 * 1000 ? 'is-queued' : ''}` },
            h('span', { class: 'status queued', text: 'queued' }),
            h('span', { class: 'repo', text: q.repo.split('/').pop() }),
            h('span', { class: 'wf', text: q.workflowName }),
            h('span', { class: 'branch' },
              labels.map((l) => h('span', { class: 'chip', text: l }))),
            h('span', { class: 'time', text: dur(waitMs) }),
            h('span', { class: 'where', text: '' })
          );
        })
      )
    );
  } else {
    mount($('#fleet-queue'));
  }

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

function runRow(r, { live }) {
  const status = r.status === 'completed' ? r.conclusion ?? 'completed' : r.status;
  const elapsed = live
    ? Date.now() - new Date(r.status === 'queued' ? r.createdAt : r.startedAt).getTime()
    : r.durationMs;
  // Prefer displayTitle (GitHub's own label) then headCommitMsg; fall back to workflowName.
  const title = r.displayTitle || r.headCommitMsg || r.workflowName;
  const subtitle = title !== r.workflowName ? r.workflowName : null;
  return h('div', { class: `row ${r.status === 'queued' ? 'is-queued' : r.status === 'in_progress' ? 'is-running' : ''}` },
    h('span', { class: `status ${status}`, text: status.replace('_', ' ') }),
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
      r.runAttempt > 1 ? h('span', { class: 'chip', text: `attempt ${r.runAttempt}` }) : null),
    h('span', { class: 'time', text: dur(elapsed) }),
    h('span', { class: 'where' },
      live ? (r.runnerName ?? 'unassigned') : `${ago(r.updatedAt)} ago`,
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
}

function renderRuns(s) {
  const active = s.active ?? [];
  mount($('#active'),
    h('div', { class: 'section-head' },
      h('h2', { text: 'Active' }),
      h('span', { class: 'count', text: `${active.length} running or queued` })
    ),
    active.length
      ? h('div', { class: 'rows' }, active.map((r) => runRow(r, { live: true })))
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
    h('div', { class: 'rows' }, recent.map((r) => runRow(r, { live: false })))
  );
}

// ------------------------------------------------------------------ drawer

function openDrawerShell(label) {
  const drawer = $('#drawer');
  const panel = drawer.querySelector('.drawer-panel');
  if (drawer.hidden) lastDrawerFocus = document.activeElement;
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

function closeDrawer() {
  const drawer = $('#drawer');
  if (drawer.hidden) return;
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
    data = await (await fetch(`/api/runner?name=${encodeURIComponent(name)}`)).json();
  } catch {
    mount($('#drawer-body'),h('div', { class: 'empty', text: 'could not load runner detail' }));
    return;
  }
  const r = data.runner;
  mount($('#drawer-body'),
    h('h3', { text: r.name }),
    h('div', { class: 'sub', text: `${r.repo} · ${STATE_WORD[runnerState(r)]}` }),
    h('dl', { class: 'kv' },
      h('dt', { text: 'launchd' }), h('dd', { text: `${r.launchdState}${r.lastExit != null ? ` (last exit ${r.lastExit})` : ''}` }),
      h('dt', { text: 'label' }), h('dd', { text: r.launchdLabel }),
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
      h('dt', { text: 'directory' }), h('dd', { text: r.dir }),
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
          h('button', {
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
        h('th', { text: 'Result' }), h('th', { text: 'Workflow' }),
        h('th', { text: 'Branch' }), h('th', { class: 'num', text: 'Took' }), h('th', { text: 'When' })
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
control.loadCatalogue();

for (const el of document.querySelectorAll('[data-close]')) {
  el.addEventListener('click', closeDrawer);
}
document.addEventListener('keydown', (e) => {
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
  renderHeader(snap);
  // The live KPI row and drift list belong to the operational tabs. Analytics
  // brings its own KPIs for the selected window; showing both stacks two
  // different meanings of "runs" on one screen.
  const live = view === 'fleet' || view === 'runs';
  $('#kpis').classList.toggle('is-hidden', !live);
  $('#drift').classList.toggle('is-hidden', !live);
  if (live) {
    renderKpis(snap);
    renderDrift(snap);
    if (view === 'fleet') renderFleet(snap);
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

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    view = tab.dataset.view;
    for (const t of document.querySelectorAll('.tab')) {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    }
    for (const name of ['fleet', 'runs', 'analytics', 'lint', 'alerts', 'capacity', 'control', 'hosts']) {
      const panel = $(`#view-${name}`);
      const active = view === name;
      panel.classList.toggle('is-hidden', !active);
      panel.setAttribute('aria-hidden', String(!active));
    }
    const activePanel = $(`#view-${view}`);
    activePanel.classList.remove('is-entering');
    // Restart only on navigation, never on the 15-second SSE refresh.
    void activePanel.offsetWidth;
    activePanel.classList.add('is-entering');
    setTimeout(() => activePanel.classList.remove('is-entering'), 320);
    // Analytics is a 30-day aggregate, so it is fetched the first time it is
    // opened rather than pushed with every live snapshot.
    if (view === 'analytics' && !analyticsLoaded) {
      analyticsLoaded = true;
      loadAnalytics();
    }
    if (view === 'control') control.loadCatalogue().then(() => control.render());
    // The catalogue too, because the sizing panel's Add button goes through
    // confirmAct and needs the action's confirm text to show a dialog.
    if (view === 'capacity') {
      Promise.all([capacity.loadSettings(), control.loadCatalogue()]).then(() => capacity.render());
    }
    if (view === 'alerts') alerts.loadAlerts();
    if (view === 'lint' && !lintLoaded) { lintLoaded = true; lint.loadLint(); }
    // Reloaded on every visit rather than cached: the whole point of this view is
    // heartbeat freshness, and a cached copy of it would be self-defeating.
    if (view === 'hosts') hosts.loadHosts();
    render();
  });
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

// Elapsed timers must tick between snapshots, or a build that started two
// minutes ago reads "15s" for as long as the fleet stays quiet.
setInterval(() => { if (snap && (snap.active ?? []).length) render(); }, 1000);

// Staleness is its own signal: a dashboard that silently stops updating is
// worse than one that says it has.
setInterval(() => {
  if (!snap) return;
  const age = Date.now() - snap.ts;
  $('#stale').textContent = age > 120000 ? `stale — last update ${dur(age)} ago` : '';
}, 5000);

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    $('#conn-dot').className = 'dot is-live';
    $('#conn-label').textContent = 'Live';
    $('.brand-symbol').classList.remove('is-offline', 'is-connecting');
  };
  es.onmessage = (e) => { snap = JSON.parse(e.data); render(); };
  es.onerror = () => {
    $('#conn-dot').className = 'dot is-dead';
    $('#conn-label').textContent = 'Reconnecting';
    $('.brand-symbol').classList.remove('is-connecting');
    $('.brand-symbol').classList.add('is-offline');
    es.close();
    setTimeout(connect, 3000);
  };
}
connect();
