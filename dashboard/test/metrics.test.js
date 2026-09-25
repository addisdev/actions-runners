import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeLabel,
  formatSample,
  renderPrometheusMetrics,
} from '../lib/metrics.js';
import { CAUSES } from '../lib/queue-cause.js';

describe('metrics helpers', () => {
  test('escapeLabel escapes backslashes, quotes, and newlines', () => {
    assert.equal(escapeLabel(String.raw`a\b"c`), String.raw`a\\b\"c`);
    assert.equal(escapeLabel('line\nbreak'), 'line\\nbreak');
  });

  test('formatSample writes integers without decimals', () => {
    assert.equal(formatSample(3), '3');
    assert.equal(formatSample(3.14159265), '3.141593');
    assert.equal(formatSample(Number.NaN), '0');
  });
});

describe('renderPrometheusMetrics', () => {
  const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

  const snapshot = {
    ts: NOW - 30_000,
    starting: false,
    runners: [
      { name: 'a', workingLocally: true },
      { name: 'b', ghBusy: true },
      { name: 'c' },
    ],
    capacity: { ok: true, busy: 2, ceiling: 3, maxTotalRunners: 8, reasons: [] },
    fleetCapacity: { ok: true, reasons: [] },
    admission: {
      waiting: [{ runner: 'a', repo: 'owner/app', since: NOW - 5000 }],
    },
    autoscale: {
      enabled: true,
      dryRun: false,
      acted: true,
      mode: 'burst',
      deficit: 2,
    },
    sizing: [{ repo: 'owner/app', have: 1, want: 3, delta: 2, reason: 'queued' }],
    queue: [
      { id: 1, cause: CAUSES.REPO_CAPACITY, queuedSinceMs: 900_000 },
      { id: 2, cause: CAUSES.REPO_CAPACITY, queuedSinceMs: 600_000 },
      { id: 3, cause: CAUSES.LABEL_MISMATCH, queuedSinceMs: 120_000 },
    ],
  };

  test('renders core fleet metrics with expected samples', () => {
    const text = renderPrometheusMetrics(snapshot, {
      now: NOW,
      collectorStaleMs: 240_000,
      hostCount: 3,
      hostStaleCount: 1,
    });

    assert.match(text, /# TYPE fleet_collector_age_seconds gauge/);
    assert.match(text, /fleet_collector_age_seconds 30/);
    assert.match(text, /fleet_collector_stale 0/);
    assert.match(text, /fleet_runners_total 3/);
    assert.match(text, /fleet_runners_busy 2/);
    assert.match(text, /fleet_admission_waiting 1/);
    assert.match(text, /fleet_capacity_ok 1/);
    assert.match(text, /fleet_fleet_capacity_ok 1/);
    assert.match(text, /fleet_capacity_busy 2/);
    assert.match(text, /fleet_capacity_ceiling 3/);
    assert.match(text, /fleet_capacity_headroom_runners 5/);
    assert.match(text, /fleet_autoscale_enabled 1/);
    assert.match(text, /fleet_autoscale_dry_run 0/);
    assert.match(text, /fleet_autoscale_last_acted 1/);
    assert.match(text, /fleet_autoscale_mode\{mode="burst"\} 1/);
    assert.match(text, /fleet_autoscale_mode\{mode="sustained"\} 0/);
    assert.match(text, /fleet_autoscale_deficit 2/);
    assert.match(text, /fleet_hosts_total 3/);
    assert.match(text, /fleet_hosts_stale 1/);
  });

  test('marks collector stale when age exceeds threshold', () => {
    const text = renderPrometheusMetrics(
      { ...snapshot, ts: NOW - 300_000 },
      { now: NOW, collectorStaleMs: 240_000 }
    );
    assert.match(text, /fleet_collector_stale 1/);
  });

  test('emits zeroed queue cause series and worst ages', () => {
    const text = renderPrometheusMetrics(snapshot, { now: NOW });
    assert.match(text, /fleet_queue_runs\{cause="repo-capacity"\} 2/);
    assert.match(text, /fleet_queue_worst_age_seconds\{cause="repo-capacity"\} 900/);
    assert.match(text, /fleet_queue_runs\{cause="label-mismatch"\} 1/);
    assert.match(text, /fleet_queue_runs\{cause="github-delay"\} 0/);
  });

  test('derives deficit from sizing when autoscale.deficit is absent', () => {
    const text = renderPrometheusMetrics(
      {
        ...snapshot,
        autoscale: { enabled: false, dryRun: true, acted: false },
        sizing: [
          { delta: 1 },
          { delta: 3 },
          { delta: 0 },
        ],
      },
      { now: NOW }
    );
    assert.match(text, /fleet_autoscale_deficit 4/);
  });

  test('ends with a trailing newline', () => {
    assert.ok(renderPrometheusMetrics(snapshot, { now: NOW }).endsWith('\n'));
  });
});
