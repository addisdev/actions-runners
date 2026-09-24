#!/usr/bin/env node
// fleetd — the runner fleet dashboard daemon.
//
// One process, deliberately: collector and server share the snapshot in memory,
// so the live view needs no polling between them, and there is one LaunchAgent
// to reason about at 3am instead of two. Unlike the runner plists, ours sets
// KeepAlive — the whole reason health.sh exists is that theirs do not.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { openDb, setMeta, getMeta } from './lib/db.js';
import { GitHub, isActiveRunStatus } from './lib/github.js';
import {
  discoverRunnerDirs,
  launchdJobs,
  runnerProcesses,
  hostVitals,
  dirSizes,
  diagTail,
  diagSummary,
  runnerVersions,
  hostDrainState,
} from './lib/local.js';
import { buildBundle, redact } from './lib/bundle.js';
import { buildRunners, deriveDrift, shapeRun, shapeJob } from './lib/state.js';
import { deriveGroups } from './lib/groups.js';
import { Backfill } from './lib/backfill.js';
import { analytics, repoDetail } from './lib/analytics.js';
import { buildActions, ActionError } from './lib/actions.js';
import { loadOrCreateToken, authorize, bearerToken, tokenMatches } from './lib/auth.js';
import {
  initAllowedHosts, refreshNetworkIdentity, reachableUrls, ensureHostAllowed, pairingUrl,
  sameOrigin, isLocalRequest, viewerContext, clientAddress,
} from './lib/remote.js';
import { hasHostToken, hostTokenMatches } from './lib/host-auth.js';
import {
  createPairingCode, exchangeCode, deviceTokenMatches, listDevices, revokeDevice, PAIRING_CODE_TTL_MS,
} from './lib/devices.js';
import { Alerts, loadConfig as loadAlertConfig } from './lib/alerts.js';
import { lintAll } from './lib/lint.js';
import { adviseAll } from './lib/concurrency-advisor.js';
import { classifyQueuedRuns, classifyQueueCause, queuedJobLabels } from './lib/queue-cause.js';
import { createSettings, SCHEMA as SETTINGS_SCHEMA, ENV_ONLY } from './lib/settings.js';
import { headroom } from './lib/capacity.js';
import { sizeFleet, concurrencyByRepo, queueEffect, sizingKey } from './lib/sizing.js';
import { planScaleUp, planScaleDown } from './lib/autoscale.js';
import { compareScenarios } from './lib/simulator.js';
import {
  choosePlacement, mergeHostSnapshots, requiredLabelsFromPlan, STALE_HEARTBEAT_MS,
} from './lib/placement.js';
import {
  buildFleetRunners, buildHostList, anyHostHasCapacity,
} from './lib/fleet.js';
import {
  buildBaseline, forecastDemand, extractSchedules, evaluatePrediction, evaluateGate,
} from './lib/forecast.js';
import { planPrewarm } from './lib/prewarm.js';
import { createAdmission } from './lib/admission.js';
import { ingestTestOutcomes } from './lib/test-results.js';
import { remediationCandidates } from './lib/remediation.js';
import { annotateActiveFromDb } from './lib/long-running.js';
import { renderPrometheusMetrics } from './lib/metrics.js';
import { classifyAnnotations } from './lib/failures.js';
import { HaCoordinator } from './lib/ha.js';
import { collectHostReport } from './lib/host-report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');

const CONFIG = {
  port: Number(process.env.FLEET_PORT ?? 7878),
  // Loopback by default. The control plane in phase 3 executes shell commands as
  // this user, so the safe default is an SSH tunnel:
  //   ssh -L 7878:localhost:7878 your-runner-host
  host: process.env.FLEET_HOST ?? '127.0.0.1',
  root: process.env.FLEET_ROOT ?? join(os.homedir(), 'actions-runners'),
  db: process.env.FLEET_DB ?? join(HERE, 'fleet.db'),
  databaseUrl: process.env.FLEET_DATABASE_URL
    ?? (process.env.FLEET_DATABASE_URL_FILE && existsSync(process.env.FLEET_DATABASE_URL_FILE)
      ? readFileSync(process.env.FLEET_DATABASE_URL_FILE, 'utf8').trim()
      : ''),
  replicaId: process.env.FLEET_REPLICA_ID
    ?? process.env.FLEET_HOST_ID
    ?? os.hostname().replace(/\.local$/, ''),
  hostName: process.env.FLEET_HOST_NAME ?? os.hostname().replace(/\.local$/, ''),
  fastMs: Number(process.env.FLEET_FAST_MS ?? 15000),
  // Ceiling on a single fast tick. The loop re-arms itself only after the tick
  // resolves, so one await that never settles silently ends collection for the
  // life of the process. Generous enough that a slow-but-working tick is never
  // cut short — the last healthy pass here took 8s — and short enough that a
  // wedged one costs a cycle rather than the afternoon.
  fastDeadlineMs: Number(process.env.FLEET_FAST_DEADLINE_MS ?? 120000),
  jobFetchConcurrency: Math.max(1, Number(process.env.FLEET_JOB_FETCH_CONCURRENCY ?? 8)),
  // How old the newest completed tick may be before this daemon calls itself
  // unhealthy. watch/fleet-watch.mjs already raises `collector-not-ok` the
  // moment /api/health stops saying ok, so reporting staleness here is the
  // whole watchdog — and its absence is why a 65-minute collection outage was
  // never reported by anything. Comfortably above one deadlined tick, so a slow
  // pass on a loaded host is not mistaken for a stopped one.
  collectorStaleMs: Number(process.env.FLEET_COLLECTOR_STALE_MS ?? 240000),
  idleMs: Number(process.env.FLEET_IDLE_MS ?? 45000),
  slowMs: Number(process.env.FLEET_SLOW_MS ?? 15 * 60 * 1000),
  backfillMs: Number(process.env.FLEET_BACKFILL_MS ?? 10 * 60 * 1000),
  // Per pass. ~1,100 runs need ~1,100 job calls, so this deliberately takes
  // several passes rather than one greedy sweep that starves the fast loop.
  backfillCalls: Number(process.env.FLEET_BACKFILL_CALLS ?? 350),
  backfillFloor: Number(process.env.FLEET_BACKFILL_FLOOR ?? 1500),
  tokenFile: process.env.FLEET_TOKEN_FILE ?? join(HERE, '.fleet-token'),
  // Agent token is separate from the browser control token so operators can
  // rotate them independently. Falls back to the control token if unset, for
  // backward compatibility with single-token deployments.
  agentTokenFile: process.env.FLEET_AGENT_TOKEN_FILE ?? join(HERE, '.fleet-agent-token'),
  agentTokensFile: process.env.FLEET_AGENT_TOKENS_FILE ?? join(HERE, '.fleet-agent-tokens.json'),
  // Read-only mode disables the control plane entirely, for a deployment that
  // should only ever look.
  readOnly: process.env.FLEET_READ_ONLY === '1',
  // Capability labels for the coordinator host itself. Placement uses these to
  // determine which jobs this host can serve — Xcode version, OS release, etc.
  // Set FLEET_HOST_LABELS=xcode-16,macos-15 in fleet.env on the coordinator.
  hostLabels: (process.env.FLEET_HOST_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  alertConfig: process.env.FLEET_ALERT_CONFIG ?? join(HERE, 'alerts.config.json'),
  alertsEnabled: process.env.FLEET_ALERTS !== '0',
  // Where hooks/job-started.sh appends its decisions. Configurable for the same
  // reason FLEET_DB is: the default assumes the dashboard lives inside the fleet
  // root, which is true here but is an assumption rather than a guarantee — and
  // a second daemon run for testing must not ingest into the real database from
  // the real log.
  admissionLog: process.env.FLEET_ADMISSION_LOG ?? join(HERE, 'logs', 'admission.ndjson'),
  testOutcomesSpool: process.env.FLEET_TEST_OUTCOMES_SPOOL ?? join(HERE, '..', '.playwright-outcomes.ndjson'),
  // The autofix bridge remains a separate process and privilege boundary. The
  // dashboard proxies only its read-only status so operators can see when
  // remediation is stale, storm-paused or disabled.
  autofixStatusUrl: process.env.FLEET_AUTOFIX_STATUS_URL ?? 'http://127.0.0.1:7879/status',
  // Extra names accepted in the Host header, beyond the ones discovered from
  // this machine. Coordinator URLs are included because an HA replica is
  // addressed by whatever name its peers and agents were configured with.
  allowedHosts: [
    ...(process.env.FLEET_ALLOWED_HOSTS ?? '').split(','),
    ...[process.env.FLEET_COORDINATOR, ...(process.env.FLEET_COORDINATORS ?? '').split(',')]
      .map((u) => { try { return new URL(String(u).trim()).hostname; } catch { return ''; } }),
  ].map((s) => s.trim()).filter(Boolean),
  deviceTokensFile: process.env.FLEET_DEVICE_TOKENS_FILE ?? join(HERE, '.fleet-device-tokens.json'),
};

// Grouping, capacity and autoscaling settings do NOT live in CONFIG. They are
// editable while the daemon runs and are read fresh where they are used, so
// caching them in a frozen object here would be a way to serve a stale value
// for the rest of the process's life. See lib/settings.js.

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.error(new Date().toISOString(), 'WARN', ...a);

const ha = new HaCoordinator({
  url: CONFIG.databaseUrl,
  replicaId: CONFIG.replicaId,
  log,
  warn,
});
const db = openDb(CONFIG.db);
const settings = createSettings(db);
const gh = new GitHub({ log });
const backfill = new Backfill({ db, gh, log, warn });
const CONTROL_TOKEN = CONFIG.readOnly ? null : loadOrCreateToken(CONFIG.tokenFile, log);
// Agent token authenticates remote host agents (heartbeat / results routes).
// A separate token lets operators rotate agent credentials without invalidating
// the browser session, and lets fleet admins share agent tokens across hosts
// without granting them control-plane authority. Falls back to CONTROL_TOKEN
// so existing single-token deployments keep working without any migration step.
const AGENT_TOKEN = CONFIG.readOnly ? null : (() => {
  const envToken = process.env.FLEET_AGENT_TOKEN;
  if (envToken && envToken.length >= 32) {
    log('using FLEET_AGENT_TOKEN from environment for agent routes');
    return envToken;
  }
  if (process.env.FLEET_AGENT_TOKEN_FILE || existsSync(CONFIG.agentTokenFile)) {
    return loadOrCreateToken(CONFIG.agentTokenFile, (msg) => log('[agent-token]', msg));
  }
  // No separate agent token configured — reuse the control token (backward compat).
  return CONTROL_TOKEN;
})();

// Accepts either the master control token or any valid per-device token so
// paired phones can use the control plane without the master token.
function checkDevice(token) {
  // Read-only mode has no control plane: a device paired before the switch must
  // not keep working where the master token no longer exists.
  if (CONFIG.readOnly) return false;
  return deviceTokenMatches(CONFIG.deviceTokensFile, token);
}
function authConfig() { return { port: CONFIG.port, host: CONFIG.host }; }
function authorizeRequest(req) { return authorize(req, CONTROL_TOKEN, authConfig(), checkDevice); }

function authorizeHost(req, host) {
  const given = bearerToken(req);
  if (!given) return { ok: false, status: 401, error: 'missing bearer token' };
  if (hasHostToken(CONFIG.agentTokensFile, host)) {
    return hostTokenMatches(CONFIG.agentTokensFile, host, given)
      ? { ok: true }
      : { ok: false, status: 403, error: `bad token for host ${host}` };
  }
  return tokenMatches(given, AGENT_TOKEN)
    ? { ok: true }
    : { ok: false, status: 403, error: 'bad token' };
}
const ACTIONS = buildActions({
  root: CONFIG.root,
  gh,
  getSnapshot: () => snapshot,
  // A function, not a value: an operator lowering the ceiling must affect the
  // very next action, not actions taken after the next restart.
  getLimits: () => settings.limits(),
});
const alerts = CONFIG.alertsEnabled
  ? new Alerts({ db, config: loadAlertConfig(CONFIG.alertConfig, log), log, warn })
  : null;
// Notifications can take longer than the fast cadence. Chain evaluations so two
// snapshots never reconcile the same in-memory open-alert map concurrently.
let alertRun = Promise.resolve();
// Decisions made by hooks/job-started.sh, read from the NDJSON those hooks
// append to. This process never makes an admission decision itself — a job's
// ability to start must not depend on the dashboard being alive.
const admission = createAdmission({ db, logPath: CONFIG.admissionLog, warn });
const logAction = db.prepare(
  'INSERT INTO action_log (ts, action, args, command, exit_code, ok, output) VALUES (?,?,?,?,?,?,?)'
);

// Read fresh on every rebuild rather than captured once, so changing a grouping
// setting regroups the fleet on the next tick instead of on the next restart.
const groupOpts = () => ({
  min: settings.get('groupMin'),
  ignore: settings.get('groupIgnore'),
  pinned: settings.get('projects'),
  enabled: settings.get('groupsEnabled'),
});

// Declared before the first snapshot because that snapshot publishes the group
// order. Empty until refreshGroups() runs on the first tick, which is correct:
// with no repos known yet there are no groups to claim.
let groups = deriveGroups([], groupOpts());

let snapshot = {
  ts: 0,
  starting: true,
  host: null,
  runners: [],
  elsewhere: [],
  active: [],
  recent: [],
  repos: [],
  drift: [],
  projects: groups.order,
  capacity: { ok: false, busy: 0, ceiling: 0, reasons: ['still starting'] },
  sizing: [],
  scaleEffect: [],
  api: {},
  collector: { lastFast: null, lastSlow: null, lastError: null, fastMs: CONFIG.fastMs },
};

const clients = new Set();

function publish() {
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------- persistence

const stmt = {
  upsertRun: db.prepare(`
    INSERT INTO runs (id, repo, workflow_id, workflow_name, run_number, event, status,
                      conclusion, head_branch, head_sha, created_at, run_started_at,
                      updated_at, html_url, duration_ms, seen_at,
                      run_attempt, display_title, workflow_path, pr_number, actor, head_commit_msg)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, conclusion=excluded.conclusion,
      updated_at=excluded.updated_at, duration_ms=excluded.duration_ms,
      seen_at=excluded.seen_at,
      run_attempt=COALESCE(excluded.run_attempt, runs.run_attempt),
      display_title=COALESCE(excluded.display_title, runs.display_title),
      workflow_path=COALESCE(excluded.workflow_path, runs.workflow_path),
      pr_number=COALESCE(excluded.pr_number, runs.pr_number),
      actor=COALESCE(excluded.actor, runs.actor),
      head_commit_msg=COALESCE(excluded.head_commit_msg, runs.head_commit_msg)`),
  upsertJob: db.prepare(`
    INSERT INTO jobs (id, run_id, repo, name, status, conclusion, created_at, started_at,
                      completed_at, runner_name, runner_id, labels, queued_ms, duration_ms,
                      html_url, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, conclusion=excluded.conclusion,
      completed_at=excluded.completed_at, runner_name=excluded.runner_name,
      queued_ms=excluded.queued_ms, duration_ms=excluded.duration_ms, seen_at=excluded.seen_at`),
  upsertRunner: db.prepare(`
    INSERT INTO runner_state (name, repo, dir, labels, gh_id, gh_status, gh_busy,
                              launchd_label, launchd_state, pid, rss_kb, work_kb, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      repo=excluded.repo, dir=excluded.dir, labels=excluded.labels, gh_id=excluded.gh_id,
      gh_status=excluded.gh_status, gh_busy=excluded.gh_busy,
      launchd_label=excluded.launchd_label, launchd_state=excluded.launchd_state,
      pid=excluded.pid, rss_kb=excluded.rss_kb,
      work_kb=COALESCE(excluded.work_kb, runner_state.work_kb),
      updated_at=excluded.updated_at`),
  insertEvent: db.prepare('INSERT INTO runner_events (ts, name, repo, kind, detail) VALUES (?,?,?,?,?)'),
  insertSample: db.prepare(`
    INSERT INTO host_samples (ts, load1, mem_used_mb, mem_total_mb, swap_used_mb,
                              swap_total_mb, disk_free_gb, disk_total_gb, listeners, busy_runners,
                              mem_free_pct, pressure, swapins_per_sec, swapouts_per_sec,
                              mem_compressed_mb)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ts) DO NOTHING`),
  upsertWorkflowFile: db.prepare(`
    INSERT INTO workflow_files (repo, path, ref, name, sha, content, fetched_at, is_default)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(repo, path, ref) DO UPDATE SET
      name=excluded.name, sha=excluded.sha, content=excluded.content,
      fetched_at=excluded.fetched_at, is_default=excluded.is_default`),
  deleteWorkflowFile: db.prepare(
    'DELETE FROM workflow_files WHERE repo = ? AND path = ? AND ref = ?'
  ),
  workflowFiles: db.prepare(
    'SELECT repo, path, ref, name, content, is_default FROM workflow_files'
  ),

  // Queue-cause transitions. lastQueueEvent is what makes this a transition log
  // rather than a sample: a row is written only when the newest row for a run
  // carries a different cause.
  lastQueueEvent: db.prepare(
    'SELECT id, cause, resolved_at FROM queue_events WHERE run_id = ? ORDER BY ts DESC LIMIT 1'
  ),
  insertQueueEvent: db.prepare(`
    INSERT INTO queue_events (ts, run_id, repo, cause, confidence, evidence, recommended)
    VALUES (?,?,?,?,?,?,?)`),
  resolveQueueEvent: db.prepare('UPDATE queue_events SET resolved_at = ? WHERE id = ?'),

  // Host federation. hosts is the roster, host_heartbeats the history — the
  // roster answers "what is in this fleet" without scanning a table that grows
  // by one row per host every 30 seconds.
  upsertHost: db.prepare(`
    INSERT INTO hosts (host_id, hostname, platform, fleet_root, first_seen, last_seen,
                       agent_version, reachable, labels, last_payload)
    VALUES (?,?,?,?,?,?,?,1,?,?)
    ON CONFLICT(host_id) DO UPDATE SET
      hostname=excluded.hostname, platform=excluded.platform, fleet_root=excluded.fleet_root,
      last_seen=excluded.last_seen, agent_version=excluded.agent_version, reachable=1,
      labels=excluded.labels, last_payload=excluded.last_payload`),
  // Scalars only. The full report lives on the hosts row; this is the time series,
  // and it grows by one row per host every 30 seconds.
  insertHeartbeat: db.prepare(`
    INSERT INTO host_heartbeats (host_id, ts, load1, mem_free_pct, disk_free_gb,
                                 runner_count, busy_count)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(host_id, ts) DO NOTHING`),
  // Only commands that have not been picked up. Without the status guard a host
  // that was slow to answer would receive the same command on every beat, which
  // for runner.duplicate means another runner each time.
  pendingCommands: db.prepare(
    "SELECT id, action, args, idempotency_key FROM host_commands "
    + "WHERE host_id = ? AND status = 'pending' AND attempts < 3 "
    + 'ORDER BY id LIMIT 8'
  ),
  markCommandSent: db.prepare(
    "UPDATE host_commands SET status = 'sent', started_at = ?, attempts = attempts + 1 "
    + "WHERE id = ? AND status = 'pending' AND attempts < 3"
  ),
  releaseCommandClaim: db.prepare(
    "UPDATE host_commands SET status = 'pending', started_at = NULL, "
    + "attempts = MAX(attempts - 1, 0) WHERE id = ? AND status = 'sent'"
  ),
  completeCommand: db.prepare(`
    UPDATE host_commands SET completed_at = ?, status = ?, result = ?
    WHERE id = ? AND status = 'sent'`),
  commandById: db.prepare(
    'SELECT id, host_id, action, args, status FROM host_commands WHERE id = ?'
  ),
  queueCommand: db.prepare(`
    INSERT INTO host_commands (host_id, ts, action, args, status, idempotency_key)
    VALUES (?,?,?,?,'pending',?)
    ON CONFLICT(idempotency_key) DO UPDATE
      SET idempotency_key=excluded.idempotency_key
    RETURNING id`),
  insertPlacement: db.prepare(`
    INSERT INTO placement_decisions (ts, repo, host_id, action, reason, dry_run)
    VALUES (?,?,?,?,?,?)`),
  recentPlacements: db.prepare(
    'SELECT ts, repo, host_id, action, reason, dry_run FROM placement_decisions '
    + 'ORDER BY ts DESC LIMIT 50'
  ),

  // Drain state and runner version, written alongside the main upsert rather
  // than folded into it so that adding these columns did not change the shape of
  // a statement every tick depends on.
  updateRunnerDrain: db.prepare(
    'UPDATE runner_state SET drain_state = ?, runner_version = ?, version_seen_at = ? WHERE name = ?'
  ),
  queueEventsFor: db.prepare(
    'SELECT ts, cause, confidence, evidence, recommended, resolved_at FROM queue_events '
    + 'WHERE run_id = ? ORDER BY ts DESC LIMIT 20'
  ),
  pushedRefs: db.prepare(`
    SELECT head_branch, COUNT(*) AS n FROM runs
    WHERE repo = ? AND event = 'push' AND run_started_at >= ?
    GROUP BY head_branch HAVING n >= 2
    ORDER BY n DESC`),
  defaultBranchOf: db.prepare('SELECT default_branch FROM repos WHERE full_name = ?'),
  upsertRepo: db.prepare(`
    INSERT INTO repos (full_name, name, archived, private, pushed_at, workflows, has_runner, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(full_name) DO UPDATE SET
      archived=excluded.archived, pushed_at=excluded.pushed_at,
      workflows=COALESCE(excluded.workflows, repos.workflows),
      has_runner=excluded.has_runner, updated_at=excluded.updated_at`),
};

const b = (v) => (v ? 1 : 0);
// SQLite rejects NaN and undefined but accepts NULL. An agent that could not read
// its own load average should record a missing value, not fail the heartbeat.
const num = (v) => (Number.isFinite(v) ? v : null);

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const count = Math.min(Math.max(1, limit), queue.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  }));
}

function persistRun(run) {
  stmt.upsertRun.run(run.id, run.repo, run.workflowId ?? null, run.workflowName ?? null,
    run.runNumber ?? null, run.event ?? null, run.status ?? null, run.conclusion ?? null,
    run.branch ?? null, run.sha ?? null, run.createdAt ?? null, run.startedAt ?? null,
    run.updatedAt ?? null, run.url ?? null, run.durationMs ?? null, Date.now(),
    run.runAttempt ?? null, run.displayTitle ?? null, run.workflowPath ?? null,
    run.prNumber ?? null, run.actor ?? null, run.headCommitMsg ?? null);
}

function persistJob(job) {
  stmt.upsertJob.run(job.id, job.runId, job.repo, job.name ?? null, job.status ?? null,
    job.conclusion ?? null, job.createdAt ?? null, job.startedAt ?? null, job.completedAt ?? null,
    job.runnerName, job.runnerId, JSON.stringify(job.labels ?? []), job.queuedMs, job.durationMs,
    job.url ?? null, Date.now());
}

// Transitions only. A row per 15s tick would be 5760 rows per runner per day to
// answer a question nobody asks; a row per change answers "when did this break".
const lastRunnerState = new Map();
const lastDrainState = new Map();
const lastVersionState = new Map();

// Remote hosts, keyed by name. In memory as well as in the database because the
// Hosts view is read on every render and a heartbeat table grows by one row per
// host every 30 seconds — reconstructing the current picture from it each time
// would mean scanning history to answer a question about the present.
//
// Rebuilt from the newest heartbeat per host at startup, so a coordinator
// restart does not blank the fleet.
const hostState = new Map();
const LOCAL_HOST_ID = CONFIG.replicaId;

const REMOTE_ACTIONS = new Set([
  'runner.duplicate',
  'runner.drain',
  'runner.resume',
  'runner.restart',
  'runner.deregisterPreview',
  'runner.deregister',
  'fleet.health',
  'fleet.healthRepair',
  'host.drain',
  'host.resume',
]);

function remoteTargetFor(action, args) {
  if (!REMOTE_ACTIONS.has(action)) return null;

  if (action.startsWith('runner.')) {
    const runners = snapshot.fleetRunners?.length
      ? snapshot.fleetRunners
      : buildFleetRunners(snapshot.runners ?? [], snapshot.elsewhere ?? [], hostState);
    const runner = runners.find((r) => r.name === args.name);
    if (!runner) throw new ActionError(`unknown runner: ${args.name}`, 404);
    if (!runner.hostId || runner.hostId === LOCAL_HOST_ID) return null;
    return { hostId: runner.hostId, repo: runner.repo, runner };
  }

  const hostId = String(args.hostId ?? '');
  if (!hostId || hostId === LOCAL_HOST_ID) return null;
  return { hostId, repo: null };
}

async function queueRemoteAction(action, args) {
  const target = remoteTargetFor(action, args);
  if (!target) return null;

  const host = hostState.get(target.hostId)
    ?? [...hostState.values()].find((h) => h.id === target.hostId || h.name === target.hostId);
  if (!host) throw new ActionError(`unknown host: ${target.hostId}`, 404);
  if (Date.now() - (host.lastHeartbeat ?? 0) > STALE_HEARTBEAT_MS) {
    throw new ActionError(`refusing: host ${host.name} has a stale heartbeat`, 409);
  }

  let queuedAction = action;
  let commandArgs = {
    ...args,
    ...(target.repo ? { repo: target.repo } : {}),
  };
  if (action === 'runner.duplicate') {
    const siblings = (snapshot.fleetRunners ?? []).filter((r) => r.repo === target.repo);
    const instance = Math.max(...siblings.map((r) => r.instance ?? 1)) + 1;
    queuedAction = 'runner.register';
    commandArgs = {
      repo: target.repo,
      instance,
      labels: target.runner?.extraLabels ?? [],
    };
  }
  const idempotencyKey = `ui.${queuedAction}.${randomUUID()}`;
  const commandId = CONFIG.databaseUrl
    ? await ha.queueCommand(target.hostId, queuedAction, commandArgs, idempotencyKey)
    : Number(stmt.queueCommand.get(
        target.hostId,
        Date.now(),
        queuedAction,
        JSON.stringify(commandArgs),
        idempotencyKey,
      ).id);
  return {
    ok: true,
    queued: true,
    commandId,
    host: host.name,
    command: queuedAction,
    output: `queued for ${host.name}; the agent will receive it on its next heartbeat`,
  };
}

function hostRecordFromPayload(hostId, lastSeen, payload) {
  const runners = payload.runners ?? [];
  return {
    id: hostId,
    name: payload.name ?? hostId,
    lastHeartbeat: Number(lastSeen),
    labels: payload.labels ?? [],
    runners,
    repos: payload.repos ?? [],
    host: payload.host ?? {},
    capacity: payload.capacity ?? null,
    runnerCount: runners.length,
    version: payload.version ?? 1,
    drained: Boolean(payload.drained),
  };
}

async function syncHaHosts() {
  if (!CONFIG.databaseUrl) return;
  for (const row of await ha.loadHosts()) {
    if (row.host_id === CONFIG.replicaId) continue;
    hostState.set(row.host_id, hostRecordFromPayload(row.host_id, row.last_seen, row.payload ?? {}));
  }
}

async function syncHaSettings() {
  if (!CONFIG.databaseUrl) return;
  for (const [key, value] of Object.entries(await ha.loadSettings())) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) continue;
    if (value?.__fleetReset === true) {
      settings.reset(key);
    } else if (JSON.stringify(settings.get(key)) !== JSON.stringify(value)) {
      settings.set(key, value);
    }
  }
}

async function resetExpiredCommands() {
  const before = Date.now() - (5 * 60 * 1000);
  const maxAttempts = 3;
  if (CONFIG.databaseUrl) {
    await ha.resetExpiredCommands(before, maxAttempts);
    return;
  }
  db.prepare(`
    UPDATE host_commands
    SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        completed_at = CASE WHEN attempts >= ? THEN ? ELSE completed_at END,
        result = CASE WHEN attempts >= ? THEN 'delivery acknowledgement timed out' ELSE result END
    WHERE status = 'sent' AND started_at < ?
  `).run(maxAttempts, maxAttempts, Date.now(), maxAttempts, before);
}

function claimLocalCommands(hostId, now, limit = 8) {
  const claimed = [];
  for (const command of stmt.pendingCommands.all(hostId).slice(0, limit)) {
    if (stmt.markCommandSent.run(now, command.id).changes === 1) claimed.push(command);
  }
  return claimed;
}

async function reportSelfToHa() {
  if (!CONFIG.databaseUrl) return;
  const report = await collectHostReport({
    root: CONFIG.root,
    hostId: CONFIG.replicaId,
    hostName: CONFIG.hostName,
    labels: CONFIG.hostLabels,
    limits: settings.limits(),
  });
  await ha.upsertHost(CONFIG.replicaId, report, report.reportedAt);
}

async function refreshStandbySnapshot() {
  if (!CONFIG.databaseUrl || ha.isLeader) return;
  const [row] = await Promise.all([
    ha.loadSnapshot(),
    syncHaHosts(),
  ]);
  if (!row?.payload) return;
  snapshot = {
    ...row.payload,
    control: {
      enabled: true,
      role: 'standby',
      replicaId: CONFIG.replicaId,
      leaderId: row.leader_id,
      sourceTs: Number(row.ts),
    },
  };
  publish();
}

async function pollSelfCommands() {
  if (!CONFIG.databaseUrl) return;
  const commands = await ha.claimCommands(CONFIG.replicaId);
  for (const command of commands) {
    const args = command.args ?? {};
    const def = ACTIONS[command.action];
    if (!def) {
      await ha.completeCommand(command.id, false, `unsupported local command: ${command.action}`);
      continue;
    }
    try {
      const actionArgs = command.action === 'runner.register'
        ? { repo: args.repo, label: args.labels ?? [], instance: args.instance }
        : args;
      const result = await def.exec(actionArgs);
      const ok = result.ok ?? result.code === 0;
      await ha.completeCommand(command.id, ok, (result.output ?? '').slice(0, 4000));
      if (ok && command.action === 'runner.register') {
        const cooldowns = await ha.getMeta('autoscale_last_up', {});
        const next = recordScaleUpMeta(cooldowns, {
          repo: args.repo,
          role: args.cooldown?.role ?? null,
          mode: args.cooldown?.mode ?? 'sustained',
        }, Date.now());
        await ha.setMeta('autoscale_last_up', next);
      }
    } catch (err) {
      await ha.completeCommand(command.id, false, String(err.message).slice(0, 4000));
    }
  }
}

function recordTransitions(runners) {
  const now = Date.now();
  for (const r of runners) {
    const key = r.name;
    const cur = `${r.launchdState}|${r.registered ? r.ghStatus : 'unregistered'}|${r.ghBusy ? 'busy' : 'idle'}`;
    const prev = lastRunnerState.get(key);
    if (prev !== undefined && prev !== cur) {
      stmt.insertEvent.run(now, r.name, r.repo, 'state', `${prev} -> ${cur}`);
      log(`runner ${r.name}: ${prev} -> ${cur}`);
    }
    lastRunnerState.set(key, cur);

    // Drain is tracked separately from the state string above, because it is a
    // different kind of fact: that string is what the machine observed, and this
    // is what somebody decided. Kept as its own event kind so "who stopped this
    // runner, and when" is answerable from the runner drawer during an incident
    // — the case this exists for is finding out that the reason a repo has no CI
    // is a drain from three days ago that nobody resumed.
    const drainNow = r.drainState ?? 'none';
    const drainPrev = lastDrainState.get(key);
    if (drainPrev !== undefined && drainPrev !== drainNow) {
      stmt.insertEvent.run(now, r.name, r.repo, 'drain', `${drainPrev} -> ${drainNow}`);
      log(`runner ${r.name}: drain ${drainPrev} -> ${drainNow}`);
    }
    lastDrainState.set(key, drainNow);

    // Version changes, which is the only record that an auto-update happened.
    // GitHub updates runners without announcing it and keeps no per-runner
    // history, so if this is not captured as it changes the information does not
    // exist anywhere. It is what makes "did anything change just before this
    // started failing" answerable.
    const verNow = r.version ?? 'unknown';
    const verPrev = lastVersionState.get(key);
    if (verPrev !== undefined && verPrev !== verNow) {
      stmt.insertEvent.run(now, r.name, r.repo, 'version', `${verPrev} -> ${verNow}`);
      log(`runner ${r.name}: version ${verPrev} -> ${verNow}`);
    }
    lastVersionState.set(key, verNow);

    stmt.upsertRunner.run(r.name, r.repo, r.dir, JSON.stringify(r.labels), r.ghId,
      r.ghStatus, b(r.ghBusy), r.launchdLabel, r.launchdState, r.pid,
      r.rssMb != null ? r.rssMb * 1024 : null, null, now);
    stmt.updateRunnerDrain.run(r.drainState ?? null, r.version ?? null, now, r.name);
  }
}

// Version drift for one runner: what it runs, what register.sh installs today,
// and what the rest of the fleet is on.
//
// GitHub auto-updates runners and there is no supported way to gate that, so
// this is deliberately not a rollout control. What it is for is answering the
// question that comes up after an update breaks something: which runners moved,
// when, and is this one an outlier. A runner alone on a version is the one to
// look at first, and that is invisible without comparing across the fleet.
function versionReport(runner) {
  const versions = runnerVersions(runner.dir);

  // What a runner registered right now would get. Read from register.sh rather
  // than duplicated here, so the two cannot drift apart.
  let pinned = null;
  try {
    const src = readFileSync(join(CONFIG.root, 'register.sh'), 'utf8');
    pinned = src.match(/^VERSION="([^"]+)"/m)?.[1] ?? null;
  } catch { /* a fleet root without register.sh is not a reason to fail */ }

  // How many runners share each version, so "everything is on this" and "only
  // this one is" are distinguishable.
  const counts = new Map();
  for (const r of snapshot.runners ?? []) {
    const v = r.version ?? 'unknown';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const fleet = [...counts].sort((a, b) => b[1] - a[1]).map(([version, count]) => ({ version, count }));

  const active = versions.active;
  const alone = active != null && (counts.get(active) ?? 0) === 1 && (snapshot.runners?.length ?? 0) > 1;

  // The most recent auto-update this runner went through, from its own event
  // log. This is the only record that it happened at all.
  let lastUpdate = null;
  try {
    lastUpdate = db.prepare(
      "SELECT ts, detail FROM runner_events WHERE name = ? AND kind = 'version' ORDER BY ts DESC LIMIT 1"
    ).get(runner.name) ?? null;
  } catch { /* the column may not have rows yet */ }

  return {
    active,
    sideBySide: versions.sideBySide,
    // Downloaded and newer than what is running: takes effect on next restart.
    stagedUpdate: versions.stagedUpdate,
    installVersion: pinned,
    // Not called "behind": a runner ahead of register.sh's pin is the normal
    // state after an auto-update, and calling that drift would report the whole
    // fleet as wrong.
    differsFromInstall: Boolean(pinned && active && pinned !== active),
    fleet,
    aloneOnVersion: alone,
    lastUpdate,
  };
}

// Shadow-mode forecast scoring.
//
// A forecast nobody scores is a forecast nobody can trust, and the cost of
// trusting a bad one is a runner pre-warmed for work that never arrives. So the
// daemon predicts, waits for the window to pass, and writes down what actually
// happened. evaluateGate() reads those rows; until it passes, no forecast is
// allowed to act.
//
// Scored one window BEHIND: the hour just gone is the newest one whose outcome
// is fully known. Scoring the current hour would compare a prediction against a
// window still filling up and record a miss for every burst that had not
// happened yet.
function scoreForecasts() {
  const HOUR = 3600_000;
  const now = Date.now();
  const windowStart = Math.floor(now / HOUR) * HOUR - HOUR;
  const windowEnd = windowStart + HOUR;

  // Already scored? This runs every slow tick, which is more often than hourly.
  const existing = db.prepare(
    'SELECT COUNT(*) AS n FROM forecast_evals WHERE window_start = ?'
  ).get(windowStart);
  if ((existing?.n ?? 0) > 0) return;

  // Rebuild the baseline from history that ENDS before the window being scored.
  // Including the window itself would let the prediction see the answer, which
  // is how a model gets a perfect score and no predictive value.
  const since = new Date(windowStart - 60 * 86400000).toISOString();
  const history = db.prepare(`
    SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
    WHERE started_at >= ? AND started_at < ? AND duration_ms IS NOT NULL`)
    .all(since, new Date(windowStart).toISOString());
  if (!history.length) return;

  const baseline = buildBaseline(history, { now: windowStart });
  const schedules = extractSchedules(stmt.workflowFiles.all());
  const predictions = forecastDemand({
    baseline, schedules, hoursAhead: 1, now: windowStart,
  });
  if (!predictions.length) return;

  const actual = db.prepare(`
    SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
    WHERE started_at >= ? AND started_at < ?`)
    .all(new Date(windowStart - HOUR).toISOString(), new Date(windowEnd + HOUR).toISOString());

  const insert = db.prepare(`
    INSERT INTO forecast_evals
      (ts, window_start, window_end, repo, predicted_peak, actual_peak, false_positive, model_version)
    VALUES (?,?,?,?,?,?,?,?)`);

  for (const prediction of predictions) {
    for (const repoPred of prediction.repos) {
      const ev = evaluatePrediction({ prediction, actualJobs: actual, repo: repoPred.repo });
      insert.run(now, windowStart, windowEnd, repoPred.repo,
        ev.predictedPeak, ev.actualPeak, ev.falsePositive, 'weekday-hour-v1');
    }
  }
}

// ------------------------------------------------------------------ the loops

let dirsCache = [];
// Seeded from the repos table rather than starting empty, because the slow loop
// is what fills it and the slow loop may be fifteen minutes away. Everything
// that reads the roster for DISPLAY tolerated that gap; reposToPoll() does not.
// It uses the roster to find repos with no runner directory, so an empty roster
// means a trimmed repo's queued work is not merely late to appear, it is not
// collected at all — and the first live test of provisioning missed its window
// for exactly this reason: the daemon restarted, the roster came back empty, and
// a run that had been queued for four minutes stopped being visible.
//
// The table is written by the same slow loop, so this is that loop's own last
// answer, reused until it produces a new one.
let repoRoster = loadRosterFromDb();
let lastSampleAt = 0;

function loadRosterFromDb() {
  try {
    return db
      .prepare(
        `SELECT full_name, name, archived, private, pushed_at, workflows, has_runner, default_branch
           FROM repos WHERE archived = 0 AND (workflows > 0 OR has_runner = 1)`
      )
      .all()
      .map((r) => ({
        fullName: r.full_name,
        name: r.name,
        project: null,
        archived: Boolean(r.archived),
        private: Boolean(r.private),
        pushedAt: r.pushed_at,
        workflows: r.workflows ?? 0,
        hasRunner: Boolean(r.has_runner),
        defaultBranch: r.default_branch ?? null,
      }));
  } catch {
    // A fresh database has no repos table content yet. Starting empty is the
    // old behaviour and the slow loop will fill it.
    return [];
  }
}

// Per-repo concurrent demand, from job history. Refreshed in the slow loop
// because it sweeps every job in the retention window — cheap enough every 15
// minutes, wasteful every 15 seconds, and the answer moves on the order of days.
let concurrencyCache = new Map();

// Whether the duplicates that exist actually shortened their repo's queue.
let effectCache = [];

function refreshConcurrency() {
  try {
    concurrencyCache = concurrencyByRepo(db, { days: 60 });
  } catch (err) {
    // Sizing degrades to "live queue only", which is still useful. Losing the
    // history is not a reason to stop serving the page.
    warn('sizing: concurrency history unavailable:', err.message);
  }

  try {
    // One split per repo that has a duplicate, at the moment its FIRST duplicate
    // was created. Earliest wins, because that is when the repo stopped being
    // served by a single runner — which is the change being measured.
    const splits = new Map();
    for (const r of snapshot.runners ?? []) {
      if ((r.instance ?? 1) < 2) continue;
      let at;
      try {
        at = statSync(r.dir).birthtimeMs;
      } catch {
        continue;
      }
      const prev = splits.get(r.repo);
      if (prev == null || at < prev) splits.set(r.repo, at);
    }
    effectCache = queueEffect(db, [...splits].map(([repo, at]) => ({ repo, at })));
  } catch (err) {
    warn('sizing: queue-effect unavailable:', err.message);
  }
}

// The names groups are inferred from, and the reason this is not simply "the
// repos we polled this tick".
//
// A group derived from one tick's API results dissolves the moment a call
// fails, and a heading that vanishes and comes back moves every tile on the
// page under it. That is the same failure the drift rules already guard
// against — a single 503 once produced a 46-second phantom orphan alert — so
// the corpus is drawn from the two sources that do not depend on this tick
// succeeding: the runner directories on disk, and every repo the roster has
// ever persisted.
function refreshGroups() {
  // Only repos the fleet has something to do with — the same test the roster
  // uses. An account's worth of boilerplates, tutorial checkouts and
  // dependency-sized modules otherwise votes on the grouping: two unrelated
  // repos that happen to start `github-` were enough to invent a `github`
  // heading, and a second repo under a prefix whose only real member has no
  // runner was enough to promote a singleton out of "other".
  let persisted = [];
  try {
    persisted = db
      .prepare('SELECT full_name FROM repos WHERE workflows > 0 OR has_runner = 1')
      .all()
      .map((r) => r.full_name);
  } catch (err) {
    warn('group corpus: could not read repos table:', err.message);
  }
  const corpus = [...dirsCache.map((d) => d.repo), ...persisted, ...repoRoster.map((r) => r.fullName)];
  groups = deriveGroups(corpus, groupOpts());
  // Roster entries loaded from the database at startup carry no project: the
  // grouping did not exist when they were read. The slow loop stamps the ones it
  // fetches, which leaves the hydrated ones unfiled for up to fifteen minutes
  // unless they are stamped here too.
  for (const r of repoRoster) if (r.project == null) r.project = groups.of(r.fullName);
}
// Swapins/Swapouts from vm_stat are cumulative since boot; only the rate means
// anything. Held across ticks so the difference can be turned into per-second.
let lastSwapCounters = null;

// ------------------------------------------------------------------ autoscale

// The last decision, acted on or not, published in the snapshot. A scaler that
// refuses silently is indistinguishable from a scaler that is broken, and this
// one is expected to refuse most of the time.
let lastAutoscale = { at: null, action: null, acted: false, reason: 'not run yet' };

const lastJobStmt = () =>
  db.prepare('SELECT MAX(completed_at) AS last FROM jobs WHERE runner_name = ?');

// How long each runner has been idle, and how old it is. Both come from durable
// sources — the job history and the directory's own creation time — rather than
// from a counter held in memory, so a daemon restart does not reset every timer
// and hand the scaler a fleet that looks brand new.
function idleInfo(runners) {
  const stmt = lastJobStmt();
  const now = Date.now();
  const map = new Map();
  for (const r of runners) {
    let lastJobAt = null;
    try {
      const row = stmt.get(r.name);
      const parsed = row?.last ? Date.parse(row.last) : NaN;
      if (Number.isFinite(parsed)) lastJobAt = parsed;
    } catch {
      // No history for this runner is itself meaningful — it has run nothing.
    }
    let ageMs = 0;
    if (Number.isFinite(r.createdAt)) {
      ageMs = now - r.createdAt;
    } else try {
      ageMs = now - statSync(r.dir).birthtimeMs;
    } catch {
      // Unreadable age is treated as brand new, which makes the runner
      // ineligible for removal. Failing towards "leave it alone" is the only
      // safe direction for a delete.
      ageMs = 0;
    }
    map.set(r.name, { lastJobAt, ageMs });
  }
  return map;
}

function autoscaleLimits() {
  return {
    ...settings.limits(),
    ...settings.autoscaleLimits(),
  };
}

function recordScaleUpMeta(lastUpByRepo, plan, now) {
  const key = sizingKey(plan.repo, plan.role ?? null);
  const next = {
    ...lastUpByRepo,
    [plan.repo]: now,
    [key]: now,
  };
  setMeta(db, 'autoscale_last_up', JSON.stringify(next));
  if (plan.mode === 'prewarm') {
    let previous = {};
    try {
      previous = JSON.parse(getMeta(db, 'prewarm_last_by_repo', '{}')) ?? {};
    } catch {
      previous = {};
    }
    setMeta(db, 'prewarm_last_by_repo', JSON.stringify({ ...previous, [plan.repo]: now }));
  }
  return next;
}

async function autoscaleTick(forcedPlan = null) {
  const autoscaleEnabled = settings.get('autoscale');
  const prewarmEnabled = settings.get('prewarm');
  if (CONFIG.readOnly || (!autoscaleEnabled && !prewarmEnabled)) {
    lastAutoscale = {
      at: Date.now(),
      action: null,
      acted: false,
      reason: CONFIG.readOnly ? 'daemon is read-only' : 'autoscaling and pre-warm are off',
    };
    return;
  }

  const dryRun = settings.get('autoscaleDryRun');
  const limits = autoscaleLimits();
  const snap = snapshot;

  // Fleet-wide runner list for sizing and scale decisions.
  const fleetRunners = buildFleetRunners(snap.runners ?? [], snap.elsewhere ?? [], hostState);

  // Build the host list for placement: coordinator as first-class member, then
  // all connected agents. Stale hosts are included so choosePlacement can name
  // them explicitly as the reason they were skipped.
  const coordinatorDrained = Boolean(hostDrainState(CONFIG.root));
  // choosePlacement returns host.name (not .id) as the chosen value. Store the
  // coordinator's name separately so the local vs. remote branch below can
  // compare against it without re-deriving it.
  const coordinatorName = CONFIG.hostName;
  const allHosts = buildHostList(
    { ts: snap.ts ?? Date.now(), runners: snap.runners ?? [], host: snap.host ?? {}, capacity: snap.capacity ?? null },
    hostState,
    {
      coordinatorLabels: CONFIG.hostLabels,
      coordinatorDrained,
      coordinatorName,
      coordinatorId: CONFIG.replicaId,
    }
  );

  // Fleet-wide capacity gate: if any non-stale host has headroom, scale-up can
  // proceed — on whichever host placement chooses. This prevents a saturated
  // coordinator from blocking a remote scale-up.
  const fleetCapacity = anyHostHasCapacity(allHosts)
    ? { ok: true, reasons: [] }
    : { ok: false, reasons: ['no eligible host has capacity for a new runner'] };

  // JSON by hand: setMeta stores String(value), so an object handed to it
  // becomes the literal "[object Object]" and every cooldown silently vanishes.
  let lastUpByRepo = {};
  try {
    lastUpByRepo = CONFIG.databaseUrl
      ? await ha.getMeta('autoscale_last_up', {})
      : (JSON.parse(getMeta(db, 'autoscale_last_up', '{}')) ?? {});
  } catch {
    lastUpByRepo = {};
  }

  // The classifier's verdicts, keyed by run, so planScaleUp can refuse to add a
  // runner for anything it has diagnosed as not being a capacity problem.
  const queueCauses = new Map(
    (snap.queue ?? []).map((q) => [q.id, {
      repo: q.repo, cause: q.cause, confidence: q.confidence, actionEligible: q.actionEligible,
    }])
  );

  const up = forcedPlan ?? (autoscaleEnabled
    ? planScaleUp({
        sizing: snap.sizing ?? [],
        // Fleet-wide capacity so planScaleUp does not refuse when the coordinator is
        // saturated but a remote host has room.
        capacity: fleetCapacity,
        // Fleet-wide runners so sizing sees runners on all hosts.
        runners: fleetRunners,
        active: snap.active ?? [],
        lastUpByRepo,
        limits,
        queueCauses,
        revalidate: true,
      })
    : { act: false, reason: 'reactive autoscaling is off', deficit: 0 });

  // Scale up wins. Considering removal in the same sweep that wanted to add
  // would let one tick both add and remove a runner on contradictory evidence.
  let plan = up;
  let kind = 'up';
  if (autoscaleEnabled && !up.act && settings.get('scaleDown')) {
    const down = planScaleDown({
      runners: fleetRunners,
      active: snap.active ?? [],
      idle: idleInfo(fleetRunners),
      limits,
    });
    if (down.act) {
      plan = down;
      kind = 'down';
    }
  }

  if (!plan.act && prewarmEnabled) {
    const prewarmCfg = settings.prewarmLimits();
    const hoursAhead = Math.ceil(prewarmCfg.prewarmLeadMs / 3_600_000) + 1;
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const history = db.prepare(`
      SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
      WHERE started_at >= ? AND duration_ms IS NOT NULL`).all(since);
    const baseline = buildBaseline(history);
    const schedules = extractSchedules(stmt.workflowFiles.all());
    const predictions = forecastDemand({ baseline, schedules, hoursAhead });
    const evals = db.prepare(
      'SELECT predicted_peak, actual_peak, false_positive FROM forecast_evals ORDER BY ts DESC LIMIT 500'
    ).all();
    const gate = evaluateGate(evals);
    let lastPrewarmByRepo = {};
    try {
      lastPrewarmByRepo = JSON.parse(getMeta(db, 'prewarm_last_by_repo', '{}')) ?? {};
    } catch {
      lastPrewarmByRepo = {};
    }
    const prewarm = planPrewarm({
      enabled: prewarmCfg.prewarm,
      predictions,
      gate,
      runners: fleetRunners,
      active: snap.active ?? [],
      lastPrewarmByRepo,
      now: Date.now(),
      leadMs: prewarmCfg.prewarmLeadMs,
      cooldownMs: prewarmCfg.prewarmCooldownMs,
      minConfidence: prewarmCfg.prewarmMinConfidence,
      cap: prewarmCfg.maxInstancesPerRepo,
    });
    if (prewarm.act) {
      plan = prewarm;
      kind = 'up';
    } else if (!autoscaleEnabled) {
      lastAutoscale = {
        at: Date.now(),
        action: null,
        acted: false,
        reason: prewarm.reason,
        mode: 'prewarm',
        deficit: prewarm.deficit ?? 0,
      };
      return;
    }
  }

  if (!plan.act) {
    lastAutoscale = {
      at: Date.now(),
      action: null,
      acted: false,
      reason: plan.reason,
      mode: plan.mode ?? 'none',
      deficit: plan.deficit ?? 0,
    };
    return;
  }

  if (kind === 'down') {
    const action = 'runner.deregister';
    const label = 'autoscale.down';
    const detail = `${plan.name} (${plan.repo}): ${plan.reason}`;

    if (dryRun) {
      log(`${label} DRY RUN: would ${action} ${detail}`);
      logAction.run(Date.now(), `${label} (dry run)`, JSON.stringify({ name: plan.name }),
        `${action} ${plan.name}`, 0, 1, `DRY RUN — no change made.\n${detail}`);
      lastAutoscale = { at: Date.now(), action, acted: false, reason: `dry run: ${detail}` };
      return;
    }

    log(`${label}: ${action} ${detail}`);
    const started = Date.now();
    try {
      const remote = await queueRemoteAction(action, { name: plan.name });
      const result = remote ?? await ACTIONS[action].exec({ name: plan.name });
      const ok = result.ok ?? result.code === 0;
      logAction.run(started, label, JSON.stringify({ name: plan.name }), result.command ?? null,
        result.code ?? null, ok ? 1 : 0, `${detail}\n\n${(result.output ?? '').slice(0, 18000)}`);
      lastAutoscale = { at: started, action, acted: ok, reason: detail };
      if (!ok) warn(`${label} failed:`, (result.output ?? '').slice(0, 300));
      await fastTick().catch(() => {});
    } catch (err) {
      logAction.run(Date.now(), label, JSON.stringify({ name: plan.name }), action, null, 0,
        `${detail}\n\nrefused: ${err.message}`);
      lastAutoscale = { at: Date.now(), action, acted: false, reason: `refused: ${err.message}` };
    }
    return;
  }

  // Scale-up: choose the best host for the new runner.
  // Labels are copied from the source runner (returned by planScaleUp) so the
  // new runner matches the same `runs-on:` as its siblings.
  const sourceRunner = fleetRunners.find((r) => r.name === plan.name);
  const requiredLabels = requiredLabelsFromPlan(plan, sourceRunner);

  const placement = choosePlacement({
    hosts: allHosts,
    repo: plan.repo,
    requiredLabels,
    // A first runner is placed on a busy host deliberately. See the parameter's
    // own note: the alternative is that a trimmed repo gets its runner back only
    // when the fleet is quiet, which on this host is not when anyone is pushing.
    requireHeadroom: !plan.firstRunner,
  });

  const now = Date.now();
  const detail = `${plan.repo}${plan.role ? `/${plan.role}` : ''}: ${plan.reason}`;
  const scaleLabel = plan.mode === 'prewarm' ? 'autoscale.prewarm' : 'autoscale.up';
  const chosenHostId = placement.chosenId ?? placement.chosen;

  // Record every placement decision, including refused ones. The operator needs
  // to see why a host was skipped — "stale heartbeat" and "missing xcode-16"
  // are different problems with different remedies.
  try {
    stmt.insertPlacement.run(
      now, plan.repo, chosenHostId ?? null,
      'runner.register', placement.reason, dryRun ? 1 : 0,
    );
    if (CONFIG.databaseUrl) {
      await ha.insertPlacement({
        ts: now,
        repo: plan.repo,
        hostId: chosenHostId ?? null,
        action: 'runner.register',
        reason: placement.reason,
        dryRun,
      });
    }
  } catch (err) {
    warn('placement record:', err.message);
  }

  if (!placement.chosen) {
    log(`${scaleLabel}: no eligible host for ${plan.repo}: ${placement.reason}`);
    logAction.run(now, scaleLabel, JSON.stringify({ repo: plan.repo }),
      null, null, 0, `no eligible host\n${placement.reason}`);
    lastAutoscale = { at: now, action: 'runner.register', acted: false, reason: placement.reason };
    return;
  }

  if (dryRun) {
    log(`${scaleLabel} DRY RUN: would runner.register on ${placement.chosen} for ${detail}`);
    logAction.run(now, `${scaleLabel} (dry run)`,
      JSON.stringify({ host: placement.chosen, repo: plan.repo }),
      'runner.register', 0, 1,
      `DRY RUN — no change made.\n${detail}\nwould place on ${placement.chosen}`);
    lastAutoscale = {
      at: now, action: 'runner.register', acted: false,
      reason: `dry run: ${placement.chosen} — ${detail}`,
      mode: plan.mode,
      deficit: plan.deficit,
    };
    return;
  }

  const isLocal = chosenHostId === CONFIG.replicaId;

  if (isLocal) {
    // Coordinator path: use the same actions the UI uses, so autoscale actions
    // appear identically in the action_log.
    //
    // Which action depends on whether the repo has a runner to copy. duplicate
    // is addressed by an existing runner NAME and derives the rest from it,
    // which a repo with none cannot supply; register is addressed by the repo
    // and needs the labels stated outright. Same intent, different arguments.
    const label = scaleLabel;
    const action = plan.register ? 'runner.register' : 'runner.duplicate';
    const siblings = fleetRunners.filter((r) => r.repo === plan.repo);
    const nextInstance = Math.max(...siblings.map((r) => r.instance ?? 1), 0) + 1;
    const args = plan.register
      ? {
          repo: plan.repo,
          label: plan.extraLabels ?? [],
          instance: plan.firstRunner ? 1 : nextInstance,
        }
      : { name: plan.name };
    log(`${label}: ${action} ${plan.register ? plan.repo : plan.name} (${plan.repo}): ${plan.reason}`);
    const started = now;
    try {
      const result = await ACTIONS[action].exec(args);
      const ok = result.ok ?? result.code === 0;
      logAction.run(started, label, JSON.stringify(args), result.command ?? null,
        result.code ?? null, ok ? 1 : 0, `${detail}\n\n${(result.output ?? '').slice(0, 18000)}`);
      if (ok) {
        const nextCooldowns = recordScaleUpMeta(lastUpByRepo, plan, now);
        if (CONFIG.databaseUrl) await ha.setMeta('autoscale_last_up', nextCooldowns);
      }
      lastAutoscale = {
        at: started,
        action,
        acted: ok,
        reason: detail,
        host: 'local',
        mode: plan.mode,
        deficit: plan.deficit,
      };
      if (!ok) warn(`${label} failed:`, (result.output ?? '').slice(0, 300));
      await fastTick().catch(() => {});
      if (ok && plan.revalidate && (plan.actions?.length ?? 0) > 1) {
        for (const next of plan.actions.slice(1)) {
          await autoscaleTick({ ...next, revalidate: false, actions: [] });
        }
      }
    } catch (err) {
      // A refusal from the action layer is the expected failure, not an anomaly:
      // headroom can close between the snapshot and the call.
      logAction.run(now, label, JSON.stringify(args), action, null, 0,
        `${detail}\n\nrefused: ${err.message}`);
      lastAutoscale = { at: now, action, acted: false, reason: `refused: ${err.message}` };
    }
  } else {
    // Remote path: fetch a short-lived GitHub registration token and queue a
    // runner.register command for the chosen agent host.
    const siblings = fleetRunners.filter((r) => r.repo === plan.repo);
    const next = Math.max(...siblings.map((r) => r.instance ?? 1), 0) + 1;

    // Idempotency key scoped to repo + instance + minute. The minute window
    // prevents two rapid autoscaleTick calls from queuing the same command
    // twice; the agent's runner-directory check handles the restart case.
    const idempotencyKey = `register.${plan.repo}.${next}.${Math.floor(now / 60000)}`;
    const cmdArgs = JSON.stringify({
      repo: plan.repo,
      labels: requiredLabels,
      instance: next,
      // Tokens are minted when the command is delivered. Keeping a one-hour
      // GitHub credential in fleet.db and its backups is unnecessary exposure.
      cooldown: { mode: plan.mode, role: plan.role ?? null },
    });

    try {
      if (CONFIG.databaseUrl) {
        await ha.queueCommand(
          chosenHostId, 'runner.register', JSON.parse(cmdArgs), idempotencyKey, now
        );
      } else {
        stmt.queueCommand.get(chosenHostId, now, 'runner.register', cmdArgs, idempotencyKey);
      }
      const cmdDetail = `${plan.repo} instance ${next} on ${placement.chosen}: ${plan.reason}`;
      logAction.run(now, scaleLabel,
        JSON.stringify({ host: placement.chosen, repo: plan.repo, instance: next }),
        'runner.register', null, 1, `queued ${cmdDetail}`);
      lastAutoscale = {
        at: now, action: 'runner.register', acted: false,
        reason: `queued: ${plan.reason}`,
        host: placement.chosen,
        mode: plan.mode,
        deficit: plan.deficit,
      };
    } catch (err) {
      warn(`${scaleLabel}: could not queue command:`, err.message);
      lastAutoscale = {
        at: now, action: 'runner.register', acted: false,
        reason: `queue failed: ${err.message}`,
      };
    }
  }
}

function reposToPoll() {
  const fromRunners = [...new Set(dirsCache.map((d) => d.repo))];
  if (!fromRunners.length) {
    // A machine with no runners of its own can still watch the fleet. Fall back to
    // whatever the roster last knew had workflows.
    return repoRoster.filter((r) => !r.archived && r.workflows).map((r) => r.fullName);
  }
  if (!settings.get('provisionUnserved')) return fromRunners;

  // Provisioning a first runner needs to SEE the queue it is provisioning for,
  // and the list above cannot: it is derived from runner directories, so a repo
  // with no runner is never polled, its queued runs never enter the snapshot,
  // and classifyQueueCause never gets the chance to call it `unserved`. Trimming
  // a repo's last runner without this would not degrade its CI, it would hide
  // it — the queue would grow on GitHub and the dashboard would show nothing.
  //
  // The roster is every non-archived owned repo that has workflows, refreshed on
  // the slow tick. Polling the union costs one extra runs query per repo per
  // tick, which is cheap for the reason the collector is already built around:
  // lib/github.js sends If-None-Match, and an idle repo answers 304 without
  // spending rate budget. The repos this adds are by definition the quiet ones.
  const union = new Set(fromRunners);
  for (const r of repoRoster) {
    if (!r.archived && r.workflows) union.add(r.fullName);
  }
  return [...union];
}

// The ten-minute backfill is durable history, but it is too slow for a failure
// that should be diagnosed before remediation decides whether to rerun it. Pull
// job detail and annotations for only the newest failed runs, under a tiny call
// budget; the regular backfill still fills steps and older history.
async function classifyRecentFailures(runs, maxCalls = 4) {
  let calls = 0;
  const hasJobs = db.prepare('SELECT 1 FROM jobs WHERE run_id = ? LIMIT 1');
  const unclassified = db.prepare(`
    SELECT id, repo FROM jobs
    WHERE run_id = ? AND conclusion IN ('failure','timed_out')
      AND failure_class IS NULL AND id > 0`);
  const setClass = db.prepare(
    'UPDATE jobs SET failure_class = ?, failure_detail = ? WHERE id = ?'
  );

  const newest = runs
    .filter((run) =>
      run.status === 'completed'
      && (run.conclusion === 'failure' || run.conclusion === 'timed_out'))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  for (const run of newest) {
    if (calls >= maxCalls || (gh.rate.remaining != null && gh.rate.remaining <= CONFIG.backfillFloor)) break;
    if (!hasJobs.get(run.id)) {
      try {
        const jobs = await gh.jobsForRun(run.repo, run.id);
        calls++;
        for (const raw of jobs) persistJob(shapeJob(run.repo, raw));
      } catch (err) {
        warn(`fast failure jobs ${run.repo}#${run.id}:`, err.message);
        continue;
      }
    }
    for (const job of unclassified.all(run.id)) {
      if (calls >= maxCalls || (gh.rate.remaining != null && gh.rate.remaining <= CONFIG.backfillFloor)) break;
      try {
        const messages = await gh.failureAnnotations(job.repo, job.id);
        calls++;
        setClass.run(classifyAnnotations(messages), messages[0]?.slice(0, 2000) ?? null, job.id);
      } catch (err) {
        warn(`fast failure cause ${job.repo}#${job.id}:`, err.message);
      }
    }
  }
}

async function fastTick() {
  const started = Date.now();
  await resetExpiredCommands().catch((err) => warn('command retry cleanup:', err.message));
  await syncHaSettings().catch((err) => warn('shared settings:', err.message));
  await syncHaHosts().catch((err) => warn('shared hosts:', err.message));
  dirsCache = discoverRunnerDirs(CONFIG.root);
  // Before anything is shaped: shapeRun and buildRunners both stamp a group
  // onto what they build, so the grouping has to be current by this point.
  refreshGroups();

  const [launchd, processes, vitals] = await Promise.all([
    launchdJobs(),
    runnerProcesses(),
    hostVitals(),
  ]);

  const repos = reposToPoll();
  const ghRunnersByRepo = new Map();
  // A normal recent-runs page keeps the completed-history strip current while
  // status-filtered pagination guarantees that an older queued run cannot be
  // pushed out of view by newer completions. Both sources can contain the same
  // run, so merge by repo+id before shaping the active set.
  const allRunsByKey = new Map();
  const rememberRun = (repo, run) => {
    const key = `${repo}:${run.id}`;
    if (!allRunsByKey.has(key)) allRunsByKey.set(key, shapeRun(repo, run, groups));
  };
  // Per tick, not per client. One repo failing must not be reported as "the
  // collector is broken", and a tick where everything succeeds clears the
  // error by construction rather than by remembering to reset a field.
  const failures = [];

  // Repos whose RUNNER list was actually fetched this tick. Not the same as
  // "repos we asked about": if the call failed we know nothing about that repo's
  // runners, which is a different state from knowing it has none.
  const runnersKnownFor = new Set();

  await Promise.all(
    repos.map(async (repo) => {
      // allSettled, not all: these are independent questions, and a failure to
      // list runs used to take the runner list down with it — which then made
      // every runner for that repo look deregistered.
      const [runnersRes, runsRes, activeRunsRes] = await Promise.allSettled([
        gh.runners(repo),
        gh.runs(repo),
        gh.activeRuns(repo),
      ]);
      if (runnersRes.status === 'fulfilled') {
        ghRunnersByRepo.set(repo, runnersRes.value);
        runnersKnownFor.add(repo);
      } else {
        failures.push({ repo, message: runnersRes.reason?.message ?? String(runnersRes.reason) });
      }
      if (runsRes.status === 'fulfilled') {
        for (const r of runsRes.value) rememberRun(repo, r);
      } else {
        failures.push({ repo, message: runsRes.reason?.message ?? String(runsRes.reason) });
      }
      if (activeRunsRes.status === 'fulfilled') {
        for (const r of activeRunsRes.value) rememberRun(repo, r);
      } else {
        failures.push({ repo, message: activeRunsRes.reason?.message ?? String(activeRunsRes.reason) });
      }
    })
  );

  const allRuns = [...allRunsByKey.values()];

  // Only worth showing when it survived the retries inside gh.get().
  //
  // Counted by distinct REPO, not by failed call. Each repo contributes two
  // independent calls, so a total outage of 24 repos reported "48 of 24 repos
  // failed" and named every one of them twice — a summary that reads like the
  // collector is confused, at the moment it most needs to be believed.
  const failedRepos = [...new Set(failures.map((f) => f.repo))];
  const repoErrors = Object.fromEntries(
    failedRepos.map((repo) => [
      repo,
      [...new Set(failures.filter((f) => f.repo === repo).map((f) => f.message))].join('; '),
    ])
  );
  const ghError = failures.length
    ? failedRepos.length === 1
      ? failures[0].message
      : `${failedRepos.length} of ${repos.length} repos failed: ${failedRepos.map((r) => r.split('/').pop()).join(', ')}`
    : null;

  // Turn the cumulative swap counters into a rate before anything reads them.
  // A counter reset (reboot) shows up as a negative delta and is discarded
  // rather than reported as a huge negative rate.
  let swapinsPerSec = null;
  let swapoutsPerSec = null;
  if (lastSwapCounters) {
    const dt = (started - lastSwapCounters.at) / 1000;
    const di = vitals.swapins - lastSwapCounters.swapins;
    const doo = vitals.swapouts - lastSwapCounters.swapouts;
    if (dt > 0 && di >= 0 && doo >= 0) {
      swapinsPerSec = di / dt;
      swapoutsPerSec = doo / dt;
    }
  }
  lastSwapCounters = { at: started, swapins: vitals.swapins, swapouts: vitals.swapouts };

  const { runners, elsewhere } = buildRunners({ dirs: dirsCache, ghRunnersByRepo, launchd, processes, runnersKnownFor, groups });

  // Fleet-wide runner list: local runners plus runners on agent hosts, enriched
  // with agent heartbeat data (workingLocally, drainState, launchdState).
  // Used for sizing, queue classification, and placement decisions.
  // Control actions (drain, duplicate, deregister) keep using local `runners`.
  const localHostName = CONFIG.hostName;
  const fleetRunners = buildFleetRunners(runners, elsewhere, hostState, started).map((r) =>
    r.hostId ? r : {
      ...r,
      hostId: LOCAL_HOST_ID,
      hostName: localHostName,
      hostStale: false,
      staleForMs: 0,
    }
  );

  const active = allRuns
    .filter((r) => isActiveRunStatus(r.status))
    .sort((a, b2) => new Date(a.startedAt) - new Date(b2.startedAt));
  const recent = allRuns
    .filter((r) => r.status === 'completed')
    .sort((a, b2) => new Date(b2.updatedAt) - new Date(a.updatedAt))
    .slice(0, 40);

  // Which runner claimed each active run is a per-job fact, so it costs an extra
  // call. Spend it only on active runs — that is where the question is live.
  await mapWithConcurrency(
    active,
    CONFIG.jobFetchConcurrency,
    async (run) => {
      try {
        const jobs = (await gh.jobsForRun(run.repo, run.id)).map((j) => shapeJob(run.repo, j));
        run.jobs = jobs;
        for (const j of jobs) persistJob(j);
        const claimed = jobs.find((j) => j.runnerName);
        run.runnerName = claimed?.runnerName ?? null;
        run.onThisHost = jobs.some((j) => runners.some((r) => r.name === j.runnerName));
      } catch {
        run.jobs = [];
        run.runnerName = null;
      }
    }
  );

  // A busy runner with no timeout can block its repo indefinitely. Compare each
  // live run with the p95 of its own workflow (falling back to repo/fleet
  // history) so the Runs view and alert engine agree on what "running long"
  // means. Sparse history abstains rather than guessing.
  try {
    annotateActiveFromDb(db, active, { now: started });
  } catch (err) {
    warn('long-running:', err.message);
  }

  for (const r of allRuns) persistRun(r);
  await classifyRecentFailures(allRuns).catch((err) => warn('fast failure classification:', err.message));
  recordTransitions(runners);

  if (started - lastSampleAt >= 60000) {
    lastSampleAt = started;
    stmt.insertSample.run(Math.floor(started / 1000) * 1000, vitals.load1, vitals.memUsedMb,
      vitals.memTotalMb, Math.round(vitals.swapUsedMb ?? 0), Math.round(vitals.swapTotalMb ?? 0),
      vitals.diskFreeGb, vitals.diskTotalGb, processes.listeners.size, processes.workers.size,
      vitals.memFreePct, vitals.memPressure, swapinsPerSec, swapoutsPerSec, vitals.memCompressedMb);
  }

  // Named rather than inlined into the snapshot because the capacity gate and
  // the queue classifier both need these numbers, and computing them more than
  // once invites the several views of the host to disagree.
  const host = {
    ...vitals,
    swapinsPerSec,
    swapoutsPerSec,
    root: CONFIG.root,
    listeners: processes.listeners.size,
    workers: processes.workers.size,
    runnerCount: runners.length,
    totalRssMb: [...processes.listeners.values()].reduce((s, p) => s + p.rssKb, 0) / 1024,
  };

  const capacity = headroom({ host, runners, limits: settings.limits() });

  // Fleet-wide capacity: if any connected, non-stale, non-drained agent has
  // headroom, the queue classifier should not report HOST_SATURATION for a
  // coordinator that is at its own ceiling. The correct diagnosis is
  // REPO_CAPACITY — adding a runner on an agent would help.
  const allHosts = buildHostList(
    { ts: started, runners, host, capacity },
    hostState,
    {
      coordinatorLabels: CONFIG.hostLabels,
      coordinatorDrained: Boolean(hostDrainState(CONFIG.root)),
      coordinatorName: localHostName,
      coordinatorId: CONFIG.replicaId,
    },
  );
  const fleetCapacity = anyHostHasCapacity(allHosts) ? { ok: true, reasons: [] } : capacity;
  const mergedFleet = mergeHostSnapshots({ hosts: allHosts, now: started });
  const federation = {
    enabled: mergedFleet.totalHosts > 1,
    totalHosts: mergedFleet.totalHosts,
    staleHosts: mergedFleet.staleHosts,
    fleetCapacityOk: fleetCapacity.ok,
    runnersOnline: fleetRunners.filter((r) => r.ghStatus === 'online').length,
    runnersBusy: fleetRunners.filter((r) => r.ghBusy || r.workingLocally).length,
  };

  // Ordered before deriveDrift because the classifier needs capacity: "every
  // runner is busy" and "the host is saturated" are indistinguishable without
  // it, and only the first is fixed by adding a runner.
  //
  // The lint findings that matter here are the critical ones — unserved and
  // unmatched-label — because those are a structural proof that a job's
  // `runs-on:` can never be satisfied. Recomputed per tick from the cached
  // workflow files, which costs no API calls.
  //
  // Uses fleetRunners so that runners on agent hosts are included in the label
  // map — a remote runner carrying xcode-16 should clear an xcode-16 label
  // check rather than having the classifier report LABEL_MISMATCH.
  const criticalLintRepos = (() => {
    try {
      const byRepo = new Map();
      for (const r of fleetRunners) {
        if (!r.registered) continue;
        if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
        byRepo.get(r.repo).push({ labels: (r.labels ?? []).map((l) => String(l).toLowerCase()) });
      }
      return new Set(
        lintAll({ files: stmt.workflowFiles.all(), runnersByRepo: byRepo })
          .filter((f) => f.severity === 'critical')
          .map((f) => f.repo)
      );
    } catch {
      // A lint failure must not take the drift view with it. Without this set
      // the classifier simply loses one input and falls through to its other
      // evidence, which is the right way to degrade.
      return new Set();
    }
  })();

  const classifyRun = (run) =>
    classifyQueueCause({
      run,
      // Fleet-wide runner list so remote runners count toward busy/idle state.
      runners: fleetRunners,
      // Fleet-wide capacity so a saturated coordinator does not block a
      // repo-capacity diagnosis when an agent has room.
      capacity: fleetCapacity,
      api: gh.rate,
      collector: { lastError: ghError, repoErrors },
      runLabels: queuedJobLabels(run),
      hasLintFindings: criticalLintRepos.has(run.repo),
    });

  const drift = deriveDrift({
    runners, elsewhere, active, repos: repoRoster, now: started, classify: classifyRun,
  });

  // Persist cause TRANSITIONS only, never one row per tick. A run stuck for an
  // hour is one row that changes when the diagnosis changes, which is what makes
  // "how long was this a label mismatch before someone noticed" answerable
  // without keeping a time series of a value that rarely moves.
  for (const run of active) {
    if (run.status !== 'queued') continue;
    try {
      const c = classifyRun(run);
      const prior = stmt.lastQueueEvent.get(run.id);
      if (!prior || prior.cause !== c.cause) {
        if (prior && !prior.resolved_at) stmt.resolveQueueEvent.run(started, prior.id);
        stmt.insertQueueEvent.run(started, run.id, run.repo, c.cause, c.confidence,
          JSON.stringify(c.evidence), c.recommended);
      }
    } catch (err) {
      warn('queue event:', err.message);
    }
  }
  // Close intervals only when GitHub positively reports that run in another
  // state. Absence is not proof: a repo call may have failed or an old run may
  // be outside the recent page.
  const observedNotQueued = new Set(
    allRuns.filter((run) => run.status !== 'queued').map((run) => run.id)
  );
  if (observedNotQueued.size) {
    try {
      for (const row of db.prepare(
        'SELECT id, run_id FROM queue_events WHERE resolved_at IS NULL'
      ).all()) {
        if (observedNotQueued.has(row.run_id)) stmt.resolveQueueEvent.run(started, row.id);
      }
    } catch (err) {
      warn('queue event resolve:', err.message);
    }
  }

  // Before the snapshot is built, so a hold that started seconds ago is in this
  // tick rather than the next one. Reads only bytes appended since last pass.
  try {
    admission.ingest();
  } catch (err) {
    warn('admission ingest:', err.message);
  }

  // Playwright per-test outcomes — non-blocking, appended by job-completed.sh.
  try {
    await ingestTestOutcomes(db, CONFIG.testOutcomesSpool);
  } catch (err) {
    warn('test outcomes ingest:', err.message);
  }

  snapshot = {
    ts: started,
    starting: false,
    host,
    runners,
    elsewhere,
    fleetRunners,
    hosts: mergedFleet.hosts,
    federation,
    active,
    recent,
    repos: repoRoster,
    drift,
    projects: groups.order,
    // Published on every tick, not computed when a button is pressed, so the UI
    // can grey out and explain a scale-up that will be refused instead of
    // offering it and reporting a 409.
    capacity,
    // Fleet-wide capacity for UI display (Capacity tab headroom indicator).
    fleetCapacity,
    // Sizing uses fleet runners so remote runners count toward "have" — a repo
    // already served by an agent runner is not recommended for another one here.
    sizing: sizeFleet({
      runners: fleetRunners,
      active,
      concurrency: concurrencyCache,
      limits: settings.limits(),
      includeUnserved: settings.get('provisionUnserved'),
    }),
    autoscale: {
      ...lastAutoscale,
      enabled: settings.get('autoscale'),
      prewarm: settings.get('prewarm'),
      dryRun: settings.get('autoscaleDryRun'),
    },
    scaleEffect: effectCache,
    // Job admission, from hooks/job-started.sh. Published on every tick because
    // a job being HELD right now is the state an operator most needs to see —
    // an unexplained pause before a job's first step is otherwise invisible.
    admission: admission.summary(),
    alertState: alerts ? alerts.snapshot() : { disabled: true, open: [], recent: [], channels: {} },
    api: { ...gh.rate, backoffUntil: gh.backoffUntil || null },
    collector: {
      lastFast: started,
      durationMs: Date.now() - started,
      lastSlow: snapshot.collector?.lastSlow ?? null,
      lastError: ghError,
      // The summary above is for operators; classifiers use this map so one
      // inaccessible repo cannot make every queued job look unknowable.
      repoErrors,
      // Distinct repos, not failed calls. Each repo makes two calls per tick
      // (runners and runs), so publishing failures.length showed 2 for a single
      // repo whose pair both failed — under a label that reads "Repos failing
      // this tick", which is how one broken repo looked like two. The deduped
      // list is already computed above for the message.
      failedRepos: failedRepos.length,
      transientRetries: gh.transientRetries,
      fastMs: currentCadence(active, runners),
      tokenSource: gh.tokenSource ?? null,
      backfill: { ...backfill.progress },
      // `open` counts what is still speaking, not everything still true. A badge
      // reading 6 while the Alerts tab shows two open and four dismissed is a
      // badge nobody trusts a second time; `dismissed` carries the rest so the
      // page can say where they went.
      alerts: alerts
        ? { ...alerts.counts(), channels: alerts.snapshot().channels }
        : null,
    },
    // Queued-run labels and queue age, surfaced here so the Fleet tab can show
    // concise capacity summaries without separate API calls.
    //
    // Each entry now carries its own diagnosis. Classifying here rather than in
    // the UI means the autoscaler and the screen are reading one verdict: a
    // button that offers to add a runner appears exactly when the autoscaler
    // would have been allowed to add one itself.
    queue: active
      .filter((r) => r.status === 'queued')
      .map((r) => {
        const c = classifyRun(r);
        return {
          id: r.id,
          repo: r.repo,
          project: r.project,
          workflowName: r.workflowName,
          // One queued job's labels, never the union: autoscale sizes a runner
          // from this, and a merged set would advertise labels no single job
          // asked for.
          labels: queuedJobLabels(r) ?? [],
          queuedSinceMs: started - Math.max(
            new Date(r.createdAt).getTime(),
            new Date(r.startedAt ?? r.createdAt).getTime()
          ),
          cause: c.cause,
          confidence: c.confidence,
          evidence: c.evidence,
          recommended: c.recommended,
          actionEligible: c.actionEligible,
          remediation: c.remediation,
        };
      }),
    control: {
      enabled: Boolean(CONFIG.databaseUrl),
      role: ha.isLeader ? 'leader' : 'standby',
      replicaId: CONFIG.replicaId,
      leaderId: ha.leaderId,
      leaderSince: ha.leaderSince,
    },
  };
  if (CONFIG.databaseUrl) {
    await ha.publishSnapshot(snapshot).catch((err) => warn('publish shared snapshot:', err.message));
  }
  publish();

  if (alerts) {
    if (CONFIG.databaseUrl) {
      try {
        const intents = await ha.listMeta('dismissal.');
        for (const [key, value] of Object.entries(intents)) {
          if (value?.dismissed === false) alerts.restore(key);
          else alerts.dismiss(key);
        }
      } catch (err) {
        warn('shared dismissals:', err.message);
      }
    }
    // Never let a notification failure take down collection: the fleet view is
    // the more important of the two, and a webhook that times out must not stop
    // the next tick from happening. Serializing here also prevents duplicate
    // opens when a slow macOS notification spans two collector ticks.
    const alertSnapshot = snapshot;
    alertRun = alertRun
      .catch(() => {})
      .then(() => alerts.run(alertSnapshot))
      .catch((e) => warn('alerts:', e.message));
  }

  // Pure autoscaling evaluator — records decisions without acting. Every repo
  // with a queued run is evaluated against current capacity. The result goes into
  // autoscale_decisions for the dashboard to show; no registration is triggered.
  try {
    await evaluateAutoscaling(snapshot);
  } catch (err) {
    warn('autoscale eval:', err.message);
  }
}

// Poll hard while anything is happening, back off when the fleet is asleep. The
// local Runner.Worker check is what makes this cheap — it answers "is anything
// building" with no API call at all.
function currentCadence(active, runners) {
  const busy = active.length > 0 || runners.some((r) => r.workingLocally || r.ghBusy);
  return busy ? CONFIG.fastMs : CONFIG.idleMs;
}

// Records what an autoscaler WOULD do for each queued repo — purely for
// observability. No runners are added or removed here. Every call writes at most
// one row per repo and is idempotent within the same minute, so the table stays
// small rather than growing 4 rows per minute per queued run.
const lastAutoEvalMinute = new Map();
const insertAutoscaleDecision = db.prepare(
  'INSERT INTO autoscale_decisions (ts, repo, action, reason, dry_run) VALUES (?,?,?,?,1)'
);
async function evaluateAutoscaling(snap) {
  const now = Date.now();
  const minuteKey = Math.floor(now / 60000);
  const limits = autoscaleLimits();
  const runners = buildFleetRunners(snap.runners ?? [], snap.elsewhere ?? [], hostState);
  const capacity = snap.fleetCapacity ?? snap.capacity ?? {};
  const repos = new Set((snap.queue ?? []).map((q) => q.repo));
  const queueCauses = new Map(
    (snap.queue ?? []).map((q) => [q.id, {
      repo: q.repo,
      cause: q.cause,
      confidence: q.confidence,
      actionEligible: q.actionEligible,
    }])
  );
  let lastUpByRepo = {};
  try {
    lastUpByRepo = CONFIG.databaseUrl
      ? await ha.getMeta('autoscale_last_up', {})
      : JSON.parse(getMeta(db, 'autoscale_last_up', '{}')) ?? {};
  } catch {
    lastUpByRepo = {};
  }

  // Shadow decisions use the exact planner that performs live scale-up. Running
  // a second, simplified policy here previously produced "proposed" rows for
  // actions the real scaler would refuse on labels, federation or cooldown.
  for (const repo of repos) {
    if (lastAutoEvalMinute.get(repo) === minuteKey) continue;
    lastAutoEvalMinute.set(repo, minuteKey);

    const plan = planScaleUp({
      sizing: (snap.sizing ?? []).filter((row) => row.repo === repo),
      capacity,
      runners,
      active: (snap.active ?? []).filter((run) => run.repo === repo),
      lastUpByRepo,
      limits,
      now,
      queueCauses,
    });
    const action = plan.act ? 'proposed' : 'refused';
    const reason = plan.act
      ? `${plan.mode ?? 'sustained'}: ${plan.reason}; remaining deficit ${plan.deficit ?? 0}`
      : plan.reason;
    try {
      insertAutoscaleDecision.run(now, repo, action, reason);
    } catch { /* table may not exist on a very old db — migrations run at startup but race is possible */ }
  }
}

// Which refs of a repo are worth linting.
//
// GitHub runs the workflow file from the ref that triggered the run, so the only
// file worth checking is one that some ref actually executes. That set comes from
// the local runs table rather than the API: it costs nothing, and it is the
// record of what really ran on this fleet.
//
// Push events only. A pull_request run's head_branch is the PR's own branch —
// 188 distinct ones for one repo in 30 days, all transient. Pushes land on
// the handful of long-lived branches, which is also the set someone can still
// fix. Requiring two pushes drops the single-push leftovers (a stale
// ci/… branch), and semver-looking refs are dropped because a finding against an
// immutable tag is not actionable.
const TAGLIKE = /^v?\d+\.\d+/;

function activeRefsFor(repo, defaultBranch) {
  const rows = stmt.pushedRefs.all(repo, new Date(Date.now() - 30 * 86400000).toISOString());
  const refs = [];
  for (const r of rows) {
    if (!r.head_branch || TAGLIKE.test(r.head_branch)) continue;
    refs.push(r.head_branch);
    if (refs.length >= 4) break;
  }
  // The default branch is always linted even with no pushes in the window: it is
  // the branch a new PR is opened against, so a finding there is the one most
  // likely to matter next.
  if (defaultBranch && !refs.includes(defaultBranch)) refs.unshift(defaultBranch);
  return refs.length ? refs : ['__default__'];
}

async function slowTick() {
  const started = Date.now();
  try {
    const owned = await gh.ownedRepos();
    const withRunners = new Set(dirsCache.map((d) => d.repo));
    const roster = [];
    for (const r of owned) {
      if (r.archived) continue;
      let workflows = null;
      try {
        workflows = await gh.workflowCount(r.full_name);
      } catch {
        workflows = null;
      }
      const entry = {
        fullName: r.full_name,
        name: r.name,
        project: groups.of(r.full_name),
        archived: Boolean(r.archived),
        private: Boolean(r.private),
        pushedAt: r.pushed_at,
        workflows: workflows ?? 0,
        hasRunner: withRunners.has(r.full_name),
        defaultBranch: r.default_branch ?? null,
      };
      roster.push(entry);
      stmt.upsertRepo.run(entry.fullName, entry.name, b(entry.archived), b(entry.private),
        entry.pushedAt, entry.workflows, b(entry.hasRunner), Date.now());
      db.prepare('UPDATE repos SET default_branch = ? WHERE full_name = ?')
        .run(entry.defaultBranch, entry.fullName);
    }
    repoRoster = roster.filter((r) => r.workflows > 0 || r.hasRunner);
    // A newly discovered repo can be the second member that brings a group into
    // existence, so the grouping is rebuilt now and the roster re-stamped with
    // it. Without this the new group appears on the next fast tick for runners
    // and runs, but not for the repo list, until the next roster refresh — the
    // same repo filed under two different headings in one page.
    refreshGroups();
    refreshConcurrency();
    for (const r of repoRoster) r.project = groups.of(r.fullName);
    log(`roster: ${repoRoster.length} repos with workflows, ${withRunners.size} served here`);
    log(`groups: ${groups.order.filter((g) => g !== 'other').join(', ') || 'none inferred'}`);
  } catch (err) {
    warn('roster refresh failed:', err.message);
  }

  // Shadow scoring. In its own try block because it is the least important thing
  // in this tick: losing an hour of forecast evaluation delays the gate, while a
  // throw here would cost the roster refresh above it.
  try {
    scoreForecasts();
  } catch (err) {
    warn('forecast scoring:', err.message);
  }

  // Workflow YAML for the lint screen. Every request is ETag'd, so a refresh
  // with nothing changed costs no rate limit at all.
  try {
    let fetched = 0;
    let dropped = 0;
    // Repos to reconcile: those the roster says have workflows, UNION those we
    // already hold files for. The union matters — a repo whose LAST workflow is
    // deleted drops to zero in the roster, and iterating the roster alone would
    // skip it forever, leaving the lint reporting on a file nobody can see.
    const cachedRepos = db.prepare('SELECT DISTINCT repo FROM workflow_files').all().map((r) => r.repo);
    const toCheck = [...new Set([
      ...repoRoster.filter((r) => r.workflows > 0).map((r) => r.fullName),
      ...cachedRepos,
    ])];

    for (const repo of toCheck) {
      let list;
      try {
        list = await gh.workflowList(repo);
      } catch (err) {
        // A transient failure must not be read as "this repo has no workflows"
        // and wipe its cache. Skip the repo entirely and try again next tick.
        warn(`workflow list ${repo}: ${err.message}`);
        continue;
      }
      const defaultBranch = stmt.defaultBranchOf.get(repo)?.default_branch ?? null;
      const refs = activeRefsFor(repo, defaultBranch);
      const seen = new Set();
      for (const wf of list) {
        if (!wf.path?.startsWith('.github/workflows/')) continue;
        for (const ref of refs) {
          try {
            // A 404 here is the ordinary case, not an error: the workflow list is
            // the repo's union of workflows and a given file need not exist on
            // every branch. Nothing is stored, so it simply is not linted there.
            const file = await gh.fileContent(repo, wf.path, ref === '__default__' ? null : ref);
            if (!file) continue;
            stmt.upsertWorkflowFile.run(repo, wf.path, ref, wf.name ?? null, file.sha,
              file.content, Date.now(), b(ref === defaultBranch || ref === '__default__'));
            seen.add(JSON.stringify([wf.path, ref]));
            fetched++;
          } catch { /* deleted between the list and the fetch, or absent on this ref */ }
        }
      }
      // Drop rows for (path, ref) pairs that no longer exist — a deleted
      // workflow, or a branch that has stopped being pushed to and is no longer
      // in the active set. Otherwise the lint keeps reporting a file nobody can
      // see, on a branch nobody uses.
      for (const row of db.prepare('SELECT path, ref FROM workflow_files WHERE repo = ?').all(repo)) {
        if (!seen.has(JSON.stringify([row.path, row.ref]))) {
          stmt.deleteWorkflowFile.run(repo, row.path, row.ref);
          dropped++;
        }
      }
    }
    log(`workflow cache: ${fetched} files refreshed, ${dropped} dropped`);
  } catch (err) {
    warn('workflow cache:', err.message);
  }

  try {
    const sizes = await dirSizes(dirsCache.map((d) => d.dir));
    for (const [dir, kb] of sizes) {
      const d = dirsCache.find((x) => x.dir === dir);
      if (d) db.prepare('UPDATE runner_state SET work_kb = ? WHERE name = ?').run(kb, d.name);
    }
  } catch (err) {
    warn('dir sizing failed:', err.message);
  }

  // Reading 29 small files is slow-loop work, and the answer only changes when
  // somebody runs scripts/install-hooks.sh.
  try {
    admission.countInstalled(dirsCache);
  } catch (err) {
    warn('hook install check:', err.message);
  }

  snapshot.collector.lastSlow = started;
  setMeta(db, 'last_slow_tick', started);
  // The roster and the sizes only reach the UI through a snapshot, and the next
  // one is up to 45s away on an idle fleet. Rebuild now so a repo you created a
  // minute ago appears when the roster notices it, not a poll later.
  await fastTick().catch((e) => warn('post-slow fast tick:', e.message));

  // Optional billing probe — called after fastTick so it does not hold up the
  // snapshot, and only if the operator has set a billing org/user.
  const billingOrg = settings.get('billingOrg');
  if (billingOrg) {
    try {
      const result = await gh.billingUsage(billingOrg);
      if (result.unavailable) {
        log(`billing: unavailable for ${billingOrg} (${result.reason}) — token may lack billing scope`);
        db.prepare(`INSERT INTO billing_snapshots (ts, raw) VALUES (?, ?)
          ON CONFLICT(ts) DO NOTHING`)
          .run(Math.floor(started / 1000) * 1000,
            JSON.stringify({ unavailable: true, reason: result.reason }));
      } else if (result.data && !result.cached) {
        const d = result.data;
        // GitHub's consolidated billing endpoint structure varies by plan; extract
        // what we can and store the raw payload for future use.
        const minutesUsed = d.total_minutes_used ?? d.included_minutes?.used ?? null;
        const minutesLimit = d.included_minutes?.total ?? null;
        const storageGb = d.total_gb_used != null ? d.total_gb_used / 1024 : null;
        const storageLimitGb = d.included_storage_gb ?? null;
        db.prepare(`INSERT OR REPLACE INTO billing_snapshots
          (ts, minutes_used, minutes_limit, storage_gb, storage_limit_gb, raw)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(Math.floor(started / 1000) * 1000, minutesUsed, minutesLimit,
            storageGb, storageLimitGb, JSON.stringify(d));
        log(`billing: ${minutesUsed ?? '?'} min used`);
      }
    } catch (err) {
      warn(`billing probe for ${billingOrg}:`, err.message);
    }
  }
}

// --------------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };

// Security headers added to every response (both API and static).
// The dashboard is intentionally loopback-only by default; these headers defend
// the case where an operator forwards the port or binds to a LAN interface.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // Read routes stay unauthenticated on loopback (by design), so no
  // strict-transport-security — the dashboard is http only.
  // Content-Security-Policy is kept permissive: the UI uses inline scripts and
  // styles from the same origin, and tightening it would require a nonce build
  // step we do not have. Operators who forward to LAN should add a reverse
  // proxy that sets a stricter CSP.
};

function json(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const body = await readFile(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    ...(rel === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// Rejected Host values are logged so an operator who reaches the dashboard by a
// name we did not discover sees why, rather than only a 421 in the browser.
// Throttled per host so a scanner cannot fill the log.
const rejectedHostLog = new Map();
function logRejectedHost(host) {
  const now = Date.now();
  if (now - (rejectedHostLog.get(host) ?? 0) < 10 * 60 * 1000) return;
  if (rejectedHostLog.size > 200) rejectedHostLog.clear();
  rejectedHostLog.set(host, now);
  warn(`refused request for unrecognised Host "${host}" — if that is a real name for this machine, add it to FLEET_ALLOWED_HOSTS`);
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding defence: a browser request must carry a Host we recognise as
  // our own. Agent routes are exempt — they are bearer-authenticated machine
  // calls that a rebinding page cannot make without the token, and agents
  // address the coordinator by whatever name their fleet.env was given.
  const path = (req.url ?? '/').split('?')[0];
  if (!path.startsWith('/api/host/')) {
    const hostCheck = await ensureHostAllowed(req);
    if (!hostCheck.ok) {
      logRejectedHost(String(req.headers.host ?? ''));
      return json(res, { error: hostCheck.error }, hostCheck.status);
    }
  }
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/access') {
    const ctx = viewerContext(req);
    return json(res, {
      via: ctx.via,
      tailscaleUser: ctx.tailscaleUser,
      urls: reachableUrls(CONFIG.port, { bindHost: CONFIG.host }),
      host: CONFIG.host,
      port: CONFIG.port,
      readOnly: CONFIG.readOnly,
    });
  }

  if (url.pathname === '/api/state') return json(res, snapshot);

  if (url.pathname === '/metrics') {
    const now = Date.now();
    const staleHosts = [...hostState.values()].filter((h) =>
      !h.lastHeartbeat || now - h.lastHeartbeat > STALE_HEARTBEAT_MS
    ).length;
    const body = renderPrometheusMetrics(snapshot, {
      now,
      collectorStaleMs: CONFIG.collectorStaleMs,
      hostCount: 1 + hostState.size,
      hostStaleCount: staleHosts,
    });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx-style proxies not to buffer the stream into silence.
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    // Comment frames keep the connection from being reaped by anything in the
    // middle during a quiet fleet.
    const beat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* closed */ }
    }, 25000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/runner') {
    const name = url.searchParams.get('name');
    const localRunner = snapshot.runners.find((x) => x.name === name);
    const r = localRunner
      ?? snapshot.fleetRunners?.find((x) => x.name === name)
      ?? [...hostState.values()].flatMap((host) =>
        (host.runners ?? []).map((runner) => ({
          ...runner,
          hostId: host.id,
          hostName: host.name,
          hostStale: Date.now() - (host.lastHeartbeat ?? 0) > STALE_HEARTBEAT_MS,
        }))
      ).find((x) => x.name === name);
    if (!r) return json(res, { error: 'unknown runner' }, 404);
    const events = localRunner
      ? db.prepare('SELECT ts, kind, detail FROM runner_events WHERE name = ? ORDER BY ts DESC LIMIT 30').all(name)
      : [];
    // `status` matters as much as `conclusion`: an in-progress job has no
    // conclusion and no duration, and without the status it renders as "– · –".
    const jobs = db.prepare(`SELECT id, repo, name, status, conclusion, started_at, completed_at,
                                    duration_ms, html_url
                             FROM jobs WHERE runner_name = ? ORDER BY started_at DESC LIMIT 20`).all(name);

    // Per-runner utilization derived from the same job history analytics use.
    // Kept outside analytics() so the drawer can show it without opening a tab.
    const sinceMs = Date.now() - 7 * 86400000;
    const sinceIso = new Date(sinceMs).toISOString();
    const utilRows = db.prepare(`
      SELECT COUNT(*) AS job_count,
             SUM(CASE WHEN conclusion = 'failure' OR conclusion = 'timed_out' THEN 1 ELSE 0 END) AS failures,
             SUM(duration_ms) AS total_ms,
             MAX(started_at) AS last_job_at
      FROM jobs
      WHERE runner_name = ? AND started_at >= ? AND id > 0 AND runner_name IS NOT NULL`).get(name, sinceIso);

    // Disk used by this runner's work directory (persisted by the slow loop).
    const workKb = db.prepare('SELECT work_kb FROM runner_state WHERE name = ?').get(name)?.work_kb ?? null;

    const diagRaw = localRunner ? diagTail(r.dir) : null;
    return json(res, {
      runner: r,
      remote: !localRunner,
      events,
      jobs,
      // Redact before serving even on loopback: the same policy as bundle.js.
      // The runner _diag can contain Authorization headers and token fragments
      // from failed API calls, and the dashboard is often port-forwarded over SSH
      // to a laptop where the browser is less tightly controlled than the host.
      diag: diagRaw ? { ...diagRaw, tail: redact(diagRaw.tail ?? '') } : diagRaw,
      // Parsed counts alongside the verbatim tail. The tail answers "what did
      // this runner last say"; this answers "is it logging errors at all",
      // which is the question you have before you know which runner to open.
      diagSummary: localRunner ? diagSummary(r.dir) : null,
      versions: localRunner
        ? versionReport(r)
        : (r.version ? { active: r.version } : null),
      utilization: {
        days: 7,
        jobCount: utilRows?.job_count ?? 0,
        failureCount: utilRows?.failures ?? 0,
        totalMs: utilRows?.total_ms ?? null,
        lastJobAt: utilRows?.last_job_at ?? null,
        workKb,
      },
    });
  }

  // Token-gated: a bundle is redacted and allowlisted, but it is still a dump of
  // one runner's configuration and recent history, and that is not something to
  // serve to an unauthenticated caller.
  if (url.pathname === '/api/runner/bundle') {
    const auth = authorizeRequest(req);
    if (!auth.ok) return json(res, { error: auth.error }, auth.status);
    const name = url.searchParams.get('name');
    const r = snapshot.runners.find((x) => x.name === name);
    if (!r) return json(res, { error: 'unknown runner' }, 404);

    const events = db.prepare(
      'SELECT ts, kind, detail FROM runner_events WHERE name = ? ORDER BY ts DESC LIMIT 50'
    ).all(name);
    const jobs = db.prepare(`SELECT name, status, conclusion, started_at, created_at, duration_ms
                             FROM jobs WHERE runner_name = ? ORDER BY started_at DESC LIMIT 20`).all(name);

    const summary = diagSummary(r.dir);
    const tail = diagTail(r.dir, 200);
    const bundle = buildBundle({
      runner: r,
      host: snapshot.host ?? {},
      events,
      jobs,
      diag: summary ? { ...summary, tail: tail?.tail ?? null } : null,
    });

    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${bundle.filename}"`,
      'cache-control': 'no-store',
    });
    return res.end(bundle.text);
  }

  if (url.pathname === '/api/history') {
    const repo = url.searchParams.get('repo');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
    const rows = repo
      ? db.prepare(`SELECT * FROM runs WHERE repo = ? ORDER BY run_started_at DESC LIMIT ?`).all(repo, limit)
      : db.prepare(`SELECT * FROM runs ORDER BY run_started_at DESC LIMIT ?`).all(limit);
    return json(res, rows);
  }

  // Readable without a token: the autofix bridge reads this to decide whether
  // to rerun or escalate a failed run, and it holds no control token.
  if (url.pathname === '/api/remediation-candidates') {
    try {
      return json(res, remediationCandidates(db));
    } catch (err) {
      warn('remediation-candidates:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/autofix/status') {
    try {
      const response = await fetch(CONFIG.autofixStatusUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error(`autofix bridge returned ${response.status}`);
      const body = await response.json();
      return json(res, { available: true, ...body });
    } catch (err) {
      return json(res, { available: false, error: err.message }, 503);
    }
  }

  if (url.pathname === '/api/queue-history') {
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours') ?? 24), 1), 24 * 90);
    const repo = url.searchParams.get('repo');
    const runIdRaw = url.searchParams.get('runId');
    const runId = runIdRaw == null ? null : Number(runIdRaw);
    if (runIdRaw != null && !Number.isInteger(runId)) {
      return json(res, { error: 'runId must be an integer' }, 400);
    }
    const clauses = ['ts >= ?'];
    const args = [Date.now() - hours * 60 * 60 * 1000];
    if (repo) {
      clauses.push('repo = ?');
      args.push(repo);
    }
    if (runId != null) {
      clauses.push('run_id = ?');
      args.push(runId);
    }
    args.push(500);
    try {
      const rows = db.prepare(`
        SELECT id, ts, run_id, repo, cause, confidence, evidence, recommended, resolved_at
        FROM queue_events
        WHERE ${clauses.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ?`).all(...args);
      return json(res, { hours, repo: repo ?? null, runId, rows });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/analytics') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 365);
    // How many runners serve each repo, so the second-runner verdict can say
    // "you already have two and they cannot help" rather than only "one would".
    const runnersByRepo = new Map();
    for (const r of snapshot.runners) {
      if (!r.registered) continue;
      runnersByRepo.set(r.repo, (runnersByRepo.get(r.repo) ?? 0) + 1);
    }
    try {
      return json(res, analytics(db, { days, runnersByRepo }));
    } catch (err) {
      warn('analytics:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/billing') {
    try {
      const latest = db.prepare(
        'SELECT ts, minutes_used, minutes_limit, storage_gb, storage_limit_gb, raw FROM billing_snapshots ORDER BY ts DESC LIMIT 1'
      ).get();
      if (!latest) return json(res, { available: false, reason: 'no data yet' });
      let rawParsed = null;
      try { rawParsed = JSON.parse(latest.raw ?? 'null'); } catch { /* ignore */ }
      if (rawParsed?.unavailable) {
        return json(res, { available: false, reason: rawParsed.reason });
      }
      return json(res, {
        available: true,
        ts: latest.ts,
        minutesUsed: latest.minutes_used,
        minutesLimit: latest.minutes_limit,
        storageGb: latest.storage_gb,
        storageLimitGb: latest.storage_limit_gb,
        // Usage fractions for UI meters, null when the limit is unknown.
        minutesFrac: latest.minutes_used != null && latest.minutes_limit
          ? latest.minutes_used / latest.minutes_limit : null,
      });
    } catch (err) {
      warn('billing api:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/autoscale') {
    try {
      const decisions = db.prepare(
        'SELECT ts, repo, action, reason FROM autoscale_decisions ORDER BY ts DESC LIMIT 50'
      ).all();
      return json(res, { decisions, capacity: snapshot.capacity, sizing: snapshot.sizing });
    } catch (err) {
      warn('autoscale api:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/admission') {
    try {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 60) || 60, 500);
      return json(res, {
        ...admission.summary(),
        recent: admission.recent(limit),
      });
    } catch (err) {
      warn('admission api:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/repo') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, { error: 'name required' }, 400);
    try {
      return json(res, repoDetail(db, name, { days: 30 }));
    } catch (err) {
      warn('repoDetail:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // The catalogue is readable without a token: knowing which buttons exist is
  // not the same as being able to press them, and the UI needs it to render.
  if (url.pathname === '/api/actions') {
    return json(res, {
      readOnly: CONFIG.readOnly,
      actions: Object.entries(ACTIONS).map(([id, a]) => ({
        id, label: a.label, danger: a.danger, confirm: a.confirm ?? null,
      })),
      recent: db.prepare(
        'SELECT ts, action, args, command, exit_code, ok, output FROM action_log ORDER BY ts DESC LIMIT 25'
      ).all(),
    });
  }

  // Readable without a token, like /api/actions: seeing the current thresholds
  // is how you understand why a scale-up was refused, and that is diagnosis
  // rather than control. Writing needs the token.
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const values = settings.all();
    const meta = settings.meta();
    return json(res, {
      readOnly: CONFIG.readOnly,
      envOnly: ENV_ONLY,
      settings: Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => ({
        key,
        label: spec.label,
        type: spec.type,
        value: values[key],
        default: spec.default,
        min: spec.min ?? null,
        max: spec.max ?? null,
        // Which of the three layers this value came from. Without it, "why is
        // this 8 when the plist says 3" has no answer visible anywhere.
        source: meta[key]?.source ?? 'default',
        updatedAt: meta[key]?.updatedAt ?? null,
      })),
    });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (CONFIG.readOnly) return json(res, { error: 'this daemon is running read-only' }, 403);
    const auth = authorizeRequest(req);
    if (!auth.ok) return json(res, { error: auth.error }, auth.status);

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) return json(res, { error: 'body too large' }, 413);
    }
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return json(res, { error: 'malformed JSON' }, 400);
    }

    try {
      // reset removes the row so the environment or default applies again,
      // which is not the same as writing the default value back.
      const value = parsed.reset ? settings.reset(parsed.key) : settings.set(parsed.key, parsed.value);
      if (CONFIG.databaseUrl) {
        await ha.setMeta(
          `setting.${parsed.key}`,
          parsed.reset ? { __fleetReset: true } : value
        );
      }
      log(`setting ${parsed.key} = ${JSON.stringify(value)}${parsed.reset ? ' (reset)' : ''}`);
      // Grouping and capacity are read on the next tick; force one so the change
      // is visible immediately rather than up to 45 seconds later.
      if (ha.isLeader) fastTick().catch(() => {});
      else refreshStandbySnapshot().catch(() => {});
      return json(res, { ok: true, key: parsed.key, value });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    if (CONFIG.readOnly) return json(res, { error: 'this daemon is running read-only' }, 403);

    const auth = authorizeRequest(req);
    if (!auth.ok) return json(res, { error: auth.error }, auth.status);

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) return json(res, { error: 'body too large' }, 413);
    }

    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return json(res, { error: 'malformed JSON' }, 400);
    }

    const def = Object.prototype.hasOwnProperty.call(ACTIONS, parsed.action)
      ? ACTIONS[parsed.action]
      : null;
    if (!def) return json(res, { error: `unknown action: ${parsed.action}` }, 404);

    const args = parsed.args ?? {};
    const started = Date.now();
    log(`action ${parsed.action} ${JSON.stringify(args)}`);
    try {
      const remote = await queueRemoteAction(parsed.action, args);
      const result = remote ?? await def.exec(args);
      // The action decides what counts as success — see okCodes in actions.js.
      const ok = result.ok ?? result.code === 0;
      logAction.run(started, parsed.action, JSON.stringify(args), result.command ?? null,
        result.code ?? null, ok ? 1 : 0, (result.output ?? '').slice(0, 20000));
      // Local actions change launchd state; refresh so the UI does not show a
      // runner as dead for another 15 seconds after you restarted it.
      if (ha.isLeader) {
        fastTick().catch(() => {});
      } else {
        reportSelfToHa()
          .then(() => refreshStandbySnapshot())
          .catch(() => {});
      }
      return json(res, { ok, ...result, durationMs: Date.now() - started });
    } catch (err) {
      const status = err instanceof ActionError ? err.status : 500;
      logAction.run(started, parsed.action, JSON.stringify(args), null, null, 0, String(err.message).slice(0, 4000));
      warn(`action ${parsed.action} failed: ${err.message}`);
      return json(res, { ok: false, error: err.message }, status);
    }
  }

  if (url.pathname === '/api/lint') {
    // Label sets come from every runner GitHub knows about for the repo, not
    // just the ones on this host: a repo whose `release` jobs are served by a
    // runner on another machine would otherwise have a perfectly good workflow
    // reported as unmatched.
    const runnersByRepo = new Map();
    const addRunner = (repo, labels) => {
      if (!runnersByRepo.has(repo)) runnersByRepo.set(repo, []);
      runnersByRepo.get(repo).push({ labels: (labels ?? []).map((l) => String(l).toLowerCase()) });
    };
    for (const r of snapshot.runners) if (r.registered) addRunner(r.repo, r.labels);
    for (const e of snapshot.elsewhere) addRunner(e.repo, e.labels);

    const files = stmt.workflowFiles.all();
    try {
      const findings = lintAll({ files, runnersByRepo });
      return json(res, {
        // `files` counts distinct workflow files; `checks` counts file×ref pairs
        // actually linted. Reporting only the latter as "files" would claim 54
        // workflows exist when there are 27 on two branches each.
        files: new Set(files.map((f) => `${f.repo}\n${f.path}`)).size,
        checks: files.length,
        refs: [...new Set(files.map((f) => f.ref))].filter((r) => r && r !== '__default__').sort(),
        repos: new Set(files.map((f) => f.repo)).size,
        findings,
      });
    } catch (err) {
      warn('lint:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/concurrency') {
    const runnersByRepo = new Map();
    for (const r of snapshot.runners) {
      if (r.registered) {
        if (!runnersByRepo.has(r.repo)) runnersByRepo.set(r.repo, []);
        runnersByRepo.get(r.repo).push(r);
      }
    }
    const files = stmt.workflowFiles.all();
    const limits = settings.limits();
    try {
      const findings = adviseAll({
        files,
        runnersByRepo,
        hostCap: limits.maxTotalRunners ?? 16,
        perRepoCap: limits.maxInstancesPerRepo,
      });
      return json(res, { findings });
    } catch (err) {
      warn('concurrency-advisor:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/queue-causes') {
    // Classify why each queued run is not being picked up.
    const fleetRunners = buildFleetRunners(
      snapshot.runners ?? [], snapshot.elsewhere ?? [], hostState
    );
    const lintFindings = (() => {
      try {
        const runnersByRepo = new Map();
        for (const r of fleetRunners) if (r.registered) {
          if (!runnersByRepo.has(r.repo)) runnersByRepo.set(r.repo, []);
          runnersByRepo.get(r.repo).push({ labels: r.labels.map((l) => l.toLowerCase()) });
        }
        return lintAll({ files: stmt.workflowFiles.all(), runnersByRepo });
      } catch { return []; }
    })();
    const reposWithLintFindings = new Set(lintFindings.filter((f) => f.severity === 'critical').map((f) => f.repo));
    const causes = classifyQueuedRuns({
      ...snapshot,
      runners: fleetRunners,
      capacity: snapshot.fleetCapacity ?? snapshot.capacity,
    }, reposWithLintFindings);
    return json(res, { causes: Object.fromEntries(causes) });
  }

  // Host federation. Agents POST here; nothing polls them, so no host needs an
  // inbound port. See dashboard/agent.js.
  if (url.pathname === '/api/host/heartbeat' && req.method === 'POST') {
    if (!bearerToken(req)) return json(res, { error: 'missing bearer token' }, 401);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      // Larger than the settings limit because a heartbeat carries every runner
      // on the host, but still bounded — a buggy agent must not be able to make
      // the coordinator hold an unbounded string.
      if (raw.length > 512 * 1024) return json(res, { error: 'body too large' }, 413);
    }
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, { error: 'malformed JSON' }, 400);
    }

    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 128) return json(res, { error: 'name is required' }, 400);
    const hostId = String(body?.id ?? name).trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostId)) {
      return json(res, { error: 'id must contain only letters, numbers, dot, underscore, or dash' }, 400);
    }
    const auth = authorizeHost(req, hostId);
    if (!auth.ok) return json(res, { error: auth.error }, auth.status);
    if (!Array.isArray(body.runners) || body.runners.length > 64) {
      return json(res, { error: 'runners must be an array of at most 64' }, 400);
    }

    const now = Date.now();
    const hostVitalsIn = body.host ?? {};
    try {
      stmt.upsertHost.run(
        hostId,
        String(hostVitalsIn.hostname ?? name),
        String(hostVitalsIn.platform ?? ''),
        String(body.fleetRoot ?? ''),
        now, now,
        String(body.version ?? 1),
        JSON.stringify(body.labels ?? []),
        JSON.stringify({
          id: hostId,
          name,
          runners: body.runners,
          host: hostVitalsIn,
          capacity: body.capacity ?? null,
          repos: body.repos ?? [],
          // Persisted with the rest so a coordinator restart does not put a
          // deliberately drained host back into rotation the moment it comes up,
          // before that host's next heartbeat has had a chance to say otherwise.
          drained: Boolean(body.drained),
        })
      );
      stmt.insertHeartbeat.run(
        hostId, now,
        num(hostVitalsIn.load1), num(hostVitalsIn.memFreePct), num(hostVitalsIn.diskFreeGb),
        body.runners.length,
        body.runners.filter((r) => r?.ghBusy || r?.workingLocally).length
      );
      hostState.set(hostId, {
        id: hostId,
        name,
        lastHeartbeat: now,
        labels: body.labels ?? [],
        runners: body.runners,
        repos: body.repos ?? [],
        host: body.host ?? {},
        capacity: body.capacity ?? null,
        runnerCount: body.runners.length,
        version: body.version ?? 1,
        drained: Boolean(body.drained),
      });
      if (CONFIG.databaseUrl) await ha.upsertHost(hostId, body, now);
    } catch (err) {
      warn('host heartbeat:', err.message);
      return json(res, { error: 'could not record heartbeat' }, 500);
    }

    // Queued commands ride back on the response, which is what lets the
    // coordinator drive a host that has no inbound port.
    let commands = [];
    try {
      const claimed = CONFIG.databaseUrl
        ? await ha.claimCommands(hostId, now)
        : claimLocalCommands(hostId, now);
      for (const c of claimed) {
        const args = typeof c.args === 'string' ? JSON.parse(c.args ?? '{}') : (c.args ?? {});
        try {
          if (c.action === 'runner.register') {
            args.token = await gh.registrationToken(args.repo);
          } else if (c.action === 'runner.deregister') {
            args.token = await gh.removalToken(args.repo);
          }
        } catch (err) {
          // Release a claim that never reached the host. A later heartbeat can
          // retry after a transient GitHub or rate-limit failure without
          // storing the short-lived token or consuming a delivery attempt.
          if (CONFIG.databaseUrl) await ha.releaseCommandClaim(c.id);
          else stmt.releaseCommandClaim.run(c.id);
          warn(`host command token ${c.id}:`, err.message);
          continue;
        }
        commands.push({
          id: c.id,
          key: c.idempotency_key ?? null,
          action: c.action,
          args,
        });
      }
    } catch (err) {
      warn('host commands:', err.message);
    }

    return json(res, { ok: true, commands });
  }

  if (url.pathname === '/api/host/results' && req.method === 'POST') {
    if (!bearerToken(req)) return json(res, { error: 'missing bearer token' }, 401);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 512 * 1024) return json(res, { error: 'body too large' }, 413);
    }
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, { error: 'malformed JSON' }, 400);
    }

    const host = String(body?.host ?? '').trim();
    if (!host) return json(res, { error: 'host is required' }, 400);
    const auth = authorizeHost(req, host);
    if (!auth.ok) return json(res, { error: auth.error }, auth.status);
    const results = Array.isArray(body?.results) ? body.results : [];
    const now = Date.now();
    let recorded = 0;
    for (const r of results.slice(0, 64)) {
      const commandId = Number(r?.id);
      if (!Number.isSafeInteger(commandId) || commandId <= 0) continue;
      try {
        const command = CONFIG.databaseUrl
          ? await ha.commandById(commandId)
          : stmt.commandById.get(commandId);
        if (!command || command.host_id !== host) {
          warn(`host result ${commandId}: command does not belong to ${host}`);
          continue;
        }
        if (command.status !== 'sent') {
          warn(`host result ${commandId}: refusing completion from status ${command.status}`);
          continue;
        }
        const resultText = String(r.error ?? r.output ?? '').slice(0, 4000);
        const completed = CONFIG.databaseUrl
          ? await ha.completeCommand(commandId, Boolean(r.ok), resultText, now)
          : stmt.completeCommand.run(now, r.ok ? 'done' : 'failed', resultText, commandId).changes === 1;
        if (!completed) continue;
        recorded++;
        if (r.ok && command.action === 'runner.register') {
          const args = typeof command.args === 'string'
            ? JSON.parse(command.args ?? '{}')
            : (command.args ?? {});
          let lastUpByRepo = {};
          try {
            lastUpByRepo = JSON.parse(getMeta(db, 'autoscale_last_up', '{}')) ?? {};
          } catch { /* start a clean cooldown map */ }
          const nextCooldowns = recordScaleUpMeta(lastUpByRepo, {
            repo: args.repo,
            role: args.cooldown?.role ?? null,
            mode: args.cooldown?.mode ?? 'sustained',
          }, now);
          if (CONFIG.databaseUrl) await ha.setMeta('autoscale_last_up', nextCooldowns);
          lastAutoscale = {
            at: now,
            action: command.action,
            acted: true,
            host,
            reason: `remote registration completed for ${args.repo}`,
            mode: args.cooldown?.mode ?? 'sustained',
          };
        }
      } catch (err) {
        warn('host result:', err.message);
      }
    }
    return json(res, { ok: true, recorded });
  }

  if (url.pathname === '/api/hosts') {
    await syncHaHosts().catch((err) => warn('shared hosts route:', err.message));
    // The local host is included as a first-class member rather than as a special
    // case. A federated view where "this machine" is rendered differently is a
    // view that has to be read twice.
    const local = {
      id: LOCAL_HOST_ID,
      name: `${CONFIG.hostName} (this machine)`,
      local: true,
      lastHeartbeat: snapshot.ts ?? Date.now(),
      labels: CONFIG.hostLabels,
      runners: snapshot.runners ?? [],
      repos: [...new Set((snapshot.runners ?? []).map((r) => r.repo))],
      host: snapshot.host ?? {},
      capacity: snapshot.capacity ?? null,
      runnerCount: (snapshot.runners ?? []).length,
      // Read here rather than cached on the snapshot: a host-level drain is a
      // file somebody just created by hand, and the point of it is to take effect
      // now rather than on the next tick.
      drained: Boolean(hostDrainState(CONFIG.root)),
    };
    const merged = mergeHostSnapshots({ hosts: [local, ...hostState.values()] });

    // Recent placement decisions for the Hosts tab. Operators need to see why
    // a host was chosen or refused, and which commands are in-flight.
    let recentPlacements = [];
    let pendingCommands = [];
    try {
      recentPlacements = CONFIG.databaseUrl
        ? await ha.recentPlacements(50)
        : stmt.recentPlacements.all();
      pendingCommands = CONFIG.databaseUrl
        ? await ha.recentCommands(20)
        : db.prepare(
            "SELECT host_id, action, status, ts, started_at, attempts FROM host_commands "
            + "WHERE status IN ('pending','sent') ORDER BY ts DESC LIMIT 20"
          ).all();
    } catch { /* table may not exist on a very old db; degrade gracefully */ }

    return json(res, {
      ...merged,
      // Federation is off unless an agent has actually reported. Said explicitly
      // so a single-host fleet does not present an empty Hosts tab as a problem.
      federated: hostState.size > 0,
      staleHeartbeatMs: STALE_HEARTBEAT_MS,
      recentPlacements,
      pendingCommands,
    });
  }

  // Read-only, and bounded on both axes: at most 90 days of history and at most
  // 8 runners per repo in a scenario. A simulation is a replay over a table this
  // daemon already holds, but it is still the one endpoint where a caller
  // chooses how much work to do, so the limits are not optional.
  if (url.pathname === '/api/simulate') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const jobs = db.prepare(`
      SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
      WHERE started_at >= ? AND queued_ms IS NOT NULL AND duration_ms IS NOT NULL
      ORDER BY started_at`).all(since);

    // Current shape, from the live fleet.
    const current = new Map();
    for (const r of snapshot.runners ?? []) {
      if (!r.registered) continue;
      current.set(r.repo, (current.get(r.repo) ?? 0) + 1);
    }

    // The proposal. `?add=repo:n` overrides one repo; with nothing given, the
    // sizing recommendation is used, which makes the default view "what would
    // happen if I did what the Capacity tab suggests".
    const proposed = new Map(current);
    const addParams = url.searchParams.getAll('add');
    if (addParams.length) {
      for (const spec of addParams) {
        const idx = spec.lastIndexOf(':');
        if (idx < 1) continue;
        const repo = spec.slice(0, idx);
        const n = Number(spec.slice(idx + 1));
        if (!current.has(repo) || !Number.isInteger(n)) continue;
        proposed.set(repo, Math.min(Math.max(n, 0), 8));
      }
    } else {
      for (const row of snapshot.sizing ?? []) {
        if (row.delta > 0) proposed.set(row.repo, Math.min(row.want, 8));
      }
    }

    const limits = settings.limits();
    try {
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
        // Said explicitly because the numbers look identical to the measured
        // ones on the Analytics tab and they are not the same thing: these come
        // from replaying real arrivals against a fleet shape that never existed.
        note: 'Replay of real job arrivals and durations against a hypothetical runner count. '
          + 'Queue waits are simulated; job durations are measured.',
      });
    } catch (err) {
      warn('simulate:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  if (url.pathname === '/api/forecast') {
    const hoursAhead = Math.min(Math.max(Number(url.searchParams.get('hours') ?? 12), 1), 48);
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 60), 7), 180);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    try {
      const jobs = db.prepare(`
        SELECT id, repo, started_at, queued_ms, duration_ms FROM jobs
        WHERE started_at >= ? AND duration_ms IS NOT NULL
        ORDER BY started_at`).all(since);

      const baseline = buildBaseline(jobs);
      const schedules = extractSchedules(stmt.workflowFiles.all());
      const predictions = forecastDemand({ baseline, schedules, hoursAhead });

      // The gate, reported alongside the predictions rather than hidden. Nothing
      // acts on a forecast until this passes, and showing the numbers is what
      // lets the operator decide whether to believe them.
      const evals = db.prepare(
        'SELECT predicted_peak, actual_peak, false_positive FROM forecast_evals ORDER BY ts DESC LIMIT 500'
      ).all();
      const gate = evaluateGate(evals);

      return json(res, {
        hoursAhead,
        historyDays: days,
        weeksCovered: baseline.weeksCovered,
        bucketsLearned: baseline.buckets.size,
        schedulesFound: schedules.length,
        predictions,
        gate,
        shadowMode: !settings.get('prewarm'),
        prewarmEnabled: settings.get('prewarm'),
        note: settings.get('prewarm')
          ? 'Pre-warming is enabled, but acts only after this evidence gate passes and every planner guard succeeds.'
          : 'Forecasts are shadow-only: they are recorded and scored, and nothing acts on them. '
            + 'Pre-warming stays locked until the gate below passes.',
      });
    } catch (err) {
      warn('forecast:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // ------------------------------------------------------------------ pairing
  // POST /api/pair/start — authenticated call from an already-authed session.
  // Returns a 6-digit code and a URL the remote device can scan as a QR code.
  if (url.pathname === '/api/pair/start' && req.method === 'POST') {
    if (CONFIG.readOnly) return json(res, { error: 'read-only mode' }, 403);
    const pairAuth = authorizeRequest(req);
    if (!pairAuth.ok) return json(res, { error: pairAuth.error }, pairAuth.status);
    const code = createPairingCode();
    const target = pairingUrl(req, { port: CONFIG.port, bindHost: CONFIG.host });
    return json(res, {
      code,
      url: `${target.url}/#pair=${code}`,
      alternatives: target.alternatives.map((u) => `${u}/#pair=${code}`),
      warning: target.warning,
      expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
    });
  }

  // POST /api/pair — the remote device submits its pairing code.
  // Rate-limited; no token, since getting one is the point. The Origin check
  // still applies so a page in another tab cannot spend guesses for someone.
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    if (CONFIG.readOnly) return json(res, { error: 'read-only mode' }, 403);
    const pairOrigin = sameOrigin(req, authConfig());
    if (!pairOrigin.ok) return json(res, { error: pairOrigin.error }, pairOrigin.status);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return json(res, { error: 'body too large' }, 413);
    }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { return json(res, { error: 'malformed JSON' }, 400); }
    const ip = clientAddress(req);
    const result = exchangeCode(CONFIG.deviceTokensFile, parsed.code, parsed.name ?? 'device', ip);
    if (result.error) {
      if (result.rateLimited) warn(`pairing: rate limit hit (client ${ip})`);
      return json(res, { error: result.error }, result.rateLimited ? 429 : 403);
    }
    log(`device paired: ${result.name} (client ${ip})`);
    return json(res, { ok: true, token: result.token, name: result.name });
  }

  // GET /api/devices — list paired devices (auth required)
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    const devAuth = authorizeRequest(req);
    if (!devAuth.ok) return json(res, { error: devAuth.error }, devAuth.status);
    return json(res, { devices: listDevices(CONFIG.deviceTokensFile) });
  }

  // POST /api/devices/revoke — revoke a device token (auth required)
  if (url.pathname === '/api/devices/revoke' && req.method === 'POST') {
    if (CONFIG.readOnly) return json(res, { error: 'read-only mode' }, 403);
    const devAuth = authorizeRequest(req);
    if (!devAuth.ok) return json(res, { error: devAuth.error }, devAuth.status);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return json(res, { error: 'body too large' }, 413);
    }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { return json(res, { error: 'malformed JSON' }, 400); }
    const revoked = revokeDevice(CONFIG.deviceTokensFile, parsed.key);
    if (!revoked) return json(res, { error: 'device not found' }, 404);
    log(`device revoked: key=${parsed.key}`);
    return json(res, { ok: true });
  }

  if (url.pathname === '/api/alerts') {
    if (!alerts) return json(res, { disabled: true, open: [], recent: [], channels: {} });
    if (CONFIG.databaseUrl && !ha.isLeader && snapshot.alertState) {
      return json(res, snapshot.alertState);
    }
    return json(res, alerts.snapshot());
  }

  // No token from the machine the daemon runs on. Dismissing changes what this
  // page and the notifier tell you; it starts nothing, stops nothing, and does
  // not touch autofix — so a prompt to go and run `./fleetctl.sh token` buys
  // nothing that reading the same alert on the same page had not already given
  // away, and it costs the one thing this control needs, which is being one
  // click. From anywhere else the token still applies, because hiding alerts on
  // a dashboard other people are reading is a different act. Either way the
  // Origin check runs: without a token it is the only thing standing between
  // this route and a page in another tab.
  if ((url.pathname === '/api/alerts/dismiss' || url.pathname === '/api/alerts/restore')
      && req.method === 'POST') {
    if (!alerts) return json(res, { error: 'alerting is disabled (FLEET_ALERTS=0)' }, 409);
    if (CONFIG.readOnly) return json(res, { error: 'this daemon is running read-only' }, 403);
    const origin = sameOrigin(req, { port: CONFIG.port, host: CONFIG.host });
    if (!origin.ok) return json(res, { error: origin.error }, origin.status);
    if (!isLocalRequest(req)) {
      const auth = authorizeRequest(req);
      if (!auth.ok) return json(res, { error: auth.error }, auth.status);
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) return json(res, { error: 'body too large' }, 413);
    }
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return json(res, { error: 'malformed JSON' }, 400);
    }

    const key = typeof parsed.key === 'string' ? parsed.key : '';
    if (!key) return json(res, { error: 'key is required' }, 400);

    if (url.pathname === '/api/alerts/restore') {
      if (CONFIG.databaseUrl) {
        await ha.setMeta(`dismissal.${key}`, { dismissed: false, at: Date.now() });
        if (!ha.isLeader) return json(res, { ok: true, key, queued: true });
      }
      if (!alerts.restore(key)) return json(res, { error: `${key} is not a dismissed open alert` }, 404);
      log(`restored ${key}`);
      return json(res, { ok: true, key });
    }

    if (CONFIG.databaseUrl) {
      const known = (snapshot.alertState?.open ?? []).some((a) => a.key === key);
      if (!ha.isLeader && !known) return json(res, { error: `${key} is not an open alert` }, 404);
      await ha.setMeta(`dismissal.${key}`, { dismissed: true, at: Date.now() });
      if (!ha.isLeader) return json(res, { ok: true, key, queued: true, dismissed_at: Date.now() });
    }
    const dismissed = alerts.dismiss(key);
    if (!dismissed) return json(res, { error: `${key} is not an open alert` }, 404);
    return json(res, { ok: true, ...dismissed });
  }

  // `ok` answers "is this daemon still collecting", not "is it still serving".
  // Those came apart once: the fast loop stopped for 65 minutes while the HTTP
  // server went on handing out the frozen snapshot, and because ok was derived
  // from `starting` alone it read true the entire time — so the fleet view was
  // an hour stale, every alert in it was fiction, and nothing said so.
  //
  // The status stays 200 on purpose. fleetctl.sh and the screenshot tools use
  // `curl -fsS` and `res.ok` to mean "the daemon answered", which is still true
  // and still worth distinguishing from a daemon that is down.
  if (url.pathname === '/api/health') {
    const ageMs = snapshot.ts ? Date.now() - snapshot.ts : null;
    const stale = ageMs !== null && ageMs > CONFIG.collectorStaleMs;
    const role = ha.isLeader ? 'leader' : 'standby';
    return json(res, {
      ok: !snapshot.starting && !stale,
      servingOk: true,
      collectorOk: ha.isLeader ? !snapshot.starting && !stale : null,
      role,
      replicaId: CONFIG.replicaId,
      leaderId: ha.leaderId ?? snapshot.control?.leaderId ?? null,
      leaderSince: ha.leaderSince,
      ts: snapshot.ts,
      ageMs,
      stale,
      collectorStaleMs: CONFIG.collectorStaleMs,
      runners: (snapshot.runners ?? []).length,
      drift: (snapshot.drift ?? []).filter((d) => d.severity !== 'info').length,
      lastError: stale
        ? `collector stalled — no completed tick for ${Math.round(ageMs / 1000)}s`
        : snapshot.collector?.lastError ?? null,
    });
  }

  if (url.pathname === '/api/leader') {
    return json(res, {
      enabled: Boolean(CONFIG.databaseUrl),
      replicaId: CONFIG.replicaId,
      role: ha.isLeader ? 'leader' : 'standby',
      leaderId: ha.leaderId ?? snapshot.control?.leaderId ?? CONFIG.replicaId,
      leaderSince: ha.leaderSince,
    });
  }

  return serveStatic(res, url.pathname);
});

// ---------------------------------------------------------------------- start

async function main() {
  log(`fleetd starting — root=${CONFIG.root} db=${CONFIG.db}`);
  await ha.start(({ isLeader }) => {
    if (isLeader) {
      fastTick().catch((err) => warn('promotion fast tick:', err.message));
    } else {
      refreshStandbySnapshot().catch((err) => warn('standby snapshot:', err.message));
    }
  });
  if (CONFIG.databaseUrl) {
    try {
      await syncHaSettings();
    } catch (err) {
      warn('shared settings:', err.message);
    }
  }
  try {
    await gh.resolveToken();
    log(`github token resolved from ${gh.tokenSource}`);
  } catch (err) {
    warn(err.message);
    warn('continuing — local state will still be collected, GitHub state will be empty');
  }

  // Listen before collecting, not after. The first fast tick fans out across
  // every repo and takes seconds; doing it first means the page is refused
  // during exactly the window where someone is reloading it wondering why the
  // dashboard is down. The UI renders the `starting` snapshot meanwhile.
  // Host allowlist first, so the very first request is judged against it.
  initAllowedHosts(CONFIG.allowedHosts);
  await refreshNetworkIdentity({ port: CONFIG.port, force: true }).catch(() => {});
  // Tailscale can come up, rename, or start serving after we did.
  setInterval(() => {
    refreshNetworkIdentity({ port: CONFIG.port, force: true }).catch(() => {});
  }, 5 * 60 * 1000).unref();

  await new Promise((resolve) => {
    server.listen(CONFIG.port, CONFIG.host, () => {
      log(`listening on http://${CONFIG.host}:${CONFIG.port}`);
      for (const { label, url } of reachableUrls(CONFIG.port, { bindHost: CONFIG.host })) {
        log(`reachable via ${label}: ${url}`);
      }
      if (CONFIG.host === '127.0.0.1') {
        log(`loopback only — for LAN access: ./fleetctl.sh remote lan on (or ssh -L ${CONFIG.port}:localhost:${CONFIG.port} your-runner-host)`);
      }
      resolve();
    });
  });

  // Before the first tick, so the first page served already has sizing on it.
  // The slow loop refreshes this afterwards; without it here, the sizing panel
  // would show history-free recommendations for up to fifteen minutes after a
  // restart, which reads as the feature being broken rather than warming up.
  refreshConcurrency();

  // Remote hosts, restored from their newest heartbeat. Without this a
  // coordinator restart shows an empty fleet until every agent's next beat, which
  // during an incident looks exactly like every host having gone away.
  //
  // Restored heartbeats keep their ORIGINAL timestamps, so a host that was
  // already stale before the restart still reads as stale rather than being
  // silently refreshed by the act of restarting.
  try {
    const rows = db.prepare(
      'SELECT host_id, labels, agent_version, last_seen, last_payload FROM hosts'
    ).all();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.last_payload ?? '{}');
        hostState.set(row.host_id, {
          id: row.host_id,
          name: payload.name ?? row.hostname ?? row.host_id,
          // The ORIGINAL last_seen, not now. A host that was already stale before
          // the restart must still read as stale — refreshing it here would mean
          // restarting the coordinator made every dead host look healthy.
          lastHeartbeat: row.last_seen,
          labels: JSON.parse(row.labels ?? '[]'),
          runners: payload.runners ?? [],
          repos: payload.repos ?? [],
          host: payload.host ?? {},
          capacity: payload.capacity ?? null,
          runnerCount: (payload.runners ?? []).length,
          version: row.agent_version ?? 1,
          drained: Boolean(payload.drained),
        });
      } catch { /* one unreadable row must not cost the others */ }
    }
    if (hostState.size) log(`federation: restored ${hostState.size} remote host(s) from their last report`);
  } catch (err) {
    warn('could not restore host state:', err.message);
  }

  await reportSelfToHa().catch((e) => warn('self heartbeat:', e.message));
  await syncHaHosts().catch((e) => warn('shared host restore:', e.message));
  if (ha.isLeader) {
    await fastTick().catch((e) => warn('first fast tick failed:', e.message));
    slowTick().catch((e) => warn('first slow tick failed:', e.message));
  } else {
    await refreshStandbySnapshot().catch((e) => warn('first standby snapshot:', e.message));
  }

  // Abandons the wait, not the work — there is no way to cancel a promise, so a
  // tick that blows its deadline may still be running when the next one starts.
  // Every write it makes is an upsert keyed by id, so a late finisher costs a
  // duplicated effort rather than a corrupted row, and that is a much better
  // trade than the alternative: the loop stopping altogether.
  const withDeadline = (promise, ms, what) => {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  };

  // Chained timeouts, not setInterval: the cadence changes with fleet activity,
  // and a slow tick must never overlap itself.
  let fastInFlight = null;
  const scheduleFast = () => {
    const delay = snapshot.collector?.fastMs ?? CONFIG.fastMs;
    setTimeout(async () => {
      try {
        if (ha.isLeader) {
          if (fastInFlight) {
            warn('fast tick: previous timed-out tick is still running; skipping overlap');
          } else {
            const task = fastTick();
            fastInFlight = task;
            task.finally(() => {
              if (fastInFlight === task) fastInFlight = null;
            }).catch(() => {});
            await withDeadline(task, CONFIG.fastDeadlineMs, 'fast tick');
          }
        } else {
          await refreshStandbySnapshot();
        }
      } catch (e) {
        warn('fast tick:', e.message);
      }
      scheduleFast();
    }, delay).unref?.();
  };

  // Its own clock, deliberately slower than the fast loop. Scaling reads the
  // snapshot the fast loop just produced, so it never needs to run more often
  // than a decision can be acted on — and registering a runner takes tens of
  // seconds, so evaluating every 15 would mostly re-decide mid-registration.
  const scheduleAutoscale = () => {
    setTimeout(async () => {
      try {
        if (ha.isLeader) await autoscaleTick();
      } catch (e) { warn('autoscale:', e.message); }
      scheduleAutoscale();
    }, 60000).unref?.();
  };
  const scheduleSlow = () => {
    setTimeout(async () => {
      try {
        if (ha.isLeader) await slowTick();
      } catch (e) { warn('slow tick:', e.message); }
      scheduleSlow();
    }, CONFIG.slowMs).unref?.();
  };

  // History runs on its own clock and idles once it has caught up. Everything
  // GitHub still holds gets captured; after that the fast loop keeps the head of
  // the list current and this has nothing to do until new runs complete.
  //
  // The gate is a live database question rather than backfill.progress.done,
  // which was a latch — it is only recomputed inside pass(), so using it to
  // decide whether to call pass() meant that once it went true it stayed true
  // and history stopped accumulating silently.
  const scheduleBackfill = () => {
    setTimeout(async () => {
      try {
        if (ha.isLeader && backfill.hasWork()) {
          await backfill.pass(reposToPoll(), {
            persistRun, persistJob,
            maxCalls: CONFIG.backfillCalls,
            minRemaining: CONFIG.backfillFloor,
          });
          publish();
        }
      } catch (e) {
        warn('backfill:', e.message);
      }
      scheduleBackfill();
    }, CONFIG.backfillMs).unref?.();
  };

  scheduleFast();
  scheduleSlow();
  scheduleAutoscale();

  if (CONFIG.databaseUrl) {
    pollSelfCommands().catch((e) => warn('self command poll:', e.message));
    setInterval(() => {
      reportSelfToHa()
        .then(() => syncHaHosts())
        .catch((e) => warn('shared host heartbeat:', e.message));
    }, 30000).unref?.();
    setInterval(() => {
      pollSelfCommands().catch((e) => warn('self command poll:', e.message));
    }, 5000).unref?.();
  }

  // First pass shortly after startup rather than immediately — let the fast loop
  // and the roster settle so the repo list is real before walking a thousand runs.
  setTimeout(() => {
    if (!ha.isLeader) return;
    backfill
      .pass(reposToPoll(), {
        persistRun, persistJob,
        maxCalls: CONFIG.backfillCalls,
        minRemaining: CONFIG.backfillFloor,
      })
      .then(() => publish())
      .catch((e) => warn('backfill:', e.message));
  }, 20000).unref?.();

  scheduleBackfill();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`${sig} — closing`);
    try { await ha.close(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
}

main().catch((err) => { warn('fatal:', err.stack ?? err.message); process.exit(1); });
