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
   `--via` aliases (default `runner-host`, then `runner-ts`), exactly as the app
   would open one.

The human output always ends with the route it used, for example
`via app (runner-host, 12s ago)` or `via runner-ts`.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Machine-readable output (pretty-printed, sorted keys) |
| `--fixture <name>` | Use a bundled fixture instead of the live fleet (`cockpit fixtures` lists them) |
| `--via <alias>` | SSH alias to tunnel through; repeat for a fallback list. Default `runner-host`, `runner-ts` |
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
  0 running, 0 queued, 3 held, 54 runners · via app (runner-host, 4s ago)
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

Everything the fleet knows about one repository. `<repo>` is `name` or
`owner/name`.

```console
$ cockpit why comet-web
Fleet: ▲ Host is saturated

comet-web: 3 runner(s)
  lost          build-host-comet-web  lost contact mid-job 5 min ago
  busy          build-host-comet-web-2  web-e2e · e2e / e2e / webkit · 3 min of ~75 min
  idle          build-host-comet-web-3  idle

Checks:
  comet-web · develop: 1 of 2 done, done in 40m–70m

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

`--json` prints `{ verdict, runners, queue, checks, failures, incidents }`.
`runners`, `queue`, `failures` and `incidents` are the glance's own objects
filtered to the repo; `checks` is a list of `"label: progress"` strings.

Exit code: from the **fleet** verdict's tone, so `why` in a script still fails
when the fleet is broken; `3` when nothing could be read.

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
cockpit wait <repo> [--pr N | --sha S | --branch B] [--timeout 45m]
```

| Option | Meaning |
|---|---|
| `--pr N` | The pull request's head commit |
| `--sha S` | A specific commit |
| `--branch B` | The branch's latest commit |
| `--timeout` | `90s`, `45m`, `2h`, or a bare number of minutes. Default `45m` |

`wait` always opens its own stream (it does not read the snapshot) and decides
on every update. Progress goes to stderr, once per change:

```console
$ cockpit wait comet-web --pr 96
… comet-web PR #96: 2 of 5 done, done in 11m–26m
… comet-web PR #96: 4 of 5 done, done in 3m–8m
✔ comet-web PR #96: 5 of 5 done
```

| Exit | Printed | Meaning |
|---|---|---|
| `0` | `✔` | Every check passed |
| `1` | `✖` and each failed check, with its URL | At least one failed or was cancelled. A cancellation is often an admission hold that ran past `timeout-minutes`, and the output says so |
| `2` | `⏹ not waiting — <reason>` | Waiting cannot end well: the host is down, the disk floor is holding jobs, GitHub is refusing jobs for billing, or one of the checks is queued with a cause that never clears. Stop and report the reason |
| `3` | `…timed out` or `? dashboard unreachable` | The timeout passed, or (for `--sha` and `--branch`) the dashboard could not be reached; try `cockpit sentinel` |

The deadline is a wall-clock timer of its own, so a wait always ends by
`--timeout`: no stream, tunnel or `gh` call can hold it (each GitHub ask gets at
most 25 seconds, capped by the time left), and the command line adds a last
backstop that exits `3` thirty seconds past the deadline whatever else is
happening. A dropped stream is reopened with backoff (3 seconds, doubling to
30). A stream with no glance and no keepalive for 75 seconds (fleetd sends one
every 25) is treated as dead: the wait drops its tunnel, opens a new one and
asks GitHub meanwhile.

### `--pr` judges the head commit

With `--pr`, the answer is the PR's **head** commit, never an older commit's
result. A red from a commit you have since pushed over, or force-pushed off,
does not end the wait. Until the head has a run, the wait keeps waiting. After a
force-push back to an earlier commit, that commit's old result waits for the new
run ("waiting for kit-ci to run again on this commit").

### `--pr` also asks GitHub

Cockpit's rows are a copy of GitHub's, made by the daemon's fast loop. When that
loop stops finishing ticks (a saturated host), the daemon publishes nothing and
the last view stays on screen while keepalives hold the stream open. So with
`--pr`, the wait also asks GitHub itself, with
`gh pr view --json headRefOid,statusCheckRollup` (GraphQL, so it does not spend
the daemon's REST budget):

| Cockpit's view | GitHub is asked |
|---|---|
| More than 4 minutes old, missing, silent, or the dashboard unreachable | Every 30 seconds |
| Fresh, but with no runs for this PR (finished before the view's window) | At once, then every 30 seconds |
| Fresh | Every 2 minutes |

GitHub's **finished** answer ends the wait, and says that it came from GitHub
and how far behind cockpit was:

```console
✔ comet-web PR #96: 1 of 1 green (from GitHub; cockpit's view is 27m old, it still read 0 of 1 done)
```

That note is a daemon problem worth reporting, not part of the PR's result.
GitHub still *pending* never overrides cockpit's own green or red. Because
GitHub can answer without the dashboard, an unreachable dashboard does not end a
`--pr` wait; a `--sha` or `--branch` wait still needs the dashboard and exits `3`
without it. The GitHub check uses your own `gh` login.

## `cockpit sentinel`

Checks the host out of band, the way the app does when the dashboard does not
answer: SSH reachability on each alias, GitHub's view of the host's runners, a
runner on another machine, githubstatus.com. Prints the verdict from the
[out-of-band table](verdict.md#when-the-dashboard-does-not-answer).

```console
$ cockpit sentinel
✖ runner-host is asleep, off or off the network
  mini in the same house is online, so power and the network are fine. Only someone there can wake it.
  · SSH port closed on every route
  · GitHub: 0 of 3 checked runners on runner-host online
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

`--via <alias>` picks the host (default `runner-host`). `--json` prints
`{ verdict, spotlightCPU, top }`. Exit `1` when Spotlight is using 50% CPU or
more, `3` when `ps` could not be run, else `0`.

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
cockpit pair                              # over runner-host
cockpit pair --via runner-ts --fleet-root ~/actions-runners
```

It runs `fleetctl.sh pair` on the host over the first `--via` alias (default
`runner-host`) to mint a six-digit code, exchanges it for a device token named
"cockpit CLI on <this Mac>", and saves the token to
`~/Library/Application Support/FleetCockpit/cli-token-cli:<host>` with mode
`0600`. `--fleet-root` is where the repository lives on the host (default
`~/actions-runners`).

The token is a file rather than a Keychain item on purpose: SwiftPM builds are
signed ad hoc, so every rebuild would otherwise meet a Keychain prompt, and a
prompt blocks a script or an agent session that cannot answer it.

## `cockpit run`

Runs one action from the dashboard's catalogue.

```bash
cockpit run fleet.health                                  # a read: runs at once
cockpit run fleet.healthRepair                            # refused: needs --yes
cockpit run fleet.healthRepair --yes
cockpit run runner.restart --name build-host-web-2 --yes
```

| Option | Meaning |
|---|---|
| `--name <runner>` | The runner, for `runner.*` actions |
| `--yes` | Required for anything whose catalogue `danger` is not `none` |

The action must be one the cockpit accepts (see
[Acting on it](using.md#acting-on-it)) **and** one the dashboard offers in
`GET /api/actions`. Without `--yes`, a changing action prints its label, danger
and confirmation text and exits `2`: an agent exploring the CLI must not repair
or restart by accident. Needs `cockpit pair` first.

`--json` prints the action result `{ ok, command, code, output, error, durationMs }`.
Exit `0` on success, `1` on failure.

## `cockpit mcp`

Runs as an MCP server over stdio. See [Agent sessions](agents.md).

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
