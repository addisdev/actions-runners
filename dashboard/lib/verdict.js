// One verdict for the whole fleet, and one state for every runner.
//
// Every other module here answers a narrow question well: drift says where this
// machine and GitHub disagree, the queue classifier says why one run is waiting,
// the failure classes say why one job died, the admission log says who is being
// held. What none of them says is the thing an operator glancing at a menu bar
// or a lock screen actually wants: *is anything wrong, which thing, and what is
// the one move.* People re-derived that from the parts during every incident,
// and got it wrong in the same ways each time — a disk-floor hold read as load,
// a saturated host read as a flaky test, an account block read as a broken
// build.
//
// So the ladder below is the order those incidents taught, written down once.
// First match wins because the rungs are ordered by what makes the others
// meaningless: when the disk floor is holding every job, "the queue is long"
// is true and useless, and when a runner service is dead, "every runner for this
// repo is busy" is a misreading.
//
// Pure, apart from the tracker's memory of when a runner first went offline —
// an `offline` flap self-resolves in 46–280 s on the reference host, so a runner
// is only called down after it has stayed that way.
//
// This file is the single source of truth for the vocabulary. The web banner,
// /api/glance, push and the macOS cockpit all read it; nothing re-derives it.

// The rungs this daemon can see. The cockpit adds two above these that no
// process on the host can ever report — its own absence ("host down" for the
// coordinator) and the viewer's own network ("blind") — and it uses the same
// ids for them so the ladder reads identically everywhere.
export const LADDER = [
  { id: 'unknown', tone: 'unknown', title: 'Cannot read GitHub' },
  { id: 'host-down', tone: 'critical', title: 'Host is not reporting' },
  { id: 'disk-floor', tone: 'critical', title: 'Disk floor is holding jobs' },
  { id: 'dead-service', tone: 'critical', title: 'Runner service is down' },
  { id: 'saturated', tone: 'warning', title: 'Host is saturated' },
  { id: 'account-blocked', tone: 'warning', title: 'GitHub is refusing jobs' },
  { id: 'config-drift', tone: 'warning', title: 'Configuration drift' },
  { id: 'waiting', tone: 'ok', title: 'Working' },
  { id: 'clear', tone: 'ok', title: 'All clear' },
];

export const RUNNER_STATES = [
  'host-down', 'unknown', 'dead', 'misconfigured', 'draining', 'offline', 'settling',
  'held-disk', 'held-slot', 'overdue', 'busy', 'lost', 'idle',
];

export const DEFAULTS = {
  // An offline runner whose listener is alive usually reconnects on its own.
  settleMs: 5 * 60 * 1000,
  // How far back a runner-lost job still says something about the host now.
  lostWindowMs: 60 * 60 * 1000,
  // Two lost jobs in the window is the saturation signature (09-12: 03:13 and
  // 04:10 on one repo). One is a network blip.
  lostThreshold: 2,
  // An account block older than this has usually been dealt with or was a
  // one-off; it stays visible on the Alerts tab, not on the glance.
  accountWindowMs: 6 * 60 * 60 * 1000,
  // A held row with no later event for its runner after this long is a hook
  // that died with a cancelled job, not a wait. Six hours was GitHub's own
  // default job ceiling and is FLEET_ADMIT_SLOT_TTL_S's default.
  holdTtlMs: 6 * 60 * 60 * 1000,
  // Queue causes that are structural: waiting will never fix them.
  driftCauses: ['unserved', 'role-unserved', 'label-mismatch', 'github-hosted'],
  // How far back the glance lists failed runs.
  recentFailureWindowMs: 2 * 60 * 60 * 1000,
};

// Failure classes whose first move is not reading the diff (lib/failures.js).
export const NOT_YOUR_CODE = ['runner-lost', 'account-blocked', 'account-quota', 'no-runner'];

const DISK_HOLD = /(\d+(?:\.\d+)?) GB disk free, below the (\d+(?:\.\d+)?) GB floor/;

export function parseDiskHold(reason) {
  const m = DISK_HOLD.exec(String(reason ?? ''));
  return m ? { freeGb: Number(m[1]), floorGb: Number(m[2]) } : null;
}

const short = (name = '') => String(name).split('/').pop();
const minutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${(ms / 3600000).toFixed(1)} h`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Failure facts that live in the jobs table rather than the snapshot. Kept apart
 * from the pure part so tests can hand them in directly.
 */
export function loadFailureFacts(db, now = Date.now(), opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const facts = { runnerLost: [], account: { blocked: 0, quota: 0, repos: [], lastAt: null }, recentFailures: [] };
  try {
    // One row per failed run in the window, carrying the class that sends the
    // reader somewhere other than the diff. The cockpit uses it to say "not
    // your code" on a red run that the host or the account failed.
    facts.recentFailures = db.prepare(`
      SELECT j.run_id AS runId, j.repo, r.workflow_name AS workflow, r.head_branch AS branch,
             r.html_url AS url, j.failure_class AS cls, MAX(j.completed_at) AS at, j.runner_name AS runner
      FROM jobs j LEFT JOIN runs r ON r.id = j.run_id
      WHERE j.conclusion IN ('failure', 'timed_out') AND j.completed_at >= ?
      GROUP BY j.run_id
      ORDER BY at DESC LIMIT 8`)
      .all(new Date(now - o.recentFailureWindowMs).toISOString())
      .map((r) => ({ ...r, at: Date.parse(r.at) || null, cls: r.cls ?? 'unknown' }));
  } catch { /* pre-migration db */ }
  try {
    facts.runnerLost = db.prepare(`
      SELECT runner_name AS runner, repo, completed_at AS at, html_url AS url FROM jobs
      WHERE failure_class = 'runner-lost' AND completed_at >= ?
      ORDER BY completed_at DESC LIMIT 50`)
      .all(new Date(now - o.lostWindowMs).toISOString())
      .map((r) => ({ ...r, at: Date.parse(r.at) || null }));
    const rows = db.prepare(`
      SELECT failure_class AS cls, repo, MAX(COALESCE(completed_at, started_at)) AS last, COUNT(*) AS n
      FROM jobs
      WHERE failure_class IN ('account-blocked', 'account-quota')
        AND COALESCE(completed_at, started_at) >= ?
      GROUP BY failure_class, repo`)
      .all(new Date(now - o.accountWindowMs).toISOString());
    const repos = new Set();
    for (const r of rows) {
      if (r.cls === 'account-blocked') facts.account.blocked += r.n;
      else facts.account.quota += r.n;
      repos.add(r.repo);
      const at = Date.parse(r.last) || null;
      if (at && (!facts.account.lastAt || at > facts.account.lastAt)) facts.account.lastAt = at;
    }
    facts.account.repos = [...repos].sort();
  } catch { /* pre-migration db: no facts is the honest answer */ }
  return facts;
}

/**
 * Keeps the one piece of memory the verdict needs. Everything else is derived
 * from the snapshot in hand.
 */
export function createVerdictTracker(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const offlineSince = new Map();
  return {
    observe(snapshot, facts = {}, now = Date.now()) {
      const offline = new Set();
      for (const r of allRunners(snapshot)) {
        if (isOffline(r)) {
          offline.add(r.name);
          if (!offlineSince.has(r.name)) offlineSince.set(r.name, now);
        }
      }
      for (const name of [...offlineSince.keys()]) if (!offline.has(name)) offlineSince.delete(name);
      return computeVerdict(snapshot, facts, { ...o, now, offlineSince });
    },
  };
}

function allRunners(snapshot) {
  const seen = new Set();
  const out = [];
  for (const r of [...(snapshot.fleetRunners ?? snapshot.runners ?? []), ...(snapshot.elsewhere ?? [])]) {
    if (!r?.name || seen.has(r.name) || r.ephemeral) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out;
}

const isOffline = (r) =>
  !r.drainState && r.registered !== false && !r.ghUnknown && r.ghStatus === 'offline';

/**
 * @returns {{ verdict, runners: Map<string, object>, counts }}
 */
export function computeVerdict(snapshot, facts = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();
  const offlineSince = o.offlineSince ?? new Map();
  const runnerLost = facts.runnerLost ?? [];
  const account = facts.account ?? { blocked: 0, quota: 0, repos: [], lastAt: null };

  const drift = snapshot.drift ?? [];
  const driftBy = (kind) => drift.filter((d) => d.kind === kind);
  const queue = snapshot.queue ?? [];
  const host = snapshot.host ?? {};
  const openAlerts = snapshot.alertState?.open ?? [];
  const floorGb = o.floorGb ?? null;

  // ---- admission waiters --------------------------------------------------
  const waiting = (snapshot.admission?.waiting ?? [])
    .filter((w) => w.since == null || now - w.since * (w.since < 1e12 ? 1000 : 1) <= o.holdTtlMs)
    .map((w) => ({ ...w, disk: parseDiskHold(w.reason) }));
  const heldByName = new Map(waiting.map((w) => [w.runner, w]));
  const diskHeld = waiting.filter((w) => w.disk);
  const effectiveFloor = diskHeld[0]?.disk.floorGb ?? floorGb;

  // ---- who is running what -------------------------------------------------
  const jobOn = new Map();
  for (const run of snapshot.active ?? []) {
    for (const j of run.jobs ?? []) {
      if (j.status !== 'in_progress' || !j.runnerName) continue;
      jobOn.set(j.runnerName, {
        runId: run.id,
        repo: run.repo,
        workflow: run.workflowName,
        job: j.name,
        startedAt: Date.parse(j.startedAt) || null,
        elapsedMs: j.startedAt ? Math.max(0, now - Date.parse(j.startedAt)) : run.elapsedMs ?? null,
        expectedMs: run.expectedDurationMs ?? null,
        overdue: Boolean(run.longRunning),
        url: j.url ?? run.url ?? null,
        prNumber: run.prNumber ?? null,
        branch: run.branch ?? null,
      });
    }
  }
  const lostBy = new Map();
  for (const l of runnerLost) if (l.runner && !lostBy.has(l.runner)) lostBy.set(l.runner, l);

  // ---- runner states --------------------------------------------------------
  const deadKinds = new Map();
  for (const d of drift) {
    if (['launchd-dead', 'launchd-missing', 'no-listener', 'orphan'].includes(d.kind)) deadKinds.set(d.subject, d);
  }
  const mismatchRepos = new Set(driftBy('label-mismatch').map((d) => d.subject));

  const runners = new Map();
  for (const r of allRunners(snapshot)) {
    const d = deadKinds.get(r.name);
    const job = jobOn.get(r.name) ?? null;
    const held = heldByName.get(r.name);
    const lost = lostBy.get(r.name) ?? null;
    let state;
    let detail;
    let since = null;
    if (r.hostStale) {
      state = 'host-down';
      detail = `host ${r.hostName ?? r.hostId} not reporting for ${minutes(r.staleForMs ?? 0)}`;
    } else if (d && d.kind !== 'orphan') {
      state = 'dead';
      detail = d.detail;
    } else if (d?.kind === 'orphan' || mismatchRepos.has(r.repo)) {
      state = 'misconfigured';
      detail = d?.detail ?? 'sibling runners carry different labels';
    } else if (r.drainState) {
      state = 'draining';
      detail = `drain ${r.drainState}`;
    } else if (r.ghUnknown) {
      state = 'unknown';
      detail = 'GitHub state not read this tick';
    } else if (isOffline(r)) {
      since = offlineSince.get(r.name) ?? now;
      state = now - since < o.settleMs ? 'settling' : 'offline';
      detail = state === 'settling'
        ? `offline for ${minutes(now - since)}; usually reconnects within 5 min`
        : `offline for ${minutes(now - since)}`;
    } else if (held) {
      state = held.disk ? 'held-disk' : 'held-slot';
      detail = `held: ${held.reason}`;
      since = held.since ? held.since * (held.since < 1e12 ? 1000 : 1) : null;
    } else if (job || r.ghBusy || r.workingLocally) {
      state = job?.overdue ? 'overdue' : 'busy';
      detail = job
        ? `${job.workflow} · ${job.job}${job.expectedMs ? ` · ${minutes(job.elapsedMs ?? 0)} of ~${minutes(job.expectedMs)}` : ''}`
        : 'busy';
    } else if (lost) {
      state = 'lost';
      detail = `lost contact mid-job ${minutes(now - (lost.at ?? now))} ago`;
    } else {
      state = 'idle';
      detail = 'idle';
    }
    runners.set(r.name, {
      name: r.name,
      repo: r.repo ?? null,
      project: r.project ?? null,
      hostId: r.hostId ?? null,
      state,
      detail,
      since,
      job,
      lostAt: lost?.at ?? null,
    });
  }

  const states = [...runners.values()];
  const inState = (...s) => states.filter((r) => s.includes(r.state));

  // ---- the ladder -----------------------------------------------------------
  const open = [];
  const push = (id, extra) => {
    const rung = LADDER.find((l) => l.id === id);
    open.push({ id, tone: rung.tone, title: rung.title, ...extra });
  };

  const polled = (snapshot.repos ?? []).filter((r) => r.hasRunner || r.workflows > 0).length;
  const failed = snapshot.collector?.failedRepos ?? 0;
  if (snapshot.starting) {
    push('unknown', {
      sentence: 'The collector has not finished its first pass yet.',
      evidence: [],
      next: { label: 'Wait for the first tick', kind: 'none' },
    });
  } else if (snapshot.collector?.lastError && polled > 0 && failed >= polled) {
    push('unknown', {
      sentence: 'Every repo failed to read this tick, so nothing below can be trusted.',
      evidence: [String(snapshot.collector.lastError).slice(0, 200)],
      next: { label: 'Check the GitHub token and network on the host', kind: 'owner' },
    });
  }

  const localIds = new Set((snapshot.hosts ?? []).filter((h) => h.local).map((h) => h.id));
  const staleHosts = (snapshot.hosts ?? []).filter((h) => !h.local && !localIds.has(h.id) && (h.stale || h.hostStale));
  if (staleHosts.length) {
    push('host-down', {
      title: staleHosts.length === 1 ? `${staleHosts[0].name ?? staleHosts[0].id} is not reporting` : `${staleHosts.length} hosts are not reporting`,
      sentence: 'Its runners may still take jobs; the coordinator cannot see or place on it.',
      evidence: staleHosts.map((h) => `${h.name ?? h.id}: no heartbeat for ${minutes(h.staleForMs ?? 0)}`),
      next: { label: 'Check the agent process and network on that host', kind: 'owner' },
    });
  }

  const diskBelow = effectiveFloor != null && host.diskFreeGb != null && host.diskFreeGb < effectiveFloor;
  const enforcing = (snapshot.admission?.mode ?? null) === 'enforce';
  if (diskHeld.length || (diskBelow && enforcing)) {
    const evidence = [];
    if (host.diskFreeGb != null && effectiveFloor != null) {
      evidence.push(`${host.diskFreeGb.toFixed(1)} GB free, floor ${effectiveFloor} GB`);
    }
    if (diskHeld.length) {
      evidence.push(`${plural(diskHeld.length, 'job')} held at Set up runner: ${diskHeld.map((w) => short(w.repo ?? w.runner)).join(', ')}`);
    } else {
      evidence.push('The next job any runner accepts will be held');
    }
    evidence.push('Waiting does not fix this; freeing disk does');
    push('disk-floor', {
      sentence: `${diskHeld.length ? plural(diskHeld.length, 'job') + ' held' : 'Jobs will be held'} because free disk is under the admission floor. It looks like load; it is disk.`,
      evidence,
      next: { label: 'Preview cleanup', kind: 'action', action: 'fleet.cleanupPreview', then: 'fleet.cleanupApply' },
    });
  }

  const dead = inState('dead', 'offline');
  const downQueued = queue.filter((q) => q.cause === 'runner-down');
  if (dead.length || downQueued.length) {
    const evidence = dead.slice(0, 6).map((r) => `${r.name}: ${r.detail}`);
    if (dead.length > 6) evidence.push(`and ${dead.length - 6} more`);
    for (const q of downQueued.slice(0, 3)) evidence.push(`${short(q.repo)} · ${q.workflowName} queued ${minutes(q.queuedSinceMs ?? 0)} behind a down runner`);
    push('dead-service', {
      title: dead.length === 1 ? `Runner service is down: ${dead[0].name}` : dead.length ? `${dead.length} runner services are down` : 'A runner is down and work is queued',
      sentence: 'launchd will not revive a dead runner service; its repo queues until it is repaired.',
      evidence,
      next: { label: 'Health check and repair', kind: 'action', action: 'fleet.healthRepair' },
    });
  }

  const recentLost = runnerLost.filter((l) => l.at && now - l.at <= o.lostWindowMs);
  const thrashing = openAlerts.find((a) => a.rule === 'swap-thrashing');
  // A run queued because the headroom gate is at capacity is NOT this rung: it
  // is waiting for a slot, and on a busy host that is most of the day. This
  // rung is for work that is dying of starvation — lost jobs, sustained paging,
  // critical pressure. Calling a full host "saturated" all afternoon is how a
  // verdict becomes wallpaper.
  if (recentLost.length >= o.lostThreshold || thrashing || host.memPressure === 'critical') {
    const evidence = [];
    if (recentLost.length) {
      evidence.push(`${plural(recentLost.length, 'job')} lost contact mid-step in the last ${minutes(o.lostWindowMs)}: ` +
        recentLost.slice(0, 4).map((l) => `${short(l.repo)} ${new Date(l.at).toISOString().slice(11, 16)}Z`).join(', '));
    }
    if (thrashing) evidence.push(thrashing.title);
    if (host.memPressure === 'critical') evidence.push('Kernel memory pressure is critical');
    if (host.load1 != null && host.cores) evidence.push(`Load ${(host.load1 / host.cores).toFixed(1)} per core`);
    push('saturated', {
      sentence: 'Jobs are dying from starvation, not from code. Check the host before the workflow, the browser or the test.',
      evidence,
      next: { label: 'Show top CPU on the host', kind: 'command', command: 'ps -Ao %cpu,comm -r | head -15', secondary: 'host.drain' },
    });
  }

  const accountN = (account.blocked ?? 0) + (account.quota ?? 0);
  if (accountN > 0 && account.lastAt && now - account.lastAt <= o.accountWindowMs) {
    const parts = [];
    if (account.blocked) parts.push(`${plural(account.blocked, 'job')} refused (billing or spending limit)`);
    if (account.quota) parts.push(`${plural(account.quota, 'job')} hit a storage quota`);
    push('account-blocked', {
      // True when GitHub refuses to START jobs; a full storage quota lets
      // them run. `cockpit wait` stops waiting only for the first.
      blocking: account.blocked > 0,
      title: account.blocked
        ? `GitHub is refusing jobs on ${plural(account.repos.length || 1, 'repo')}`
        : 'Artifact storage quota is full',
      sentence: account.blocked
        ? 'Nothing on this machine is wrong. The account is refusing work: payment or spending limit.'
        : 'Nothing on this machine is wrong. Jobs ran but could not publish their artifacts or caches.',
      evidence: [
        `${parts.join('; ')} in the last ${minutes(o.accountWindowMs)}`,
        account.repos.length ? `Repos: ${account.repos.map(short).join(', ')}` : null,
        `Last seen ${minutes(now - account.lastAt)} ago`,
      ].filter(Boolean),
      next: { label: 'Open billing', kind: 'url', url: 'https://github.com/settings/billing' },
    });
  }

  const drifted = [...driftBy('orphan'), ...driftBy('label-mismatch')];
  const structural = queue.filter((q) => o.driftCauses.includes(q.cause));
  if (drifted.length || structural.length) {
    push('config-drift', {
      sentence: 'Some work can never be picked up as configured. Waiting will not clear it.',
      evidence: [
        ...drifted.slice(0, 4).map((d) => `${d.kind}: ${d.subject}`),
        ...structural.slice(0, 4).map((q) => `${short(q.repo)} · ${q.workflowName}: ${q.cause}`),
      ],
      next: { label: 'Open the Lint tab', kind: 'url', url: '#/lint' },
    });
  }

  const running = states.filter((r) => r.job || r.state === 'busy' || r.state === 'overdue').length;
  const slotHeld = waiting.filter((w) => !w.disk);
  const counts = { running, queued: queue.length, held: waiting.length, runners: states.length };

  // Queued runs a fault above already explains are that fault's evidence, not
  // a second finding that says "working" next to "down".
  const explained = new Set(['runner-down', ...o.driftCauses]);
  const plainQueue = queue.filter((q) => !explained.has(q.cause));
  if (plainQueue.length || slotHeld.length) {
    const oldest = plainQueue.reduce((m, q) => Math.max(m, q.queuedSinceMs ?? 0), 0);
    const causes = [...new Set(plainQueue.map((q) => q.cause))];
    push('waiting', {
      title: 'Working',
      sentence: [
        `${running} running`,
        plainQueue.length ? `${plainQueue.length} queued${oldest ? `, oldest ${minutes(oldest)}` : ''}` : null,
        slotHeld.length ? `${slotHeld.length} waiting for an admission slot` : null,
      ].filter(Boolean).join(', ') + '. A queue is not a stall.',
      evidence: [
        ...plainQueue.slice(0, 4).map((q) => `${short(q.repo)} · ${q.workflowName}: ${q.cause} (${q.confidence})`),
        ...slotHeld.slice(0, 3).map((w) => `${short(w.repo ?? w.runner)} held: ${w.reason}`),
      ],
      causes,
      next: { label: 'Nothing to do', kind: 'none' },
    });
  }

  const partial = failed > 0 && !open.some((x) => x.id === 'unknown')
    ? `${plural(failed, 'repo')} could not be read this tick`
    : null;

  if (!open.length) {
    push('clear', {
      sentence: running ? `${running} running, nothing queued.` : 'Nothing running, nothing queued, nothing wrong.',
      evidence: [],
      next: { label: 'Nothing to do', kind: 'none' },
    });
  }
  if (partial) open[0].evidence = [...(open[0].evidence ?? []), partial];

  const top = open[0];
  return {
    verdict: {
      id: top.id,
      tone: top.tone,
      title: top.title,
      sentence: top.sentence,
      evidence: top.evidence ?? [],
      next: top.next,
      rung: LADDER.findIndex((l) => l.id === top.id),
      open,
    },
    runners,
    counts,
  };
}

/**
 * The compact payload for small screens and slow links: everything the glance
 * needs and nothing it does not. `schema` is bumped only on a breaking change,
 * so a newer daemon never breaks an older cockpit.
 */
export const GLANCE_SCHEMA = 1;

export function buildGlance(snapshot, result, opts = {}) {
  const now = opts.now ?? Date.now();
  const ageMs = snapshot.ts ? now - snapshot.ts : null;
  const stale = ageMs != null && opts.staleMs != null && ageMs > opts.staleMs;
  const elsewhereNames = new Set((snapshot.elsewhere ?? []).map((r) => r.name));

  // Runners registered on machines this daemon does not supervise (no agent)
  // are GitHub-only facts. They get a lane per name prefix — register.sh names
  // runners <host>-<repo> — so the Mini's six release runners read as "server"
  // rather than being mixed into the coordinator's lane.
  const prefixOf = (name) => String(name).split('-')[0];
  const prefixCounts = new Map();
  for (const n of elsewhereNames) prefixCounts.set(prefixOf(n), (prefixCounts.get(prefixOf(n)) ?? 0) + 1);
  const laneFor = (r) => {
    if (!elsewhereNames.has(r.name) || r.hostId && r.hostId !== opts.localHostId) return r.hostId ?? opts.localHostId ?? 'local';
    const p = prefixOf(r.name);
    return (prefixCounts.get(p) ?? 0) >= 2 ? `elsewhere:${p}` : 'elsewhere';
  };

  const localIds = new Set((snapshot.hosts ?? []).filter((h) => h.local).map((h) => h.id));
  const hosts = (snapshot.hosts ?? []).filter((h) => h.local || !localIds.has(h.id)).map((h) => {
    const v = h.host ?? (h.local ? snapshot.host : null) ?? {};
    return {
      id: h.id,
      name: h.name ?? h.id,
      local: Boolean(h.local),
      stale: Boolean(h.stale || h.hostStale),
      staleForMs: h.staleForMs ?? 0,
      ghOnly: false,
      drained: Boolean(h.drained),
      vitals: {
        cores: v.cores ?? null,
        load1: round(v.load1, 2),
        memPressure: v.memPressure ?? null,
        memFreePct: v.memFreePct ?? null,
        swapinsPerSec: round(v.swapinsPerSec, 1),
        swapUsedMb: v.swapUsedMb != null ? Math.round(v.swapUsedMb) : null,
        diskFreeGb: round(v.diskFreeGb, 1),
        diskTotalGb: round(v.diskTotalGb, 0),
        diskFloorGb: h.local ? opts.floorGb ?? null : null,
        diskFloorEtaMs: h.local ? snapshot.host?.diskFloorEtaMs ?? null : null,
        diskRateGbPerHour: h.local ? snapshot.host?.diskForecast?.rate6hGbPerHour ?? null : null,
        uptimeSec: v.uptimeSec ?? null,
      },
    };
  });
  const lanes = new Set(hosts.map((h) => h.id));
  const runners = [];
  for (const r of result.runners.values()) {
    const src = (snapshot.fleetRunners ?? []).find((x) => x.name === r.name) ?? (snapshot.elsewhere ?? []).find((x) => x.name === r.name) ?? {};
    const lane = laneFor({ ...src, name: r.name, hostId: r.hostId });
    if (!lanes.has(lane)) {
      lanes.add(lane);
      hosts.push({
        id: lane,
        name: lane.startsWith('elsewhere:') ? lane.slice('elsewhere:'.length) : 'elsewhere',
        local: false,
        stale: false,
        staleForMs: 0,
        ghOnly: true,
        drained: false,
        vitals: null,
      });
    }
    runners.push(strip({
      name: r.name,
      repo: r.repo,
      project: r.project,
      host: lane,
      state: r.state,
      detail: r.detail,
      since: r.since,
      lostAt: r.lostAt,
      job: r.job ? strip(r.job) : null,
    }));
  }
  const activeById = new Map((snapshot.active ?? []).map((a) => [a.id, a]));

  return {
    schema: GLANCE_SCHEMA,
    ts: snapshot.ts ?? null,
    generatedAt: now,
    ageMs,
    stale,
    fastMs: snapshot.collector?.fastMs ?? null,
    verdict: result.verdict,
    counts: result.counts,
    hosts,
    runners,
    queue: (snapshot.queue ?? []).map((q) => {
      const run = activeById.get(q.id) ?? {};
      return strip({
        id: q.id,
        repo: q.repo,
        project: q.project,
        workflow: q.workflowName,
        queuedMs: q.queuedSinceMs,
        cause: q.cause,
        confidence: q.confidence,
        recommended: q.recommended,
        evidence: q.evidence,
        url: run.url ?? null,
        branch: run.branch ?? null,
        prNumber: run.prNumber ?? null,
        title: run.displayTitle ?? null,
        etaStartMs: q.etaStartMs ?? null,
        etaDoneMs: q.etaDoneMs ?? null,
        etaBasis: q.etaBasis ?? null,
      });
    }),
    // Runs, compact: what is building now, and what finished in the last two
    // hours. Enough to roll a PR's checks up into one row and to tell a waiting
    // script that its checks are done, without the 130 KB state.
    runs: (snapshot.active ?? []).map((r) => compactRun(r, now)),
    recent: (snapshot.recent ?? [])
      .filter((r) => now - (Date.parse(r.updatedAt) || 0) <= 2 * 60 * 60 * 1000)
      .slice(0, 20)
      .map((r) => compactRun(r, now)),
    failures: (opts.failures ?? []).map((f) => strip({
      runId: f.runId,
      repo: f.repo,
      workflow: f.workflow ?? null,
      branch: f.branch ?? null,
      url: f.url ?? null,
      cls: f.cls,
      notYourCode: NOT_YOUR_CODE.includes(f.cls),
      runner: f.runner ?? null,
      at: f.at ?? null,
    })),
    // Standing risks that are currently open (lib/posture.js), for the
    // cockpit's posture chip. Checked on the slow loop.
    posture: opts.posture
      ? { checkedAt: opts.posture.checkedAt, items: opts.posture.items.filter((i) => i.ok === false).map((i) => strip(i)) }
      : null,
    incidents: (snapshot.alertState?.open ?? []).map((a) => strip({
      key: a.key,
      rule: a.rule,
      severity: a.severity,
      title: a.title,
      body: typeof a.body === 'string' ? a.body.slice(0, 400) : null,
      openedAt: a.opened_at ?? null,
      dismissed: Boolean(a.dismissed_at),
    })),
    admission: {
      mode: snapshot.admission?.mode ?? null,
      limit: snapshot.admission?.limit ?? null,
      waiting: (snapshot.admission?.waiting ?? []).length,
    },
    collector: {
      lastError: snapshot.collector?.lastError ?? null,
      failedRepos: snapshot.collector?.failedRepos ?? 0,
    },
    api: snapshot.api ? { remaining: snapshot.api.remaining ?? null, limit: snapshot.api.limit ?? null } : null,
  };
}

function compactRun(r, now) {
  return strip({
    id: r.id,
    repo: r.repo,
    workflow: r.workflowName ?? null,
    status: r.status ?? null,
    conclusion: r.conclusion ?? null,
    branch: r.branch ?? null,
    sha: r.sha ? String(r.sha).slice(0, 12) : null,
    prNumber: r.prNumber ?? null,
    event: r.event ?? null,
    title: r.displayTitle ? String(r.displayTitle).slice(0, 120) : null,
    url: r.url ?? null,
    startedAt: Date.parse(r.startedAt) || null,
    updatedAt: Date.parse(r.updatedAt) || null,
    elapsedMs: r.status === 'in_progress' && r.startedAt ? Math.max(0, now - Date.parse(r.startedAt)) : null,
    expectedMs: r.expectedDurationMs ?? null,
  });
}

function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// Nulls cost bytes on every tick and carry nothing a decoder cannot default.
function strip(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
