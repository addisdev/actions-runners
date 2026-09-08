// Captures the dashboard screenshots in docs/img.
//
// The daemon cannot run here: fleetd builds its runner list from
// discoverRunnerDirs(), `launchctl list` and the GitHub API, and a machine
// building the documentation has none of the three. So this serves the real
// dashboard/public/ directory unchanged and answers every /api/ request from
// fixture-fleet.mjs, driving the real front-end with fixture data.
//
// Read-only with respect to the repository. dashboard/public/ is served from
// disk and never written; the fleet database is `:memory:`; the runner
// directories live in a temp directory that is removed on exit. Nothing here
// needs a network, a GitHub token, or a fleet.
//
//   node shoot-dash.mjs                 every shot
//   node shoot-dash.mjs --only fleet-tab,hosts-tab
//   node shoot-dash.mjs --serve         serve and stay up, for poking by hand

import http from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { openDb } from '../../dashboard/lib/db.js';
import { createSettings, SCHEMA as SETTINGS_SCHEMA, ENV_ONLY } from '../../dashboard/lib/settings.js';
import { analytics, repoDetail } from '../../dashboard/lib/analytics.js';
import { lintAll } from '../../dashboard/lib/lint.js';
import { adviseAll } from '../../dashboard/lib/concurrency-advisor.js';
import { compareScenarios } from '../../dashboard/lib/simulator.js';
import { buildBaseline, forecastDemand, extractSchedules, evaluateGate } from '../../dashboard/lib/forecast.js';
import { mergeHostSnapshots, STALE_HEARTBEAT_MS } from '../../dashboard/lib/placement.js';
import { classifyQueuedRuns } from '../../dashboard/lib/queue-cause.js';
import { Alerts } from '../../dashboard/lib/alerts.js';
import { buildActions } from '../../dashboard/lib/actions.js';
import { buildBundle } from '../../dashboard/lib/bundle.js';
import { diagSummary, diagTail, runnerVersions } from '../../dashboard/lib/local.js';

import {
  NOW, HOST, REMOTE_HOST_REPORT, DIAG_DIRS, DISPLAY_ROOT,
  materialiseFleetRoot, seedDb, buildSnapshot,
} from './fixture-fleet.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../../dashboard/public');
const OUT_DIR = resolve(HERE, '../img');

const args = process.argv.slice(2);
const SERVE_ONLY = args.includes('--serve');
const onlyArg = args[args.indexOf('--only') + 1];
const ONLY = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;

const log = (...a) => console.log('[shoot]', ...a);
const warn = (...a) => console.warn('[shoot]', ...a);

// The token is only ever held in the browser's localStorage, exactly as a real
// operator's would be. Nothing here can act on anything — POST /api/action is
// refused below — but the front-end gates several panels on its presence, and a
// screenshot of a locked dashboard is a screenshot of half the product.
const CONTROL_TOKEN = 'fixture-control-token';

// ------------------------------------------------------------------- state

const fleet = materialiseFleetRoot();
const db = openDb(':memory:');
seedDb(db);
const settings = createSettings(db);
let snapshot = buildSnapshot({ db, root: fleet.root, settings });

const alerts = new Alerts({
  db,
  config: { macos: true, webhook: null },
  log: () => {},
  warn: () => {},
});

const ACTIONS = buildActions({
  root: fleet.root,
  gh: null,
  getSnapshot: () => snapshot,
  getLimits: () => settings.limits(),
});

// ------------------------------------------------------------- api helpers

// The fleet root is a real mkdtemp directory, because discoverRunnerDirs,
// runnerVersions, diagSummary and diagTail have to run against actual files —
// that is what makes these screenshots the real UI rather than a mock. The path
// is also the one thing in the payload that is not fixture: it carries this
// machine's per-user temp identifier, and the runner drawer prints it in full.
//
// buildSnapshot already presents it as DISPLAY_ROOT, keeping the real path in
// DIAG_DIRS for the routes that read from disk. This is the net under that: it
// rewrites anything that reaches the browser by another path. Same constant on
// purpose — two presented roots would eventually disagree in one field.
const present = (text) => text.split(fleet.root).join(DISPLAY_ROOT);

const json = (res, body, status = 200) => {
  const text = present(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};

const runnersByRepoLabels = () => {
  const map = new Map();
  const add = (repo, labels) => {
    if (!map.has(repo)) map.set(repo, []);
    map.get(repo).push({ labels: (labels ?? []).map((l) => String(l).toLowerCase()) });
  };
  for (const r of snapshot.runners) if (r.registered) add(r.repo, r.labels);
  for (const e of snapshot.elsewhere) add(e.repo, e.labels);
  return map;
};

const workflowFiles = () =>
  db.prepare('SELECT repo, path, ref, name, content, is_default FROM workflow_files').all();

// Mirrors fleetd's versionReport, including the pinned version read straight out
// of the fleet root's register.sh rather than duplicated.
const onDisk = (runner) => DIAG_DIRS.get(runner.name) ?? runner.dir;

async function versionReport(runner) {
  const versions = runnerVersions(onDisk(runner));
  let pinned = null;
  try {
    const src = await readFile(join(fleet.root, 'register.sh'), 'utf8');
    pinned = src.match(/^VERSION="([^"]+)"/m)?.[1] ?? null;
  } catch { /* a fleet root without register.sh is not a reason to fail */ }

  const counts = new Map();
  for (const r of snapshot.runners ?? []) {
    const v = r.version ?? 'unknown';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const fleetVersions = [...counts].sort((a, b) => b[1] - a[1]).map(([version, count]) => ({ version, count }));
  const active = versions.active;
  const alone = active != null && (counts.get(active) ?? 0) === 1 && (snapshot.runners?.length ?? 0) > 1;
  const lastUpdate = db.prepare(
    "SELECT ts, detail FROM runner_events WHERE name = ? AND kind = 'version' ORDER BY ts DESC LIMIT 1"
  ).get(runner.name) ?? null;

  return {
    active,
    sideBySide: versions.sideBySide,
    stagedUpdate: versions.stagedUpdate,
    installVersion: pinned,
    differsFromInstall: Boolean(pinned && active && pinned !== active),
    fleet: fleetVersions,
    aloneOnVersion: alone,
    lastUpdate,
  };
}

// -------------------------------------------------------------- the routes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = resolve(PUBLIC_DIR, rel);
  // dashboard/public is served read-only and nothing outside it is reachable.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

const sseClients = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/state') return json(res, snapshot);

  if (p === '/api/health') {
    return json(res, {
      ok: true, ts: snapshot.ts, runners: snapshot.runners.length,
      drift: snapshot.drift.filter((d) => d.severity !== 'info').length, lastError: null,
    });
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(`data: ${present(JSON.stringify(snapshot))}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/runner') {
    const name = url.searchParams.get('name');
    const r = snapshot.runners.find((x) => x.name === name);
    if (!r) return json(res, { error: 'unknown runner' }, 404);

    const events = db.prepare(
      'SELECT ts, kind, detail FROM runner_events WHERE name = ? ORDER BY ts DESC LIMIT 30'
    ).all(name);
    const jobs = db.prepare(`SELECT id, repo, name, status, conclusion, started_at, completed_at,
                                    duration_ms, html_url
                             FROM jobs WHERE runner_name = ? ORDER BY started_at DESC LIMIT 20`).all(name);
    const sinceIso = new Date(NOW - 7 * 86400000).toISOString();
    const util = db.prepare(`
      SELECT COUNT(*) AS job_count,
             SUM(CASE WHEN conclusion = 'failure' OR conclusion = 'timed_out' THEN 1 ELSE 0 END) AS failures,
             SUM(duration_ms) AS total_ms,
             MAX(started_at) AS last_job_at
      FROM jobs
      WHERE runner_name = ? AND started_at >= ? AND id > 0 AND runner_name IS NOT NULL`).get(name, sinceIso);
    const workKb = db.prepare('SELECT work_kb FROM runner_state WHERE name = ?').get(name)?.work_kb ?? null;

    return json(res, {
      runner: r,
      events,
      jobs,
      diag: diagTail(onDisk(r)),
      diagSummary: diagSummary(onDisk(r)),
      versions: await versionReport(r),
      utilization: {
        days: 7,
        jobCount: util?.job_count ?? 0,
        failureCount: util?.failures ?? 0,
        totalMs: util?.total_ms ?? null,
        lastJobAt: util?.last_job_at ?? null,
        workKb,
      },
    });
  }

  if (p === '/api/runner/bundle') {
    const name = url.searchParams.get('name');
    const r = snapshot.runners.find((x) => x.name === name);
    if (!r) return json(res, { error: 'unknown runner' }, 404);
    const events = db.prepare(
      'SELECT ts, kind, detail FROM runner_events WHERE name = ? ORDER BY ts DESC LIMIT 50'
    ).all(name);
    const jobs = db.prepare(`SELECT name, status, conclusion, started_at, created_at, duration_ms
                             FROM jobs WHERE runner_name = ? ORDER BY started_at DESC LIMIT 20`).all(name);
    const summary = diagSummary(onDisk(r));
    const tail = diagTail(onDisk(r), 200);
    const bundle = buildBundle({
      runner: r, host: snapshot.host ?? {}, events, jobs,
      diag: summary ? { ...summary, tail: tail?.tail ?? null } : null,
    });
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${bundle.filename}"`,
    });
    return res.end(bundle.text);
  }

  if (p === '/api/repo') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, { error: 'name required' }, 400);
    return json(res, repoDetail(db, name, { days: 30 }));
  }

  if (p === '/api/analytics') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 365);
    const runnersByRepo = new Map();
    for (const r of snapshot.runners) {
      if (!r.registered) continue;
      runnersByRepo.set(r.repo, (runnersByRepo.get(r.repo) ?? 0) + 1);
    }
    return json(res, analytics(db, { days, runnersByRepo }));
  }

  if (p === '/api/lint') {
    const files = workflowFiles();
    const findings = lintAll({ files, runnersByRepo: runnersByRepoLabels() });
    return json(res, {
      files: new Set(files.map((f) => `${f.repo}\n${f.path}`)).size,
      checks: files.length,
      refs: [...new Set(files.map((f) => f.ref))].filter((r) => r && r !== '__default__').sort(),
      repos: new Set(files.map((f) => f.repo)).size,
      findings,
    });
  }

  if (p === '/api/concurrency') {
    const byRepo = new Map();
    for (const r of snapshot.runners) {
      if (!r.registered) continue;
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
      byRepo.get(r.repo).push(r);
    }
    const limits = settings.limits();
    return json(res, {
      findings: adviseAll({
        files: workflowFiles(),
        runnersByRepo: byRepo,
        hostCap: limits.maxTotalRunners ?? 16,
        perRepoCap: limits.maxInstancesPerRepo,
      }),
    });
  }

  if (p === '/api/queue-causes') {
    const critical = new Set(
      lintAll({ files: workflowFiles(), runnersByRepo: runnersByRepoLabels() })
        .filter((f) => f.severity === 'critical').map((f) => f.repo)
    );
    return json(res, { causes: Object.fromEntries(classifyQueuedRuns(snapshot, critical)) });
  }

  if (p === '/api/alerts') return json(res, alerts.snapshot());

  if (p === '/api/actions') {
    return json(res, {
      readOnly: false,
      actions: Object.entries(ACTIONS).map(([id, a]) => ({
        id, label: a.label, danger: a.danger, confirm: a.confirm ?? null,
      })),
      recent: db.prepare(
        'SELECT ts, action, args, command, exit_code, ok, output FROM action_log ORDER BY ts DESC LIMIT 25'
      ).all(),
    });
  }

  if (p === '/api/autoscale') {
    return json(res, {
      decisions: db.prepare(
        'SELECT ts, repo, action, reason FROM autoscale_decisions ORDER BY ts DESC LIMIT 50'
      ).all(),
      capacity: snapshot.capacity,
      sizing: snapshot.sizing,
    });
  }

  if (p === '/api/settings' && req.method === 'GET') {
    const values = settings.all();
    const meta = settings.meta();
    return json(res, {
      readOnly: false,
      envOnly: ENV_ONLY,
      settings: Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => ({
        key, label: spec.label, type: spec.type, value: values[key], default: spec.default,
        min: spec.min ?? null, max: spec.max ?? null,
        source: meta[key]?.source ?? 'default',
        updatedAt: meta[key]?.updatedAt ?? null,
      })),
    });
  }

  // Writes are refused rather than implemented. This rig exists to photograph
  // the dashboard, and a screenshot tool that can change state is a screenshot
  // tool that can be blamed for one.
  if (p === '/api/settings' || p === '/api/action') {
    return json(res, { error: 'the screenshot rig serves fixture data and runs nothing' }, 403);
  }

  if (p === '/api/simulate') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 90);
    const since = new Date(NOW - days * 86400000).toISOString();
    const jobs = db.prepare(`
      SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
      WHERE started_at >= ? AND queued_ms IS NOT NULL AND duration_ms IS NOT NULL
      ORDER BY started_at`).all(since);

    const current = new Map();
    for (const r of snapshot.runners ?? []) {
      if (!r.registered) continue;
      current.set(r.repo, (current.get(r.repo) ?? 0) + 1);
    }
    const proposed = new Map(current);
    for (const row of snapshot.sizing ?? []) {
      if (row.delta > 0) proposed.set(row.repo, Math.min(row.want, 8));
    }

    const limits = settings.limits();
    const out = compareScenarios(jobs, current, proposed, {
      hostCap: limits.maxTotalRunners ?? 16,
      idleTtlMs: limits.idleTtlMs,
    });
    return json(res, {
      days,
      jobsConsidered: jobs.length,
      currentCounts: Object.fromEntries(current),
      proposedCounts: Object.fromEntries(proposed),
      ...out,
      note: 'Replay of real job arrivals and durations against a hypothetical runner count. '
        + 'Queue waits are simulated; job durations are measured.',
    });
  }

  if (p === '/api/forecast') {
    const hoursAhead = Math.min(Math.max(Number(url.searchParams.get('hours') ?? 12), 1), 48);
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 60), 7), 180);
    const since = new Date(NOW - days * 86400000).toISOString();
    const jobs = db.prepare(`
      SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
      WHERE started_at >= ? AND duration_ms IS NOT NULL
      ORDER BY started_at`).all(since);
    const baseline = buildBaseline(jobs);
    const schedules = extractSchedules(workflowFiles());
    const predictions = forecastDemand({ baseline, schedules, hoursAhead });
    const evals = db.prepare(
      'SELECT predicted_peak, actual_peak, false_positive FROM forecast_evals ORDER BY ts DESC LIMIT 500'
    ).all();
    return json(res, {
      hoursAhead,
      historyDays: days,
      weeksCovered: baseline.weeksCovered,
      bucketsLearned: baseline.buckets.size,
      schedulesFound: schedules.length,
      predictions,
      gate: evaluateGate(evals),
      shadowMode: true,
      note: 'Forecasts are shadow-only: they are recorded and scored, and nothing acts on them. '
        + 'Pre-warming stays locked until the gate below passes.',
    });
  }

  if (p === '/api/hosts') {
    const local = {
      id: 'local',
      name: `${HOST} (this machine)`,
      lastHeartbeat: snapshot.ts,
      labels: ['mac-mini', 'm4-pro'],
      runners: snapshot.runners ?? [],
      repos: [...new Set((snapshot.runners ?? []).map((r) => r.repo))],
      host: snapshot.host ?? {},
      capacity: snapshot.capacity ?? null,
      runnerCount: (snapshot.runners ?? []).length,
      drained: snapshot._hostDrained,
    };
    const merged = mergeHostSnapshots({ hosts: [local, REMOTE_HOST_REPORT] });
    return json(res, { ...merged, federated: true, staleHeartbeatMs: STALE_HEARTBEAT_MS });
  }

  if (p.startsWith('/api/')) return json(res, { error: `not served by the fixture rig: ${p}` }, 404);

  return serveStatic(res, p);
});

// ---------------------------------------------------------------- the shots

const SHOTS = [
  {
    file: 'fleet-tab.png', tab: 'fleet',
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#fleet .runner').length >= 10
          && document.querySelectorAll('#fleet .project').length >= 3
          && document.querySelectorAll('#drift .drift-item').length >= 3
          && document.querySelectorAll('#fleet-queue .row').length >= 3
          && document.querySelectorAll('#unserved .row').length >= 1
      );
    },
  },
  {
    file: 'runs-tab.png', tab: 'runs', frame: { sel: '#active' },
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#active .row').length >= 5
          && document.querySelectorAll('#recent .row').length >= 20
      );
    },
  },
  {
    file: 'analytics-tab.png', tab: 'analytics', frame: { sel: '#view-analytics > .section-head' },
    ready: async (page) => {
      await page.waitForFunction(() => {
        const root = document.querySelector('#view-analytics');
        if (!root || root.textContent.includes('Loading…')) return false;
        if (root.querySelector('.empty')) return true; // let the check below report it
        return root.querySelectorAll('.panel').length >= 6 && root.querySelectorAll('.kpi').length >= 6;
      });
      await page.waitForFunction(
        () => !document.querySelector('#view-analytics .empty')
      );
    },
  },
  {
    file: 'lint-tab.png', tab: 'lint', frame: { sel: '#view-lint > .section-head' },
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#view-lint .drift-item').length >= 4
          && !document.querySelector('#view-lint').textContent.includes('Loading…')
      );
    },
  },
  {
    file: 'alerts-tab.png', tab: 'alerts', frame: { panel: 'Channels' },
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#view-alerts .drift-item').length >= 1
          && document.querySelectorAll('#view-alerts .mini-table tbody tr').length >= 4
          && !document.querySelector('#view-alerts').textContent.includes('Loading…')
      );
    },
  },
  {
    file: 'capacity-tab.png', tab: 'capacity', frame: { panel: 'Did adding a runner help?' },
    // The replay and the forecast are on-demand by design — they sweep a month
    // and two months of job rows respectively. Both are triggered here so the
    // shot shows the panels doing their job rather than their resting state.
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#view-capacity .panel').length >= 6
      );
      await page.getByRole('button', { name: 'Run replay' }).click();
      await page.getByRole('button', { name: 'Load forecast' }).click();
      await page.waitForFunction(() => {
        const t = document.querySelector('#view-capacity').textContent;
        return t.includes('jobs replayed over')
          && (t.includes('Learned from') || t.includes('Forecast failed'))
          && !t.includes('replaying…') && !t.includes('loading…');
      });
    },
  },
  {
    file: 'hosts-tab.png', tab: 'hosts',
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#view-hosts .host-card').length === 2
          && document.querySelectorAll('#view-hosts .host-card.is-stale').length === 1
      );
    },
  },
  {
    file: 'control-tab.png', tab: 'control', frame: { panel: 'Fleet' },
    ready: async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll('#view-control .panel').length >= 5
          && document.querySelectorAll('#view-control .settings-table tbody tr').length >= 5
          && document.querySelectorAll('#view-control .row-actions button').length >= 6
      );
    },
  },
  {
    file: 'runner-drawer.png', tab: 'fleet',
    ready: async (page) => {
      await page.waitForFunction(() => document.querySelectorAll('#fleet .runner').length >= 10);
      // The runner in launchd-dead drift: the state with the most to show —
      // last exit code, the errors its own log recorded, and a staged version.
      // The name, not the tile: the repo line inside a tile has its own click
      // handler and opens the repository drawer instead.
      await page.locator('#fleet .runner', { hasText: 'app-backend-2' })
        .first().locator('.runner-name').click();
      await page.waitForFunction(() => {
        const b = document.querySelector('#drawer-body');
        return b && b.querySelector('h3') && b.querySelector('pre.diag')
          && b.querySelectorAll('.mini li').length >= 4
          && b.textContent.includes('7-day utilization');
      });
      // Let the drawer's slide-in settle before the shutter.
      await page.waitForTimeout(500);
    },
  },
];

// Put a tab's own content in the frame.
//
// Six of the eight tabs open below the live KPI row, which the dashboard means
// to hide on them and does not — `.is-hidden` is declared before `.kpis` in
// style.css, so the later rule wins and `#kpis.is-hidden` still displays as a
// grid. Scrolling past it is the only fix available from here, since this rig
// must not touch dashboard/. It is also the better composition regardless: the
// top bar is sticky, so the tab stays named at the top of every shot.
async function frame(page, target) {
  if (!target) return;
  await page.evaluate((t) => {
    const el = t.sel
      ? document.querySelector(t.sel)
      : [...document.querySelectorAll('.view:not(.is-hidden) .panel')]
        .find((n) => n.textContent.trim().startsWith(t.panel));
    if (!el) throw new Error(`nothing to scroll to: ${JSON.stringify(t)}`);
    // 88px clears the sticky top bar.
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 88 - (t.above ?? 0)));
  }, target);
  await page.waitForTimeout(150);
}

// Things that must never appear in a shot. A screenshot of a spinner or a
// disconnected banner is worse than no screenshot.
async function assertHealthy(page, file) {
  const problems = await page.evaluate(() => {
    const out = [];
    const conn = document.querySelector('#conn-label')?.textContent ?? '';
    if (conn !== 'Live') out.push(`connection reads "${conn}"`);
    if (document.querySelector('#stale')?.textContent) out.push('the stale banner is showing');
    const view = document.querySelector('.view:not(.is-hidden)');
    if (!view) out.push('no view is visible');
    const text = view?.textContent ?? '';
    for (const bad of ['Loading…', 'Not loaded', 'Not run yet', 'could not load', 'Could not load',
      'failed:', 'Failed:', 'unavailable', 'waiting for the first snapshot']) {
      if (text.includes(bad)) out.push(`visible text contains "${bad}"`);
    }
    if (view?.querySelector('.empty-state.is-loading')) out.push('a loading empty-state is showing');
    if (document.body.scrollWidth > document.documentElement.clientWidth + 2) {
      out.push('the page scrolls horizontally');
    }
    return out;
  });
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
}

async function capture() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await context.addInitScript((token) => {
    try {
      localStorage.setItem('fleet-control-token', token);
      localStorage.removeItem('fleet-theme');
    } catch { /* ignore */ }
  }, CONTROL_TOKEN);

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

  const written = [];
  for (const shot of SHOTS) {
    if (ONLY && !ONLY.has(shot.file.replace(/\.png$/, ''))) continue;

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#conn-label:text-is("Live")', { timeout: 15_000 });
    if (shot.tab !== 'fleet') await page.click(`#tab-${shot.tab}`);
    await shot.ready(page);
    await frame(page, shot.frame);
    await assertHealthy(page, shot.file);

    const path = join(OUT_DIR, shot.file);
    // Viewport-sized, at 2x, matching the dashboard screenshots already in
    // docs/img. A full-page shot of the Runs tab is six thousand pixels of
    // repeated rows that no documentation page can display legibly.
    await page.screenshot({ path, animations: 'disabled' });
    const { size } = await stat(path);
    written.push({ file: shot.file, size });
    log(`${shot.file} — ${(size / 1024).toFixed(0)} KB`);
  }

  await browser.close();
  if (consoleErrors.length) {
    warn(`${consoleErrors.length} console error(s) during capture:`);
    for (const e of [...new Set(consoleErrors)]) warn('  ', e);
  }
  return written;
}

// --------------------------------------------------------------------- main

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  if (SERVE_ONLY) {
    log(`serving the fixture fleet on http://127.0.0.1:${port} — ctrl-c to stop`);
    return;
  }
  let code = 0;
  try {
    const written = await capture();
    const over = written.filter((w) => w.size > 400 * 1024);
    log(`wrote ${written.length} screenshot(s) to docs/img/`);
    if (over.length) {
      warn('over 400 KB:', over.map((o) => `${o.file} (${Math.round(o.size / 1024)} KB)`).join(', '));
    }
  } catch (err) {
    console.error('[shoot] failed:', err.message);
    code = 1;
  } finally {
    for (const c of sseClients) { try { c.end(); } catch { /* closed */ } }
    server.close();
    db.close();
    fleet.cleanup();
  }
  process.exit(code);
});

process.on('SIGINT', () => { fleet.cleanup(); process.exit(130); });
