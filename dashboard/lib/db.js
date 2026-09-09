// SQLite store. `node:sqlite` ships with Node, which is the whole reason this
// file has no dependencies — see ../README.md for why that matters on a machine
// whose actual job is running CI.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Workflow YAML, cached by content sha. The lint runs over this rather than
// refetching: 27 files across 14 repos is cheap, but not every 15 seconds, and
// an ETag'd refetch of unchanged files costs nothing against the rate limit.
//
// Keyed by ref as well as path, because the file that GitHub executes is the one
// on the branch being pushed, and on this fleet main and develop have diverged.
// Linting only the default branch described a file that was not the one running.
// Extracted to a const so the migration below can rebuild it.
const WORKFLOW_FILES_DDL = `
CREATE TABLE IF NOT EXISTS workflow_files (
  repo       TEXT NOT NULL,
  path       TEXT NOT NULL,
  ref        TEXT NOT NULL DEFAULT '',
  name       TEXT,
  sha        TEXT,
  content    TEXT,
  fetched_at INTEGER,
  is_default INTEGER DEFAULT 0,
  PRIMARY KEY (repo, path, ref)
);`;

// One row per admission decision made by hooks/job-started.sh: admitted, held,
// timeout, released, or the observe-mode would-hold. Ingested from the NDJSON
// file those hooks append to rather than written by them directly, because this
// database is held open in WAL mode by the daemon and a second writer appearing
// from inside a CI job is a race nobody wants to debug during an incident.
//
// limit_n rather than limit, because LIMIT is a SQL keyword. waited_s is the
// load-bearing column: a held job is in progress as far as GitHub is concerned,
// so its wait is inside its own reported duration, and this is what lets that
// time be attributed instead of silently inflating the percentiles.
//
// Extracted to a const so the migration below can rebuild it.
const ADMISSION_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS admission_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  event    TEXT NOT NULL,
  mode     TEXT,
  runner   TEXT,
  repo     TEXT,
  run_id   TEXT,
  job      TEXT,
  waited_s INTEGER,
  -- How long a released slot was occupied. Distinct from waited_s so a release
  -- cannot report its occupancy as though the job had waited that long.
  ran_s    INTEGER,
  busy     INTEGER,
  limit_n  INTEGER,
  -- Whether the hook found a Runner.Worker to own its slot ('worker') or fell
  -- back to its parent ('fallback'), and which PID that was. Named for what it
  -- holds: an earlier column called 'owner' stored the kind, which read as a PID.
  owner_kind TEXT,
  owner_pid  TEXT,
  reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admission_ts ON admission_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_admission_event ON admission_events(event, ts DESC);
`;

const TEST_OUTCOMES_DDL = `
CREATE TABLE IF NOT EXISTS test_outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  repo        TEXT NOT NULL,
  head_sha    TEXT,
  run_id      TEXT,
  job_id      TEXT,
  browser     TEXT,
  project     TEXT,
  file        TEXT NOT NULL,
  title       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL,
  flaky       INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_test_outcomes_ts   ON test_outcomes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_test_outcomes_repo ON test_outcomes(repo, ts DESC);
CREATE INDEX IF NOT EXISTS idx_test_outcomes_flaky ON test_outcomes(flaky, ts DESC);
`;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Current state of every runner this host knows about, keyed by the agent name
-- because that is the one identifier shared by GitHub and by launchd.
CREATE TABLE IF NOT EXISTS runner_state (
  name            TEXT PRIMARY KEY,
  repo            TEXT,
  dir             TEXT,
  labels          TEXT,
  gh_id           INTEGER,
  gh_status       TEXT,
  gh_busy         INTEGER,
  launchd_label   TEXT,
  launchd_state   TEXT,
  pid             INTEGER,
  rss_kb          INTEGER,
  work_kb         INTEGER,
  updated_at      INTEGER
);

-- Transitions, not samples. One row when a runner changes state, so "when did
-- this go offline" is answerable without keeping every 15s tick forever.
CREATE TABLE IF NOT EXISTS runner_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  name   TEXT NOT NULL,
  repo   TEXT,
  kind   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_runner_events_ts ON runner_events(ts DESC);

-- Runs and jobs are append-only and tiny. Keep them forever: GitHub discards
-- run detail after 90 days and has never had a cross-repo view, so this table
-- is the only place the fleet's own history will exist.
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL,
  workflow_id    INTEGER,
  workflow_name  TEXT,
  run_number     INTEGER,
  event          TEXT,
  status         TEXT,
  conclusion     TEXT,
  head_branch    TEXT,
  head_sha       TEXT,
  created_at     TEXT,
  run_started_at TEXT,
  updated_at     TEXT,
  html_url       TEXT,
  duration_ms    INTEGER,
  seen_at        INTEGER
);

-- Optional billing snapshots, one row per slow-tick probe. Keeps only the most
-- recent readings rather than a full history — the interesting question is
-- "how much have we used this month", not a 15-minute time series.
CREATE TABLE IF NOT EXISTS billing_snapshots (
  ts              INTEGER PRIMARY KEY,
  minutes_used    REAL,
  minutes_limit   REAL,
  storage_gb      REAL,
  storage_limit_gb REAL,
  raw             TEXT
);

-- Autoscaling decisions, for observability. The evaluator is pure — it never
-- acts — so every row is either PROPOSED (would add) or REFUSED (with reason),
-- which lets the operator validate the logic before enabling autonomous action.
CREATE TABLE IF NOT EXISTS autoscale_decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  repo       TEXT NOT NULL,
  action     TEXT NOT NULL,
  reason     TEXT,
  dry_run    INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_autoscale_ts ON autoscale_decisions(ts DESC);

${ADMISSION_EVENTS_DDL}
CREATE INDEX IF NOT EXISTS idx_runs_repo_started ON runs(repo, run_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL,
  repo         TEXT NOT NULL,
  name         TEXT,
  status       TEXT,
  conclusion   TEXT,
  created_at   TEXT,
  started_at   TEXT,
  completed_at TEXT,
  runner_name  TEXT,
  runner_id    INTEGER,
  labels       TEXT,
  queued_ms    INTEGER,
  duration_ms  INTEGER,
  html_url     TEXT,
  seen_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_runner ON jobs(runner_name, started_at DESC);
-- The analytics window filters on started_at across every repo, and the
-- backfill's "runs with no jobs yet" probe hits jobs by run_id constantly.
CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at);
CREATE INDEX IF NOT EXISTS idx_jobs_repo_started ON jobs(repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(run_started_at);

-- Populated in phase 2. Declared now so the analytics screens do not need a
-- schema migration on a box nobody is watching.
CREATE TABLE IF NOT EXISTS steps (
  job_id       INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  name         TEXT,
  status       TEXT,
  conclusion   TEXT,
  started_at   TEXT,
  completed_at TEXT,
  duration_ms  INTEGER,
  PRIMARY KEY (job_id, number)
);

-- Host vitals at 1-minute resolution. Swap is the one that predicts pain on
-- this machine, so it gets its own column rather than living in a blob.
CREATE TABLE IF NOT EXISTS host_samples (
  ts             INTEGER PRIMARY KEY,
  load1          REAL,
  mem_used_mb    INTEGER,
  mem_total_mb   INTEGER,
  swap_used_mb   INTEGER,
  swap_total_mb  INTEGER,
  disk_free_gb   REAL,
  disk_total_gb  REAL,
  listeners      INTEGER,
  busy_runners   INTEGER
);

-- Repo roster, refreshed slowly. This is what makes a repo you create tomorrow
-- show up on the fleet page without anyone editing a config file.
CREATE TABLE IF NOT EXISTS repos (
  full_name   TEXT PRIMARY KEY,
  name        TEXT,
  archived    INTEGER,
  private     INTEGER,
  pushed_at   TEXT,
  workflows   INTEGER,
  has_runner  INTEGER,
  updated_at  INTEGER
);

-- Every control-plane action, whether it succeeded or not. A dashboard that can
-- restart runners and delete caches has to be able to answer "who ran what, and
-- what did it say" afterwards.
CREATE TABLE IF NOT EXISTS action_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  action   TEXT NOT NULL,
  args     TEXT,
  command  TEXT,
  exit_code INTEGER,
  ok       INTEGER,
  output   TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_log_ts ON action_log(ts DESC);

-- Alerts are stored as intervals, not events: one row per condition, closed when
-- it resolves. That is what makes "this runner has been down for two hours"
-- answerable, and it is what lets a restart reload what was already open instead
-- of re-announcing every condition it finds.
CREATE TABLE IF NOT EXISTS alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL,
  rule      TEXT NOT NULL,
  severity  TEXT NOT NULL,
  title     TEXT,
  body      TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  notified  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(closed_at, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_key_open ON alerts(key) WHERE closed_at IS NULL;

${WORKFLOW_FILES_DDL}

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Operator-editable settings, separate from the meta table because those two
-- have opposite lifecycles: meta is the daemon's own bookkeeping (backfill
-- cursors, schema version) and nobody should edit it, while every row here
-- exists because a person changed it deliberately. Keeping them apart means a
-- settings screen can show this whole table without exposing internals, and
-- updated_at answers "when did this stop being the default" during an incident.
--
-- Only rows that were explicitly set exist. Anything absent falls through to the
-- environment and then to the built-in default, so this table stays small and
-- readable rather than being a full copy of the config.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

${TEST_OUTCOMES_DDL}
`;

// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// new columns need an explicit migration or every upgrade silently keeps the old
// shape. Names here are internal constants, never user input.
function addColumn(db, table, column, type) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Prune test outcomes older than 90 days. Row counts grow linearly with test
  // suite size and run frequency; 90 days is enough for trend analysis.
  try {
    db.exec(`DELETE FROM test_outcomes WHERE ts < ${Date.now() - 90 * 86400000}`);
  } catch { /* ignore on old schema — table may not exist yet */ }
  // Swap level turned out to be an accumulator rather than a pressure signal,
  // so these are what the host tiles and alerts read now.
  addColumn(db, 'host_samples', 'mem_free_pct', 'INTEGER');
  addColumn(db, 'host_samples', 'pressure', 'TEXT');
  addColumn(db, 'host_samples', 'swapins_per_sec', 'REAL');
  addColumn(db, 'host_samples', 'swapouts_per_sec', 'REAL');
  addColumn(db, 'host_samples', 'mem_compressed_mb', 'INTEGER');

  // The lint used to read one file per (repo, path); it now reads one per ref as
  // well, which changes the primary key, and SQLite cannot ALTER a primary key.
  //
  // Rebuilding rather than copying is the right move specifically because this
  // table is a cache: every row is refetchable, the fetches are ETag'd so the
  // ones that have not changed cost nothing against the rate limit, and a
  // half-migrated cache keyed the old way would silently lint the wrong ref.
  if (!db.prepare('PRAGMA table_info(workflow_files)').all().some((c) => c.name === 'ref')) {
    db.exec('DROP TABLE IF EXISTS workflow_files');
    db.exec(WORKFLOW_FILES_DDL);
  }

  // Two columns in this table were named for the wrong thing: 'owner' held the
  // owner KIND ('worker' or 'fallback') rather than a PID, and a release put its
  // slot occupancy in waited_s, reporting it as though the job had waited.
  //
  // Rebuilt rather than migrated for the same reason as workflow_files: this
  // table is a cache of hooks/'s NDJSON log, which is the source of truth. Reset
  // the read cursor with it, or the rows are dropped and never re-read.
  const admissionCols = db.prepare('PRAGMA table_info(admission_events)').all().map((c) => c.name);
  if (admissionCols.includes('owner') || !admissionCols.includes('ran_s')) {
    db.exec('DROP TABLE IF EXISTS admission_events');
    db.exec(ADMISSION_EVENTS_DDL);
    db.exec("DELETE FROM meta WHERE key = 'admission_log_offset'");
  }

  // Which branch the repo considers canonical. Needed to tell "this finding is
  // on the branch you would open a PR against" from "this finding is on a branch
  // that merely still gets pushes".
  addColumn(db, 'repos', 'default_branch', 'TEXT');

  // Why a job failed, from its annotations — see lib/failures.js. NULL means
  // "not looked at yet", which is what lets the backfill find the ones still
  // needing a fetch; 'unknown' means looked at and GitHub had nothing left.
  addColumn(db, 'jobs', 'failure_class', 'TEXT');
  addColumn(db, 'jobs', 'failure_detail', 'TEXT');
  // Partial index: only failed jobs are ever queried by class, and on this fleet
  // they are ~6% of rows.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_jobs_failure ON jobs(repo, failure_class) '
    + "WHERE conclusion = 'failure'"
  );

  // Richer run metadata: these fields are on the run object GitHub already
  // returns in the fast loop and backfill, so there is no new API cost.
  // run_attempt distinguishes the first attempt from a re-run of the same run.
  // display_title is what GitHub shows in the UI (commit subject or a dispatch
  // title). workflow_path is the relative path to the .yml file, which ties a
  // lint finding to the exact run that exercised it. pr_number links a
  // pull_request-triggered run back to its PR without opening GitHub. actor is
  // who triggered the run. head_commit_msg is the first line of the commit
  // message — enough to read recent history without opening GitHub.
  addColumn(db, 'runs', 'run_attempt', 'INTEGER');
  addColumn(db, 'runs', 'display_title', 'TEXT');
  addColumn(db, 'runs', 'workflow_path', 'TEXT');
  addColumn(db, 'runs', 'pr_number', 'INTEGER');
  addColumn(db, 'runs', 'actor', 'TEXT');
  addColumn(db, 'runs', 'head_commit_msg', 'TEXT');

  // -----------------------------------------------------------------------
  // Phase 0 migrations: shared schema foundation for the six enhancement
  // workstreams. Each group is documented with its purpose.

  // Queue-cause classification (W1).
  //
  // One row per cause *transition* for a queued run, not one per tick. Like
  // runner_events, a transition log costs much less than a time-series and still
  // answers "how long was this stuck as a label mismatch" — which is what you
  // need after an incident.
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      run_id          INTEGER NOT NULL,
      repo            TEXT NOT NULL,
      cause           TEXT NOT NULL,
      confidence      TEXT NOT NULL,
      evidence        TEXT,
      recommended     TEXT,
      resolved_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_queue_events_run ON queue_events(run_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_events_repo ON queue_events(repo, ts DESC);
  `);

  // Drain mode (W2).
  //
  // drain_state: NULL = normal, 'draining' = waiting for job to finish,
  //              'drained' = stopped intentionally (will not auto-restart).
  // drain_requested_at: when the drain was initiated.
  // drain_note: optional operator comment.
  addColumn(db, 'runner_state', 'drain_state', 'TEXT');
  addColumn(db, 'runner_state', 'drain_requested_at', 'INTEGER');
  addColumn(db, 'runner_state', 'drain_note', 'TEXT');

  // Runner version inventory (W4).
  //
  // runner_version: the active binary version this runner is running.
  // install_version: what register.sh pinned when it was first created.
  // version_seen_at: when the active version was last confirmed.
  addColumn(db, 'runner_state', 'runner_version', 'TEXT');
  addColumn(db, 'runner_state', 'install_version', 'TEXT');
  addColumn(db, 'runner_state', 'version_seen_at', 'INTEGER');

  // Burst forecast evaluation (W5).
  //
  // Forecasts run in shadow mode: we predict, compare with reality, and only
  // unlock pre-warming once precision/recall thresholds are met. This table is
  // the paper trail that makes that evaluation possible.
  db.exec(`
    CREATE TABLE IF NOT EXISTS forecast_evals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      window_start    INTEGER NOT NULL,
      window_end      INTEGER NOT NULL,
      repo            TEXT NOT NULL,
      predicted_peak  INTEGER,
      actual_peak     INTEGER,
      precision_score REAL,
      recall_score    REAL,
      false_positive  INTEGER DEFAULT 0,
      model_version   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_forecast_evals_repo ON forecast_evals(repo, ts DESC);
  `);

  // Federation host registry (W6).
  //
  // hosts: one row per known machine, created when it first heartbeats in.
  // host_heartbeats: recency check; a host missing heartbeats for N minutes is
  //   treated as unreachable and receives no placement reservations.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      host_id         TEXT PRIMARY KEY,
      hostname        TEXT,
      platform        TEXT,
      fleet_root      TEXT,
      first_seen      INTEGER,
      last_seen       INTEGER,
      agent_version   TEXT,
      reachable       INTEGER DEFAULT 1,
      labels          TEXT
    );
    CREATE TABLE IF NOT EXISTS host_heartbeats (
      host_id         TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      load1           REAL,
      mem_free_pct    INTEGER,
      disk_free_gb    REAL,
      runner_count    INTEGER,
      busy_count      INTEGER,
      PRIMARY KEY (host_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_host_heartbeats_ts ON host_heartbeats(host_id, ts DESC);
  `);

  // The most recent full report from each host, kept on the hosts row rather than
  // in host_heartbeats.
  //
  // WHY NOT IN THE HEARTBEAT TABLE. host_heartbeats is a time series: one row per
  // host every 30 seconds, which is 2,880 rows per host per day. Putting a
  // complete runner list in each of those rows would multiply the size of the
  // fastest-growing table in the schema by the number of runners on the host, to
  // store the same answer over and over.
  //
  // What the coordinator actually needs is the LATEST report, so it lives in one
  // row per host that gets overwritten. The time series keeps only the small
  // scalar metrics that are worth having history for.
  addColumn(db, 'hosts', 'last_payload', 'TEXT');

  // Placement decisions (W6). One row per placement attempt; every refusal is
  // recorded with its reason so the operator can see why a repo landed where it
  // did (or did not land at all).
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      repo            TEXT NOT NULL,
      host_id         TEXT,
      action          TEXT NOT NULL,
      reason          TEXT,
      dry_run         INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_placement_ts ON placement_decisions(ts DESC);
  `);

  // Remote command queue (W6). The coordinator writes commands here; agents
  // poll for their pending rows and execute them locally. Completed and failed
  // rows are kept for audit rather than deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_commands (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      action          TEXT NOT NULL,
      args            TEXT,
      status          TEXT DEFAULT 'pending',
      started_at      INTEGER,
      completed_at    INTEGER,
      result          TEXT,
      idempotency_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_host_commands_host ON host_commands(host_id, status, ts);
  `);

  return db;
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
