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
import { existsSync } from 'node:fs';

import { discoverRunnerDirs, launchdJobs, runnerProcesses, hostVitals, hostDrainState } from './lib/local.js';
import { headroom } from './lib/capacity.js';
// Shared with buildRunners so a duplicate is numbered the same way on every host.
import { instanceOf } from './lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  coordinator: process.env.FLEET_COORDINATOR ?? '',
  token: process.env.FLEET_AGENT_TOKEN ?? '',
  root: process.env.FLEET_ROOT ?? join(os.homedir(), 'actions-runners'),
  // Named so a fleet can distinguish two hosts with the same hostname, which
  // happens more often than it should.
  hostName: process.env.FLEET_HOST_NAME ?? os.hostname().replace(/\.local$/, ''),
  heartbeatMs: Number(process.env.FLEET_HEARTBEAT_MS ?? 30_000),
  labels: (process.env.FLEET_HOST_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Commands are OPT-IN. An agent that only reports is useful on its own, and it
  // is the right default: joining a fleet should not silently grant remote
  // execution.
  allowCommands: process.env.FLEET_AGENT_ALLOW_COMMANDS === '1',
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
// Deliberately absent, beyond deregistration: restart and duplicate. Neither is
// a fleet script — restart is svc.sh inside the runner's own directory, and
// duplicate is register.sh plus the per-repo cap check that lives on the
// coordinator. Entries pointing at scripts that do not exist are worse than no
// entries, since they read as supported until someone tries them.
const ALLOWED_COMMANDS = {
  'runner.drain': { script: 'scripts/drain-runner.sh', args: (a, resolve) => [resolve(a.name), '--drain'] },
  'runner.resume': { script: 'scripts/drain-runner.sh', args: (a, resolve) => [resolve(a.name), '--resume'] },
  'health.check': { script: 'health.sh', args: () => [] },
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), 'warn:', ...a);

function fail(message) {
  console.error(`fleet-agent: ${message}`);
  process.exit(1);
}

if (!CONFIG.coordinator) fail('FLEET_COORDINATOR is not set — nothing to report to.');
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

async function runCommand(cmd) {
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

async function heartbeat() {
  let payload;
  try {
    payload = await collect();
  } catch (err) {
    warn('collection failed:', err.message);
    return;
  }

  try {
    const res = await fetch(`${CONFIG.coordinator.replace(/\/$/, '')}/api/host/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      consecutiveFailures++;
      warn(`coordinator returned ${res.status}${res.status === 401 ? ' — check FLEET_AGENT_TOKEN' : ''}`);
      return;
    }

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
      const result = await runCommand(cmd);
      log(`${cmd.action}: ${result.ok ? 'ok' : `failed — ${result.error}`}`);
      results.push(result);
    }

    await fetch(`${CONFIG.coordinator.replace(/\/$/, '')}/api/host/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.token}` },
      body: JSON.stringify({ host: CONFIG.hostName, results }),
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => warn('could not report results:', err.message));
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

log(`fleet-agent starting — host=${CONFIG.hostName} root=${CONFIG.root}`);
log(`reporting to ${CONFIG.coordinator} every ${CONFIG.heartbeatMs / 1000}s`);
log(CONFIG.allowCommands
  ? `remote commands ENABLED: ${Object.keys(ALLOWED_COMMANDS).join(', ')}`
  : 'remote commands disabled (report-only) — set FLEET_AGENT_ALLOW_COMMANDS=1 to enable');

await heartbeat();
setInterval(heartbeat, CONFIG.heartbeatMs);
