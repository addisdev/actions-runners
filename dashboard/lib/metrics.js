// Prometheus text-format exporter for the fleet snapshot.
//
// fleetd will wire GET /metrics to this later; the module is deliberately
// standalone so it can be unit-tested without starting the daemon.
import { busyCount } from './capacity.js';
import { CAUSES } from './queue-cause.js';

const CAUSE_VALUES = Object.values(CAUSES);

/** Escape a label value for Prometheus exposition format. */
export function escapeLabel(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/** Format one floating-point sample; integers are written without a decimal. */
export function formatSample(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

function metricLine(name, value, labels = null) {
  if (labels && Object.keys(labels).length) {
    const body = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(',');
    return `${name}{${body}} ${formatSample(value)}`;
  }
  return `${name} ${formatSample(value)}`;
}

function help(name, text) {
  return `# HELP ${name} ${text}`;
}

function type(name, kind) {
  return `# TYPE ${name} ${kind}`;
}

function block(name, kind, helpText, lines) {
  return [help(name, helpText), type(name, kind), ...lines].join('\n');
}

function sumSizingDeficit(sizing = []) {
  let total = 0;
  for (const row of sizing) {
    const delta = Number(row?.delta);
    if (Number.isFinite(delta) && delta > 0) total += delta;
  }
  return total;
}

function queueByCause(queue = []) {
  const byCause = new Map();
  for (const q of queue) {
    const cause = q?.cause ?? 'unknown';
    const ageSec = Math.max(0, Number(q?.queuedSinceMs ?? 0) / 1000);
    const row = byCause.get(cause) ?? { count: 0, worstAgeSec: 0 };
    row.count += 1;
    if (ageSec > row.worstAgeSec) row.worstAgeSec = ageSec;
    byCause.set(cause, row);
  }
  return byCause;
}

/**
 * Render fleet snapshot metrics in Prometheus text exposition format.
 *
 * @param {object} snapshot - fleetd snapshot object
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()] - evaluation time for collector age
 * @param {number} [opts.collectorStaleMs=240000] - staleness threshold
 * @param {number|null} [opts.hostCount] - federation host total (defaults to 1)
 * @param {number|null} [opts.hostStaleCount] - stale federation hosts
 * @returns {string}
 */
export function renderPrometheusMetrics(snapshot, opts = {}) {
  const now = opts.now ?? Date.now();
  const collectorStaleMs = opts.collectorStaleMs ?? 240000;
  const ts = Number(snapshot?.ts ?? 0);
  const ageSec = ts > 0 ? Math.max(0, (now - ts) / 1000) : 0;
  const stale = snapshot?.starting ? 1 : (ts > 0 && now - ts > collectorStaleMs ? 1 : 0);

  const runners = snapshot?.fleetRunners ?? snapshot?.runners ?? [];
  const capacity = snapshot?.capacity ?? {};
  const fleetCapacity = snapshot?.fleetCapacity ?? capacity;
  const admission = snapshot?.admission ?? {};
  const autoscale = snapshot?.autoscale ?? {};
  const queue = snapshot?.queue ?? [];

  const runnerTotal = runners.length;
  const runnerBusy = busyCount(runners);
  const maxTotal = Number(capacity.maxTotalRunners ?? 0);
  const headroomRunners = maxTotal > 0 ? Math.max(0, maxTotal - runnerTotal) : 0;

  const deficit = Number.isFinite(Number(autoscale.deficit))
    ? Math.max(0, Number(autoscale.deficit))
    : sumSizingDeficit(snapshot?.sizing ?? []);

  const mode = autoscale.mode ?? 'none';
  const hostCount = opts.hostCount ?? 1;
  const hostStaleCount = opts.hostStaleCount ?? 0;

  const sections = [];

  sections.push(block(
    'fleet_collector_age_seconds',
    'gauge',
    'Age of the current fleet snapshot in seconds.',
    [metricLine('fleet_collector_age_seconds', ageSec)]
  ));

  sections.push(block(
    'fleet_collector_stale',
    'gauge',
    'Whether the snapshot is stale (1) or fresh (0).',
    [metricLine('fleet_collector_stale', stale)]
  ));

  sections.push(block(
    'fleetd_is_leader',
    'gauge',
    'Whether this fleetd replica currently owns the control-plane leader lock.',
    [metricLine('fleetd_is_leader', snapshot?.control?.role === 'standby' ? 0 : 1,
      { replica: snapshot?.control?.replicaId ?? 'single' })]
  ));

  const queueCounts = [];
  const queueWorst = [];
  const seenCauses = queueByCause(queue);
  for (const cause of CAUSE_VALUES) {
    const row = seenCauses.get(cause);
    queueCounts.push(metricLine('fleet_queue_runs', row?.count ?? 0, { cause }));
    queueWorst.push(metricLine('fleet_queue_worst_age_seconds', row?.worstAgeSec ?? 0, { cause }));
  }
  for (const [cause, row] of seenCauses) {
    if (CAUSE_VALUES.includes(cause)) continue;
    queueCounts.push(metricLine('fleet_queue_runs', row.count, { cause }));
    queueWorst.push(metricLine('fleet_queue_worst_age_seconds', row.worstAgeSec, { cause }));
  }

  sections.push(block(
    'fleet_queue_runs',
    'gauge',
    'Number of queued runs by diagnosed cause.',
    queueCounts
  ));

  sections.push(block(
    'fleet_queue_worst_age_seconds',
    'gauge',
    'Longest queue wait in seconds for each diagnosed cause.',
    queueWorst
  ));

  sections.push(block(
    'fleet_runners_total',
    'gauge',
    'Registered runners across all known fleet hosts.',
    [metricLine('fleet_runners_total', runnerTotal)]
  ));

  sections.push(block(
    'fleet_runners_busy',
    'gauge',
    'Runners currently executing a job.',
    [metricLine('fleet_runners_busy', runnerBusy)]
  ));

  sections.push(block(
    'fleet_admission_waiting',
    'gauge',
    'Jobs currently held by admission control.',
    [metricLine('fleet_admission_waiting', (admission.waiting ?? []).length)]
  ));

  sections.push(block(
    'fleet_capacity_ok',
    'gauge',
    'Local host headroom available (1) or refused (0).',
    [metricLine('fleet_capacity_ok', capacity.ok ? 1 : 0)]
  ));

  sections.push(block(
    'fleet_fleet_capacity_ok',
    'gauge',
    'Fleet-wide headroom available on any eligible host (1) or refused (0).',
    [metricLine('fleet_fleet_capacity_ok', fleetCapacity.ok ? 1 : 0)]
  ));

  sections.push(block(
    'fleet_capacity_busy',
    'gauge',
    'Jobs currently running on the local host.',
    [metricLine('fleet_capacity_busy', Number(capacity.busy ?? runnerBusy))]
  ));

  sections.push(block(
    'fleet_capacity_ceiling',
    'gauge',
    'Busy-job ceiling for adding another runner on the local host.',
    [metricLine('fleet_capacity_ceiling', Number(capacity.ceiling ?? 0))]
  ));

  sections.push(block(
    'fleet_capacity_headroom_runners',
    'gauge',
    'Runners that may still be added before maxTotalRunners on the local host.',
    [metricLine('fleet_capacity_headroom_runners', headroomRunners)]
  ));

  sections.push(block(
    'fleet_autoscale_enabled',
    'gauge',
    'Autoscaling enabled (1) or disabled (0).',
    [metricLine('fleet_autoscale_enabled', autoscale.enabled ? 1 : 0)]
  ));

  sections.push(block(
    'fleet_autoscale_dry_run',
    'gauge',
    'Autoscaling dry-run mode (1) or live actions (0).',
    [metricLine('fleet_autoscale_dry_run', autoscale.dryRun ? 1 : 0)]
  ));

  sections.push(block(
    'fleet_autoscale_last_acted',
    'gauge',
    'Whether the most recent autoscale decision acted (1) or refused/dry-run (0).',
    [metricLine('fleet_autoscale_last_acted', autoscale.acted ? 1 : 0)]
  ));

  sections.push(block(
    'fleet_autoscale_mode',
    'gauge',
    'Most recent autoscale mode (1 for the active mode label, 0 for others).',
    ['burst', 'sustained', 'none'].map((m) =>
      metricLine('fleet_autoscale_mode', mode === m ? 1 : 0, { mode: m })
    )
  ));

  sections.push(block(
    'fleet_autoscale_deficit',
    'gauge',
    'Remaining runner deficit from sizing or the last scale-up plan.',
    [metricLine('fleet_autoscale_deficit', deficit)]
  ));

  sections.push(block(
    'fleet_hosts_total',
    'gauge',
    'Hosts in the federation view, including the coordinator.',
    [metricLine('fleet_hosts_total', hostCount)]
  ));

  sections.push(block(
    'fleet_hosts_stale',
    'gauge',
    'Hosts whose heartbeat is stale.',
    [metricLine('fleet_hosts_stale', hostStaleCount)]
  ));

  return `${sections.join('\n')}\n`;
}
