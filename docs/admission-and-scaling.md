# Admission Control and Autoscaling

## Why two separate mechanisms

The fleet has two separate capacity controls that solve different problems:

**Autoscaling** (the Capacity tab) manages the *number of runners*. It adds
runners when the queue grows beyond what the current fleet can absorb, and
removes idle duplicates. It acts between jobs.

**Admission control** (the hooks) manages *concurrent execution*. It holds a
job at the `job-started` hook until a slot is free. It acts inside a job.

Both are off by default. You can use either, both, or neither.

## Autoscaling

### How it works

Every fast-loop tick (15 s), the queue classifier checks each queued job:

1. Does the repo have a runner for it? If not → `unserved` (can't add more).
2. Does the runner have the right labels? If not → `label-mismatch` (can't add more).
3. Are runners down/draining? → `runner-down` (can't add more).
4. Is the host saturated? → `host-saturation` (can't add more).
5. More jobs than runners? → `repo-capacity` — **autoscale eligible**.
6. GitHub not dispatching a ready runner? → `github-delay` (wait).

A `repo-capacity` verdict with high confidence triggers `planScaleUp`, which
calls `register.sh` to add a runner — subject to the capacity gates:

- `FLEET_CEILING`: do not add while this many jobs are running
- `FLEET_MAX_TOTAL_RUNNERS`: hard cap on total runners per host
- `FLEET_LOAD_PER_CORE`: do not add above this load average ratio
- `FLEET_MIN_FREE_DISK_GB`: do not add below this free disk level

### Autoscale configuration

Toggle and configure from the **Capacity tab** in the dashboard. No restart
required.

| Setting | Default | Effect |
|---|---|---|
| Autoscale enabled | off | Whether to act on recommendations |
| Dry run | off | Log decisions without executing them |
| Per-repo runner cap | 4 | Max runners per repo |
| Idle TTL | 0 (off) | Deregister idle duplicates after N hours |

The autoscaler never removes the instance-1 (first) runner for any repo —
removing the last runner would leave the repo with no runner at all, which is
never the right outcome.

### Scale-down

`--idle-ttl` removes duplicate runners (instance-2 and above) that have been
idle for the configured number of hours. Set it to `2` if you want runners to
shrink back after a burst.

### Scenario replay

Before enabling autoscaling, use the **Scenario** panel on the Capacity tab
to model what would have happened with different runner counts against your
actual historical job data. The simulator shows:

- Queue wait percentiles (p50, p95)
- Peak simultaneous queue depth
- SLO compliance (fraction of jobs starting within 60 s)

Run both the current and proposed configuration; the comparison shows the
delta in runner-hours and queue improvement.

## Admission control

Admission control gates job *execution* from inside the runner's started hook.
This is the only mechanism that can stop two simultaneously triggered jobs from
both starting at once.

### How it works

When a job starts on any runner, `hooks/job-started.sh` runs first. In
`enforce` mode:

1. It joins a host-wide FIFO waiter queue under an atomic directory mutex
   (one queue per [lane](#lanes) when lanes are enforced).
2. It reaps waiter files whose hook process has exited and slot files whose
   owning `Runner.Worker` has exited.
3. The oldest waiter checks live admitted slots and free disk. Later waiters
   do not take the mutex at all while a live waiter is ahead of them: only the
   oldest can be admitted, and when every waiter polled through the lock, a
   long queue on a loaded host kept it busy so the oldest almost never won it.
4. If there is room, it claims a slot owned by its `Runner.Worker`, leaves the
   waiter queue, and starts the workflow.
5. While blocked, it watches for cancellation. Every poll it reads its own
   `Runner.Worker`'s log in `<runner>/_diag` for the cancel message: the worker
   never signals the hook, and GitHub keeps a cancelled run `in_progress` for
   minutes while its job is held, so the log is the only prompt sign. Every
   `FLEET_ADMIT_CANCEL_POLL_S` it also asks whether the run has ended, from the
   dashboard daemon (`/api/run-status`) first: runner LaunchAgents set
   `SessionCreate`, so `gh` inside a job cannot read the keychain token. `gh`,
   then `curl` with a job token, are the fallbacks.
6. At `FLEET_ADMIT_MAX_WAIT_S`, `FLEET_ADMIT_TIMEOUT_ACTION` either admits the
   job (`admit`, the compatibility default) or keeps the limit strict (`hold`).

A held job is **in progress as far as GitHub is concerned** — the wait counts
against `timeout-minutes`. In fail-open mode, keep `FLEET_ADMIT_MAX_WAIT_S`
well under the tightest timeout in the fleet. In strict mode, cancellation
polling releases the runner when that timeout ends the run.

The hook cannot budget its hold against that timeout: GitHub enforces
`timeout-minutes` on its side and leaves it out of the job message the runner
receives. So the fleet keeps jobs out of the hook instead. With
[tiers](design/tiers.md#parking-no-twin) on, a primary lane at its cap takes its
idle runners offline (onto a standby twin, or parked when there is none), and
the jobs wait in GitHub's queue, where the wait is not charged to the job. A
hold that still ends in a timeout is classed `admission-hold` and shown as not
your code.

### Lanes

One host-wide limit treats a 5-second grep like a 12-minute Xcode build. On
ultra (30 cores, October 2026) load1 rose about 8 per concurrent job, 74 % of
jobs finished in under 90 s, and with one FIFO line the short ones waited
behind the long ones. `FLEET_ADMIT_LANES` gives each kind of job its own limit
and its own line:

| Lane | Which jobs | Limit |
|---|---|---|
| `simulator` | runners `FLEET_SIMULATOR_RUNNERS` selects (with `FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT` > 0) | `FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT`, strict as before, **and** a heavy slot |
| `heavy` | `FLEET_ADMIT_HEAVY_PATTERNS`, jobs whose recent median run is `FLEET_ADMIT_SHORT_JOB_S` or more, and anything not known | `FLEET_ADMIT_HEAVY_MAX_CONCURRENT` (4) |
| `light` | `FLEET_ADMIT_LIGHT_PATTERNS`, and jobs whose recent median run is under `FLEET_ADMIT_SHORT_JOB_S` (90 s) | `FLEET_ADMIT_LIGHT_MAX_CONCURRENT` (12) |

All under `FLEET_ADMIT_TOTAL_MAX_CONCURRENT` (default
`FLEET_ADMIT_MAX_CONCURRENT`), and the disk floors, as before.

**Classification**, once per job before it waits, first match wins:

1. The Simulator runner rule.
2. `FLEET_ADMIT_HEAVY_PATTERNS`, then `FLEET_ADMIT_LIGHT_PATTERNS`:
   space-separated `repo:job` shell patterns, quoted in `fleet.env`. `job` is
   `GITHUB_JOB`, the YAML id of the job that runs (inside a reusable workflow,
   its own key: `test`, not `ios / test`); the repo may be written with or
   without its owner. `"*:e2e acme/app:test site:*"`.
3. The dashboard's history, `GET /api/job-class` (see the [API](api.md)): the
   median of the job's last 30 runs in 14 days, from the admission log's own
   release lines (`ran_s`, the time it held a slot). Light under
   `FLEET_ADMIT_SHORT_JOB_S` with at least 5 runs, heavy at or over it,
   `unknown` with fewer. The answer is cached in `.admission/job-class/` for
   `FLEET_ADMIT_CLASS_CACHE_S` (300 s), so a push that starts twenty jobs asks
   once per job name.
4. Otherwise heavy: `unknown`, a daemon that does not answer in 3 s, or no
   daemon URL. A heavy job let into the light lane is what overloads the host;
   a light job in the heavy lane only waits a little longer.

A job's duration says nothing about its CPU: a 70-second Gradle build is short
and heavy. Name such jobs in `FLEET_ADMIT_HEAVY_PATTERNS`.

**Per-lane FIFO.** Each line is FIFO on its own: the oldest light job is never
behind an older heavy one, and a later job in a line still leaves the mutex to
the oldest one in it. A waiter file is named
`<ts>-<pid>-<light|heavy>-<runner>` so the lockless check reads its line from
the directory listing; a name from before lanes reads as heavy. Simulator jobs
wait in the heavy line, and one held by the Simulator limit is skipped, as in
the single line. Mutex, reaping, cancel polling, the disk floors and the
timeout action are unchanged; the heavy and light limits are relaxed by
`FLEET_ADMIT_TIMEOUT_ACTION=admit` like the host limit, and the Simulator limit
stays strict.

**Reasons.** The total cap, the Simulator limit and the disk floors keep their
words. The lanes add `4 heavy job(s) already running, at the heavy limit of 4`,
`12 light job(s) already running, at the light limit of 12` and `an older job
is waiting for the next heavy slot` (or `light slot`), which the lake files with
the old ones as `concurrency limit` and `queue order`.

**Modes.**

- `off` (default): no lane logic at all; the log line is the one it always was.
- `observe`: the single lane decides, exactly as with lanes off. Every line also
  carries `lanes`, `lane`, `lane_source` (`runner`, `pattern`, `history`,
  `unknown`, `fallback`), `heavy_busy`, `light_busy`, the three limits, and the
  lanes' own answer: `lane_would_hold` (true/false, null when it could not be
  worked out that poll), `lane_reason`, and for a wait `lane_wait_s`, how far
  into the wait the lanes would first have admitted the job. Set
  `FLEET_ADMIT_TOTAL_MAX_CONCURRENT` to the total you mean to enforce, so the
  lanes are judged at it while the single lane keeps its own limit.
- `enforce`: the lanes decide. The log's `limit` is then the total cap.

**Rolling out.** Observe for a day, then read the Capacity tab's lane rows (held
by the single lane where the lanes would admit, admitted where they would hold,
summed waits under each) and `cockpit load` (host load1 p50/p90 by busy
runners): the heavy limit is right when load at that many heavy jobs stays near
the core count. Then set `FLEET_ADMIT_LANES=enforce`. Going back is
`FLEET_ADMIT_LANES=off`; nothing restarts, because the hooks read `fleet.env`
for every job.

### Installing the hooks

```bash
scripts/install-hooks.sh              # dry run
scripts/install-hooks.sh --apply      # write .env files
scripts/install-hooks.sh --apply --restart  # also restart idle runners
```

`--restart` only touches idle runners. A runner mid-job reads its `.env` at
process start, so it picks up the hook on its next start.

New runners registered by `register.sh` get the hooks automatically if they
are already installed in any runner directory.

### Admission modes

| Mode | Effect |
|---|---|
| `off` (default) | Hook exits immediately. Nothing changes. |
| `observe` | Records what enforcing would have done. Never delays a job. |
| `enforce` | Queues the job FIFO until a slot frees; timeout behavior is configurable. |

Run `observe` for a week first. The Capacity tab shows every decision with
timestamps and hold durations. That is the only honest way to calibrate the
limit — setting it too low builds a queue, not a safeguard.

### Playwright rollout

Playwright jobs are disk-heavy: each runner may download several gigabytes of
browsers on first run. **Nothing in this repository enables admission or deploys
alert thresholds for you** — both stay off until an operator opts in on a live
fleet. That is deliberate:

- **`observe` first.** Hooks record what `enforce` would have done without
  delaying jobs. Playwright install steps can run 10–15 minutes; a concurrency
  limit set from guesswork will queue real work while the Capacity tab still
  shows green.
- **`enforce` only after review.** Compare held-job counts against E2E queue
  times in the Analytics tab's Playwright section and against `./cleanup.sh`
  dry-run output. Raise `FLEET_ADMIT_MIN_FREE_DISK_GB` if installs are refused
  with "disk low" while Xcode builds still start.
- **Alerts stay local.** Disk warnings mention Playwright caches in their text,
  but firing thresholds live in your daemon config — not in a commit that assumes
  your disk budget.

If admission refuses jobs with "disk low" while Xcode builds still start, raise
`FLEET_ADMIT_MIN_FREE_DISK_GB` or run `./cleanup.sh --apply` during idle windows
— see [Operations](operations.md#disk-cleanup).

**The disk floor counts purgeable space.** `df` reports macOS's purgeable caches
as used, and macOS frees them only when space actually runs short. A floor read
from `df` held every job while the system still had the room: on runner-host
`df` said 101 GB free while macOS offered 163 GB, and a held, idle fleet never
creates the pressure that would make macOS purge, so it stayed held until
someone deleted something by hand. The hook now compares
`FLEET_ADMIT_MIN_FREE_DISK_GB` against usable space (plain free plus purgeable,
as macOS reports it for important use) and keeps a lower hard floor on plain
free, `FLEET_ADMIT_MIN_PLAIN_FREE_GB` (15 GB), for the time a purge takes. The
dashboard's disk figures, verdict and forecast use the same measure.

### Admission configuration

Set in `fleet.env`. These variables cannot live in the dashboard because the
hooks run inside CI jobs and cannot reach the daemon's database.

```bash
FLEET_ADMIT_MODE=observe
FLEET_ADMIT_MAX_CONCURRENT=3
FLEET_ADMIT_MAX_WAIT_S=600
FLEET_ADMIT_TIMEOUT_ACTION=admit
FLEET_ADMIT_CANCEL_POLL_S=30
FLEET_ADMIT_MIN_FREE_DISK_GB=40
# Lanes (see above)
FLEET_ADMIT_LANES=observe
FLEET_ADMIT_TOTAL_MAX_CONCURRENT=16
FLEET_ADMIT_HEAVY_MAX_CONCURRENT=4
FLEET_ADMIT_LIGHT_MAX_CONCURRENT=12
FLEET_ADMIT_SHORT_JOB_S=90
```

See [Configuration](configuration.md) for all admission variables.

### Browser matrix burn-in: observe → enforce

The browser matrix (Playwright `web-e2e` with `matrix_cells`) runs multiple
concurrent jobs per repo — one per browser/shard cell. On a fleet with `ui-web`
runners dedicated to E2E, each cell lands on its own runner. On a shared host,
all cells from the same repo land on the same pool.

**Recommended burn-in sequence:**

1. Keep `FLEET_ADMIT_MODE=observe` for the first two weeks of matrix runs.
2. Watch the Capacity tab's E2E queue p95 and host pressure charts. Matrix runs
   for Greenfolio (6 cells) and Dozehound (4 cells) are the stress drivers.
3. Compare `.playwright-outcomes.ndjson` growth to the `test_outcomes` DB table
   (ingested each tick by the daemon).
4. When host pressure stays below "warning" on three consecutive matrix days,
   consider moving to `enforce` with `FLEET_ADMIT_MAX_CONCURRENT` set to one
   below the observed peak concurrent E2E jobs.
5. Promote advisory Firefox/WebKit legs to blocking only after each engine has
   a 14-day, 30-run history at ≥ 98% success rate with no runner-specific
   failures.

**Example matrix cell counts:**

A small suite (1–30 tests) typically runs 1 Chromium shard + 1 advisory Firefox
+ 1 advisory WebKit = 3 cells. A larger suite benefits from 2–4 Chromium shards
to keep wall time under 10 minutes; Firefox and WebKit stay at 1 cell each until
their reliability justifies sharding.

**Canary checklist** (run once after deploying the matrix workflow):

- [ ] Trigger `web-e2e` on each product repo and verify all cells start.
- [ ] Confirm `blob-*` artifacts appear for each cell; `merge-reports` produces
      a single merged HTML; `gate` passes when only advisory cells fail.
- [ ] Force a test failure in one Chromium cell and verify `gate` blocks the PR.
- [ ] Force a failure in Firefox only and verify `gate` stays green.
- [ ] Introduce a deliberate retry-pass (one failing attempt, one passing) and
      verify the test appears as flaky in the Analytics tab.
- [ ] Run `./preflight.sh` and check Playwright cache sizes are per-runner.
- [ ] Run `./cleanup.sh` (dry run) and confirm stale `__dirlock` removal is
      mentioned without errors.

## Failure behaviour

Every failure path in admission exits 0. A hook that cannot read its config,
cannot take the lock, or hits an unexpected error admits the job and logs why.
Losing a build to a bug in the throttle would cost more than the throttle
saves.
