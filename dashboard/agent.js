#!/usr/bin/env node
// fleet-agent — reports one host's runners to a coordinator dashboard.
//
//   FLEET_COORDINATOR=http://coordinator:7878 FLEET_AGENT_TOKEN=... node agent.js
//
// OUTBOUND ONLY, AND THAT IS THE POINT.
//
// This opens connections to the coordinator and never listens. Nothing has to be
// port-forwarded, no inbound firewall rule is needed, and a laptop on a home
// network can join a fleet without being reachable from it. The alternative —
// the coordinator polling each host — needs every host to expose a control plane
// that executes shell commands, which is a much larger thing to secure and the
// reason the main dashboard binds to loopback by default.
//
// Commands travel back on the SAME connection, as the response to a heartbeat.
// The coordinator queues work in host_commands and this drains it. That gives
// remote control without an inbound port, at the cost of up to one heartbeat
// interval of latency — which is nothing next to the time it takes to register a
// runner.
//
// WHAT THIS AGENT MAY DO
//
// Only the actions in the allowlist below, and only after checking they are
// enabled for this host. A coordinator is not trusted to send arbitrary
// commands: it can be compromised, misconfigured, or simply running a newer
// version that knows about actions this host has not agreed to. So the host is
// the one that decides, which is the only arrangement where a mistake on the
// coordinator cannot become a shell on every host in the fleet.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, statSync, readFileSync, writeFileSync, renameSync, chmodSync,
} from 'node:fs';

import { discoverRunnerDirs, launchdJobs, runnerProcesses, hostVitals, hostDrainState } from './lib/local.js';
import { headroom } from './lib/capacity.js';
// Shared with buildRunners so a duplicate is numbered the same way on every host.
import { instanceOf } from './lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  coordinators: (process.env.FLEET_COORDINATORS ?? process.env.FLEET_COORDINATOR ?? '')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  token: process.env.FLEET_AGENT_TOKEN
    ?? (process.env.FLEET_AGENT_TOKEN_FILE && existsSync(process.env.FLEET_AGENT_TOKEN_FILE)
      ? readFileSync(process.env.FLEET_AGENT_TOKEN_FILE, 'utf8').trim()
      : ''),
  root: process.env.FLEET_ROOT ?? join(os.homedir(), 'actions-runners'),
  // Named so a fleet can distinguish two hosts with the same hostname, which
  // happens more often than it should.
  hostName: process.env.FLEET_HOST_NAME ?? os.hostname().replace(/\.local$/, ''),
  hostId: process.env.FLEET_HOST_ID
    ?? process.env.FLEET_HOST_NAME
    ?? os.hostname().replace(/\.local$/, ''),
  heartbeatMs: Number(process.env.FLEET_HEARTBEAT_MS ?? 30_000),
  commandResultsFile: process.env.FLEET_AGENT_RESULTS_FILE
    ?? join(HERE, '.fleet-agent-command-results.json'),
  labels: (process.env.FLEET_HOST_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Commands are OPT-IN. An agent that only reports is useful on its own, and it
  // is the right default: joining a fleet should not silently grant remote
  // execution.
  allowCommands: process.env.FLEET_AGENT_ALLOW_COMMANDS === '1',
  // runner.register is a separate opt-in. It downloads a runner tarball,
  // installs a LaunchAgent, and calls the GitHub runner registration API —
  // higher blast radius than drain or health. Set both flags to enable it.
  allowRegister: process.env.FLEET_AGENT_ALLOW_REGISTER === '1',
  // Removal is deliberately separate from registration. It is destructive and
  // should remain disabled on a reporting-only or scale-up-only host.
  allowDeregister: process.env.FLEET_AGENT_ALLOW_DEREGISTER === '1',
  // Spelled exactly as headroom() reads them, because it merges this object over
  // CAPACITY_DEFAULTS and silently ignores anything it does not recognise. The
  // earlier names — maxRunners, maxLoadPerCore — were therefore dropped on the
  // floor: a host configured to allow 8 runners advertised headroom up to the
  // default 32, and a deliberately strict load limit of 2 was replaced by the
  // default 4. The agent reported capacity its operator had refused.
  //
  // FLEET_MIN_FREE_MEM_PCT is gone rather than renamed. headroom() has no
  // free-memory gate — it uses kernel memory pressure and swap-in rate, because
  // free memory on macOS reads as almost nothing on a healthy machine — so the
  // knob could not be wired to anything and only implied a limit that was never
  // applied.
  limits: {
    maxTotalRunners: Number(process.env.FLEET_MAX_TOTAL_RUNNERS ?? 8),
    ceiling: Number(process.env.FLEET_CEILING ?? 3),
    loadPerCore: Number(process.env.FLEET_LOAD_PER_CORE ?? 2),
    minFreeDiskGb: Number(process.env.FLEET_MIN_FREE_DISK_GB ?? 50),
    maxInstancesPerRepo: Number(process.env.FLEET_MAX_INSTANCES_PER_REPO ?? 4),
  },
};

// Exactly what a coordinator may ask this host to do, and the script that does
// it. A denylist would be wrong here for the usual reason: the next action added
// to the coordinator would be permitted by default.
//
// Notably absent: anything that removes a runner from GitHub. Deregistration is
// destructive and irreversible from the host's point of view, and a coordinator
// bug that deregistered a fleet would be a bad afternoon. It stays a local
// decision.
// Each args function receives the coordinator's arguments and a resolver that
// turns a runner name into the directory name on THIS host, because that is what
// drain-runner.sh takes and the two are not interchangeable: the name is the
// GitHub agent name and the directory is where the runner lives. Passing the
// former where the latter was expected made every remote drain a no-op.
//
// runner.register is in a separate opt-in category (FLEET_AGENT_ALLOW_REGISTER)
// because it is higher blast radius than drain or health: it downloads a
// 121 MB tarball, installs a LaunchAgent, and contacts GitHub's runner API.
// An operator who wants reporting + drain/resume but not remote provisioning
// gets that by default.
const ALLOWED_COMMANDS = {
  'runner.drain': { script: 'scripts/drain-runner.sh', args: (a, resolve) => [resolve(a.name), '--drain'] },
  'runner.resume': { script: 'scripts/drain-runner.sh', args: (a, resolve) => [resolve(a.name), '--resume'] },
  'runner.restart': { script: 'scripts/restart-runner.sh', args: (a, resolve) => [resolve(a.name)] },
  'runner.deregisterPreview': { script: 'scripts/deregister.sh', args: (a, resolve) => [resolve(a.name)] },
  'health.check': { script: 'health.sh', args: () => [] },
  'fleet.health': { script: 'health.sh', args: () => [] },
  'fleet.healthRepair': { script: 'health.sh', args: () => ['--repair'] },
  'host.drain': { script: 'scripts/host-drain.sh', args: () => ['--drain'] },
  'host.resume': { script: 'scripts/host-drain.sh', args: () => ['--resume'] },
};

// runner.register is separate from ALLOWED_COMMANDS because it does not fit
// the generic spec.args shape: it passes a registration token via env rather
// than a positional argument (tokens are long, opaque, and must not appear in
// argv where `ps` can see them), and it requires its own idempotency and
// headroom checks before invoking register.sh.
const REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const LABEL_RE = /^[a-zA-Z0-9_.-]{1,50}$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), 'warn:', ...a);

function loadCommandResults() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG.commandResultsFile, 'utf8'));
    return new Map(Object.entries(parsed && typeof parsed === 'object' ? parsed : {}));
  } catch {
    return new Map();
  }
}

const commandResults = loadCommandResults();

function commandCacheKey(command) {
  return command.key
    ? `key:${command.key}`
    : `id:${command.id}:${command.action}`;
}

function rememberCommandResult(command, result) {
  commandResults.set(commandCacheKey(command), result);
  while (commandResults.size > 256) commandResults.delete(commandResults.keys().next().value);
  const temp = `${CONFIG.commandResultsFile}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(Object.fromEntries(commandResults), null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, CONFIG.commandResultsFile);
  chmodSync(CONFIG.commandResultsFile, 0o600);
}

function fail(message) {
  console.error(`fleet-agent: ${message}`);
  process.exit(1);
}

if (!CONFIG.coordinators.length) fail('FLEET_COORDINATOR or FLEET_COORDINATORS is not set — nothing to report to.');
if (!CONFIG.token) fail('FLEET_AGENT_TOKEN is not set. The coordinator will reject an unauthenticated agent.');
if (!existsSync(CONFIG.root)) fail(`FLEET_ROOT does not exist: ${CONFIG.root}`);

// Previous swap counters, kept across heartbeats so a rate can be derived from
// two readings. The first beat after start has nothing to compare against and
// reports null, which headroom() treats as unknown rather than as zero.
let lastSwapCounters = null;

// One host's state, in the same shape the coordinator's own collector produces,
// so mergeHostSnapshots has nothing special to do for local versus remote.
async function collect() {
  const dirs = discoverRunnerDirs(CONFIG.root);
  // All three shell out and are async. Without the await these were Promises,
  // jobs.get() threw on the first runner, and collect() rejected on every tick —
  // an agent that started cleanly and then never reported anything.
  const [jobs, procs, vitals] = await Promise.all([launchdJobs(), runnerProcesses(), hostVitals()]);

  const runners = dirs.map((d) => {
    const label = `actions.runner.${d.repo.replace('/', '-')}.${d.name}`;
    const job = jobs.get(label);
    const proc = procs.listeners.get(d.dir);
    return {
      name: d.name,
      repo: d.repo,
      dir: d.dir,
      dirName: d.dirName,
      instance: instanceOf(d.dirName, d.repo),
      // Deliberately absent, not empty. Labels live on the GitHub side and this
      // process does not call the API, so the honest report is "unknown" —
      // sending [] claimed as fact that the runner has no labels, which is never
      // true (every runner carries self-hosted at minimum) and would read to any
      // label-matching rule as a runner that can serve nothing.
      launchdLabel: label,
      // Same three words buildRunners uses. 'stopped'/'missing' meant a remote
      // runner's state did not compare against a local one, and any rule keyed
      // on the local vocabulary would have read a dead remote runner as fine.
      launchdState: job ? (job.pid ? 'running' : 'dead') : 'not-loaded',
      lastExit: job?.lastExit ?? null,
      pid: proc?.pid ?? null,
      rssMb: proc ? Math.round(proc.rssKb / 1024) : null,
      workingLocally: procs.workers.has(d.dir),
      drainState: d.drainState ?? null,
      version: d.version ?? null,
      createdAt: (() => {
        try { return statSync(d.dir).birthtimeMs; } catch { return null; }
      })(),
      // GitHub state is deliberately NOT collected here. The agent has no
      // guarantee of a working `gh`, and the coordinator already talks to the
      // GitHub API for every repo in the fleet — asking 20 hosts to make the
      // same calls would multiply the rate-limit cost by 20 to learn one answer.
      registered: true,
    };
  });

  // The same derivation the coordinator does for itself. headroom() gates on
  // swap-in RATE, and hostVitals reports cumulative counters, so without this the
  // remote capacity report silently skipped that check: a host thrashing hard
  // enough to refuse locally still advertised headroom when it was a remote one.
  // A counter reset across a reboot shows as a negative delta and is discarded
  // rather than reported as a large negative rate.
  let swapinsPerSec = null;
  let swapoutsPerSec = null;
  const at = Date.now();
  if (lastSwapCounters) {
    const dt = (at - lastSwapCounters.at) / 1000;
    const di = vitals.swapins - lastSwapCounters.swapins;
    const doo = vitals.swapouts - lastSwapCounters.swapouts;
    if (dt > 0 && di >= 0 && doo >= 0) {
      swapinsPerSec = di / dt;
      swapoutsPerSec = doo / dt;
    }
  }
  lastSwapCounters = { at, swapins: vitals.swapins, swapouts: vitals.swapouts };

  const host = {
    ...vitals,
    swapinsPerSec,
    swapoutsPerSec,
    runnerCount: runners.length,
    listeners: procs.listeners.size,
    workers: procs.workers.size,
  };

  return {
    id: CONFIG.hostId,
    name: CONFIG.hostName,
    labels: CONFIG.labels,
    version: 1,
    reportedAt: Date.now(),
    // The coordinator stores this against the host. Runner directories differ
    // per host, and knowing where a remote fleet lives is the difference between
    // a usable path in a diagnosis and a guess.
    fleetRoot: CONFIG.root,
    // Reported by the host that owns the decision. The placer already refuses a
    // drained host and the Hosts tab already flags one, but nothing set this, so
    // "take this Mac out of rotation" was a state the fleet could display and
    // never reach.
    drained: Boolean(hostDrainState(CONFIG.root)),
    runners,
    repos: [...new Set(runners.map((r) => r.repo))],
    host,
    // Computed HERE, on the host, rather than centrally. The host is the only
    // place that knows its own load and disk, and a coordinator deciding
    // capacity from a 30-second-old copy would be deciding from stale data at
    // exactly the moment it matters.
    capacity: headroom({ host, runners, limits: CONFIG.limits }),
  };
}

// Handle runner.register separately from the generic command runner: it uses
// environment variables for sensitive values (token must not appear in argv
// where `ps` can see it), and it performs its own idempotency and headroom
// checks before invoking register.sh.
async function runRegister(cmd) {
  if (!CONFIG.allowCommands) {
    return { id: cmd.id, ok: false, error: 'remote commands disabled (set FLEET_AGENT_ALLOW_COMMANDS=1)' };
  }
  if (!CONFIG.allowRegister) {
    return { id: cmd.id, ok: false, error: 'remote registration disabled (set FLEET_AGENT_ALLOW_REGISTER=1)' };
  }

  const a = cmd.args ?? {};
  const repo = String(a.repo ?? '');
  const labels = Array.isArray(a.labels) ? a.labels : [];
  const instance = Number(a.instance ?? 1);
  const token = String(a.token ?? '');

  if (!REPO_RE.test(repo)) return { id: cmd.id, ok: false, error: 'malformed repo' };
  if (!Number.isInteger(instance) || instance < 1 || instance > 8) {
    return { id: cmd.id, ok: false, error: 'invalid instance number' };
  }
  if (labels.some((l) => !LABEL_RE.test(String(l)))) {
    return { id: cmd.id, ok: false, error: 'malformed label' };
  }
  if (!token) return { id: cmd.id, ok: false, error: 'registration token is required' };

  const registerScript = join(CONFIG.root, 'register.sh');
  if (!existsSync(registerScript)) {
    return { id: cmd.id, ok: false, error: 'register.sh not found on this host' };
  }

  // Idempotency: if a runner for this repo and instance already exists, treat
  // the command as a success. A command that was sent, executed, and whose
  // result POST was lost will be retried by the coordinator — this prevents the
  // retry from registering a second runner.
  const name = String(repo).split('/').pop();
  const suffix = instance > 1 ? `-${instance}` : '';
  const runnerDir = join(CONFIG.root, `${name}${suffix}`);
  if (existsSync(join(runnerDir, '.runner'))) {
    return { id: cmd.id, ok: true, output: `runner already exists at ${runnerDir} — nothing to do` };
  }

  // Check local headroom immediately before invoking register.sh. The
  // coordinator checked capacity at placement time, but load can change in
  // the seconds between queuing and execution.
  const dirs = discoverRunnerDirs(CONFIG.root);
  const [jobs, procs, vitals] = await Promise.all([launchdJobs(), runnerProcesses(), hostVitals()]);
  const runners = dirs.map((d) => ({
    name: d.name, repo: d.repo, workingLocally: procs.workers.has(d.dir),
  }));
  const host = { ...vitals, runnerCount: runners.length };
  const hr = headroom({ host, runners, limits: CONFIG.limits });
  if (!hr.ok) {
    return { id: cmd.id, ok: false, error: `no headroom: ${hr.reasons.join('; ')}` };
  }

  // Per-repo cap, matching the coordinator's constraint.
  const MAX_INSTANCES = CONFIG.limits.maxInstancesPerRepo;
  const existing = dirs.filter((d) => d.repo === repo);
  if (existing.length >= MAX_INSTANCES) {
    return { id: cmd.id, ok: false, error: `at per-repo cap of ${MAX_INSTANCES} runners` };
  }

  const positionalArgs = [repo, ...labels];
  const env = {
    ...process.env,
    RUNNER_TOKEN: token,
    ...(instance > 1 ? { RUNNER_INSTANCE: String(instance) } : {}),
  };

  log(`runner.register: ${repo} instance ${instance}${labels.length ? ` [${labels.join(',')}]` : ''}`);

  return new Promise((res) => {
    execFile(registerScript, positionalArgs, {
      cwd: CONFIG.root, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, env,
    }, (err, stdout, stderr) => {
      res({
        id: cmd.id,
        ok: !err,
        error: err ? (err.killed ? 'timed out' : err.message) : null,
        output: String(stdout ?? '').slice(-4000) + String(stderr ?? '').slice(-2000),
      });
    });
  });
}

async function runDeregister(cmd) {
  if (!CONFIG.allowCommands) {
    return { id: cmd.id, ok: false, error: 'remote commands disabled (set FLEET_AGENT_ALLOW_COMMANDS=1)' };
  }
  if (!CONFIG.allowDeregister) {
    return { id: cmd.id, ok: false, error: 'remote deregistration disabled (set FLEET_AGENT_ALLOW_DEREGISTER=1)' };
  }

  const a = cmd.args ?? {};
  const token = String(a.token ?? '');
  if (!token) return { id: cmd.id, ok: false, error: 'removal token is required' };

  const dirs = discoverRunnerDirs(CONFIG.root);
  const target = dirs.find((d) => d.name === a.name || d.dirName === a.name);
  if (!target) return { id: cmd.id, ok: false, error: `no runner named ${a.name} on this host` };

  const script = join(CONFIG.root, 'scripts', 'deregister.sh');
  return new Promise((resolve) => {
    execFile(script, [target.dirName, '--apply'], {
      cwd: CONFIG.root,
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RUNNER_TOKEN: token },
    }, (err, stdout, stderr) => {
      resolve({
        id: cmd.id,
        ok: !err,
        error: err ? (err.killed ? 'timed out' : err.message) : null,
        output: String(stdout ?? '').slice(-4000) + String(stderr ?? '').slice(-2000),
      });
    });
  });
}

async function runCommand(cmd) {
  // runner.register has its own handler because it needs custom validation,
  // idempotency, and env-var-based secret passing.
  if (cmd.action === 'runner.register') return runRegister(cmd);
  if (cmd.action === 'runner.deregister') return runDeregister(cmd);

  const spec = ALLOWED_COMMANDS[cmd.action];
  if (!spec) {
    // Refused by name, and reported back. A coordinator asking for something
    // unknown is worth surfacing — it usually means the two are on different
    // versions, and silent refusal would make that invisible.
    return { id: cmd.id, ok: false, error: `action not allowed on this host: ${cmd.action}` };
  }
  if (!CONFIG.allowCommands) {
    return { id: cmd.id, ok: false, error: 'this agent is report-only (set FLEET_AGENT_ALLOW_COMMANDS=1 to enable)' };
  }

  const script = join(CONFIG.root, spec.script);
  if (!existsSync(script)) {
    return { id: cmd.id, ok: false, error: `script not present on this host: ${spec.script}` };
  }

  // Resolved from what this host can actually see on disk. A name the
  // coordinator believes in but this host does not have is refused here rather
  // than becoming an argument to a script.
  const resolve = (name) => {
    if (!name) throw new Error('no runner name given');
    const dirs = discoverRunnerDirs(CONFIG.root);
    const match = dirs.find((d) => d.name === name || d.dirName === name);
    if (!match) throw new Error(`no runner named ${name} on this host`);
    return match.dirName;
  };

  let args;
  try {
    args = spec.args(cmd.args ?? {}, resolve);
  } catch (err) {
    return { id: cmd.id, ok: false, error: `bad arguments: ${err.message}` };
  }
  // Every argument is validated against what this host can see, not against
  // what the coordinator claims. A runner name is a directory name here, and
  // anything with a slash or a traversal in it is refused before exec.
  for (const a of args) {
    if (typeof a !== 'string' || !a.length) return { id: cmd.id, ok: false, error: 'empty argument' };
    if (a.startsWith('-') && !a.startsWith('--')) return { id: cmd.id, ok: false, error: `suspicious argument: ${a}` };
    if (a.includes('/') || a === '..' || a === '.') return { id: cmd.id, ok: false, error: `unsafe argument: ${a}` };
  }

  return new Promise((resolve) => {
    execFile(script, args, { cwd: CONFIG.root, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          id: cmd.id,
          ok: !err,
          error: err ? (err.killed ? 'timed out' : err.message) : null,
          output: String(stdout ?? '').slice(-4000) + String(stderr ?? '').slice(-2000),
        });
      });
  });
}

let consecutiveFailures = 0;
let coordinatorCursor = 0;

async function postToCoordinator(path, payload) {
  let lastError = null;
  for (let offset = 0; offset < CONFIG.coordinators.length; offset++) {
    const index = (coordinatorCursor + offset) % CONFIG.coordinators.length;
    const base = CONFIG.coordinators[index];
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        coordinatorCursor = index;
        return { res, base };
      }
      lastError = new Error(`${base} returned ${res.status}`);
      if (res.status === 401 || res.status === 403) continue;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no coordinator available');
}

async function heartbeat() {
  let payload;
  try {
    payload = await collect();
  } catch (err) {
    warn('collection failed:', err.message);
    return;
  }

  try {
    const { res, base } = await postToCoordinator('/api/host/heartbeat', payload);

    if (consecutiveFailures > 0) {
      log(`reconnected to coordinator after ${consecutiveFailures} failed heartbeat(s)`);
      consecutiveFailures = 0;
    }

    // Commands ride back on the heartbeat response. Results are posted on the
    // next beat rather than immediately, which keeps the agent to one outbound
    // endpoint and one shape of request.
    const body = await res.json().catch(() => ({}));
    const commands = Array.isArray(body.commands) ? body.commands : [];
    if (!commands.length) return;

    log(`coordinator sent ${commands.length} command(s)`);
    // Sequentially, deliberately. These restart services and register runners;
    // two at once on one host is how a fleet ends up in a state nobody predicted.
    const results = [];
    for (const cmd of commands) {
      const cached = commandResults.get(commandCacheKey(cmd));
      const result = cached ?? await runCommand(cmd);
      if (!cached) rememberCommandResult(cmd, result);
      log(`${cmd.action}: ${result.ok ? 'ok' : `failed — ${result.error}`}`);
      results.push(result);
    }

    await postToCoordinator('/api/host/results', {
      host: CONFIG.hostId,
      name: CONFIG.hostName,
      results,
    })
      .catch((err) => warn(`could not report results via ${base}:`, err.message));
  } catch (err) {
    consecutiveFailures++;
    // Deliberately not fatal, and deliberately not escalating. A coordinator
    // that is down or unreachable must not stop this host's runners from working
    // — they take jobs directly from GitHub and do not need this process at all.
    // The agent's only job is reporting, so the correct response to a network
    // problem is to keep trying quietly.
    if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
      warn(`heartbeat failed (${consecutiveFailures} in a row): ${err.message}`);
    }
  }
}

log(`fleet-agent starting — host=${CONFIG.hostName} id=${CONFIG.hostId} root=${CONFIG.root}`);
log(`reporting to ${CONFIG.coordinators.join(', ')} every ${CONFIG.heartbeatMs / 1000}s`);
if (CONFIG.allowCommands) {
  const cmds = [...Object.keys(ALLOWED_COMMANDS)];
  if (CONFIG.allowRegister) cmds.push('runner.register');
  log(`remote commands ENABLED: ${cmds.join(', ')}`);
} else {
  log('remote commands disabled (report-only) — set FLEET_AGENT_ALLOW_COMMANDS=1 to enable');
}
if (CONFIG.allowCommands && !CONFIG.allowRegister) {
  log('runner.register disabled — set FLEET_AGENT_ALLOW_REGISTER=1 to allow remote provisioning');
}

await heartbeat();
setInterval(heartbeat, CONFIG.heartbeatMs);
