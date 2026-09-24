import os from 'node:os';
import { statSync } from 'node:fs';
import {
  discoverRunnerDirs, launchdJobs, runnerProcesses, hostVitals, hostDrainState,
} from './local.js';
import { headroom } from './capacity.js';
import { instanceOf } from './state.js';

let lastSwap = null;

export async function collectHostReport({
  root,
  hostId,
  hostName = os.hostname().replace(/\.local$/, ''),
  labels = [],
  limits = {},
}) {
  const dirs = discoverRunnerDirs(root);
  const [jobs, procs, vitals] = await Promise.all([
    launchdJobs(), runnerProcesses(), hostVitals(),
  ]);
  const now = Date.now();
  let swapinsPerSec = null;
  let swapoutsPerSec = null;
  if (lastSwap) {
    const seconds = (now - lastSwap.at) / 1000;
    const ins = vitals.swapins - lastSwap.ins;
    const outs = vitals.swapouts - lastSwap.outs;
    if (seconds > 0 && ins >= 0 && outs >= 0) {
      swapinsPerSec = ins / seconds;
      swapoutsPerSec = outs / seconds;
    }
  }
  lastSwap = { at: now, ins: vitals.swapins, outs: vitals.swapouts };

  const runners = dirs.map((d) => {
    const label = `actions.runner.${d.repo.replace('/', '-')}.${d.name}`;
    const job = jobs.get(label);
    let createdAt = null;
    try { createdAt = statSync(d.dir).birthtimeMs; } catch {}
    return {
      name: d.name,
      repo: d.repo,
      dirName: d.dirName,
      instance: instanceOf(d.dirName, d.repo),
      launchdState: job ? (job.pid ? 'running' : 'dead') : 'not-loaded',
      lastExit: job?.lastExit ?? null,
      workingLocally: procs.workers.has(d.dir),
      drainState: d.drainState ?? null,
      version: d.version ?? null,
      createdAt,
      registered: true,
    };
  });
  const host = {
    ...vitals,
    swapinsPerSec,
    swapoutsPerSec,
    hostname: hostName,
    platform: process.platform,
    runnerCount: runners.length,
    listeners: procs.listeners.size,
    workers: procs.workers.size,
  };
  return {
    id: hostId,
    name: hostName,
    labels,
    version: 2,
    reportedAt: now,
    fleetRoot: root,
    drained: Boolean(hostDrainState(root)),
    runners,
    repos: [...new Set(runners.map((r) => r.repo))],
    host,
    capacity: headroom({ host, runners, limits }),
  };
}
