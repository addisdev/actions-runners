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

// The rate limit as GitHub reports it on each response. Read from the response
// headers, not `gh api rate_limit`: on 2026-10-02 that endpoint kept answering
// 5000/5000 while four workers ran the quota out, and the quota is per USER —
// the fleet daemon's token on the runner host shares it and was penalised for
// ~45 minutes. Every worker waits on one shared pause.
const rate = { remaining: null, reset: null, pause: null };

function readHeaders(text) {
  const head = text.split(/\r?\n\r?\n/, 1)[0];
  const h = (name) => head.match(new RegExp(`^${name}:\\s*(\\S+)`, 'im'))?.[1];
  const remaining = h('x-ratelimit-remaining');
  const reset = h('x-ratelimit-reset');
  if (remaining != null) rate.remaining = Number(remaining);
  if (reset != null) rate.reset = Number(reset) * 1000;
  return text.slice(head.length).trim();
}

async function waitForRoom(floor) {
  if (rate.pause) return rate.pause;
  if (rate.remaining == null || rate.remaining >= floor) return;
  const waitMs = Math.max(0, (rate.reset ?? Date.now()) - Date.now()) + 5_000;
  console.error(`rate ${rate.remaining} under floor ${floor}; sleeping ${Math.round(waitMs / 1000)}s`);
  rate.pause = sleep(waitMs).then(() => { rate.pause = null; rate.remaining = null; });
  return rate.pause;
}

async function ghApi(path, floor) {
  for (let attempt = 1; ; attempt++) {
    await waitForRoom(floor);
    try {
      const { stdout } = await run('gh', ['api', '-i', path], { maxBuffer: 16 << 20 });
      return { data: JSON.parse(readHeaders(stdout)) };
    } catch (err) {
      if (err.stdout) readHeaders(err.stdout);
      const msg = `${err.stderr ?? ''}${err.stdout ?? ''}`;
      if (/HTTP 404/.test(msg)) return { gone: true };
      if (/API rate limit exceeded/i.test(msg) && attempt <= 3) {
        rate.remaining = 0;
        continue;
      }
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

async function fetchAll() {
  const inPath = arg('in');
  const outPath = arg('out');
  // High on purpose: the daemon needs its share of the same per-user quota.
  const floor = Number(arg('floor', 2500));
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

  // One worker by default. More finish sooner (each call is a process spawn)
  // but spend the shared quota faster than the daemon expects; raise it only
  // with the floor high.
  const workers = Number(arg('concurrency', 1));
  let n = 0;
  let next = 0;
  const one = async (row) => {
    const res = await ghApi(`repos/${row.repo}/actions/jobs/${row.id}`, floor);
    n++;
    const out = { id: row.id, repo: row.repo };
    if (res.gone) {
      out.gone = true;
    } else {
      out.job = shapeJob(row.repo, res.data);
      if (out.job.conclusion === 'failure' || out.job.conclusion === 'timed_out') {
        const ann = await ghApi(`repos/${row.repo}/check-runs/${row.id}/annotations`, floor);
        n++;
        const messages = (Array.isArray(ann.data) ? ann.data : [])
          .filter((a) => a?.annotation_level === 'failure')
          .map((a) => String(a.message ?? '').trim())
          .filter(Boolean);
        out.failureClass = classifyAnnotations(messages);
        out.failureDetail = messages[0]?.slice(0, 2000) ?? null;
      }
    }
    appendFileSync(outPath, `${JSON.stringify(out)}\n`);
  };
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < todo.length) {
      const i = next++;
      await one(todo[i]);
      if (i % 250 === 0) console.error(`${i}/${todo.length} jobs, ${n} calls, rate ${rate.remaining}`);
      await sleep(gapMs);
    }
  }));
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
