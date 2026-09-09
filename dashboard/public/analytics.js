// The analytics view. Fetched on demand rather than pushed over SSE: it is a
// 30-day aggregate that changes on the scale of minutes, and putting it in every
// live snapshot would ship the same kilobytes fifteen times a minute.

import { barChart, stackedBarChart, columnChart, fmtMs, fmtPct, chartEl as h } from './charts.js';

let state = { days: 30, data: null, loading: false, error: null };
let onOpenRepo = () => {};

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

const panel = (title, sub, ...body) =>
  h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: title })),
    sub ? h('div', { class: 'panel-sub', text: sub }) : null,
    ...body
  );

const statTile = ({ label, value, unit, sub, tone }) =>
  h('div', { class: 'kpi' },
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: `kpi-value ${tone ?? ''}` }, String(value),
      unit ? h('span', { class: 'unit', text: unit }) : null),
    sub ? h('div', { class: 'kpi-sub', text: sub }) : null
  );

export function setRepoOpener(fn) { onOpenRepo = fn; }

export async function loadAnalytics(days = state.days) {
  state.days = days;
  state.loading = true;
  state.error = null;
  render();
  try {
    const res = await fetch(`/api/analytics?days=${days}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    try {
      render();
    } catch (err) {
      // Rendering is part of loading the view. Without this guard, a bad data
      // shape leaves the previous "Loading…" DOM in place forever and only
      // reports the real failure in the browser console.
      state.data = null;
      state.error = `Could not render data: ${err.message}`;
      render();
    }
  }
}

export function render() {
  const root = document.querySelector('#view-analytics');
  if (!root) return;

  const rangeBar = h('div', { class: 'section-head' },
    h('h2', { text: 'Analytics' }),
    h('span', { class: 'count', text: state.data ? `${state.data.totals.runs} runs in window` : '' }),
    h('div', { class: 'range' },
      [7, 30, 90].map((d) =>
        h('button', {
          class: d === state.days ? 'is-active' : '',
          text: `${d}d`,
          onclick: () => loadAnalytics(d),
        })
      )
    )
  );

  if (state.error) return mount(root, rangeBar, h('div', { class: 'empty', text: `Could not load analytics: ${state.error}` }));
  if (!state.data) return mount(root, rangeBar, h('div', { class: 'empty', text: 'Loading…' }));

  const d = state.data;
  const t = d.totals;

  // ---- KPI row -------------------------------------------------------------
  const kpis = h('section', { class: 'kpis' },
    statTile({
      label: 'Runs', value: t.completedRuns,
      sub: `${t.jobs} jobs with detail captured`,
    }),
    statTile({
      label: 'Success rate',
      value: t.successRate == null ? '–' : fmtPct(t.successRate),
      sub: `${t.failures} failed of ${t.successes + t.failures} that ran`,
      tone: t.successRate == null ? undefined : t.successRate > 0.9 ? 'good' : t.successRate > 0.75 ? 'warning' : 'critical',
    }),
    statTile({
      label: 'CI time', value: Math.round(t.ciMinutes), unit: 'min',
      sub: 'on this fleet, billed to nobody',
    }),
    statTile({
      label: 'Allowance saved', value: Math.round(t.allowanceMinutes).toLocaleString(), unit: 'min',
      sub: 'macOS bills 10× against the included allowance',
      tone: 'good',
    }),
    statTile({
      label: 'Peak concurrency', value: d.concurrency.max, unit: 'jobs',
      sub: 'most jobs running at once on this host',
      tone: d.concurrency.max >= 4 ? 'warning' : undefined,
    }),
    statTile({
      label: 'Never scheduled', value: t.zombieRuns,
      sub: t.zombieRuns ? 'runs that queued until GitHub killed them' : 'every run got a runner',
      tone: t.zombieRuns ? 'serious' : 'good',
    })
  );

  // ---- the second-runner question -----------------------------------------
  const queueRows = d.repos
    .filter((r) => r.sampledRuns > 0)
    .slice(0, 12)
    .map((r) => ({
      label: r.name,
      queue: r.p50Queue ?? 0,
      exec: r.p50JobDuration ?? 0,
      note: r.verdict,
      noteTone: r.verdictTone,
    }));

  const secondRunner = panel(
    'Would a second runner help?',
    'Median queue wait against median job time, per repo. A second runner only helps a repo whose ' +
      'workflows have more than one job — one job cannot run twice, so the extra listener just sits idle. ' +
      'The verdict on the right applies that test to the measured jobs-per-run.',
    queueRows.length
      ? stackedBarChart(queueRows, {
          series: [
            { key: 'queue', label: 'queue wait (p50)', tone: 'series-2' },
            { key: 'exec', label: 'job time (p50)', tone: 'series-1' },
          ],
        })
      : h('div', { class: 'empty', text: 'No job detail captured yet — the backfill is still running.' })
  );

  // ---- slowest workflows ---------------------------------------------------
  const wfRows = d.workflows
    .filter((w) => w.p50 != null && w.timedRuns >= 2)
    .slice(0, 12)
    .map((w) => ({
      label: `${w.name} · ${w.workflow}`,
      value: w.p50,
      marker: w.p95,
      title: `${w.timedRuns} runs · p50 ${fmtMs(w.p50)} · p95 ${fmtMs(w.p95)}`,
      note: w.failureRate > 0 ? `${fmtPct(w.failureRate)} fail` : '',
      noteTone: w.failureRate >= 0.25 ? 'critical' : w.failureRate >= 0.1 ? 'warning' : '',
    }));

  const slowest = panel(
    'Where the wall-clock goes',
    'Median duration per workflow, with a tick at p95. Cancelled runs are excluded — their duration ' +
      'measures how long until something killed them, not how long the work takes.',
    wfRows.length
      ? barChart(wfRows, { markerLabel: 'p95' })
      : h('div', { class: 'empty', text: 'Not enough completed runs in this window.' })
  );

  // ---- never-scheduled runs ------------------------------------------------
  const zombiePanel = d.zombies.length
    ? panel(
        'Runs that queued until GitHub killed them',
        'A run cancelled after more than an hour never got a runner. Almost always a runs-on: label ' +
          'no live runner carries — these consume nothing but they hide real failures and make every ' +
          'success-rate number wrong.',
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Repo' }), h('th', { text: 'Workflow' }),
            h('th', { class: 'num', text: 'Runs' }), h('th', { class: 'num', text: 'Of total' }),
            h('th', { text: 'Last seen' })
          )),
          h('tbody', {}, d.zombies.map((z) =>
            h('tr', {},
              h('td', { class: 'mono linkish', text: z.name, onclick: () => onOpenRepo(z.repo) }),
              h('td', { text: z.workflow }),
              h('td', { class: 'num', text: z.count }),
              h('td', { class: 'num', text: fmtPct(z.count / z.runs) }),
              h('td', { text: (z.lastAt ?? '').slice(0, 10) })
            )
          ))
        )
      )
    : null;

  // ---- step level ----------------------------------------------------------
  const stepRows = d.steps.filter((s) => s.p50 != null).slice(0, 12).map((s) => ({
    label: `${s.name} · ${s.step}`,
    value: s.p50,
    marker: s.p95,
    title: `${s.workflow} · ${s.job}\n${s.samples} samples · p50 ${fmtMs(s.p50)} · p95 ${fmtMs(s.p95)}`,
    note: s.bimodal ? 'p95 ≫ p50 — cache misses' : '',
    noteTone: s.bimodal ? 'serious' : '',
  }));

  const steps = panel(
    'The costliest steps',
    'Median step duration across every job, with a tick at p95. A step whose p95 is several times its ' +
      'p50 is a cache that misses some of the time — that is the shape of a build directory being ' +
      'deleted before the run that needed it.',
    stepRows.length
      ? barChart(stepRows, { markerLabel: 'p95' })
      : h('div', { class: 'empty', text: 'No step timings yet — they arrive with the job backfill.' })
  );

  // ---- flaky ---------------------------------------------------------------
  const flakyPanel = d.flaky.length
    ? panel(
        'Flaky',
        'The same commit red once and green another time. The code did not change between those two ' +
          'runs, so the difference is the test or the machine.',
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Repo' }), h('th', { text: 'Workflow' }), h('th', { text: 'Commit' }),
            h('th', { text: 'Branch' }), h('th', { class: 'num', text: 'Runs' }), h('th', { text: 'Last' })
          )),
          h('tbody', {}, d.flaky.slice(0, 10).map((f) =>
            h('tr', {},
              h('td', { class: 'mono linkish', text: f.name, onclick: () => onOpenRepo(f.repo) }),
              h('td', { text: f.workflow }),
              h('td', { class: 'mono', text: f.sha }),
              h('td', { class: 'mono', text: f.branch ?? '–' }),
              h('td', { class: 'num', text: f.attempts }),
              h('td', { text: (f.lastAt ?? '').slice(0, 10) })
            )
          ))
        )
      )
    : null;

  // ---- volume --------------------------------------------------------------
  const volume = d.daily.length
    ? panel(
        'Daily volume',
        'Completed runs per day across every repo.',
        columnChart(
          d.daily.map((x) => ({
            label: x.day,
            tick: x.day.slice(5),
            success: x.success,
            failure: x.failure,
            other: x.other,
          })),
          {
            series: [
              { key: 'success', label: 'success', tone: 'good' },
              { key: 'failure', label: 'failure', tone: 'critical' },
              { key: 'other', label: 'cancelled / other', tone: 'muted' },
            ],
            labelEvery: Math.max(1, Math.ceil(d.daily.length / 12)),
          }
        )
      )
    : null;

  // Why the failures failed. This sits directly under the success-rate tile on
  // purpose: it is the panel that says whether that number is about your code at
  // all. A run blocked by the account's spending limit never reached a runner and
  // never ran a step, but it lands in the failure count identically.
  const fc = d.failureCauses;
  const BLAME_TONE = { code: 'warning', host: 'critical', account: 'serious', unclassified: 'muted', unknown: 'muted' };
  const BLAME_WHO = {
    code: 'yours to fix — read the step log',
    host: 'this machine — check load and network',
    account: 'billing or quota, not code',
    unclassified: 'not looked up yet',
    unknown: 'annotations expired',
  };
  const causesPanel = fc && fc.failedJobs
    ? panel('Why jobs failed',
        fc.classified === 0
          ? `${fc.failedJobs} failed jobs in this window, none classified yet — the backfill fetches `
            + 'each failure\'s annotations to find the cause, and has not reached them.'
          : `${fc.classified} of ${fc.failedJobs} failed jobs classified. "Failure" covers causes that `
            + 'need different people: a broken test, a starved runner, and an account-level block are '
            + 'the same conclusion in the runs table and nothing alike in practice.',
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Cause' }),
            h('th', { text: 'Whose problem' }),
            h('th', { class: 'num', text: 'Jobs' }),
            h('th', { class: 'num', text: 'Repos' })
          )),
          h('tbody', {}, fc.causes.map((c) =>
            h('tr', {},
              h('td', {},
                h('span', { class: `flag ${BLAME_TONE[c.blame] ?? ''}`, text: c.label }),
                c.hint ? h('div', { class: 'panel-sub', text: c.hint }) : null
              ),
              h('td', { text: BLAME_WHO[c.blame] ?? c.blame }),
              h('td', { class: 'num', text: String(c.n) }),
              h('td', { class: 'num', text: String(c.repos) })
            )
          ))
        )
      )
    : null;

  // ---- per-runner utilization ----------------------------------------------
  const runnerUtilPanel = d.runnerStats?.length
    ? panel(
        'Runner workload distribution',
        `Jobs completed per runner in the last ${d.window.days} days. ` +
          'A runner with zero jobs may be misconfigured or pointing at a workflow that no longer runs.',
        barChart(
          d.runnerStats.slice(0, 20).map((r) => ({
            label: r.name.replace(/^[^-]+-/, ''),
            value: r.jobs,
            note: r.failures ? `${Math.round(r.failureRate * 100)}% fail` : '',
            noteTone: r.failureRate >= 0.25 ? 'critical' : r.failureRate >= 0.1 ? 'warning' : '',
            title: `${r.jobs} jobs · ${r.failures} failures · ${Math.round(r.busyFrac * 100)}% busy`,
          })),
          { unit: (n) => `${n} jobs` }
        )
      )
    : null;

  // ---- event-type breakdown ------------------------------------------------
  const eventBreakdownPanel = d.eventBreakdown?.length
    ? panel(
        'Runs by trigger event',
        'What kinds of GitHub events drive CI on this fleet.',
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Event' }),
            h('th', { class: 'num', text: 'Runs' }),
            h('th', { class: 'num', text: 'Share' })
          )),
          h('tbody', {}, d.eventBreakdown.map((e) =>
            h('tr', {},
              h('td', { text: e.event }),
              h('td', { class: 'num', text: String(e.n) }),
              h('td', { class: 'num', text: t.completedRuns ? fmtPct(e.n / t.completedRuns) : '–' })
            )
          ))
        )
      )
    : null;

  // ---- host pressure trend -------------------------------------------------
  const hostPressurePanel = d.hostPressureTrend?.length > 1
    ? panel(
        'Host pressure over time',
        'Minutes per day where kernel-reported memory pressure was non-normal. ' +
          'A spike here that aligns with a failure spike above is the host, not the code.',
        columnChart(
          d.hostPressureTrend.map((row) => ({
            label: row.day,
            tick: row.day.slice(5),
            pressure: Math.round((row.pressure_secs ?? 0) / 60),
          })),
          {
            series: [{ key: 'pressure', label: 'pressure (min)', tone: 'warning' }],
            labelEvery: Math.max(1, Math.ceil(d.hostPressureTrend.length / 12)),
          }
        )
      )
    : null;

  // ---- alert stats ---------------------------------------------------------
  const alertStatsPanel = d.alertStats?.length
    ? panel(
        'Alert history',
        `How often each rule fired in the last ${d.window.days} days, and how long it stayed open on average.`,
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Rule' }), h('th', { text: 'Severity' }),
            h('th', { class: 'num', text: 'Times' }),
            h('th', { class: 'num', text: 'Avg open' }),
            h('th', { class: 'num', text: 'Still open' })
          )),
          h('tbody', {}, d.alertStats.map((a) =>
            h('tr', {},
              h('td', { text: a.rule }),
              h('td', {}, h('span', { class: `flag ${a.severity}`, text: a.severity })),
              h('td', { class: 'num', text: String(a.count) }),
              h('td', { class: 'num', text: a.avgDurationMs != null ? dur(a.avgDurationMs) : '–' }),
              h('td', { class: 'num', text: a.stillOpen ? String(a.stillOpen) : '0' })
            )
          ))
        )
      )
    : null;

  // ---- backfill coverage ---------------------------------------------------
  const bc = d.backfillCoverage;
  const backfillCoveragePanel = bc
    ? panel(
        'History coverage',
        bc.coveragePct === 100
          ? 'Job detail captured for all completed runs — every aggregate above is based on complete data.'
          : bc.coveragePct != null
            ? `Job detail captured for ${bc.coveragePct}% of completed runs (${bc.sampledRuns} of ${bc.totalRuns}). ` +
              'Aggregates may undercount until backfill completes.'
            : 'Coverage unknown.',
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Metric' }), h('th', { class: 'num', text: 'Count' })
          )),
          h('tbody', {},
            h('tr', {}, h('td', { text: 'Completed runs in DB' }), h('td', { class: 'num', text: String(bc.totalRuns ?? '–') })),
            h('tr', {}, h('td', { text: 'Runs with job detail' }), h('td', { class: 'num', text: String(bc.sampledRuns ?? '–') })),
            h('tr', {}, h('td', { text: 'Still pending backfill' }), h('td', { class: 'num', text: String(bc.pendingRuns ?? '–') })),
            h('tr', {}, h('td', { text: 'Failures not yet classified' }), h('td', { class: 'num', text: String(bc.unclassified ?? '–') }))
          )
        )
      )
    : null;

  // ---- Playwright / E2E (from step and job names only) ---------------------
  const pw = d.playwright;
  const playwrightPanel = pw
    ? panel(
        'Playwright / E2E',
        'Browser-install step timings and E2E job outcomes from recorded step and job names. ' +
          'No flake rate, browser split, or artifact availability unless workflows name them.',
        (pw.browserInstall?.count || pw.e2eJobs?.count)
          ? h('section', { class: 'kpis kpis-compact' },
              statTile({
                label: 'Browser install',
                value: pw.browserInstall.count,
                unit: 'steps',
                sub: pw.browserInstall.p50 != null
                  ? `p50 ${fmtMs(pw.browserInstall.p50)} · p95 ${fmtMs(pw.browserInstall.p95)}`
                  : 'no install step timings yet',
              }),
              statTile({
                label: 'E2E jobs',
                value: pw.e2eJobs.count,
                sub: pw.e2eJobs.count
                  ? `${pw.e2eJobs.successes} ok · ${pw.e2eJobs.failures} failed`
                  : 'no matching jobs in window',
                tone: pw.e2eJobs.successRate == null ? undefined
                  : pw.e2eJobs.successRate > 0.9 ? 'good'
                    : pw.e2eJobs.successRate > 0.75 ? 'warning' : 'critical',
              }),
              statTile({
                label: 'E2E job time',
                value: pw.e2eJobs.p50Duration != null ? fmtMs(pw.e2eJobs.p50Duration) : '–',
                sub: pw.e2eJobs.p95Duration != null ? `p95 ${fmtMs(pw.e2eJobs.p95Duration)}` : '',
              }),
              statTile({
                label: 'E2E queue',
                value: pw.e2eJobs.p50Queue != null ? fmtMs(pw.e2eJobs.p50Queue) : '–',
                sub: pw.e2eJobs.p95Queue != null ? `p95 ${fmtMs(pw.e2eJobs.p95Queue)}` : '',
              })
            )
          : h('div', { class: 'empty', text: 'No Playwright or E2E jobs in this window — or step detail has not backfilled yet.' })
      )
    : null;

  mount(root, rangeBar, kpis, causesPanel, playwrightPanel, secondRunner, slowest, zombiePanel, steps, flakyPanel, volume,
    runnerUtilPanel, eventBreakdownPanel, hostPressurePanel, alertStatsPanel, backfillCoveragePanel);
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
