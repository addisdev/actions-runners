// Alerts — being told, instead of watching.
//
// The rules mostly do not invent new conditions. Drift already computes the
// states where launchd and GitHub disagree, so the alert engine consumes that
// rather than reimplementing it; what it adds is the part drift has no opinion
// about: *when* a condition deserves to interrupt someone.
//
// Three things make that difference:
//
//   TRANSITIONS, NOT LEVELS. An alert fires when a condition opens and again
//   when it closes. A rule evaluated every 15 seconds that notified every time
//   it was true would send 240 notifications an hour for one dead runner, and
//   the second one would already be ignored.
//
//   SUSTAIN WINDOWS. Disk and swap cross their thresholds constantly during a
//   build and come straight back. A threshold alone measures the sample; a
//   threshold plus a duration measures the problem.
//
//   A STORM GUARD. If a host reboots, every runner is briefly down at once.
//   Sixteen notifications is not sixteen times as useful as one that says
//   sixteen.
//
// Deliberately absent: a load-average rule. Measured on this host, a single
// ordinary Xcode build drives load past 100 on 12 cores. Alerting on that would
// fire on healthy behaviour every day, which is how people learn to ignore
// alerts.

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { FAILURE_CLASSES } from './failures.js';

export const DEFAULTS = {
  diskWarnGb: 40,
  diskCriticalGb: 20,
  // Pages per second read back FROM swap, sustained. Not a swap level — see the
  // rule itself for why a level is not a condition.
  swapinWarnPerSec: 50,
  pressureSustainMs: 5 * 60 * 1000,
  // Sustain windows, in milliseconds. Both of these cross and re-cross during a
  // normal build; the duration is what separates a spike from a problem.
  swapSustainMs: 10 * 60 * 1000,
  diskSustainMs: 5 * 60 * 1000,
  stormThreshold: 5,
  // How long a runner must have run zero jobs before the unused-runner alert fires.
  unusedRunnerWindowMs: 7 * 24 * 60 * 60 * 1000,
  // Channels. macOS notifications are on by default because they cost nothing
  // and stay on the machine. The webhook is off and stays off until someone
  // fills it in — it sends fleet state to a third party, which is a decision
  // for the operator, not a default.
  macos: true,
  webhook: null, // { url, method?, headers?, template? }
};

export function loadConfig(path, log) {
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    log(`alert config loaded from ${path}`);
    return { ...DEFAULTS, ...raw };
  } catch (err) {
    log(`alert config at ${path} is unreadable (${err.message}) — using defaults`);
    return { ...DEFAULTS };
  }
}

// Drift severities that are worth waking someone for, and what to call them.
const DRIFT_ALERTS = {
  'launchd-missing': { severity: 'critical', title: 'Runner has no LaunchAgent' },
  'launchd-dead': { severity: 'critical', title: 'Runner service is dead' },
  offline: { severity: 'critical', title: 'Runner is offline' },
  orphan: { severity: 'warning', title: 'Orphan runner' },
  'label-mismatch': { severity: 'warning', title: 'Runner label mismatch' },
  'stuck-queue': { severity: 'warning', title: 'Run is stuck in the queue' },
  'no-listener': { severity: 'warning', title: 'Runner has no listener process' },
};

// One entry per queue cause, because the severity of a stuck job depends
// entirely on why it is stuck.
//
// The two criticals are the ones nothing will fix on its own: a repo with no
// runner and a runner that has stopped talking both mean work will sit there
// until a person intervenes. A capacity shortage is a warning because the
// autoscaler may well clear it without help, and a probable dispatch delay is
// informational because the usual outcome is that it resolves in seconds.
const QUEUE_CAUSE_ALERTS = {
  'telemetry-unavailable': { severity: 'info', title: 'Queue diagnosis unavailable' },
  unserved: { severity: 'critical', title: 'No runner exists for this repo' },
  'label-mismatch': { severity: 'critical', title: 'Job labels match no runner' },
  'runner-down': { severity: 'critical', title: 'Runner is down and work is queued' },
  'concurrency-block': { severity: 'warning', title: 'Work held by workflow concurrency' },
  'host-saturation': { severity: 'warning', title: 'Host is saturated and work is queued' },
  'repo-capacity': { severity: 'warning', title: 'Every runner for this repo is busy' },
  'github-delay': { severity: 'info', title: 'Probable GitHub dispatch delay' },
};

export class Alerts {
  constructor({ db, config, log, warn }) {
    this.db = db;
    this.config = config;
    this.log = log;
    this.warn = warn;
    this.open = new Map(); // key -> alert
    this.pending = new Map(); // key -> first time the condition was seen
    this.ticks = 0;

    this.insert = db.prepare(`
      INSERT INTO alerts (key, rule, severity, title, body, opened_at, closed_at, notified)
      VALUES (?,?,?,?,?,?,?,?)`);
    this.close = db.prepare('UPDATE alerts SET closed_at = ? WHERE key = ? AND closed_at IS NULL');
    this.causeRows = db.prepare(`
      SELECT failure_class, COUNT(*) AS n FROM jobs
      WHERE run_id = ? AND conclusion = 'failure' AND failure_class IS NOT NULL
      GROUP BY failure_class ORDER BY n DESC`);

    // Anything left open from a previous process is reloaded, so a restart does
    // not re-announce every condition that was already known.
    for (const row of db.prepare('SELECT * FROM alerts WHERE closed_at IS NULL').all()) {
      this.open.set(row.key, row);
    }
    if (this.open.size) log(`alerts: ${this.open.size} still open from a previous run`);
  }

  // A condition that must hold for `windowMs` before it counts. Returns true
  // once it has held that long; resets the moment it stops being true.
  sustained(key, isTrue, windowMs, now) {
    if (!isTrue) {
      this.pending.delete(key);
      return false;
    }
    const since = this.pending.get(key);
    if (since == null) {
      this.pending.set(key, now);
      return false;
    }
    return now - since >= windowMs;
  }

  evaluate(snapshot, now = Date.now()) {
    const c = this.config;
    const found = new Map();
    const add = (key, rule, severity, title, body) => found.set(key, { key, rule, severity, title, body });

    for (const d of snapshot.drift ?? []) {
      const meta = DRIFT_ALERTS[d.kind];
      if (!meta) continue;

      // A stuck queue is not one condition, it is seven, and they do not all
      // deserve the same words or the same severity. Before the classifier every
      // one of them arrived as "Run is stuck in the queue", which told whoever
      // was woken up nothing about whether to add a runner, fix a label, or go
      // back to sleep.
      //
      // The cause is part of the KEY, deliberately. A run whose diagnosis changes
      // from a capacity shortage to a downed runner is new information and gets a
      // new alert, while the same diagnosis holding for an hour stays one open
      // interval rather than re-announcing itself every tick.
      if (d.kind === 'stuck-queue' && d.cause) {
        const spec = QUEUE_CAUSE_ALERTS[d.cause] ?? { severity: meta.severity, title: meta.title };
        // Low confidence means the evidence was circumstantial. Waking someone
        // for a guess is how a channel gets muted, so those stay informational
        // and are visible on the dashboard without being pushed anywhere.
        const severity = d.confidence === 'low' ? 'info' : spec.severity;
        add(`drift:stuck-queue:${d.cause}:${d.subject}`, 'stuck-queue', severity,
          `${spec.title}: ${d.subject}`,
          [
            d.detail,
            d.evidence?.length ? `\nEvidence:\n${d.evidence.map((e) => `  · ${e}`).join('\n')}` : null,
            d.hint ? `\n${d.hint}` : null,
            d.confidence ? `\n(${d.confidence} confidence)` : null,
          ].filter(Boolean).join(''));
        continue;
      }

      add(`drift:${d.kind}:${d.subject}`, d.kind, meta.severity, `${meta.title}: ${d.subject}`,
        `${d.detail}${d.hint ? `\n${d.hint}` : ''}`);
    }

    const host = snapshot.host ?? {};

    if (host.diskFreeGb != null) {
      const critical = host.diskFreeGb < c.diskCriticalGb;
      const warn = host.diskFreeGb < c.diskWarnGb;
      if (this.sustained('disk', warn, c.diskSustainMs, now)) {
        add('host:disk', 'disk-low', critical ? 'critical' : 'warning',
          `Disk low: ${Math.round(host.diskFreeGb)} GB free`,
          `Below the ${critical ? c.diskCriticalGb : c.diskWarnGb} GB threshold. ` +
            `Runner directories are ~7 GB each; Playwright browser caches can add several GB per runner. ` +
            `./cleanup.sh --apply prunes DerivedData, stale Playwright __dirlock files, and old _diag.`);
      }
    }

    // Swap LEVEL is not a condition. macOS never reclaims swap space, so the
    // number only ever climbs and a level rule eventually fires forever on a
    // machine that is completely healthy — this host sat at 84% with 71% memory
    // free and zero swap I/O. What is worth waking someone for is the machine
    // actually paging: a sustained swap-IN rate means threads are stopped
    // waiting for memory, and the kernel's own pressure level says the same.
    const swapinRate = host.swapinsPerSec;
    if (swapinRate != null) {
      if (this.sustained('swapin', swapinRate >= c.swapinWarnPerSec, c.swapSustainMs, now)) {
        add('host:swapin', 'swap-thrashing', 'warning',
          `Paging in ${Math.round(swapinRate)} pages/s, sustained`,
          `Sustained for over ${Math.round(c.swapSustainMs / 60000)} minutes. Threads are stopping to ` +
            'wait for memory. Concurrent heavy builds are the usual cause. ' +
            `(${Math.round((host.swapUsedMb ?? 0) / 1024)} GB is parked in swap, which on its own means nothing.)`);
      }
    }

    if (host.memPressure && host.memPressure !== 'normal') {
      if (this.sustained('mempressure', true, c.pressureSustainMs, now)) {
        add('host:pressure', 'memory-pressure', host.memPressure === 'critical' ? 'critical' : 'warning',
          `Kernel reports ${host.memPressure} memory pressure`,
          `${host.memFreePct ?? '?'}% of memory free. This is the signal macOS itself broadcasts to ` +
            'applications, and it is the one that precedes processes being killed.');
      }
    } else {
      this.sustained('mempressure', false, c.pressureSustainMs, now);
    }

    // The collector losing its GitHub connection is itself an outage: every
    // other rule here goes quiet at the same time, so silence would otherwise
    // read as "all clear".
    const err = snapshot.collector?.lastError;
    if (this.sustained('collector', Boolean(err), 5 * 60 * 1000, now)) {
      add('collector:error', 'collector-error', 'warning',
        'Collector cannot reach GitHub',
        String(err).slice(0, 300));
    }

    // Sustained low API rate headroom. GitHub's REST rate limit is 5,000/hr for
    // a PAT and 1,000/hr for an OAuth app. Dropping below 10% for 10 minutes
    // means the collector is burning budget faster than it can recover, and the
    // next quiet spell will not restore it in time. Does not fire at all when
    // remaining is unknown — a missing header is not a low limit.
    const apiRemaining = snapshot.api?.remaining;
    const apiLimit = snapshot.api?.limit;
    if (apiRemaining != null && apiLimit != null && apiLimit > 0) {
      const fraction = apiRemaining / apiLimit;
      if (this.sustained('api-rate', fraction < 0.10, 10 * 60 * 1000, now)) {
        add('api:rate-low', 'api-rate-low', 'warning',
          `API rate limit low: ${apiRemaining}/${apiLimit} remaining`,
          'Under 10% of the hourly budget for 10+ minutes. The fast loop polls every repo every ' +
            `${Math.round((snapshot.collector?.fastMs ?? 15000) / 1000)}s; fewer repos or a longer ` +
            'cadence (FLEET_FAST_MS) would reduce consumption.');
      }
    }

    // Repeated account-blocked failures. A single block fires the "newly-failing"
    // alert. This separate rule fires when the same condition keeps blocking jobs
    // across MULTIPLE repos within 24 hours — a pattern that means the block is
    // account-wide and still active, not a one-off that self-resolved.
    const recentBlockedCount = (() => {
      try {
        return this.db.prepare(`
          SELECT COUNT(DISTINCT repo) AS n FROM jobs
          WHERE failure_class = 'account-blocked'
            AND started_at >= ? AND id > 0`)
          .get(new Date(now - 24 * 60 * 60 * 1000).toISOString())?.n ?? 0;
      } catch { return 0; }
    })();
    if (recentBlockedCount >= 2) {
      add('account:blocked', 'account-blocked-recurring', 'critical',
        `Account blocked on ${recentBlockedCount} repos in the last 24h`,
        'Actions is refusing to start jobs across multiple repos — this is a billing or spending-limit block. ' +
          'Nothing on this machine is wrong; go to github.com/settings/billing.');
    } else {
      this.sustained('account-blocked', false, 0, now);
    }

    // Registered runners unused for an extended period. A runner that has never
    // run a job in the configured window is consuming a slot while doing nothing.
    // The window is long by default (7 days) to avoid alerting on a runner added
    // just before a repo goes quiet over a weekend.
    try {
      const unusedWindowMs = c.unusedRunnerWindowMs ?? 7 * 24 * 60 * 60 * 1000;
      const unusedSince = new Date(now - unusedWindowMs).toISOString();
      const unusedRunners = this.db.prepare(`
        SELECT name FROM runner_state
        WHERE gh_status = 'online' AND name NOT IN (
          SELECT DISTINCT runner_name FROM jobs
          WHERE runner_name IS NOT NULL AND started_at >= ?
        )`).all(unusedSince);
      for (const r of unusedRunners) {
        const key = `runner:unused:${r.name}`;
        if (this.sustained(key, true, unusedWindowMs * 0.1, now)) {
          add(key, 'runner-unused', 'warning',
            `Runner idle for over ${Math.round(unusedWindowMs / 86400000)} days: ${r.name}`,
            'This runner is registered and online but has not run a job in the window. ' +
              'Check that the workflow runs-on: label matches, or remove the runner if the repo is inactive.');
        }
      }
      // Clear sustain timers for runners that have since run a job.
      for (const key of [...this.pending.keys()]) {
        if (!key.startsWith('runner:unused:')) continue;
        const name = key.slice('runner:unused:'.length);
        if (!unusedRunners.some((r) => r.name === name)) this.pending.delete(key);
      }
    } catch { /* pre-migration db — skip silently */ }

    // Newly-failing workflows go through the SAME reconcile as everything else.
    // They used to be inserted straight into `open`, which meant the next tick
    // found them missing from `found` and closed them, and the tick after that
    // reopened them — a notification each way, every 15 seconds, for one broken
    // deploy. Alert fatigue engineered by hand. Producing them as ordinary
    // findings makes open/close fall out of the same code path as the rest, and
    // the condition closes exactly when a newer green run appears.
    for (const f of this.newlyFailing(now)) found.set(f.key, f);

    return this.reconcile(found, now);
  }

  // The cause worth putting in an alert title, or null.
  //
  // 'job-failed' returns null on purpose. "Started failing" already means a step
  // exited non-zero, so "· Job failed" is a title that says the same thing
  // twice, and a title that adds nothing trains people to stop reading them.
  // Only causes that send the reader somewhere other than the diff qualify.
  //
  // Returns null when nothing is classified yet — the backfill may not have
  // reached this run — so the alert falls back to its original wording rather
  // than claiming an unknown cause.
  causeOf(runId) {
    let rows;
    try {
      rows = this.causeRows.all(runId);
    } catch {
      return null; // pre-migration database; not worth failing an alert over
    }
    const top = rows.find((r) => r.failure_class !== 'job-failed' && r.failure_class !== 'unknown');
    if (!top) return null;
    return FAILURE_CLASSES[top.failure_class] ?? null;
  }

  // Newly-failing workflows come from the database rather than the snapshot: it
  // needs the run *before* this one, which the live snapshot does not carry.
  // Only a green-to-red edge counts — a workflow that is already red does not
  // re-alert on every subsequent failure.
  newlyFailing(now = Date.now()) {
    const rows = this.db.prepare(`
      SELECT repo, workflow_name, conclusion, head_branch, run_started_at, html_url, id
      FROM runs
      WHERE status = 'completed' AND conclusion IN ('success','failure','timed_out')
        AND run_started_at >= ?
      ORDER BY repo, workflow_name, run_started_at DESC`)
      .all(new Date(now - 7 * 86400000).toISOString());

    const seen = new Map();
    const out = [];
    for (const r of rows) {
      const key = `${r.repo}\u0000${r.workflow_name}`;
      const prior = seen.get(key);
      if (!prior) {
        seen.set(key, [r]);
      } else if (prior.length === 1) {
        prior.push(r);
        const [latest, previous] = prior;
        if (latest.conclusion !== 'success' && previous.conclusion === 'success') {
          // Say *why*, when it is known. "Started failing" sends someone to read
          // a diff; "Account blocked" sends them to the billing page. Measured on
          // this fleet, 55 job failures across 9 repos in eleven days were the
          // account's spending limit refusing to start the job — every one of
          // them would have alerted here as an ordinary regression.
          const cause = this.causeOf(latest.id);
          out.push({
            key: `newfail:${r.repo}:${r.workflow_name}:${latest.id}`,
            rule: 'newly-failing',
            severity: 'warning',
            title: cause
              ? `${r.repo.split('/').pop()} · ${r.workflow_name} — ${cause.label}`
              : `${r.repo.split('/').pop()} · ${r.workflow_name} started failing`,
            body: `${latest.conclusion} on ${latest.head_branch ?? '?'} — the previous run was green.`
              + (cause ? `\n${cause.hint}` : '')
              + `\n${latest.html_url ?? ''}`,
          });
        }
      }
    }
    return out;
  }

  reconcile(found, now) {
    const opened = [];
    const closed = [];

    for (const [key, a] of found) {
      if (this.open.has(key)) continue;
      this.insert.run(key, a.rule, a.severity, a.title, a.body, now, null, 0);
      this.open.set(key, { ...a, opened_at: now });
      opened.push(a);
    }

    for (const key of [...this.open.keys()]) {
      if (found.has(key)) continue;
      this.close.run(now, key);
      closed.push(this.open.get(key));
      this.open.delete(key);
    }

    return { opened, closed };
  }

  // A reboot puts every runner down at once. Sixteen notifications is not
  // sixteen times as useful as one that says sixteen.
  summarise(opened, closed) {
    const messages = [];
    if (opened.length >= this.config.stormThreshold) {
      const worst = opened.some((a) => a.severity === 'critical') ? 'critical' : 'warning';
      messages.push({
        severity: worst,
        title: `${opened.length} alerts opened`,
        body: opened.slice(0, 6).map((a) => `• ${a.title}`).join('\n') +
          (opened.length > 6 ? `\n…and ${opened.length - 6} more` : ''),
      });
    } else {
      messages.push(...opened);
    }
    if (closed.length >= this.config.stormThreshold) {
      messages.push({ severity: 'info', title: `${closed.length} alerts resolved`, body: '' });
    } else {
      messages.push(...closed.map((a) => ({ severity: 'info', title: `Resolved: ${a.title}`, body: '' })));
    }
    return messages;
  }

  async notify(messages) {
    for (const m of messages) {
      this.log(`ALERT [${m.severity}] ${m.title}`);
      if (this.config.macos) await this.notifyMacos(m).catch((e) => this.warn('macos notify:', e.message));
      if (this.config.webhook?.url) await this.notifyWebhook(m).catch((e) => this.warn('webhook:', e.message));
    }
    if (messages.length) {
      this.db.prepare('UPDATE alerts SET notified = 1 WHERE closed_at IS NULL AND notified = 0').run();
    }
  }

  // The title and body are passed as ARGUMENTS to the script, never interpolated
  // into it. AppleScript string concatenation with a repo name in it is a script
  // injection waiting for a branch called `" & (do shell script "…") & "`.
  notifyMacos({ title, body }) {
    const script =
      'on run argv\n' +
      '  display notification (item 1 of argv) with title "Fleet" subtitle (item 2 of argv)\n' +
      'end run';
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-e', script, (body || ' ').slice(0, 400), title.slice(0, 200)],
        { timeout: 15000 },
        (err) => (err ? reject(err) : resolve()));
    });
  }

  // Generic JSON POST. Whatever is configured — ntfy, Pushover, a Slack webhook —
  // receives the alert; nothing is sent anywhere unless a URL is configured.
  async notifyWebhook({ severity, title, body }) {
    const w = this.config.webhook;
    const payload = { severity, title, body, host: 'fleet', at: new Date().toISOString() };
    const res = await fetch(w.url, {
      method: w.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(w.headers ?? {}) },
      body: JSON.stringify(w.template ? renderTemplate(w.template, payload) : payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  }

  async run(snapshot) {
    this.ticks++;
    const now = Date.now();
    const { opened, closed } = this.evaluate(snapshot, now);
    const messages = this.summarise(opened, closed);
    if (messages.length) await this.notify(messages);
    return { opened: opened.length, closed: closed.length };
  }

  snapshot() {
    return {
      open: [...this.open.values()].sort((a, b) => {
        const order = { critical: 0, warning: 1, info: 2 };
        return (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || b.opened_at - a.opened_at;
      }),
      channels: {
        macos: Boolean(this.config.macos),
        webhook: Boolean(this.config.webhook?.url),
      },
      recent: this.db.prepare(
        'SELECT key, rule, severity, title, body, opened_at, closed_at FROM alerts ORDER BY opened_at DESC LIMIT 40'
      ).all(),
    };
  }
}

function renderTemplate(template, payload) {
  const out = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = typeof v === 'string'
      ? v.replace(/\{(\w+)\}/g, (_, name) => String(payload[name] ?? ''))
      : v;
  }
  return out;
}
