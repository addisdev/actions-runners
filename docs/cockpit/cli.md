# Command line

`cockpit` gives scripts and agent sessions the same verdict the menu bar shows.
[Install it](install.md#install-the-command-line) on your `PATH`, or run it from
the repository with `swift run cockpit …` inside `cockpit/`.

```
cockpit <command> [options]
```

## Where the answer comes from

Every command that reads the fleet takes the cheapest source that is
trustworthy, in this order:

1. **`--fixture <name>`**: a bundled recorded incident, no network at all.
2. **The app's snapshot** at
   `~/Library/Application Support/FleetCockpit/glance.json`, when it is under
   90 seconds old and you did not pass `--fresh`, `--url` or `--via`. This
   answers in milliseconds and opens nothing.
3. **Its own connection**: `--url` directly, otherwise an SSH tunnel through
   `--via` aliases (default `ultra`, then `ultra-ts`), exactly as the app
   would open one.

The human output always ends with the route it used, for example
`via app (ultra, 12s ago)` or `via ultra-ts`.

`why`, `wait`, `run` and `mcp` ask the dashboard's [`/api/v1`](../api.md#version-1-apiv1)
instead, over the same route, and never read the snapshot or a fixture. The
daemon does the work: it diagnoses the repo, decides when checks are done and
finds orphaned jobs, and these commands print its answer. A dashboard older
than `/api/v1` gets the message to update actions-runners on the host.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Machine-readable output (pretty-printed, sorted keys) |
| `--fixture <name>` | Use a bundled fixture instead of the live fleet (`cockpit fixtures` lists them) |
| `--via <alias>` | SSH alias to tunnel through; repeat for a fallback list. Default `ultra`, `ultra-ts` |
| `--url <url>` | Reach the dashboard directly, for example over Tailscale Serve |
| `--fresh` | Ignore the app's snapshot and connect now |
| `--port <n>` | The dashboard's port on the host, for `sentinel`. Other commands tunnel to 7878; use `--url` for a dashboard on another port |
| `-h`, `--help` | Usage |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Fine, or healthy waiting |
| `1` | A real fault (a `warning` or `critical` verdict), a red check, or a failed action |
| `2` | `wait`: waiting is pointless. `run`: refused without `--yes` |
| `3` | Nothing could be read, or `wait` timed out |
| `64` | Usage error (a missing argument, an unknown command) |

## `cockpit status`

The fleet verdict, one screen.

```console
$ cockpit status
✖ Disk floor is holding jobs
  3 jobs held because free disk is under the admission floor. It looks like load; it is disk.
  · 36.6 GB free, floor 40 GB
  · 3 jobs held at Set up runner: comet-web, comet-backend, ember-ios
  · Waiting does not fix this; freeing disk does
  → Preview cleanup
  0 running, 0 queued, 3 held, 54 runners · via app (ultra, 4s ago)
```

The mark is `✔` for ok and info, `▲` warning, `✖` critical, `?` unknown. `→` is
the next move, with its command or URL when it has one.

`--json` prints `{ verdict, route, counts }`, where `verdict` is the glance's
[verdict object](verdict.md) and `counts` is
`{ running, queued, held, runners }` (absent when nothing could be read).

Exit code: from the verdict's tone (`0`, `1` or `3`).

When the daemon's last finished tick is more than 4 minutes old, `status` (and
`why`) say **Collector stalled** and exit `3` rather than repeat the old verdict:
an app still connected to a stalled collector keeps rewriting its snapshot with
the last glance, whose "Working" may have been true half an hour ago. See
[Verdict reference](verdict.md#collector-stalled).

## `cockpit why <repo>`

Everything the fleet knows about one repository, from
[`GET /api/v1/repos/{owner}/{repo}/diagnosis`](../api.md#version-1-apiv1).
`<repo>` is `owner/name`, or `name` when only one repository the fleet serves
has that name.

```console
$ cockpit why comet-web
Fleet: ▲ Host is saturated

comet-web: 3 runner(s)
  lost          build-host-comet-web  lost contact mid-job 5 min ago
  busy          build-host-comet-web-2  web-e2e · e2e / e2e / webkit · 3 min of ~75 min
  idle          build-host-comet-web-3  idle

Checks:
  develop @ 8c10c20: 1 of 2 done, done in 40m–70m

Failed in the last 2 hours:
  web-e2e: Runner lost contact — the host, not the code  [not your code]
```

And for a repo whose run is simply waiting:

```console
$ cockpit why ember-ios
Fleet: ✔ Working

ember-ios: 4 runner(s)
  idle          build-host-ember-ios  idle
  …

Queued:
  ios-ci — 9m, behind a busy runner (medium); starts in 4m–11m
    · all 4 matching runners are busy
    → Wait, or add a runner.
```

Sections appear only when they have something in them. A repo with no runners
says so: its jobs can only queue. Each queued run shows its age, the cause in
words with the classifier's confidence, and the ETA; under it, `·` lines are the
classifier's evidence and `→` its recommendation.

A job [orphaned by a draining runner](#a-job-orphaned-by-a-draining-runner)
gets its own section, with the commands that end it:

```console
Orphaned (the runner went away while the job was finishing):
  build: orphaned by a draining runner — not your code. Every step passed, then MACSERIAL0-lake-api (draining) went away; stuck at "Complete job" for 12 min.
    gh api -X POST repos/addisdev/lake-api/actions/runs/38318681067/force-cancel
    # about a minute later, once the run shows completed:
    gh run rerun 38318681067 -R addisdev/lake-api
```

`--json` prints the daemon's diagnosis as it sent it: `verdict`, `runners`,
`queue`, `runs`, `recent`, `failures`, `checks`, `orphans`, `incidents` and
`freshness`.

Exit code: from the **fleet** verdict's tone, so `why` in a script still fails
when the fleet is broken; `3` when nothing could be read or the dashboard's view
is stale.

## `cockpit queue`

Every queued run, oldest first, with cause and ETA.

```console
$ cockpit queue
9m     ember-ios · ios-ci — behind a busy runner; starts in 4m–11m · done in 26m–41m
```

`--json` prints the glance's `queue` array. Exit code `0`, or `3` when nothing
could be read.

## `cockpit wait`

Blocks until a commit's checks finish. Built for scripts and agent sessions that
would otherwise run `gh pr checks --watch`, which waits forever on a check that
will never start.

```
cockpit wait <repo> [--pr N | --sha S | --branch B] [--timeout 45m] [--recover]
```

| Option | Meaning |
|---|---|
| `--pr N` | The pull request's head commit |
| `--sha S` | A specific commit |
| `--branch B` | The branch's latest commit |
| `--timeout` | `90s`, `45m`, `2h`, or a bare number of minutes. Default `45m` |
| `--recover` | With `--pr` only: force-cancel and re-run this PR's [orphaned](#a-job-orphaned-by-a-draining-runner) runs instead of stopping |

`wait` asks [`GET /api/v1/repos/{owner}/{repo}/checks`](../api.md#waiting-on-checks),
which the daemon holds open for up to 5 minutes until the checks finish, and
asks again until `--timeout`. The rules below are the daemon's
(`dashboard/lib/checks.js`). Progress goes to stderr, once per change:

```console
$ cockpit wait comet-web --pr 96
… comet-web PR #96: 2 of 5 done, done in 11m–26m
… comet-web PR #96: 4 of 5 done, done in 3m–8m
✔ comet-web PR #96: 5 of 5 done
```

| Exit | Printed | Meaning |
|---|---|---|
| `0` | `✔` | Every check passed, and GitHub confirms every run and job for the head finished (see [a green is confirmed on GitHub](#a-green-is-confirmed-on-github)) |
| `1` | `✖` and each failed check, with its URL | At least one failed or was cancelled. A cancellation is often an admission hold that ran past `timeout-minutes`, and the output says so |
| `2` | `⏹ not waiting — <reason>` | Waiting cannot end well: the host is down, the disk floor is holding jobs, GitHub is refusing jobs for billing, one of the checks is queued with a cause that never clears, or a job was orphaned by a draining runner (the reason carries the recovery commands). Stop and report the reason |
| `3` | `…timed out` or `? dashboard unreachable` | The timeout passed, or (for `--sha` and `--branch`) the dashboard could not be reached; try `cockpit sentinel` |

The deadline is the command line's own: each request asks the daemon to hold
no longer than the time left, and a last backstop exits `3` thirty seconds
past the deadline whatever else is happening. A dashboard that stops answering
does not end the wait. The tunnel is reopened and the request retried every 10
seconds, and with `--pr` cockpit asks GitHub itself meanwhile, once a minute,
with your own `gh` login
(`gh pr view --json headRefOid,statusCheckRollup`, the branch ref, and
`actions/runs?head_sha=`). GitHub's finished answer, by the same rule as
[a confirmed green](#a-green-is-confirmed-on-github), ends the wait and says so:

```console
✔ comet-web PR #96: 1 of 1 green (from GitHub)
```

A `--sha` or `--branch` wait needs the dashboard, and exits `3` when it cannot
be reached at the start.

### `--pr` judges the head commit

With `--pr`, the answer is the PR's **head** commit, never an older commit's
result. A red from a commit you have since pushed over, or force-pushed off,
does not end the wait. Until the head has a run, the wait keeps waiting. After a
force-push back to an earlier commit, that commit's old result waits for the new
run ("waiting for kit-ci to run again on this commit").

### A green is confirmed on GitHub

The fleet's view rolls up the runs it has seen, and right after a push it has
not seen them all. On acme/stream-app PR #5 (2026-10-24) a wait that
started 8 seconds after a push printed `1 of 1 green` at once: the view still
held the previous head's run, and the new head's run, with nine jobs, was
queued. Every agent merges on exit `0`, so that could merge untested code.

Now GitHub names the head (an open PR's branch ref), and a green ends the wait
only when GitHub has, for that head:

- every workflow run (`actions/runs?head_sha=`) completed, the newest of each
  workflow counting;
- every job of those runs, and every other check and status, completed with
  `success`, `skipped` or `neutral`;
- nothing new for 30 seconds: runs for `push` and `pull_request` register
  separately, a `workflow_run` run appears only after the run it follows, and
  a job behind `needs:` only once its needs finish.

Until then the wait prints GitHub's count and reason:

```console
… stream-app PR #5: 2 of 3 done
… stream-app PR #5: 9 of 9 done — settling: GitHub's newest run or job for d42a20f changed 4 s ago, and a green waits 30 s for any run still to register
✔ stream-app PR #5: 1 of 1 green (GitHub: 1 run, 9 jobs)
```

GitHub not answering is not a yes: the wait stays pending. With a dashboard
older than this rule (no `verified` in its answer), the CLI confirms the green
itself with your `gh` login.

### A red is checked against the run's latest attempt

A re-run (`gh run rerun`, with or without `--failed`) keeps the run id, and the
fleet's view can still hold the attempt it retries for a tick or more. So
before a red ends the wait, the daemon asks GitHub for each failed run's latest
attempt. A run that is running again keeps the wait open; one that already
passed ends it green.

### When the fleet's view is behind

The daemon's rows are a copy of GitHub's, made by its fast loop, and that loop
can stop finishing ticks on a saturated host. So the daemon also asks GitHub
for the commit's check runs and statuses (REST, cached 20 seconds per commit):

| The fleet's view | GitHub is asked |
|---|---|
| Stale, with no runs for the target, or behind a re-run | Every 30 seconds |
| Fresh | Every 2 minutes |

GitHub's **finished** answer ends the wait, with how far behind the fleet was:

```console
✔ comet-web PR #96: 1 of 1 green (from GitHub; the fleet's view is 27m old, it still read 0 of 1 done)
```

That note is a daemon problem worth reporting, not part of the PR's result.
GitHub still *pending* never overrides the fleet's own red, and holds its
green until GitHub finishes.

### A job orphaned by a draining runner

A runner that is drained while it finishes a job can stop before the job's
result reaches GitHub. The job then passed every step and still reads
`in_progress`, with "Complete runner" cancelled or stuck and "Complete job" in
progress, and it stays that way: `gh run cancel` does nothing, and only
`POST repos/<repo>/actions/runs/<id>/force-cancel` completes it (addisdev/lake-api
PR #73, 2026-10-12/13). The drain bug behind it is fixed, but a runner can still
be stopped mid-report (a host reboot, a killed service), so the daemon checks
every active run's jobs. See [Orphaned jobs](../api.md#orphaned-jobs) for the
exact rule.

Without `--recover` the wait stops with exit `2` and the commands:

```console
⏹ lake-api PR #73: not waiting — build: orphaned by a draining runner — not your code. Every step passed, then MACSERIAL0-lake-api (draining) went away; stuck at "Complete job" for 12 min.
    gh api -X POST repos/addisdev/lake-api/actions/runs/38318681067/force-cancel
    # about a minute later, once the run shows completed:
    gh run rerun 38318681067 -R addisdev/lake-api
  or let cockpit do both: cockpit wait lake-api --pr 73 --recover
```

With `--pr N --recover`, the wait runs the dashboard's `run.recoverOrphan`
action for each orphaned run, then keeps waiting. The dashboard force-cancels
the run, re-runs it once GitHub has completed it, and records both in its
action log under the cockpit's paired name. Each run is recovered at most once
per wait, and the cancelled result the force-cancel leaves for a minute doesn't
end the wait. A job whose work had already failed is never recovered, because a
re-run would repeat it. Recovery is opt-in and limited to the PR you are waiting
on because it acts on GitHub: cancelling runs across the fleet kills other
sessions' fresh re-runs. It needs `cockpit pair`.

## `cockpit sentinel`

Checks the host out of band, the way the app does when the dashboard does not
answer: SSH reachability on each alias, GitHub's view of the host's runners, a
runner on another machine, githubstatus.com. Prints the verdict from the
[out-of-band table](verdict.md#when-the-dashboard-does-not-answer).

```console
$ cockpit sentinel
✖ ultra is asleep, off or off the network
  mini in the same house is online, so power and the network are fine. Only someone there can wake it.
  · SSH port closed on every route
  · GitHub: 0 of 3 checked runners on ultra online
  · mini: online
  → Wake it in person
  via out of band
```

The GitHub checks need to know which runners to ask about, which they take from
the app's last snapshot. With no snapshot they are skipped, and the output says
so. `--port` sets the dashboard port asked on the host; `--via` the aliases.

Exit code: from the verdict's tone.

## `cockpit top`

The host's top CPU users over SSH, naming Spotlight outright when it is the
culprit (it is the usual cause of a saturated host).

```console
$ cockpit top
Spotlight is using 150% CPU — it is indexing, most likely the runner work trees. Exclude the fleet root in Spotlight privacy.
   65.3%  mds
   62.0%  swift-frontend
   54.2%  mds_stores
   11.2%  mdworker_shared
```

`--via <alias>` picks the host (default `ultra`). `--json` prints
`{ verdict, spotlightCPU, top }`. Exit `1` when Spotlight is using 50% CPU or
more, `3` when `ps` could not be run, else `0`.

## `cockpit load`

Host load by how many runners were busy, from the dashboard's per-minute host
samples (`/api/load-by-busy`): load1 p50 and p90 for each busy-runner count,
and p90 per core. This is the table the [admission lanes](../admission-and-scaling.md#lanes)'
heavy limit is set from; re-read it when the job mix changes.

```console
$ cockpit load --days 7
ultra: load1 by busy runners, last 7 day(s), 9841 sample(s), 30 cores
  busy  samples  load1 p50  load1 p90  p90/core
     0     2210        3.0        8.0       0.3
     2      890       12.0       27.0       0.9
     4      640       28.0       53.0       1.8
lanes observe: heavy 4, light 12, total 16
busy counts runners GitHub shows busy, including jobs held by admission.
```

`--days N` (1 to 90, default 7) sets the window. `--json` prints the daemon's
answer. Busy runners include jobs the admission hook is holding, which use no
CPU, so on a host that holds a lot the low rows read high.

## `cockpit brief`

A markdown incident brief of the current state: the verdict, its evidence and
next move, everything else open, host vitals, runners that are neither idle nor
busy, the queue and open alerts. The same text as **Copy brief** in the app,
written to paste into an issue or an agent session.

```console
$ cockpit brief
## Fleet: Disk floor is holding jobs

_2026-10-03T13:17:34Z · verdict `disk-floor` (critical) · via app · cli_

3 jobs held because free disk is under the admission floor. It looks like load; it is disk.

**Evidence**
- 36.6 GB free, floor 40 GB
- 3 jobs held at Set up runner: comet-web, comet-backend, ember-ios
- Waiting does not fix this; freeing disk does

**Next move:** Preview cleanup

**State** — 0 running, 0 queued, 3 held, 54 runners, snapshot 0s old
- build-host: load 1.7/core, memory warning, swap-ins 2/s, disk 36.6 GB free (floor 40 GB)

**Runners not idle or busy**
- `build-host-comet-web` held-disk: held: 36 GB disk free, below the 40 GB floor
…
```

`cockpit brief | pbcopy` puts it on the clipboard.

Exit code: from the verdict's tone.

## `cockpit pair`

Pairs the command line with the dashboard, with a token of its own, separate
from the app's and revocable on its own.

```bash
cockpit pair                              # over ultra
cockpit pair --via ultra-ts --fleet-root ~/actions-runners
```

It runs `fleetctl.sh pair` on the host over the first `--via` alias (default
`ultra`) to mint a six-digit code, exchanges it for a device token named
"cockpit CLI on <this Mac>", and saves the token to
`~/Library/Application Support/FleetCockpit/cli-token-cli:<host>` with mode
`0600`. `--fleet-root` is where the repository lives on the host (default
`~/actions-runners`).

The token is a file rather than a Keychain item on purpose: SwiftPM builds are
signed ad hoc, so every rebuild would otherwise meet a Keychain prompt, and a
prompt blocks a script or an agent session that cannot answer it.

## `cockpit run`

Runs one action from the dashboard's catalogue, through
[`POST /api/v1/actions/{id}`](../api.md#running-an-action): a preview, then the
run with the confirmation the preview returned.

```bash
cockpit run fleet.health                                  # a read: runs at once
cockpit run fleet.healthRepair                            # refused: needs --yes
cockpit run fleet.healthRepair --yes
cockpit run runner.restart --name build-host-web-2 --yes
```

| Option | Meaning |
|---|---|
| `--name <runner>` | The runner, for `runner.*` actions |
| `--host <id>` | The host, for `host.*` actions (default: the dashboard's own) |
| `--repo <owner/name>`, `--run <id>` | The run, for `run.*` actions |
| `--yes` | Required for anything whose catalogue `danger` is not `none` |

Any other `--flag value` is passed as the action's argument of that name. The
dashboard refuses an argument the action doesn't take and says which ones it
does; `GET /api/v1/actions` lists them. Without `--yes`, a changing action
prints its label, danger, what it does and the command it would run, and exits
`2`: an agent exploring the CLI must not repair or restart by accident. Needs
`cockpit pair` first.

`--json` prints the dashboard's answer:
`{ status, action, args, ok, command, code, output, durationMs }`. Exit `0` on
success, `1` on failure or refusal.

## `cockpit mcp`

The dashboard's MCP tools over stdio. The tunnel opens when a call needs it and
closes after `--idle` seconds with none in flight (default `90`; `0` holds it
for the whole session). See [Agent sessions](agents.md#the-mcp-server).

## `cockpit fixtures`

Lists the bundled fixture names, for `--fixture`:

| Fixture | The state it records |
|---|---|
| `live` | A real busy afternoon |
| `quiet` | Healthy and idle |
| `waiting` | Runs queued behind busy runners: healthy |
| `dead` | A runner service exited and nothing restarted it |
| `diskBelowIdle` | Disk under the floor, nothing asked to start yet |
| `diskHold` | Three jobs held at *Set up runner* by the disk floor |
| `saturated` | Jobs lost contact mid-step while Spotlight indexed the work trees |
| `accountBlocked` | GitHub refusing jobs for billing |
| `drift` | Sibling runners with different labels |
| `agentDown` | A federated agent host stopped heartbeating |
| `blind` | Nothing readable |

## Recipes

```bash
# Fail a script early when the fleet is broken, before pushing.
cockpit status >/dev/null || { cockpit status; exit 1; }

# Push, then wait without hanging on a check that will never start.
git push && cockpit wait comet-web --branch "$(git branch --show-current)" --timeout 30m
case $? in
  0) echo green ;;
  1) echo "red: read the failures" ;;
  2) echo "not the code: $(cockpit status --json | jq -r .verdict.title)" ;;
  3) echo "timed out or unreachable" ;;
esac

# Everything queued for longer than 10 minutes.
cockpit queue --json | jq '.[] | select(.queuedMs > 600000) | {repo, workflow, cause}'
```
