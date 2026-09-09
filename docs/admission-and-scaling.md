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

1. It acquires a named POSIX lock (`flock`) on a shared file.
2. Counts the `Runner.Worker` PIDs currently running.
3. If count ≥ `FLEET_ADMIT_MAX_CONCURRENT`: release the lock, sleep 5 s, retry.
4. If count < limit: claim a slot by writing the PID, release the lock, exit 0.
5. If the wait exceeds `FLEET_ADMIT_MAX_WAIT_S`: admit the job anyway (exit 0).

A held job is **in progress as far as GitHub is concerned** — the wait counts
against `timeout-minutes`. Keep `FLEET_ADMIT_MAX_WAIT_S` well under the
tightest timeout in the fleet.

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
| `enforce` | Holds the job until a slot frees or the timeout elapses. |

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

### Admission configuration

Set in `fleet.env`. These variables cannot live in the dashboard because the
hooks run inside CI jobs and cannot reach the daemon's database.

```bash
FLEET_ADMIT_MODE=observe
FLEET_ADMIT_MAX_CONCURRENT=3
FLEET_ADMIT_MAX_WAIT_S=600
FLEET_ADMIT_MIN_FREE_DISK_GB=40
```

See [Configuration](configuration.md) for all admission variables.

## Failure behaviour

Every failure path in admission exits 0. A hook that cannot read its config,
cannot take the lock, or hits an unexpected error admits the job and logs why.
Losing a build to a bug in the throttle would cost more than the throttle
saves.
