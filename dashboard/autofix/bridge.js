#!/usr/bin/env node
// The auto-remediation bridge.
//
// fleetd's alert engine already does the hard part: it fires on TRANSITIONS,
// so a condition opens once and closes once. That is what makes automated
// response viable at all — a rule evaluated every 15 seconds that acted on the
// level would remediate 240 times an hour for one dead runner.
//
//   fleetd alert  ──webhook──>  bridge  ──>  health.sh --repair
//                                       ──>  run.rerun (runner-lost failures)
//                                       ──>  fix.sh    (code/config failures)
//
// The webhook is treated as a DOORBELL, not as the message. Its payload carries
// only {severity,title,body,host,at} — no rule, no key — and a storm collapses
// sixteen alerts into one summary. So the bridge ignores the body entirely and
// re-reads /api/alerts, which is structured, current, and complete. That also
// makes the whole thing idempotent: every wake-up is a full reconcile against
// real state, so a missed webhook, a duplicate, or a daemon restart all
// converge to the same place instead of each needing their own handling.
//
// Three layers of action, each with a different blast radius:
//
//   1. Infrastructure repair (health.sh --repair): deterministic, reversible,
//      triggered by alert transitions. Unchanged from the original design.
//
//   2. Infra reruns (run.rerun): when a runner crashed under load and the run
//      failed with runner-lost, retrying is the right response. One attempt per
//      run/attempt triple, with a daily cap and storm guard.
//
//   3. AI fixes (fix.sh): for code or config failures, a cloud agent reads the
//      workflow and proposes a PR. Opt-in per repo (AUTOFIX_FIX_REPOS), much
//      tighter budgets, and never acts without an explicit allowlist.
//
// Zero dependencies, matching the rest of the dashboard. A remediation daemon
// that breaks unattended because a transitive dependency changed is strictly
// worse than no remediation daemon.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH = dirname(HERE);

// Escalation accepts either credential, so both are watched. The key file is an
// operator's deliberate choice and does not expire; the login is what you get
// without dashboard access and lapses after 90 days. Kept in sync with
// escalate.sh, which is the file that actually resolves them.
const CREDENTIALS = [
  join(DASH, '.cursor-api-key'),
  join(homedir(), '.cursor', 'sdk', 'auth.json'),
];

const hasCredential = () => CREDENTIALS.some((p) => existsSync(p));

// Newest mtime across both, used as "someone has attended to the credential".
function credentialTouchedAt() {
  let newest = 0;
  for (const p of CREDENTIALS) {
    try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* absent */ }
  }
  return newest;
}

const CONFIG = {
  port: Number(process.env.AUTOFIX_PORT ?? 7879),
  fleetUrl: process.env.FLEET_URL ?? 'http://127.0.0.1:7878',
  // Overridable so a test instance can be pointed at a scratch file. The
  // running daemon owns the default path, and two bridges writing it would
  // each be clobbering the other's attempt counters.
  statePath: process.env.AUTOFIX_STATE ?? join(HERE, 'state.json'),
  logDir: join(DASH, 'logs'),
  // A sweep is required, not a fallback. Every rule below refuses to act until
  // an alert has been open for a while, and the webhook only ever fires at the
  // instant it opened — so without a timer, an alert that becomes eligible two
  // minutes later would sit there forever waiting for a doorbell that already
  // rang.
  sweepMs: Number(process.env.AUTOFIX_SWEEP_MS ?? 60_000),
  cooldownMs: Number(process.env.AUTOFIX_COOLDOWN_MS ?? 900_000),
  // Past this many open alerts, act on nothing. Six alerts at once is a reboot,
  // a network partition or a full disk — a systemic event where the per-alert
  // fix is wrong by construction, and sixteen concurrent runner restarts turn a
  // recoverable morning into an outage. fleetd already reasons this way about
  // notifications; this is the same idea applied to actions.
  stormThreshold: Number(process.env.AUTOFIX_STORM ?? 6),
  dryRun: process.env.AUTOFIX_DRY_RUN === '1',
  // A hard ceiling on escalations per rolling 24h, independent of any per-rule
  // cooldown. The cooldowns bound how often one CONDITION is diagnosed; this
  // bounds what a bad week can cost in total. Escalation also disables itself
  // entirely if the key file is absent, so this stays at zero cost until a key
  // is installed.
  escalateDailyCap: Number(process.env.AUTOFIX_ESCALATE_CAP ?? 8),
  escalateTimeoutMs: Number(process.env.AUTOFIX_ESCALATE_TIMEOUT_MS ?? 420_000),
  // --- Infra reruns ---
  // Minimum time a run must have been completed (and classified) before we
  // rerun it. Five minutes ensures we don't race the fast loop's own detection
  // and that the failure class is final.
  rerunMinWaitMs: Number(process.env.AUTOFIX_RERUN_MIN_WAIT_MS ?? 5 * 60_000),
  // Per-run/attempt combination, reset never (the ledger key persists). One
  // auto-rerun per run attempt is the hard limit.
  rerunMaxAttempts: 1,
  // Per-scope cooldown so the same (repo, workflow) pair does not trigger
  // repeated reruns if it keeps runner-losing.
  rerunCooldownMs: Number(process.env.AUTOFIX_RERUN_COOLDOWN_MS ?? 3 * 3_600_000),
  // Daily cap, separate from the escalation cap.
  rerunDailyCap: Number(process.env.AUTOFIX_RERUN_DAILY_CAP ?? 20),
  // --- AI fixes ---
  // Comma-separated list of repos eligible for automated fix PRs. Empty means
  // AI fixes are disabled entirely (the safe default).
  fixRepos: (process.env.AUTOFIX_FIX_REPOS ?? '').split(',').filter(Boolean),
  fixMinWaitMs: Number(process.env.AUTOFIX_FIX_MIN_WAIT_MS ?? 5 * 60_000),
  // Per-condition cooldown: the scope strips the run/attempt id away so
  // repeated failures on the same workflow don't each spend a fix budget.
  fixCooldownMs: Number(process.env.AUTOFIX_FIX_COOLDOWN_MS ?? 24 * 3_600_000),
  // Daily cap across all repos.
  fixDailyCap: Number(process.env.AUTOFIX_FIX_DAILY_CAP ?? 3),
  fixTimeoutMs: Number(process.env.AUTOFIX_FIX_TIMEOUT_MS ?? 10 * 60_000),
};

// The only three rules with an automatic fix, and it is the same fix for all
// three because health.sh --repair is what an operator would run anyway.
// Anything not listed here is logged once and left to notify a human.
//
//   minOpenMs   how long the condition must persist before it counts as real
//   maxAttempts per alert key, reset when the alert closes
//
// The minOpenMs values are not guesses. Measured on this host, `offline` alerts
// closed on their own after 46s, 195s, 264s and 276s — four for four. Repairing
// the moment one opened would have been fighting a listener that was already
// recovering, every time, while looking like the thing that fixed it. Five
// minutes is longer than every self-resolution observed so far.
const ROUTES = {
  'launchd-dead':    { action: 'fleet.healthRepair', minOpenMs:  60_000, maxAttempts: 3 },
  'launchd-missing': { action: 'fleet.healthRepair', minOpenMs:  60_000, maxAttempts: 3 },
  'offline':         { action: 'fleet.healthRepair', minOpenMs: 300_000, maxAttempts: 2 },
};

// The other half of the same idea. These rules have no deterministic repair —
// the paragraph above says they are "left to notify a human instead", and that
// remains true, but the notification now arrives with the reading already done.
// escalate.sh spends money and reaches the network, so the budgets here are
// much tighter than the repair budgets above and every one of them is a cost
// control rather than a correctness control:
//
//   minOpenMs   don't pay to diagnose something that resolves on its own.
//               stuck-queue only fires after 5m queued and has been observed
//               clearing seconds later, so it waits longest.
//   cooldownMs  per SCOPE, not per alert key. newly-failing keys embed a run
//               id, so the same broken workflow produces a brand new key on
//               every push — keying the cooldown on that would diagnose the
//               identical failure twenty times before lunch.
//
// escalate.sh allows two more rules (orphan, no-listener) that are absent here
// on purpose: no-listener usually co-occurs with a launchd alert autofix is
// already repairing, so escalating it would pay to describe a fix in progress.
// Enabling one is a deliberate edit, not a config tweak.
const ESCALATE = {
  'newly-failing':  { minOpenMs: 120_000, cooldownMs:  6 * 3_600_000 },
  'stuck-queue':    { minOpenMs: 600_000, cooldownMs: 12 * 3_600_000 },
  'label-mismatch': { minOpenMs: 300_000, cooldownMs: 24 * 3_600_000 },
};

// Reserved prefix for bookkeeping that must outlive the alerts it describes.
// reconcile() deletes every state key whose alert has closed, which is right
// for attempt counters and fatal for a spend ledger: a newly-failing alert can
// close in under a minute, so a cooldown stored under its key would evaporate
// before it ever suppressed anything.
const LEDGER = '#escalations';
const RERUN_LEDGER = '#reruns';
const FIX_LEDGER = '#fixes';

// ---------------------------------------------------------------------------

mkdirSync(CONFIG.logDir, { recursive: true });

// Just stdout. The plist points StandardOutPath at the log file, so writing to
// it here as well put every line in twice.
function log(...parts) {
  console.log(`[${new Date().toISOString()}] ${parts.join(' ')}`);
}

function loadState() {
  try { return JSON.parse(readFileSync(CONFIG.statePath, 'utf8')); } catch { return {}; }
}

// Write to a pid-scoped temp file then rename into place so a crash mid-write
// never leaves a truncated state.json for the next reconcile to parse.
function saveState(state) {
  const body = JSON.stringify(state, null, 2) + '\n';
  const tmp = `${CONFIG.statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, CONFIG.statePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function fleetActionable(health) {
  return Boolean(health?.ok) && !health?.stale;
}

function recordFleetStale(state, health, now = Date.now()) {
  const prev = state.__fleetStale ?? {};
  state.__fleetStale = {
    since: prev.since ?? now,
    lastChecked: now,
    ok: health?.ok ?? false,
    stale: health?.stale ?? true,
    ageMs: health?.ageMs ?? null,
    lastError: health?.lastError ?? null,
  };
}

function clearFleetStale(state) {
  delete state.__fleetStale;
}

let state = loadState();

async function getAlerts() {
  const res = await fetch(`${CONFIG.fleetUrl}/api/alerts`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /api/alerts -> ${res.status}`);
  return res.json();
}

async function getRemediationCandidates() {
  const res = await fetch(
    `${CONFIG.fleetUrl}/api/remediation-candidates`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`GET /api/remediation-candidates -> ${res.status}`);
  return res.json();
}

async function getFleetHealth() {
  const res = await fetch(`${CONFIG.fleetUrl}/api/health`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /api/health -> ${res.status}`);
  return res.json();
}

// Every action goes through fleet-action.sh rather than being POSTed from here.
// That script exact-matches an allowlist and holds the control token, so the
// set of things this daemon can do stays one readable list in one file — and
// the token stays out of any process that talks to the network.
function runAction(action, args = {}) {
  return new Promise((resolve) => {
    execFile(join(HERE, 'fleet-action.sh'), [action, JSON.stringify(args)],
      { cwd: HERE, timeout: 330_000, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err?.code ?? 0, output: `${stdout ?? ''}${stderr ?? ''}`.trim() });
      });
  });
}

// fire-and-forget on purpose. fix.sh launches a cloud agent that can take many
// minutes. Awaiting it here would stall the reconcile loop just as escalate.sh
// would, and two fix agents running against the same repo simultaneously would
// each be spending budget without adding information.
let fixing = false;

function considerFix(candidate, now, openCount) {
  if (!CONFIG.fixRepos.length) return false;               // feature disabled
  if (!CONFIG.fixRepos.includes(candidate.repo)) return false;
  if (openCount >= CONFIG.stormThreshold) return false;    // systemic; per-run fix is wrong
  if (fixing) return false;                                // one at a time

  const ledger = state[FIX_LEDGER] ?? {};

  // Scope strips repo+workflow but not the run/attempt id, so the same broken
  // workflow does not get fixed on every push.
  const scope = `${candidate.repo}:${candidate.workflowName ?? candidate.runId}`;
  const last = ledger[scope]?.lastTs ?? 0;
  if (last && now - last < CONFIG.fixCooldownMs) return false;

  // Age check: wait a little before acting, for the same reasons as the
  // escalation minOpenMs — a failure that resolves on its own saves a fix spend.
  const completedAt = candidate.runStartedAt ? new Date(candidate.runStartedAt).getTime() : 0;
  if (completedAt && now - completedAt < CONFIG.fixMinWaitMs) return false;

  const dayAgo = now - 86_400_000;
  const recentFixes = Object.values(ledger).filter((e) => (e?.lastTs ?? 0) > dayAgo).length;
  if (recentFixes >= CONFIG.fixDailyCap) {
    if (!ledger.__capped || ledger.__capped < dayAgo) {
      log(`fix: daily cap reached (${recentFixes}/${CONFIG.fixDailyCap}) — not fixing ${scope}`);
      ledger.__capped = now;
      state[FIX_LEDGER] = ledger;
      saveState(state);
    }
    return false;
  }

  // Record before spawning for the same reason as the repair path.
  ledger[scope] = { lastTs: now, repo: candidate.repo, count: (ledger[scope]?.count ?? 0) + 1 };
  delete ledger.__capped;
  state[FIX_LEDGER] = ledger;
  saveState(state);

  if (CONFIG.dryRun) {
    log(`DRY-RUN would fix ${scope} (${candidate.strategy}) run ${candidate.runId}`);
    return true;
  }

  fixing = true;
  log(`fix: '${candidate.strategy}' -> cloud agent for ${scope} (run ${candidate.runId})`);
  execFile(join(HERE, 'fix.sh'),
    [JSON.stringify({
      repo: candidate.repo,
      runId: candidate.runId,
      runAttempt: candidate.runAttempt,
      workflowName: candidate.workflowName,
      workflowPath: candidate.workflowPath,
      event: candidate.event,
      branch: candidate.branch,
      sha: candidate.sha,
      prNumber: candidate.prNumber,
      defaultBranch: candidate.defaultBranch,
      url: candidate.url,
      jobs: candidate.jobs,
    })],
    { cwd: HERE, timeout: CONFIG.fixTimeoutMs, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => {
      fixing = false;
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim().replace(/\s+/g, ' ');
      const l = state[FIX_LEDGER] ?? {};

      if (err?.code === 69) {
        log(`fix: disabled (${out.slice(0, 160)})`);
      } else if (err?.code === 1) {
        // Startup failure (auth, config, network).
        l.__startupFailures = (l.__startupFailures ?? 0) + 1;
        log(`fix: could not start (${l.__startupFailures}/3) — ${out.slice(0, 300)}`);
        if (l.__startupFailures >= 3) {
          l.__disabled = Date.now();
          log('fix: DISABLED after 3 consecutive startup failures. Run '
            + './autofix/fix.sh --verify to diagnose, then --login (or rewrite the key file) '
            + 'to re-enable.');
        }
        state[FIX_LEDGER] = l;
        saveState(state);
      } else if (err) {
        log(`fix: FAILED (${err.code ?? '?'}) — ${out.slice(0, 400)}`);
      } else {
        if (l.__startupFailures) { delete l.__startupFailures; state[FIX_LEDGER] = l; saveState(state); }
        log(`fix: done — ${out.slice(0, 400)}`);
      }
    });
  return true;
}

// The condition, not the instance. See the ESCALATE comment: a newly-failing
// key is `newfail:<repo>:<workflow>:<run id>`, and the run id is what makes
// every recurrence look like a new problem.
function scopeOf(alert) {
  return alert.key.startsWith('newfail:')
    ? alert.key.split(':').slice(0, 3).join(':')
    : alert.key;
}

let escalating = false;

// Fire-and-forget on purpose. reconcile() walks alerts sequentially, and an
// escalation can take minutes — awaiting it here would stall the loop and delay
// the deterministic repair of a dead runner further down the same list. The
// concurrency guard is a flag rather than a queue because two agents reading
// the same fleet at once is spend without information.
function considerEscalation(alert, now, openCount) {
  const rule = ESCALATE[alert.rule];
  if (!rule) return false;
  if (openCount >= CONFIG.stormThreshold) return false;   // systemic; per-alert diagnosis is wrong
  if (now - alert.opened_at < rule.minOpenMs) return false;
  if (escalating) return false;

  const ledger = state[LEDGER] ?? {};

  // The circuit breaker, and the reason it exists is written in the README: the
  // previous attempt at this spawned `claude -p`, its headless auth resolved to
  // the wrong credential, and it returned "Credit balance is too low" for six
  // real alerts across four days without ever producing a diagnosis. The design
  // was fine; nothing noticed that it had stopped working.
  //
  // So a credential that cannot start a run is treated as a fault in its own
  // right. Three consecutive startup failures disables escalation rather than
  // retrying forever, and only touching the key file re-enables it — which is
  // exactly the action that fixes the underlying problem.
  if (ledger.__disabled) {
    if (credentialTouchedAt() > ledger.__disabled) {
      delete ledger.__disabled;
      delete ledger.__startupFailures;
      state[LEDGER] = ledger;
      saveState(state);
      log('escalation re-enabled: credential changed since it was disabled');
    } else {
      return false;
    }
  }

  const scope = scopeOf(alert);

  const last = ledger[scope]?.lastTs ?? 0;
  if (last && now - last < rule.cooldownMs) return false;

  const dayAgo = now - 86_400_000;
  const recent = Object.values(ledger).filter((e) => (e?.lastTs ?? 0) > dayAgo).length;
  if (recent >= CONFIG.escalateDailyCap) {
    if (!ledger.__capped || ledger.__capped < dayAgo) {
      log(`escalation cap reached (${recent}/${CONFIG.escalateDailyCap} in 24h) — not escalating ${scope}`);
      ledger.__capped = now;
      state[LEDGER] = ledger;
      saveState(state);
    }
    return false;
  }

  // Recorded before the spawn, for the same reason the repair path does it: if
  // this process dies mid-run the attempt must still count, or a crash loop
  // escalates the same alert on every restart.
  ledger[scope] = { lastTs: now, rule: alert.rule, count: (ledger[scope]?.count ?? 0) + 1 };
  delete ledger.__capped;
  state[LEDGER] = ledger;
  saveState(state);

  if (CONFIG.dryRun) {
    log(`DRY-RUN would escalate ${scope} ('${alert.rule}')`);
    return true;
  }

  escalating = true;
  log(`escalate: '${alert.rule}' -> agent for ${scope}`);
  execFile(join(HERE, 'escalate.sh'),
    [JSON.stringify({
      rule: alert.rule, key: alert.key, title: alert.title,
      body: alert.body, severity: alert.severity, opened_at: alert.opened_at,
    })],
    { cwd: HERE, timeout: CONFIG.escalateTimeoutMs, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => {
      escalating = false;
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim().replace(/\s+/g, ' ');
      const l = state[LEDGER] ?? {};

      // 69 is "no key installed" — expected and quiet until someone opts in.
      if (err?.code === 69) {
        log(`escalate: disabled (${out.slice(0, 160)})`);
      } else if (err?.code === 1) {
        // The run never started: auth, config or network. This is the failure
        // mode that went unnoticed last time, so it is counted, not just logged.
        l.__startupFailures = (l.__startupFailures ?? 0) + 1;
        log(`escalate: could not start (${l.__startupFailures}/3) — ${out.slice(0, 300)}`);
        if (l.__startupFailures >= 3) {
          l.__disabled = Date.now();
          log('escalate: DISABLED after 3 consecutive startup failures. The credential '
            + 'is not working — it may simply have expired. Run '
            + './autofix/escalate.sh --verify, then --login (or rewrite the key file) '
            + 'to re-enable.');
        }
        state[LEDGER] = l;
        saveState(state);
      } else if (err) {
        log(`escalate: FAILED (${err.code ?? '?'}) — ${out.slice(0, 400)}`);
      } else {
        if (l.__startupFailures) { delete l.__startupFailures; state[LEDGER] = l; saveState(state); }
        log(`escalate: done — ${out.slice(0, 400)}`);
      }
    });
  return true;
}

// ---------------------------------------------------------------------------

async function consider(alert, now, openCount) {
  const route = ROUTES[alert.rule];
  const st = state[alert.key] ?? { attempts: 0, lastTs: 0 };

  // No mechanical fix. Try to at least explain it, then fall back to the
  // notification fleetd already sent. Logged once either way, so the bridge's
  // own log always says why it did what it did.
  if (!route) {
    const sent = considerEscalation(alert, now, openCount);
    if (!st.noted) {
      log(sent
        ? `no automatic fix for '${alert.rule}' — escalated for diagnosis: ${alert.title}`
        : `no automatic fix for '${alert.rule}' — notified only: ${alert.title}`);
      state[alert.key] = { ...st, rule: alert.rule, noted: true };
      saveState(state);
    }
    return;
  }

  const age = now - alert.opened_at;
  if (age < route.minOpenMs) return;             // not yet real; the sweep will return
  if (st.attempts >= route.maxAttempts) {
    if (!st.exhausted) {
      log(`giving up on ${alert.key} after ${st.attempts} attempt(s) — needs a human`);
      state[alert.key] = { ...st, exhausted: true };
      saveState(state);
    }
    return;
  }
  if (st.lastTs && now - st.lastTs < CONFIG.cooldownMs) return;

  if (openCount >= CONFIG.stormThreshold) {
    if (!st.stormed) {
      log(`storm: ${openCount} alerts open (>= ${CONFIG.stormThreshold}) — not acting on ${alert.key}`);
      state[alert.key] = { ...st, stormed: true };
      saveState(state);
    }
    return;
  }

  if (CONFIG.dryRun) {
    log(`DRY-RUN would run ${route.action} for ${alert.key}`);
    return;
  }

  // Recorded BEFORE the work, not after. If the process dies mid-remediation,
  // the attempt must still count — otherwise a restart loop survives every
  // crash and retries forever.
  state[alert.key] = { ...st, attempts: st.attempts + 1, lastTs: now, rule: alert.rule, stormed: false };
  saveState(state);

  log(`repair: ${route.action} for ${alert.key}`);
  const result = await runAction(route.action);
  log(`repair: ${route.action} ${result.ok ? 'ok' : `FAILED (${result.code})`} — ${result.output.slice(0, 300)}`);

  state[alert.key] = { ...state[alert.key], lastOk: result.ok, lastOutput: result.output.slice(0, 400) };
  saveState(state);
}

// Consider a rerun for an infra-failure candidate. Unlike the alert repair
// path, the ledger key is stable for the lifetime of the run/attempt
// combination — it is never deleted when the run's alert closes, so a restart
// cannot cause a second rerun for the same failure.
async function considerRerun(candidate, now, openCount) {
  if (openCount >= CONFIG.stormThreshold) return; // systemic; per-run rerun is wrong

  const ledger = state[RERUN_LEDGER] ?? {};
  const key = `${candidate.repo}:${candidate.runId}:${candidate.runAttempt}`;
  const entry = ledger[key] ?? { attempts: 0 };

  if (entry.attempts >= CONFIG.rerunMaxAttempts) return; // hard limit: one auto-rerun ever

  // Age-gate: wait for backfill to classify all jobs and for the failure to
  // be confirmed rather than transient. The run_started_at is the closest
  // proxy available without a separate completed_at fetch.
  const startedAt = candidate.runStartedAt ? new Date(candidate.runStartedAt).getTime() : 0;
  if (startedAt && now - startedAt < CONFIG.rerunMinWaitMs) return;

  // Per-scope cooldown: the same repo/workflow pair should not trigger repeated
  // reruns. Key on (repo, workflowName) rather than (repo, runId) so a workflow
  // that keeps runner-losing doesn't consume the daily cap one run at a time.
  const scope = `${candidate.repo}:${candidate.workflowName ?? 'unknown'}`;
  const scopeEntry = ledger[`scope:${scope}`] ?? {};
  if (scopeEntry.lastTs && now - scopeEntry.lastTs < CONFIG.rerunCooldownMs) return;

  // Daily cap across all repos.
  const dayAgo = now - 86_400_000;
  const todayCount = Object.entries(ledger).filter(([k, e]) => !k.startsWith('scope:') && !k.startsWith('__') && (e?.lastTs ?? 0) > dayAgo).length;
  if (todayCount >= CONFIG.rerunDailyCap) {
    if (!ledger.__capLogged || ledger.__capLogged < dayAgo) {
      log(`rerun: daily cap reached (${todayCount}/${CONFIG.rerunDailyCap}) — skipping ${key}`);
      ledger.__capLogged = now;
      state[RERUN_LEDGER] = ledger;
      saveState(state);
    }
    return;
  }

  if (CONFIG.dryRun) {
    log(`DRY-RUN would rerun ${key} (runner-lost, failedOnly)`);
    return;
  }

  // Record before acting.
  ledger[key] = { attempts: 1, lastTs: now, repo: candidate.repo };
  ledger[`scope:${scope}`] = { lastTs: now };
  delete ledger.__capLogged;
  state[RERUN_LEDGER] = ledger;
  saveState(state);

  log(`rerun: run.rerun for ${key} (runner-lost on all failed jobs, failedOnly=true)`);
  const result = await runAction('run.rerun', {
    repo: candidate.repo,
    runId: candidate.runId,
    failedOnly: true,
  });
  log(`rerun: run.rerun ${result.ok ? 'ok' : `FAILED (${result.code})`} — ${result.output.slice(0, 300)}`);

  ledger[key] = { ...ledger[key], lastOk: result.ok, lastOutput: result.output.slice(0, 400) };
  state[RERUN_LEDGER] = ledger;
  saveState(state);
}

// ---------------------------------------------------------------------------

let reconciling = false;
let pending = false;

async function reconcile(reason) {
  if (reconciling) { pending = true; return; }   // one at a time; coalesce the rest
  reconciling = true;
  try {
    const now = Date.now();
    let health;
    try {
      health = await getFleetHealth();
    } catch (err) {
      health = { ok: false, stale: true, lastError: err.message };
    }

    const wasStale = Boolean(state.__fleetStale);
    const actionable = fleetActionable(health);
    if (!actionable) {
      recordFleetStale(state, health, now);
      saveState(state);
      log(`reconcile (${reason}): fleet stale — skipping repair/rerun/escalate/fix`
        + (health.lastError ? ` (${health.lastError})` : ''));
      return;
    }
    clearFleetStale(state);
    if (wasStale) saveState(state);

    // Both fetches are independent; a failure in one must not suppress the other.
    const [alertsRes, candidatesRes] = await Promise.allSettled([
      getAlerts(),
      getRemediationCandidates(),
    ]);

    const { open = [] } = alertsRes.status === 'fulfilled' ? alertsRes.value : {};
    const candidates = candidatesRes.status === 'fulfilled' ? candidatesRes.value : [];

    if (alertsRes.status === 'rejected') log(`reconcile: alerts fetch failed — ${alertsRes.reason?.message}`);
    if (candidatesRes.status === 'rejected') log(`reconcile: candidates fetch failed — ${candidatesRes.reason?.message}`);

    const openKeys = new Set(open.map((a) => a.key));

    // Forget anything that closed. A condition that recurs later is a new
    // problem and deserves a fresh attempt budget — carrying the old count
    // forward means the second genuine outage of the week is never acted on.
    let dropped = 0;
    for (const key of Object.keys(state)) {
      if (key.startsWith('#')) continue;             // bookkeeping, not an alert
      if (!openKeys.has(key)) { delete state[key]; dropped++; }
    }

    // The escalation ledger is pruned by age instead, since its whole purpose is
    // to remember conditions whose alerts have already closed. A week is well
    // past the longest cooldown, so nothing still in force is ever discarded.
    for (const ledgerKey of [LEDGER, RERUN_LEDGER, FIX_LEDGER]) {
      const ledger = state[ledgerKey];
      if (!ledger) continue;
      const cutoff = Date.now() - 7 * 86_400_000;
      for (const [scope, entry] of Object.entries(ledger)) {
        if (scope.startsWith('__')) continue;
        if (scope.startsWith('scope:')) {
          // Scope-level cooldown entries: prune when older than the cooldown.
          if ((entry?.lastTs ?? 0) < cutoff) { delete ledger[scope]; dropped++; }
          continue;
        }
        if ((entry?.lastTs ?? 0) < cutoff) { delete ledger[scope]; dropped++; }
      }
    }
    if (dropped) saveState(state);

    // Dismissed conditions are ones the operator has waved away, so they do not
    // make an event systemic. They are still repaired — the loop below walks
    // every open alert, dismissed or not — and they keep their attempt budgets,
    // because `openKeys` above is built from all of them. What they no longer do
    // is push this bridge over its storm threshold and so disable remediation
    // for everything else. Four dormant runners sit at 4 of 6 permanently; two
    // real failures would then have stopped all autofix.
    const openCount = open.filter((a) => !a.dismissed_at).length;
    const dismissed = open.length - openCount;

    log(`reconcile (${reason}): ${open.length} alert(s)`
      + (dismissed ? ` (${dismissed} dismissed)` : '')
      + `, ${candidates.length} candidate(s), ${dropped} cleared`);

    // Alert path: sequential on purpose — health.sh --repair walks the whole
    // fleet, so two of them racing would each be reading state the other is
    // changing.
    for (const alert of open) await consider(alert, now, openCount);

    // Candidate path: reruns are awaited (fast, just a GitHub API call).
    // Fix invocations are fire-and-forget (can take minutes).
    for (const candidate of candidates) {
      if (candidate.strategy === 'infra-rerun') {
        await considerRerun(candidate, now, openCount);
      } else if (candidate.strategy === 'ai-fix') {
        considerFix(candidate, now, openCount);
      }
    }
  } catch (e) {
    log(`reconcile failed: ${e.message}`);
  } finally {
    reconciling = false;
    if (pending) { pending = false; setImmediate(() => reconcile('coalesced')); }
  }
}

// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/alert') {
    // The body is drained and discarded. /api/alerts is the source of truth,
    // and parsing a payload here would mean trusting a POST that anything on
    // loopback can make.
    req.resume();
    req.on('end', () => {
      res.writeHead(204).end();
      reconcile('webhook');
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const dayAgo = Date.now() - 86_400_000;
    const ledger = state[LEDGER] ?? {};
    const rerunLedger = state[RERUN_LEDGER] ?? {};
    const fixLedger = state[FIX_LEDGER] ?? {};
    res.end(JSON.stringify({
      ok: true,
      dryRun: CONFIG.dryRun,
      fleet: state.__fleetStale ? {
        actionable: false,
        stale: true,
        since: new Date(state.__fleetStale.since).toISOString(),
        lastChecked: new Date(state.__fleetStale.lastChecked).toISOString(),
        ageMs: state.__fleetStale.ageMs,
        lastError: state.__fleetStale.lastError,
      } : { actionable: true, stale: false },
      tracked: state,
      routes: ROUTES,
      escalation: {
        rules: ESCALATE,
        enabled: hasCredential() && !ledger.__disabled,
        running: escalating,
        // Surfaced because the last version of this failed silently for four
        // days. If escalation has given up, /status must say so out loud.
        disabledAt: ledger.__disabled ? new Date(ledger.__disabled).toISOString() : null,
        consecutiveStartupFailures: ledger.__startupFailures ?? 0,
        usedLast24h: Object.entries(ledger)
          .filter(([k, e]) => k !== '__capped' && !k.startsWith('__') && (e?.lastTs ?? 0) > dayAgo).length,
        dailyCap: CONFIG.escalateDailyCap,
      },
      reruns: {
        enabled: true,
        dailyCap: CONFIG.rerunDailyCap,
        usedLast24h: Object.entries(rerunLedger)
          .filter(([k, e]) => !k.startsWith('__') && !k.startsWith('scope:') && (e?.lastTs ?? 0) > dayAgo).length,
      },
      fixes: {
        enabled: CONFIG.fixRepos.length > 0 && hasCredential() && !fixLedger.__disabled,
        repos: CONFIG.fixRepos,
        running: fixing,
        disabledAt: fixLedger.__disabled ? new Date(fixLedger.__disabled).toISOString() : null,
        consecutiveStartupFailures: fixLedger.__startupFailures ?? 0,
        dailyCap: CONFIG.fixDailyCap,
        usedLast24h: Object.entries(fixLedger)
          .filter(([k, e]) => !k.startsWith('__') && (e?.lastTs ?? 0) > dayAgo).length,
      },
    }, null, 2));
    return;
  }
  res.writeHead(404).end();
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

function replaceState(next) {
  state = { ...(next ?? {}) };
  return state;
}

export {
  CONFIG,
  fleetActionable,
  recordFleetStale,
  clearFleetStale,
  saveState,
  loadState,
  replaceState,
  reconcile,
};

if (isMain) {
  server.listen(CONFIG.port, '127.0.0.1', () => {
    log(`autofix bridge on 127.0.0.1:${CONFIG.port} -> ${CONFIG.fleetUrl}${CONFIG.dryRun ? ' [DRY RUN]' : ''}`);
    reconcile('startup');
    setInterval(() => reconcile('sweep'), CONFIG.sweepMs);
  });
}
