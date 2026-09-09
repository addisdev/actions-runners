# Scripts

Every command-line entry point in the fleet, with the flags its code actually
parses.

One convention runs through all of them: **anything that deletes, deregisters or
rewrites is dry-run by default and needs `--apply`**. Run it once, read what it
says it would do, then run it again. The other half of that convention is that
each script states what it *refuses* to do — `cleanup.sh` will not run while a
job is in flight, `deregister.sh` will not remove a runner mid-job or leave a
repo with no CI, the reaper will not touch a directory with a live process in
it. Those refusals are the interesting part of the behaviour, so they are
documented here alongside the flags.

Scripts that only read — `status.sh`, `runs.sh`, `preflight.sh`, `health.sh`
without `--repair` — have no `--apply` because there is nothing to guard.

## Summary

| Script | What it does | Dry run by default |
|---|---|---|
| `register.sh` | Register a runner for one repo | no — creating a runner is reversible |
| `status.sh` | Every runner, its status, and what the fleet costs idle | read-only |
| `health.sh` | launchd + GitHub state per runner; `--repair` restarts dead services | read-only without `--repair` |
| `runs.sh` | What is building across every repo, and on which machine | read-only |
| `cleanup.sh` | Prune stale DerivedData, dead simulators, old `_diag` | **yes** |
| `preflight.sh` | Check a host against what the workflows assume | read-only, installs nothing |
| `scripts/deregister.sh` | Remove one named runner completely | **yes** |
| `scripts/drain-runner.sh` | Stop a runner gracefully, or resume it | no — every state it writes is reversible |
| `scripts/drain-stop-when-idle.sh` | Stop a drained runner once its job ends | internal; called by the completion hook |
| `scripts/ephemeral-runner.sh` | One job in a fresh directory, then delete it | **yes** |
| `scripts/reap-ephemeral.sh` | Remove ephemeral directories a crash left behind | **yes** |
| `scripts/install-hooks.sh` | Point every runner at the job hooks | **yes** |
| `scripts/release-check.sh` | Fail if anything host-specific reached a tracked file | read-only except `--install-hook` |
| `scripts/check-docs.sh` | Verify the docs are internally consistent | read-only |
| `scripts/test-drain.sh` | Shell tests for drain and resume | runs against a temporary fleet |
| `scripts/test-ephemeral.sh` | Shell tests for the ephemeral reaper | runs against a temporary fleet |
| `scripts/infer-checks.py` | Work out which preflight checks this fleet needs | read-only |
| `dashboard/fleetctl.sh` | Install, run and inspect the dashboard daemon | n/a — subcommands |
| `dashboard/watch/watchctl.sh` | Install, run and inspect the watchdog | n/a — subcommands |
| `dashboard/autofix/autofixctl.sh` | Install, run and inspect the auto-remediation bridge | `dryrun` subcommand |

## Fleet management

### `register.sh`

Registers a self-hosted runner for one repository: downloads the runner tarball,
verifies its checksum, configures it, and installs and starts a LaunchAgent.
Source: [`register.sh`](https://github.com/addisdev/actions-runners/blob/main/register.sh).

```bash
./register.sh owner/repo [extra-label...]
RUNNER_INSTANCE=2 ./register.sh owner/repo [extra-label...]
```

Examples:

```bash
./register.sh owner/project-ios xcode-16.3
./register.sh owner/project-web ci playwright
```

It parses no flags. The repository is the first positional argument; every
argument after it is an extra label. Multiple labels are passed to `config.sh`
as a single comma-separated `--labels` value (`ci,playwright`).

| Variable | Effect |
|---|---|
| `RUNNER_INSTANCE` | Which instance this is. `1` (the default) keeps the bare directory name; anything else appends `-<n>`, so instance 2 of `app-ios` lives in `app-ios-2`. |
| `FLEET_ROOT` | Where runners are registered. Defaults to the script's own directory, so a clone somewhere else registers into itself rather than silently building a second fleet. |
| `RUNNER_TOKEN` | A registration token supplied by the caller instead of being minted with `gh`. See the SSH note in [Get started](../getting-started.md). |

What it refuses to do:

- **It will not register on top of an existing runner.** If the target
  directory already has a `.runner` file it exits and prints the commands to
  remove that runner first, along with the `RUNNER_INSTANCE` value that would
  add another one alongside it.
- **It will not use a tarball whose checksum does not match**, and the checksum
  is verified on every run rather than only on download — a truncated or
  swapped cache is otherwise found by a runner that behaves strangely.

Two details worth knowing. The runner's `.env` is written with an explicit
`PATH` because a LaunchAgent does not inherit a login shell's, and
`ANDROID_HOME` is written only when `~/Library/Android/sdk` exists at
registration time. And the job hook lines are written for every new runner but
are inert: both hooks exit immediately unless `FLEET_ADMIT_MODE` is set in
`fleet.env`.

When `gh` cannot authenticate locally, the post-registration status check is
skipped rather than reported as a failure — `svc.sh install` and `svc.sh start`
are the real evidence that it worked.

### `status.sh`

One line per runner: repo, status, runner name, followed by the fleet's idle
cost in resident memory and its size on disk.
Source: [`status.sh`](https://github.com/addisdev/actions-runners/blob/main/status.sh).

```bash
./status.sh
```

No flags. Reads `FLEET_ROOT` from the environment or `fleet.env`. Results are
deduplicated by repository rather than by directory, because a repo with a
second runner has two directories that name the same repo.

### `health.sh`

Asks whether every runner service is actually alive and whether GitHub agrees.
Source: [`health.sh`](https://github.com/addisdev/actions-runners/blob/main/health.sh).

```bash
./health.sh           # report only
./health.sh --repair  # also restart any service that is loaded but dead
```

| Flag | Effect |
|---|---|
| `--repair` | Restart any service whose launchd state is not `running`. Recognised only as the first argument. |

It exists because no runner LaunchAgent sets `KeepAlive`. `runsvc.sh` supervises
`Runner.Listener`, so a crashed listener recovers on its own; a crashed or
OOM-killed `RunnerService.js` does not, and the only symptom is one repo's jobs
queueing forever while every other repo looks fine.

Exit status is non-zero if any runner is `DEAD`, `NOT-LOADED`, `offline`, or
unknown to the GitHub API.

What it refuses to do:

- **It will not revive a drained runner.** A runner with a `.drain` file is
  reported as drained and skipped before any launchd or GitHub check, including
  under `--repair`. A repair that undoes a deliberate drain is worse than no
  repair, and it would also set a non-zero exit that reads as "the fleet is
  unhealthy" when nothing is wrong.

### `runs.sh`

A cross-repo view of what is building, which GitHub does not offer — each repo
has its own Actions tab, so past a handful of repos there is no single page that
answers "is anything running, and where".
Source: [`runs.sh`](https://github.com/addisdev/actions-runners/blob/main/runs.sh).

```bash
./runs.sh            # one snapshot
./runs.sh --watch    # refresh every 15s until interrupted
./runs.sh --host     # group by machine instead of by repo
./runs.sh --refresh  # rediscover which repos have CI, then report
```

| Flag | Effect |
|---|---|
| `--watch` | Redraw every 15 seconds until interrupted. |
| `--host` | Attribute runs to a host rather than grouping by repo. |
| `--refresh` | Rediscover which repos have Actions before reporting, ignoring the cache TTL. |
| `-h`, `--help` | Print the usage header. |

Unrecognised arguments are ignored rather than rejected.

Runs are attributed to a *host*, not just to a runner, because after a migration
the same repo has runners on two machines. The host is read straight off the
runner name, since `register.sh` names every runner `<LocalHostName>-<repo>`.

On a machine with no runner directories of its own — a laptop watching a fleet
hosted elsewhere — it falls back to discovery:

| Variable | Effect |
|---|---|
| `FLEET_REPOS` | An explicit repo list, which always wins over discovery. Bare names get `FLEET_OWNER` prepended. |
| `FLEET_OWNER` | The account to discover repos for. Defaults to whoever `gh` is logged in as. |
| `FLEET_REPO_CACHE` | Where the discovered list is cached. Defaults to `.fleet-repos` beside the script. |
| `FLEET_REPO_CACHE_TTL` | Cache lifetime in seconds. Default `21600` (six hours). |
| `FLEET_REPO_LIMIT` | How many repos `gh repo list` returns. Default `200`. |

Discovery keeps only repos that actually have workflows, and a failed discovery
never overwrites a cache that still works.

### `cleanup.sh`

Reclaims the disk that CI quietly eats.
Source: [`cleanup.sh`](https://github.com/addisdev/actions-runners/blob/main/cleanup.sh).

```bash
./cleanup.sh            # dry run — prints what it WOULD delete, touches nothing
./cleanup.sh --apply    # actually delete
```

| Flag | Effect |
|---|---|
| `--apply` | Perform the deletions. Recognised only as the first argument. |

It removes DerivedData directories older than 7 days, simulators whose runtime
is no longer installed, runner `_diag` logs older than 14 days, and stale
Playwright `__dirlock` entries older than 6 hours when no browser install is
running. It reports Playwright cache sizes without deleting browser binaries,
and prints free disk before and after.

What it refuses to do:

- **It will not clean while any runner is busy.** Deleting DerivedData out from
  under a live `xcodebuild` produces a failure that looks like a code problem
  and is not reproducible afterwards. It names the busy runners and exits.
- **It never runs `simctl shutdown all` and never kills
  `CoreSimulatorService`.** Those close simulators the user is working in. Only
  `simctl delete unavailable` is used, which removes devices whose runtime is
  already gone and which nothing can be using.
- **It never touches a runner's `_work`.** That is where the checkouts and build
  caches live; wiping it makes every job re-clone and recompile from cold.

Dry run is the default because the build host is usually somebody's laptop too,
and everything above is shared with their interactive Xcode.

### `preflight.sh`

Checks a prospective runner host against what the fleet's workflows actually
assume. Every check corresponds to something a workflow does, so a miss is not a
warning — it is a red build later, usually with a diagnostic that points
somewhere other than the real cause.
Source: [`preflight.sh`](https://github.com/addisdev/actions-runners/blob/main/preflight.sh).

```bash
./preflight.sh            # check only what the workflows actually need
./preflight.sh --all      # check everything this script knows how to check
./preflight.sh --explain  # show what was inferred, and stop
```

| Flag | Effect |
|---|---|
| `--all` | Skip inference and run every check. |
| `--explain` | Print what was inferred from the workflows, then exit 0 without checking. |
| `-h`, `--help` | Print the usage header. |

An unknown argument exits 2. Any miss exits non-zero.

Which checks apply is inferred from the workflow YAML the dashboard has already
fetched into SQLite, read via `scripts/infer-checks.py`. Only files mentioning
`self-hosted` are consulted: a job pinned to `ubuntu-latest` runs on GitHub's
hardware and implies nothing about this Mac. With no readable database it says
so and checks everything, which is the safe direction to fail in.

| Variable | Effect |
|---|---|
| `FLEET_DB` | The dashboard database to infer from. Defaults to `dashboard/fleet.db` beside the script. |

What it refuses to do:

- **It installs nothing.** It reports and exits; every miss comes with the
  command that would fix it.
- **It will not `eval` the inference output.** The `KEY=value` lines from
  `infer-checks.py` are filtered against a known key list and a value pattern
  before being sourced, so a tampered or buggy script cannot run arbitrary code.

The Node check is unconditional rather than workflow-derived, because the
dashboard's `node:sqlite` requirement is architectural. The `gh` check requires
authentication, not merely installation. The network checks — one default route,
one primary resolver, and five successful resolutions of `codeload.github.com` —
are there because a VPN alongside the LAN makes DNS a race, and the resulting
job failure names no cause and points at GitHub rather than at the network.

## Runner lifecycle

### `scripts/deregister.sh`

Removes one runner from this host completely: stops the service, uninstalls its
LaunchAgent, deregisters it from GitHub, deletes its directory.
Source: [`scripts/deregister.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/deregister.sh).

```bash
scripts/deregister.sh <dir-name>                    # say what would happen
scripts/deregister.sh <dir-name> --apply            # do it
scripts/deregister.sh <dir-name> --apply --force    # ignore the last-runner guard
```

| Flag | Effect |
|---|---|
| `--apply` | Perform the removal. Without it, the four commands it would run are printed in order. |
| `--force` | Allow removing the only runner a repo has. |
| `-h`, `--help` | Print the usage header. |

The argument is the runner's **directory name** under the fleet root — `app-ios`,
or `app-ios-2` for a second instance — which is what `register.sh` created and
what the dashboard shows. `RUNNER_TOKEN` may supply the removal token when `gh`
cannot mint one locally.

This replaced `teardown.sh`, and the replacement is the whole point. `teardown.sh`
had one selector, `--keep <dir,dir,…>`: to remove a single runner you had to name
every *other* runner, and an empty or mistyped keep-list removed the entire
fleet. The dashboard had to reconstruct the keep-list on every call to work
around it. Naming the target directly cannot fail that way — the worst typo
removes nothing, because the name will not match a directory.

What it refuses to do:

- **It refuses an argument that is not a plain directory name.** Anything
  containing `/`, or `.` or `..` on its own, is rejected outright, so no
  argument can escape the fleet root however the script is called.
- **It refuses a runner that is executing a job.** Mid-job is the one state
  where this is actively destructive: the job dies and GitHub reports it as a
  lost runner rather than as somebody's decision, which reads like an
  infrastructure fault to whoever finds the red build.
- **It refuses to leave a repo with no runner** unless `--force` is passed. It
  counts siblings first and prints the count. This is why the autoscaler only
  ever removes second and later instances.
- **It will not delete the directory if deregistration failed.** If no
  remove-token can be minted, or `config.sh remove` fails, the directory is left
  in place and the command to retry is printed. Deleting it would orphan the
  registration on GitHub, where it shows as an offline runner that nothing on
  this host can remove.

### `scripts/drain-runner.sh`

Marks one runner as draining or drained, and stops or restarts its service.
Source: [`scripts/drain-runner.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/drain-runner.sh).

```bash
scripts/drain-runner.sh <dir-name>            # show current drain state
scripts/drain-runner.sh <dir-name> --drain    # stop if idle, mark draining if busy
scripts/drain-runner.sh <dir-name> --stop     # stop the service immediately
scripts/drain-runner.sh <dir-name> --resume   # clear the marker and start the service
```

| Flag | Effect |
|---|---|
| *(none)* | Print the drain state and change nothing. |
| `--drain` | Idle: write a `drained` marker and stop the service. Busy: write a `draining` marker plus a `.drain-stop` flag, and let the completion hook stop it after the job. |
| `--stop` | Write a `drained` marker and stop the service now, busy or not. |
| `--resume` | Remove both markers and start the service. |
| `-h`, `--help` | Print the usage header. |

Not dry-run by default, unlike the destructive scripts: every state it writes is
undone by `--resume`. Note that with no flag at all it only *reports* — draining
is always something you ask for explicitly.

It refuses an argument that is not a plain directory name, and a directory with
no `.runner` file, on the same reasoning as `deregister.sh`.

Two behaviours are worth knowing. A drained runner is **not** deregistered from
GitHub: it stays on the roster and continues to show as `online` until it misses
enough heartbeats, because GitHub has no temporary-disable API. And draining a
*busy* runner depends on `ACTIONS_RUNNER_HOOK_JOB_COMPLETED` being configured —
without the hook the intent is recorded and the dashboard shows it, but the
service is not stopped until someone drains the runner again while it is idle.
See [Operations](../operations.md#draining-a-runner-for-maintenance).

### `scripts/drain-stop-when-idle.sh`

Stops a runner's service once it is no longer executing a job.
Source: [`scripts/drain-stop-when-idle.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/drain-stop-when-idle.sh).

```bash
scripts/drain-stop-when-idle.sh <runner-dir> [timeout-seconds]
```

Two positional arguments, no flags. The timeout defaults to **3600** seconds.

Called **detached** by `hooks/job-completed.sh` when a `.drain-stop` flag is
present, and never in the foreground from a hook. The reason is specific: the
completion hook runs as a child of `Runner.Worker`, and the worker has not yet
reported the job's result when the hook runs. `svc.sh stop` unloads the
LaunchAgent, tearing down the listener and the worker under it — so stopping
from inside the hook kills the process that was about to say "this job passed",
and the job shows on GitHub as a lost runner: a red build whose steps all
succeeded, caused by the drain rather than by the code.

What it refuses to do:

- **It will not stop a runner whose drain was cancelled.** The `.drain-stop`
  flag is checked before the wait and again after it, so a `--resume` during the
  wait wins.
- **It will not wait forever.** On reaching the timeout it exits, leaving the
  drain marker showing `draining` and the flag in place so the next completed
  job tries again. A wedged job is exactly the sort of thing someone is draining
  a runner to deal with.

On success it stops the service, removes the flag, and rewrites the marker from
`draining` to `drained`, which is what the dashboard reads to stop showing the
operation as in progress.

### `scripts/ephemeral-runner.sh`

Registers a one-job runner in a fresh directory, waits for the job, and then
removes the directory.
Source: [`scripts/ephemeral-runner.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/ephemeral-runner.sh).

```bash
scripts/ephemeral-runner.sh owner/repo [extra-label]           # show what it would do
scripts/ephemeral-runner.sh owner/repo [extra-label] --apply
```

| Flag | Effect |
|---|---|
| `--apply` | Actually create the runner and wait for a job. Without it, the plan is printed and nothing is created. |
| `-h`, `--help` | Print the header comment as help. |

The repo is positional; any other non-flag argument is taken as the extra label.
An unknown `-`-prefixed argument exits 1.

GitHub's `--ephemeral` makes the runner take exactly one job and then deregister
itself. GitHub removes the *registration*; nothing removes the *directory*,
which is the part that matters — a fleet that creates ephemeral runners and
never cleans up leaves a 121 MB unpacked runner plus a full checkout behind for
every job it ran. So this script owns the whole lifecycle and runs in the
foreground: a backgrounded version cannot clean up after itself if the caller
goes away.

The runner version and checksum are read out of `register.sh` rather than
duplicated, and the tarball comes from the same cache the persistent runners use.

What it refuses to do:

- **It refuses a repo that is not `owner/name`.**
- **It refuses to delete a path that does not look like one it created.** The
  `EXIT`/`INT`/`TERM` trap only removes directories under `.ephemeral/`, and
  says so if handed anything else.
- **It does not use `--replace`.** An ephemeral runner's name is unique by
  construction, and `--replace` on a colliding name would evict a runner
  somebody else is using.

Before deleting, the trap tries to remove the registration from GitHub, so an
interrupted run does not leave a permanently offline runner for someone to clean
up by hand.

Not for routine CI: unpacking the runner and cloning from scratch costs minutes
per job. See [Ephemeral runners](../ephemeral-runners.md).

### `scripts/reap-ephemeral.sh`

The backstop for ephemeral directories nothing owns any more.
Source: [`scripts/reap-ephemeral.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/reap-ephemeral.sh).

```bash
scripts/reap-ephemeral.sh                          # show what would be removed
scripts/reap-ephemeral.sh --apply
scripts/reap-ephemeral.sh --apply --min-age-hours 1
```

| Flag | Effect |
|---|---|
| `--apply` | Remove the candidates. |
| `--min-age-hours <n>` | Minimum directory age to consider. Default **2**. Must be a whole number, or the script exits 1. |
| `-h`, `--help` | Print the header comment as help. |

`ephemeral-runner.sh` already cleans up after itself, but from a trap — and a
trap cannot run if the process was `SIGKILL`ed, if the machine lost power, or if
the OOM reaper took it, which on a 16 GB machine running Xcode is a real event.
Each of those leaves a directory holding an unpacked runner and a full checkout
that nothing else will ever remove.

What it refuses to do:

- **It refuses a directory with a live process in it.** This is the check that
  makes the script safe to run from a timer: without it, a sweep during a
  40-minute build would delete the build.
- **It refuses a directory younger than the minimum age.** Registration takes a
  while, and there is a window where the directory exists and `run.sh` has not
  started yet.
- **It refuses to delete a path outside `.ephemeral/`.**
- **A missing `.ephemeral` directory is not an error** — it exits 0 saying
  nothing has run an ephemeral runner on this host.

When a reaped directory still has a `.runner` file, its registration is removed
from GitHub first, so it does not linger there as a permanently offline runner.
Scheduling is covered in [Ephemeral runners](../ephemeral-runners.md#scheduling-the-reaper).

## Hooks

### `scripts/install-hooks.sh`

Points every registered runner at the fleet's job hooks by rewriting the
`ACTIONS_RUNNER_HOOK_JOB_STARTED` and `ACTIONS_RUNNER_HOOK_JOB_COMPLETED` lines
in each runner's `.env`.
Source: [`scripts/install-hooks.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/install-hooks.sh).

```bash
scripts/install-hooks.sh                    # show what would change
scripts/install-hooks.sh --apply            # write it
scripts/install-hooks.sh --apply --restart
scripts/install-hooks.sh --remove --apply
```

| Flag | Effect |
|---|---|
| `--apply` | Write the changes. Without it nothing is written. |
| `--remove` | Strip the hook lines instead of adding them. |
| `--restart` | Stop and start each changed runner's service, so the new `.env` is definitely picked up. |
| `-h`, `--help` | Print the header comment as help. |

An unknown argument exits 1. Runners already pointing at the right hooks are
counted as skipped rather than rewritten.

The hooks serve two features that behave differently, and the script says so
before the dry-run exit rather than after it, because an operator planning a
rollout is exactly who needs to know:

- **Job admission is inert** until `FLEET_ADMIT_MODE` is set in `fleet.env`.
  Rolling a hook out to a fleet and turning it on are two decisions, and the
  second one is the one that can cost a build.
- **Draining a busy runner** needs the completion hook and works as soon as it
  is installed, with no opt-in. It does nothing until somebody asks for a drain,
  and only acts on the runner they asked about.

What it refuses to do:

- **It refuses to restart a runner that is mid-job.** Those are collected and
  named at the end, with the suggestion to re-run `--restart` when they are idle.
- **It will not leave a truncated `.env` behind.** Each file is rewritten via a
  temp file in the same directory and moved into place, because a half-written
  `.env` strips the runner's `PATH` and breaks every job on it.

### `hooks/job-started.sh`

Runs before a job's first step. This is the only place in the fleet where code
runs *before* a job is allowed to begin, which is what makes admission control
possible at all.
Source: [`hooks/job-started.sh`](https://github.com/addisdev/actions-runners/blob/main/hooks/job-started.sh).

Nothing in the fleet throttles execution — there is no scheduler, every
registered runner listens independently, and if 27 of them are offered work in
the same second, 27 jobs start. The dashboard's `ceiling` only refuses to *add* a
runner; it cannot stop a burst across runners that already exist. This hook can.

Behaviour by `FLEET_ADMIT_MODE`:

| Mode | What the hook does |
|---|---|
| `off` (default) | Exits immediately. Anything unrecognised also means `off`, because a misspelled mode reading as `enforce` would be the most expensive interpretation of a typo. |
| `observe` | Takes a slot so the count stays honest, never delays anything, and logs whether enforcing *would* have held this job. |
| `enforce` | Holds the job until there is room, bounded by `FLEET_ADMIT_MAX_WAIT_S`, then admits it anyway and logs the wait. |

A job is held when the live slot count has reached `FLEET_ADMIT_MAX_CONCURRENT`
or free disk is below `FLEET_ADMIT_MIN_FREE_DISK_GB`. Every decision is appended
as one NDJSON line to `dashboard/logs/admission.ndjson`, which `fleetd` ingests
on its slow tick — a log file rather than a direct SQLite write, because the
daemon holds that database open and a second writer appearing from inside a CI
job is a race nobody wants to debug. Defaults are listed in
[Configuration](../configuration.md#job-admission-variables).

What it refuses to do:

- **It can never fail a job.** A non-zero exit from a job-started hook fails the
  job before its first step, so an admission controller that errored would turn
  every build on the host red at once. There is no `set -e` and there is a
  `trap 'exit 0' EXIT`: every unexpected condition means "let the job run".
- **It will not let a contended mutex stop CI.** If the lock cannot be taken the
  job is admitted without counting, and the log line says so.
- **It will not hold a job indefinitely.** A held job is `in_progress` as far as
  GitHub is concerned, so the hold burns the job's own `timeout-minutes`. On
  reaching the bound the job is admitted regardless.

Slots are files rather than a `pgrep` count, because the hook is itself a child
of the `Runner.Worker` about to run the job — five held jobs counting worker
processes would each see the other four plus themselves, all conclude the host
is full, and all wait out the timeout together. Each slot records the PID of the
worker that owns it, so a job killed with `SIGKILL` has its slot reaped by the
next admission instead of leaking concurrency permanently.

### `hooks/job-completed.sh`

Runs after a job's last step. Its main job is to give back the slot
`job-started.sh` took, so the next queued job can start.
Source: [`hooks/job-completed.sh`](https://github.com/addisdev/actions-runners/blob/main/hooks/job-completed.sh).

It also handles drain, and does so **before** the admission-mode check, because
a drain has nothing to do with admission and must work on a fleet that never
turned admission on. It identifies the runner's directory from
`RUNNER_WORKSPACE` (falling back to `GITHUB_WORKSPACE` for older runner
versions), and if a `.drain-stop` flag is there it launches
`scripts/drain-stop-when-idle.sh` detached and returns immediately.

The slot release records how long the slot was occupied and logs it as `ran_s`,
which is the job's execution time as the host saw it — GitHub's own duration
includes the queue.

Same rule as the started hook: **it can never fail a job.** A non-zero exit here
marks a job failed after its steps have already succeeded, which is the most
confusing possible outcome — a green build reported red by its own cleanup. The
PID check on each slot means a leaked slot is reclaimed even if this hook never
runs at all; this is the fast path, not the only path.

## Maintenance and release

### `scripts/release-check.sh`

Fails if anything host- or account-specific reached a tracked file.
Source: [`scripts/release-check.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/release-check.sh).

```bash
scripts/release-check.sh                # every tracked file
scripts/release-check.sh --staged       # only what is about to be committed
scripts/release-check.sh --list         # print what it looks for, and stop
scripts/release-check.sh --install-hook # run --staged on every commit
scripts/release-check.sh --offline      # skip the gh lookups, check the rest
```

| Flag | Effect |
|---|---|
| `--staged` | Check the staged content from the index rather than the working tree. The point of a pre-commit hook is to judge what is about to be committed, which is not always what is on disk. |
| `--list` | Print the derived patterns and exit 0. |
| `--install-hook` | Write `.git/hooks/pre-commit` to run `--staged`. The only thing this script writes. |
| `--offline` | Accept that `gh` could not be reached and check only what is derivable from this machine. |
| `-h`, `--help` | Print the usage header. |

An unknown argument exits 2.

What it looks for is derived from the machine — serial number, username,
`LocalHostName`, `ComputerName`, the `gh` login, the repos this host serves, and
every repo the account owns — never from a list kept in the file. A hardcoded
list of forbidden strings would go stale the moment a repo was renamed, and
could not ship in a public repo without publishing the very strings it was
hiding. Patterns shorter than 4 characters are dropped, as are generic CI
usernames (`runner`, `ubuntu`, `admin`, and similar) that would otherwise match
almost every line in a codebase about GitHub Actions runners. This repo's own
owner and name are stripped from each line before matching, so the README's own
`git clone` line is not reported every time.

What it refuses to do:

- **It refuses to report a pass it did not actually perform.** If no patterns
  could be derived it exits 1 rather than printing a green line.
- **It refuses to run when `gh` could not list the account's repos**, unless
  `--offline` says the caller knows. Those names are most of what it checks for,
  so a pass without them would be meaningless. A refusal is recoverable; a false
  pass is what the script exists to prevent.

Matching uses `grep -F`, so a repo name containing a `.` cannot become a
wildcard that matches a name it merely resembles.

### `scripts/check-docs.sh`

Verifies the documentation is internally consistent. Safe to run offline; no
flags.
Source: [`scripts/check-docs.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/check-docs.sh).

```bash
scripts/check-docs.sh
```

Four checks, and it exits non-zero if any fails:

1. Every internal Markdown link in a tracked `.md` file resolves to a file that
   exists. Paths in `.github/` are resolved from the repo root, because that is
   how GitHub renders them. **No file is exempt.** One used to be, and the
   exemption outlived the reason for it — a file excluded from a link check is
   a file whose links rot silently.
2. Every tracked script appears on this page. The check used to be the other
   way round, against a hand-maintained array of twelve names, which caught the
   direction that never breaks — a documented script is deleted — and missed
   the one that always does. Nine scripts had reached the tree undocumented by
   the time anyone looked.
3. Every `FLEET_*` and `RUNNER_INSTANCE` variable in `fleet.env.example` is
   mentioned in `docs/configuration.md`.
4. Example workflows target `self-hosted` and pin actions to a full SHA.

Three files are named as deliberate exceptions to check 2 — `hooks/common.sh`,
`hooks/tests/install.sh` and `autofix/escalate/run.mjs` — because each is
sourced or spawned by something else rather than run by a person. They are
listed individually rather than matched by a pattern, so that adding one is a
decision somebody makes in a diff.

There is deliberately no check that every script named on this page exists,
because this page names `teardown.sh`, which was removed and is described here
as history, and `config.sh`, `svc.sh` and `runsvc.sh`, which ship inside each
runner directory and are never tracked. A check that has to special-case those
is a check that gets silenced rather than fixed.

### `scripts/test-drain.sh`

Shell tests for drain, resume, and unsafe-path handling. No flags.
Source: [`scripts/test-drain.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/test-drain.sh).

```bash
scripts/test-drain.sh
```

It builds a fake fleet in a temporary directory — real `.runner` files and a stub
`svc.sh` that records what it was asked to do instead of talking to launchd — and
drives the real scripts against it with `FLEET_ROOT` pointed at the temp
directory. Nothing touches the live fleet.

The stub is the design: the thing worth testing is that `drain-runner.sh` calls
`stop` at the right moment and does not call it at the wrong one, and a stub
that appends to a log file answers exactly that, against the real script rather
than a copy of its logic. Most of the assertions are about refusals — that a
busy runner is not interrupted, that `health.sh --repair` does not revive a
drained runner, that `../escape` and `a/b` are rejected. Exits non-zero if any
test fails.

### `scripts/test-ephemeral.sh`

Shell tests for the ephemeral runner reaper. No flags.
Source: [`scripts/test-ephemeral.sh`](https://github.com/addisdev/actions-runners/blob/main/scripts/test-ephemeral.sh).

```bash
scripts/test-ephemeral.sh
```

Same approach and the same emphasis: the reaper deletes directories, so the
tests that matter are the ones proving it refuses to — a directory with a live
process in it, one younger than the minimum age, one protected by a raised
`--min-age-hours`. It also checks that `ephemeral-runner.sh` creates nothing
without `--apply` and rejects a repo that is not `owner/name`.

### `scripts/infer-checks.py`

Works out which of `preflight.sh`'s checks this fleet's workflows actually need.
Source: [`scripts/infer-checks.py`](https://github.com/addisdev/actions-runners/blob/main/scripts/infer-checks.py).

```bash
python3 scripts/infer-checks.py <path-to-fleet.db>
```

One positional argument, no flags. Called by `preflight.sh`; rarely run by hand.

It reads workflow YAML out of the dashboard's `workflow_files` table, keeps only
files mentioning `self-hosted`, and prints shell assignments — `NEED_XCODE`,
`NEED_XCODEGEN`, `NEED_WATCHOS`, `NEED_SIM`, `NEED_NODE`, `NEED_DOCKER`,
`NEED_ANDROID`, `NEED_POSTGRES`, `PG_VERSIONS`, `INFERRED_FROM`. Postgres
versions are whatever the workflows name, never a default.

It is a separate file rather than a heredoc inside `preflight.sh` because
`/bin/bash` on macOS is still 3.2, which mis-parses a heredoc inside command
substitution. It opens the database read-only, since the dashboard daemon is very
likely writing to it, and it **exits non-zero printing nothing** when there is no
usable data — the caller then checks everything, which is the safe direction to
fail in.

Matching is substring matching on lowercased YAML rather than a YAML parse,
because the interesting facts live inside `run:` shell blocks, where a parser
gives you one long string and no more structure than this does.

## Dashboard daemons

Each of the three control scripts generates its LaunchAgent plist rather than
shipping one, because the paths are user- and version-specific and a hardcoded
`/Users/<someone>` fails silently a month later. All three take the LaunchAgent
label prefix from `FLEET_LABEL_PREFIX` (default `com.runner-fleet`), read from
`fleet.env` — changing it renames the agent, and a mismatch makes a daemon that
is running perfectly well look absent.

### `dashboard/fleetctl.sh`

Installs, runs and inspects the dashboard daemon.
Source: [`dashboard/fleetctl.sh`](https://github.com/addisdev/actions-runners/blob/main/dashboard/fleetctl.sh).

| Subcommand | What it does |
|---|---|
| `install` | Write the LaunchAgent plist, load it, and report status. |
| `uninstall` | Unload the agent and delete the plist. |
| `start` / `stop` | Load or unload the agent. |
| `restart` | Unload, load, and report status. |
| `status` | **The default.** launchd PID and last exit status, plus the daemon's `/api/health` summary. |
| `logs [n]` | Tail the daemon log. Default 60 lines. |
| `run` | Run `fleetd.js` in the foreground, for debugging. |
| `token` | Print the control token. Exits 1 if the daemon has not generated one yet. |

Anything else prints the usage header and exits 1.

The plist sets `KeepAlive`, unlike the runner plists — `health.sh` exists
precisely because theirs do not, and a monitoring daemon that dies quietly is
worse than no monitoring daemon. `FLEET_PORT` (default `7878`) is baked into the
plist along with the resolved `node` path and `gh`'s directory, because launchd
gets a minimal `PATH`.

The control token is deliberately not served to the page: read access and the
right to restart runners are different things. Paste it into the Control tab
once and the browser keeps it. Note that `run` over SSH will fail to get a GitHub
token — see the SSH note in [Get started](../getting-started.md).

### `dashboard/watch/watchctl.sh`

Installs, runs and inspects the fleet watchdog.
Source: [`dashboard/watch/watchctl.sh`](https://github.com/addisdev/actions-runners/blob/main/dashboard/watch/watchctl.sh).

| Subcommand | What it does |
|---|---|
| `install` | Write the LaunchAgent plist, load it, and report status. |
| `uninstall` | Unload the agent and delete the plist. |
| `start` / `stop` | Load or unload the agent. |
| `restart` | Unload, load, and report status. |
| `status` | **The default.** launchd state, the last log line, and how many faults have been reported. |
| `logs [n]` | Tail the watch log. Default 60 lines. |
| `problems` | Print only the `FLEET_PROBLEM`, `FLEET_UNREACHABLE` and `FLEET_RECOVERED` transitions. Says so explicitly when there are none. |
| `run` | Run `fleet-watch.mjs` in the foreground, for debugging. |

Its `node` lookup deliberately tries `/opt/homebrew/bin/node` and
`/usr/local/bin/node` *before* `command -v node`, which is the opposite of what
`fleetctl.sh` does. Whoever runs the installer probably has nvm active, and
nvm's node path embeds its version — baking that into a plist means the watchdog
stops surviving reboots the day that version is uninstalled, silently, months
later, which is the failure mode a watchdog least wants.

Its `ThrottleInterval` is 30 rather than 10: if it cannot start, retrying twice a
minute only fills the log faster than anyone will read it.

### `dashboard/autofix/autofixctl.sh`

Installs, runs and inspects the auto-remediation bridge.
Source: [`dashboard/autofix/autofixctl.sh`](https://github.com/addisdev/actions-runners/blob/main/dashboard/autofix/autofixctl.sh).

| Subcommand | What it does |
|---|---|
| `install` | Write the LaunchAgent plist, load it, and report status. |
| `uninstall` | Unload the agent and delete the plist. |
| `start` / `stop` | Load or unload the agent. |
| `restart` | Unload, load, and report status. |
| `status` | **The default.** launchd state, plus the bridge's `/status`: whether it is in dry-run mode, how many alerts it is tracking, and which have exhausted their attempts and need a human. |
| `logs [n]` | Tail the bridge log. Default 60 lines. |
| `run` | Run `bridge.js` in the foreground. |
| `dryrun` | Run `bridge.js` in the foreground with `AUTOFIX_DRY_RUN=1` — it decides but never acts. |
| `ping` | POST an empty alert to the bridge, as if one had fired. |
| `wire` | Point `fleetd`'s alert webhook at this bridge, preserving anything else already in `alerts.config.json`, then tell you to restart the dashboard. |

`AUTOFIX_PORT` defaults to `7879`; the bridge is given `FLEET_URL` pointing at
`127.0.0.1:$FLEET_PORT`. It resolves a stable `node` path for the same reason
`watchctl.sh` does.

### `dashboard/autofix/fleet-action.sh`

The only way the auto-remediation bridge can act on the fleet.
Source: [`dashboard/autofix/fleet-action.sh`](https://github.com/addisdev/actions-runners/blob/main/dashboard/autofix/fleet-action.sh).

```bash
./fleet-action.sh <action-id> ['{"json":"args"}']
```

The bridge decides *when* to act; this decides *what may ever be acted on*. Those
are separate files on purpose — the complete set of things an unattended process
can do to the fleet should be one short list you can read in a few seconds, not
something reconstructed by following control flow through a daemon. It also keeps
the control token out of the daemon holding an open socket.

The allowlist is `fleet.health`, `fleet.healthRepair`, `fleet.status`,
`fleet.preflight`, `fleet.cleanupPreview`, `runner.restart` and `run.rerun`. Each
is read-only or idempotent and reversible.

What it refuses to do:

- **Anything not on the list**, matched exactly — no globbing and no prefix
  matching, because a prefix rule accepting `fleet.cleanup` would accept
  `fleet.cleanupApply`. It exits 77 and tells the caller to report the alert to
  an operator rather than work around it.
- `fleet.cleanupApply`, `runner.register` and `runner.deregister` are absent
  deliberately; adding one is a decision, not a config tweak.
- `run.cancel` is absent for a subtler reason: cancelling looks harmless, but the
  fleet's analytics treat a cancelled run as unmeasurable, so anything cancelling
  automatically would quietly corrupt the duration percentiles it is judged by.

The request body is built here rather than accepted from the caller, so the
arguments can never override the action field that just passed the allowlist
check.

### `dashboard/autofix/escalate.sh`

The only way the bridge can ask an agent about an alert.
Source: [`dashboard/autofix/escalate.sh`](https://github.com/addisdev/actions-runners/blob/main/dashboard/autofix/escalate.sh).

```bash
./escalate.sh '<alert-json>'
./escalate.sh --login    # sign in with an existing Cursor account
./escalate.sh --verify   # check the credential actually works
```

Escalatable rules are `newly-failing`, `stuck-queue`, `label-mismatch`, `orphan`
and `no-listener`. What qualifies a rule is that answering it requires *reading*
something — a workflow file, an annotation, a percentile — rather than running
something; if the answer is a known shell command it belongs in
`fleet-action.sh`'s allowlist instead.

What it refuses to do:

- **It refuses `launchd-dead`, `launchd-missing` and `offline`.** Those have a
  deterministic repair that autofix owns, and escalating one would pay a model to
  narrate a fix that is already running, racing the repair it describes.
- **It refuses any other rule not on the escalatable list**, and it parses the
  alert JSON to find the rule rather than pattern-matching, so a rule name
  appearing inside a workflow title cannot smuggle an alert past the allowlist.
- **It refuses a world-readable credential file** rather than quietly using it.
- **It refuses to run with no credential at all**, printing both ways to create
  one.

`--verify` exists because of how this path failed before: the key was present,
the daemon looked installed, and every run died on authentication for four days
before anyone noticed there had been no diagnoses. It reports the credential
source and warns when a stored login is within 14 days of expiry.

## See also

- [Configuration](../configuration.md) — every variable these scripts read
- [Operations](../operations.md) — when to run which of them
- [Admission control and autoscaling](../admission-and-scaling.md) — what the
  hooks are for
- [HTTP API](../api.md) — the actions `fleet-action.sh` calls
