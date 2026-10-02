#!/usr/bin/env node
// One-off: settle the job rows that froze before their run completed.
//
// Before lib/settle.js, fleetd never re-fetched a job once its run completed,
// so the last snapshot (queued or in progress, no conclusion or duration) stuck.
// The daemon now heals these itself, a few hundred per backfill pass; this is
// the fast way to clear the history in one go, and it runs where `gh` works —
// over SSH, gh on the runner host cannot read its keychain token.
//
// Three steps, each restartable:
//
//   ssh runner-host "/usr/bin/sqlite3 -json ~/actions-runners/dashboard/fleet.db \
//     \"$(node scripts/settle-stale-jobs.mjs query)\"" > stale.json
//   node scripts/settle-stale-jobs.mjs fetch --in stale.json --out fetched.ndjson
//   node scripts/settle-stale-jobs.mjs sql --in fetched.ndjson \
//     | ssh runner-host /usr/bin/sqlite3 ~/actions-runners/dashboard/fleet.db
//
// fetch skips ids already in --out, so an interrupted run resumes. It paces
// itself under GitHub's primary limit (sleeps to the reset below --floor) and
// backs off on the secondary limit. The SQL only touches rows that still have
// no conclusion, so it cannot clobber a row the daemon settled in the meantime.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { shapeJob } from '../lib/state.js';
import { classifyAnnotations } from '../lib/failures.js';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same criterion as lib/settle.js.
const QUERY = `SELECT j.id, j.repo FROM jobs j JOIN runs r ON r.id = j.run_id
WHERE j.conclusion IS NULL AND j.id > 0 AND r.status = 'completed'
  AND (j.seen_at IS NULL OR j.seen_at < CAST(strftime('%s', r.updated_at) AS INTEGER) * 1000 + 120000)
ORDER BY j.id`;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function ghApi(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await run('gh', ['api', path], { maxBuffer: 16 << 20 });
      return { data: JSON.parse(stdout) };
    } catch (err) {
      const msg = `${err.stderr ?? ''}${err.stdout ?? ''}`;
      if (/HTTP 404/.test(msg)) return { gone: true };
      if (/secondary rate limit|HTTP 429|abuse/i.test(msg) && attempt <= 5) {
        console.error(`secondary rate limit on ${path}; sleeping ${60 * attempt}s`);
        await sleep(60_000 * attempt);
        continue;
      }
      if (/HTTP 5\d\d/.test(msg) && attempt <= 3) {
        await sleep(5_000 * attempt);
        continue;
      }
      throw new Error(`${path}: ${msg.trim().slice(0, 200)}`);
    }
  }
}

async function core() {
  const { stdout } = await run('gh', ['api', 'rate_limit', '--jq', '.resources.core']);
  return JSON.parse(stdout);
}

async function fetchAll() {
  const inPath = arg('in');
  const outPath = arg('out');
  const floor = Number(arg('floor', 1000));
  const gapMs = Number(arg('gap-ms', 250));
  if (!inPath || !outPath) throw new Error('fetch needs --in and --out');

  const rows = JSON.parse(readFileSync(inPath, 'utf8') || '[]');
  const done = new Set();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, 'utf8').split('\n')) {
      if (line.trim()) done.add(JSON.parse(line).id);
    }
  }
  const todo = rows.filter((r) => !done.has(r.id));
  console.error(`${rows.length} stale, ${done.size} already fetched, ${todo.length} to go`);

  let n = 0;
  for (const row of todo) {
    // rate_limit itself is free; check it every 50 calls.
    if (n % 50 === 0) {
      const c = await core();
      if (c.remaining < floor) {
        const waitMs = Math.max(0, c.reset * 1000 - Date.now()) + 5_000;
        console.error(`rate ${c.remaining}/${c.limit} under floor ${floor}; sleeping ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }
    n++;
    const res = await ghApi(`repos/${row.repo}/actions/jobs/${row.id}`);
    const out = { id: row.id, repo: row.repo };
    if (res.gone) {
      out.gone = true;
    } else {
      out.job = shapeJob(row.repo, res.data);
      if (out.job.conclusion === 'failure' || out.job.conclusion === 'timed_out') {
        n++;
        const ann = await ghApi(`repos/${row.repo}/check-runs/${row.id}/annotations`);
        const messages = (Array.isArray(ann.data) ? ann.data : [])
          .filter((a) => a?.annotation_level === 'failure')
          .map((a) => String(a.message ?? '').trim())
          .filter(Boolean);
        out.failureClass = classifyAnnotations(messages);
        out.failureDetail = messages[0]?.slice(0, 2000) ?? null;
      }
    }
    appendFileSync(outPath, `${JSON.stringify(out)}\n`);
    if (n % 250 < 2) console.error(`${n} calls, at job ${row.id}`);
    await sleep(gapMs);
  }
  console.error(`fetch done: ${n} calls`);
}

const q = (v) => (v == null ? 'NULL'
  : typeof v === 'number' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`);

function toSql() {
  const inPath = arg('in');
  if (!inPath) throw new Error('sql needs --in');
  const now = Date.now();
  const lines = ['.timeout 15000', 'BEGIN;'];
  for (const line of readFileSync(inPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.gone) {
      lines.push(`UPDATE jobs SET seen_at = ${now} WHERE id = ${q(r.id)} AND conclusion IS NULL;`);
      continue;
    }
    const j = r.job;
    const failure = r.failureClass
      ? `, failure_class = ${q(r.failureClass)}, failure_detail = ${q(r.failureDetail)}`
      : '';
    lines.push(`UPDATE jobs SET status = ${q(j.status)}, conclusion = ${q(j.conclusion)}, `
      + `started_at = COALESCE(${q(j.startedAt)}, started_at), completed_at = ${q(j.completedAt)}, `
      + `runner_name = COALESCE(${q(j.runnerName)}, runner_name), `
      + `runner_id = COALESCE(${q(j.runnerId)}, runner_id), `
      + `queued_ms = ${q(j.queuedMs)}, duration_ms = ${q(j.durationMs)}${failure}, seen_at = ${now} `
      + `WHERE id = ${q(r.id)} AND conclusion IS NULL;`);
  }
  lines.push('COMMIT;', 'SELECT total_changes();');
  process.stdout.write(`${lines.join('\n')}\n`);
}

const mode = process.argv[2];
if (mode === 'query') process.stdout.write(`${QUERY}\n`);
else if (mode === 'fetch') await fetchAll();
else if (mode === 'sql') toSql();
else {
  console.error('usage: settle-stale-jobs.mjs query | fetch --in F --out F [--floor N] [--gap-ms N] | sql --in F');
  process.exit(2);
}
