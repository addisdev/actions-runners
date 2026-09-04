// The alerts view: what is open now, and what has fired recently.

import { chartEl as h } from './charts.js';

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

let data = null;
let loading = false;
// Collector telemetry comes from the live snapshot rather than /api/alerts, so
// this shows the same numbers as the footer instead of a second copy that could
// quietly disagree with it.
let getSnapshot = () => null;

export function setSnapshotSource(fn) { getSnapshot = fn; }

const ago = (ts) => {
  if (!ts) return '–';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export async function loadAlerts() {
  if (loading) return;
  loading = true;
  try {
    data = await (await fetch('/api/alerts')).json();
  } catch {
    data = null;
  } finally {
    loading = false;
  }
  render();
}

// The collector panel reports freshness from the live snapshot, but the list
// below it comes from /api/alerts and is only fetched when the tab opens. Left
// alone, this page would claim "collected 3s ago" above a list that was minutes
// old — a freshness indicator lying about the thing directly beneath it. The
// snapshot already carries the open count, so a mismatch is the cue to refetch:
// exactly when something changed, and never otherwise.
function refetchIfCountMoved() {
  if (loading || !data) return;
  const open = getSnapshot()?.collector?.alerts?.open;
  if (open != null && open !== (data.open?.length ?? 0)) loadAlerts();
}

export function render() {
  const root = document.querySelector('#view-alerts');
  if (!root) return;
  refetchIfCountMoved();

  if (!data) return mount(root, h('div', { class: 'empty', text: 'Loading…' }));
  if (data.disabled) {
    return mount(root,
      h('div', { class: 'section-head' }, h('h2', { text: 'Alerts' })),
      h('div', { class: 'empty', text: 'Alerting is disabled (FLEET_ALERTS=0).' }));
  }

  const open = data.open ?? [];
  const channels = data.channels ?? {};

  const channelLine =
    `Delivering to: ${[channels.macos && 'macOS notifications', channels.webhook && 'webhook']
      .filter(Boolean).join(', ') || 'nothing — no channel is configured'}.` +
    (channels.webhook ? '' : ' A webhook (ntfy, Pushover, Slack) is off until you configure one in alerts.config.json.');

  const head = h('div', { class: 'section-head' },
    h('h2', { text: 'Alerts' }),
    h('span', { class: 'count', text: open.length ? `${open.length} open` : 'nothing open' })
  );

  const openPanel = open.length
    ? h('div', { class: 'drift-list' },
        open.map((a) =>
          h('div', { class: `drift-item ${a.severity}` },
            h('span', { class: 'drift-sev', text: a.severity }),
            h('span', { class: 'drift-subject', text: `${ago(a.opened_at)} ago` }),
            h('span', { class: 'drift-detail' }, a.title,
              a.body ? h('span', { class: 'drift-hint', text: a.body }) : null)
          )
        )
      )
    : h('div', { class: 'all-clear' }, h('b', { text: '✓' }),
        ' Nothing is open. Alerts fire on transitions, so silence here means every condition is clear.');

  const recent = (data.recent ?? []).filter((r) => r.closed_at);
  const history = recent.length
    ? h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', { text: 'Resolved' })),
        h('div', { class: 'panel-sub', text: 'Alerts are stored as intervals, so how long each condition lasted is a fact, not a guess.' }),
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Severity' }), h('th', { text: 'What' }),
            h('th', { text: 'Opened' }), h('th', { class: 'num', text: 'Lasted' })
          )),
          h('tbody', {}, recent.slice(0, 20).map((r) =>
            h('tr', {},
              h('td', {}, h('span', { class: `status ${r.severity === 'critical' ? 'failure' : r.severity === 'warning' ? 'timed_out' : 'success'}`, text: r.severity })),
              h('td', { text: r.title }),
              h('td', { text: new Date(r.opened_at).toLocaleString() }),
              h('td', { class: 'num', text: ago(r.opened_at) === '–' ? '–' : humanSpan(r.closed_at - r.opened_at) })
            )
          ))
        )
      )
    : null;

  mount(root, head,
    collectorPanel(),
    backfillTrustPanel(),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Channels' })),
      h('div', { class: 'panel-sub', text: channelLine }),
      h('div', { class: 'panel-sub', text:
        'No load-average rule, on purpose: a single ordinary Xcode build drives this host past 100 on ' +
        '12 cores, so alerting on it would fire on healthy behaviour every day. No swap-level rule ' +
        'either — macOS never reclaims swap, so that number only ever climbs.' })
    ),
    openPanel,
    history
  );
}

// An empty alerts page means "nothing is wrong" only if the thing that would
// have noticed is actually running. Without this, a collector that cannot reach
// GitHub looks exactly like a healthy fleet — the most dangerous state a
// monitoring page can be in, because it is silent and reassuring at once.

// Shows backfill coverage and billing freshness so "no alerts" can be read with
// appropriate confidence — gaps in history or stale billing data explain away
// false silence in the "newly-failing" and "account-blocked" rules.
function backfillTrustPanel() {
  const snap = getSnapshot();
  if (!snap) return null;
  const bf = snap.collector?.backfill ?? {};
  const api = snap.api ?? {};

  const statusFor = (pct) =>
    pct == null ? 'muted' :
    pct < 50 ? 'critical' :
    pct < 90 ? 'warning' : 'good';

  const coveragePct = (() => {
    // Approximate coverage from in-memory backfill progress if available
    if (bf.done) return 100;
    if (bf.pending != null && bf.pending === 0) return 100;
    return null;
  })();

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Data coverage' }),
      coveragePct === 100
        ? h('span', { class: 'flag good', text: 'complete' })
        : bf.phase && bf.phase !== 'idle' && bf.phase !== 'complete'
          ? h('span', { class: 'flag warning', text: `backfill ${bf.phase}` })
          : null
    ),
    h('div', { class: 'panel-sub' },
      'The "newly-failing" and "account-blocked" rules read from job history. Coverage gaps mean those ' +
        'rules are watching an incomplete record — not a reason to distrust open alerts, but a reason ' +
        'to check the Analytics tab\'s coverage panel before concluding a pattern is absent.'
    ),
    h('table', { class: 'mini-table' },
      h('tbody', {},
        h('tr', {},
          h('td', { text: 'Backfill phase' }),
          h('td', { class: 'mono', text: bf.phase ?? '–' })
        ),
        h('tr', {},
          h('td', { text: 'Pending runs (no job detail yet)' }),
          h('td', { class: `mono ${(bf.pending ?? 0) > 0 ? 'fail' : ''}`, text: String(bf.pending ?? '–') })
        ),
        h('tr', {},
          h('td', { text: 'Failures not yet classified' }),
          h('td', { class: `mono ${(bf.unclassified ?? 0) > 0 ? '' : ''}`, text: String(bf.unclassified ?? '–') })
        ),
        h('tr', {},
          h('td', { text: 'API rate remaining' }),
          h('td', { class: 'mono', text: api.remaining != null ? `${api.remaining}/${api.limit ?? '?'}` : '–' })
        )
      )
    )
  );
}

function collectorPanel() {
  const snap = getSnapshot();
  const c = snap?.collector;
  if (!c) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Collector' }),
        h('span', { class: 'flag serious', text: 'no data' })),
      h('div', { class: 'panel-sub', text:
        'No live snapshot — the page is not connected to the daemon, so the alert list below may be stale.' })
    );
  }

  const age = snap.ts ? Math.round((Date.now() - snap.ts) / 1000) : null;
  const stale = age != null && age > 120;
  const retries = c.transientRetries ?? 0;
  const failed = c.failedRepos ?? 0;

  const state = c.lastError ? 'error' : stale ? 'stale' : 'healthy';
  const flag = { error: 'serious', stale: 'warning', healthy: null }[state];

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Collector' }),
      flag ? h('span', { class: `flag ${flag}`, text: state }) : null
    ),
    h('div', { class: 'panel-sub', text:
      state === 'healthy'
        ? 'These rules are being evaluated. An empty list below therefore means nothing is wrong, ' +
          'rather than nothing is watching.'
        : 'Treat the list below with suspicion until this clears — the rules cannot see what the ' +
          'collector cannot fetch.' }),
    h('table', { class: 'mini-table' },
      h('tbody', {},
        h('tr', {},
          h('td', { text: 'Last collected' }),
          h('td', { class: 'mono', text: age == null ? '–' : `${age}s ago` })
        ),
        h('tr', {},
          h('td', { text: 'Repos failing this tick' }),
          h('td', { class: `mono ${failed ? 'fail' : ''}`, text: String(failed) })
        ),
        h('tr', {},
          h('td', { text: 'GitHub retries absorbed' }),
          // Retries are not failures — the client recovered. A rising count just
          // means GitHub has been flaky, which is worth seeing but not worth
          // colouring red.
          h('td', { class: 'mono', text: retries
            ? `${retries} since start — transient 5xx, recovered`
            : 'none' })
        ),
        c.lastError
          ? h('tr', {},
              h('td', { text: 'Current error' }),
              h('td', { class: 'mono fail', text: c.lastError.slice(0, 160) })
            )
          : null
      )
    )
  );
}

function humanSpan(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
