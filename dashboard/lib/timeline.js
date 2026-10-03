// History for the glance: what went wrong this week, in the ladder's terms.
//
// Alerts are already stored as intervals (opened_at, closed_at), which makes
// "how long was the disk floor holding jobs on Monday" a query rather than a
// guess. This maps each interval onto the rung of the verdict ladder it
// belongs to, adds the day's queue time against build time — on this fleet jobs
// have spent more hours waiting than running — and the few numbers a weekly
// digest needs.

const DAY = 24 * 60 * 60 * 1000;

/** Which ladder rung an alert rule belongs to. */
export function rungOf(rule, key = '') {
  switch (rule) {
    case 'launchd-dead': case 'launchd-missing': case 'offline': case 'no-listener':
      return 'dead-service';
    case 'stuck-queue':
      if (key.includes(':runner-down:')) return 'dead-service';
      if (/:(label-mismatch|unserved|role-unserved|github-hosted):/.test(key)) return 'config-drift';
      return 'waiting';
    case 'orphan': case 'label-mismatch':
      return 'config-drift';
    case 'disk-low': case 'disk-floor-soon':
      return 'disk-floor';
    case 'admission-hold':
      return key === 'admission:disk-floor' ? 'disk-floor' : 'waiting';
    case 'host-stale': case 'offline-host':
      return 'host-down';
    case 'swap-thrashing': case 'memory-pressure': case 'host-saturated':
      return 'saturated';
    case 'account-blocked': case 'account-blocked-recurring': case 'account-quota':
      return 'account-blocked';
    case 'collector-error': case 'api-rate-low':
      return 'unknown';
    case 'newly-failing':
      return 'failing';
    default:
      return 'other';
  }
}

function localMidnight(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function timeline(db, { days = 7, now = Date.now(), cores = null } = {}) {
  const since = now - days * DAY;
  const out = { days, generatedAt: now, incidents: [], today: null, week: null, flaky: [], samples: [] };

  try {
    out.incidents = db.prepare(`
      SELECT key, rule, severity, title, opened_at, closed_at FROM alerts
      WHERE (opened_at >= ? OR closed_at IS NULL OR closed_at >= ?) AND severity != 'info'
      ORDER BY opened_at`).all(since, since)
      .map((a) => ({
        key: a.key, rule: a.rule, severity: a.severity, title: a.title,
        openedAt: a.opened_at, closedAt: a.closed_at, rung: rungOf(a.rule, a.key),
      }));
  } catch { /* pre-migration */ }

  const midnight = localMidnight(now);
  try {
    const jobs = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(queued_ms), 0) AS queued, COALESCE(SUM(duration_ms), 0) AS built,
             SUM(CASE WHEN failure_class = 'runner-lost' THEN 1 ELSE 0 END) AS lost
      FROM jobs WHERE started_at >= ? AND runner_name IS NOT NULL`).get(new Date(midnight).toISOString());
    let held = 0;
    try {
      held = db.prepare(`SELECT COALESCE(SUM(waited_s), 0) AS s FROM admission_events
        WHERE event IN ('admitted', 'timeout') AND ts >= ?`).get(Math.floor(midnight / 1000)).s;
    } catch { /* no admission table */ }
    out.today = { since: midnight, jobs: jobs.n, queueMs: jobs.queued, buildMs: jobs.built, lostJobs: jobs.lost ?? 0, heldSeconds: held };
  } catch { /* pre-migration */ }

  try {
    const worst = db.prepare(`
      SELECT repo, SUM(queued_ms) AS queued, COUNT(*) AS n FROM jobs
      WHERE started_at >= ? AND runner_name IS NOT NULL GROUP BY repo ORDER BY queued DESC LIMIT 3`)
      .all(new Date(now - 7 * DAY).toISOString());
    const week = out.incidents.filter((i) => i.openedAt >= now - 7 * DAY && i.rung !== 'failing' && i.rung !== 'other');
    const closed = week.filter((i) => i.closedAt);
    out.week = {
      worstWait: worst.map((w) => ({ repo: w.repo, queueMs: w.queued, jobs: w.n })),
      incidents: week.length,
      byRung: week.reduce((m, i) => ({ ...m, [i.rung]: (m[i.rung] ?? 0) + 1 }), {}),
      mttrMs: closed.length ? Math.round(closed.reduce((s, i) => s + (i.closedAt - i.openedAt), 0) / closed.length) : null,
    };
  } catch { /* pre-migration */ }

  try {
    out.flaky = db.prepare(`
      SELECT runner_name AS runner, COUNT(*) AS lost FROM jobs
      WHERE failure_class = 'runner-lost' AND completed_at >= ? AND runner_name IS NOT NULL
      GROUP BY runner_name ORDER BY lost DESC LIMIT 8`).all(new Date(now - 7 * DAY).toISOString())
      .map((r) => ({ runner: r.runner, lost: r.lost }));
  } catch { /* pre-migration */ }

  // Two hours of host samples, at most 60 points, for sparklines.
  try {
    const rows = db.prepare(`SELECT ts, load1, swapins_per_sec, disk_free_gb, busy_runners FROM host_samples
      WHERE ts >= ? ORDER BY ts`).all(now - 2 * 60 * 60 * 1000);
    const step = Math.max(1, Math.ceil(rows.length / 60));
    out.samples = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => [
      r.ts,
      r.load1 != null && cores ? Math.round((r.load1 / cores) * 100) / 100 : r.load1,
      r.swapins_per_sec != null ? Math.round(r.swapins_per_sec) : null,
      r.disk_free_gb != null ? Math.round(r.disk_free_gb * 10) / 10 : null,
      r.busy_runners,
    ]);
  } catch { /* pre-migration */ }

  return out;
}
