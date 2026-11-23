# Verdict reference

The verdict is one answer to *is anything wrong, which thing, and what is the
one move*. It is computed on the runner host by `dashboard/lib/verdict.js` and
delivered in [`GET /api/glance`](../api.md#get-apiglance); the cockpit adds the
verdicts that only an outside observer can reach.

## The ladder

The rungs are checked in order and **the first match wins**, because each rung
makes the ones below it meaningless. When the disk floor is holding every job,
"the queue is long" is true and useless; when a runner service is dead, "every
runner for this repo is busy" is a misreading.

| Rung | `id` | Tone | Title | Opens when | Next move |
|---|---|---|---|---|---|
| 0 | `unknown` | unknown | Cannot read GitHub | The collector has not finished a pass, or every repo failed to read | Wait for the first tick; then check the host's GitHub token and network |
| 1 | `host-down` | critical | Host is not reporting | A federated agent host stopped heartbeating (the cockpit also uses this id for the coordinator itself — [below](#when-the-dashboard-does-not-answer)) | Check the agent process and network on that host |
| 2 | `disk-floor` | critical | Disk floor is holding jobs | A job is held by the admission disk floor, or free disk is under the floor while admission enforces | **Preview cleanup** → **Apply cleanup** |
| 3 | `dead-service` | critical | Runner service is down | A runner service is dead or missing, a runner has been offline for 5 minutes, or work is queued behind a down runner | **Health check and repair** |
| 4 | `shm-low` | warning (critical when full) | Shared memory table nearly full | Fewer than `FLEET_SHM_LOW_FREE` (4) System V segments free on a host, or a `low` event from `hooks/shm-reap.sh` in the last 30 minutes. Every new Postgres cluster fails in shmget when the table fills, which reads as a broken test | List the segments: `ipcs -m -o -p` |
| 5 | `saturated` | warning | Host is saturated | Two or more `runner-lost` jobs in an hour, sustained paging, or critical memory pressure | Show top CPU on the host |
| 6 | `account-blocked` | warning | GitHub is refusing jobs | An `account-blocked` or `account-quota` failure in the last 6 hours | **Open billing** |
| 7 | `config-drift` | warning | Configuration drift | An orphan runner or label mismatch, or a queue cause that waiting cannot fix | Open the Lint tab |
| 8 | `waiting` | ok | Working | Runs are queued or held for an admission slot, and nothing above explains them | Nothing to do |
| 9 | `clear` | ok | All clear | None of the above | Nothing to do |

`verdict.open` lists every rung that is true right now, in ladder order; the
popover shows the first as the verdict and the rest as *also open*.

### What does not open a rung

These were each read as an incident at least once, and are deliberately not:

- **A disk-floor hold whose disk has since recovered.** A held job's reason is
  logged once, when the hold starts. `disk-floor` needs free disk to actually be
  under the floor now, not a stale reason saying it was.
- **Orphaned shared memory segments.** A segment a killed Postgres cluster
  left behind is removed by the next job's hook before that job's steps run,
  so `shm-low` counts it as free. What opens the rung is the table filling
  with live clusters or another user's segments, which no hook will remove.
- **Memory pressure "warning" on its own.** On a busy build host that is normal.
  `saturated` needs lost jobs, sustained paging or *critical* pressure.
- **A run queued because the headroom gate is at capacity.** That is the gate
  working: `waiting`, not `saturated`.
- **A public repository's queue for GitHub-hosted runners.** Public repos run on
  GitHub's runners for free, and their queue clears by itself: `waiting`, not
  `config-drift`. The same cause in a *private* repo is drift — it will bill, or
  be refused.
- **A runner offline for under five minutes.** An `offline` flap self-resolves
  in roughly 45 seconds to 5 minutes on a busy host, so it is `settling` until it
  has stayed down.

### Queue causes that never clear

`config-drift` opens for a queued run whose cause waiting cannot fix:

| Cause | Meaning |
|---|---|
| `unserved` | No runner is registered for this repository |
| `role-unserved` | Runners exist, but none with the role this job asks for |
| `label-mismatch` | `runs-on:` asks for labels no runner has |
| `github-hosted` | A private repo's job targets GitHub-hosted runners |

Such a run shows *won't start on its own* instead of an ETA, and `cockpit wait`
on it exits `2` at once. The full list of causes is in
[Concepts](../concepts.md).

### Queued runs of merged or closed PRs

GitHub does not cancel a PR's runs when the PR closes, and `concurrency:` only
supersedes a run when a later run of the same workflow starts. A later push
that misses the workflow's `paths:` filter starts nothing, so the old run waits
for a slot that nobody needs. On 2026-11-23 `homelake` had six queued `Public
mirror (dry run)` runs for PRs that had merged hours earlier.

Sessions never cancel other sessions' runs, so the daemon does it, with the
**closed-PR sweep** (`dashboard/lib/pr-sweep.js`). Every five minutes, from the
runs the fast loop already fetched, it cancels a run only when all of these
hold:

- its status is `queued`: never `in_progress`, never `waiting` (an environment
  approval). The run is fetched again just before the cancel, and left if it
  has started;
- its event is `pull_request` (not `push`, not `pull_request_target`);
- its repo is on the allow-list;
- every PR GitHub has for the run's head branch is closed or merged. One open
  PR on that branch and the run is left;
- this attempt was triggered before the PR closed. A workflow listening for
  `pull_request: types: [closed]`, or a person re-running a job after the
  merge, starts a run after the close on purpose, and that run is left;
- it has been queued for at least ten minutes.

Anything GitHub cannot answer (a failed lookup, no PR found) leaves the run.
The sweep pauses while fewer than 500 API calls are left in the hour, and looks
up at most 20 branches per pass, oldest runs first.

| Setting | Default | Meaning |
|---|---|---|
| `sweepClosedPr` | off | Run the sweep at all |
| `sweepClosedPrDryRun` | on | List what it would cancel, cancel nothing. Always on for a read-only daemon |
| `sweepClosedPrRepos` | empty | Repos it may touch, by name (`homelake`) or `owner/name`. Empty touches nothing |

Change them on the dashboard's Settings panel (**Closed-PR sweep**) or with
`PUT /api/settings`; they apply on the next pass, without a restart.

Each cancel, and each run a dry run would cancel (once per run, not every
pass), is a row in the action log (`sweep.closedPrRun`, or
`sweep.closedPrRun (dry run)`) with the run id, repo and PR number, and comes
back in `/api/timeline` as `sweeps`. `GET /api/sweeps/closed-prs` shows the
switches and what the last pass found.

To turn it on: set `sweepClosedPrRepos`, turn `sweepClosedPr` on, read what the
dry run lists, then turn `sweepClosedPrDryRun` off.

## Collector stalled

The daemon can be reachable and still not current: when its fast loop stops
finishing ticks (a saturated host), it publishes nothing new while keepalives
hold the stream open, and the last glance stays on screen. A view whose last
finished tick is more than 4 minutes old is therefore shown as **Collector
stalled** (`unknown` tone, on rung 0) in the app, `cockpit status` and
`cockpit why` — never the old verdict, which may say "Working" about a fleet
that has since stopped. It says how long ago the last pass finished, carries the
collector's last error as evidence, and offers restarting the dashboard as the
next move; a stall that clears on its own (a busy minute on a saturated host)
needs nothing. `cockpit wait --pr` keeps working
through a stall by [asking GitHub directly](cli.md#-pr-also-asks-github).

## Next-move kinds

`verdict.next.kind` says what kind of thing the next move is, which decides how
the cockpit renders it:

| Kind | Rendered as | Example |
|---|---|---|
| `action` | A button that runs a catalogue action (needs pairing); `then` names a follow-up offered after it succeeds | `fleet.cleanupPreview` then `fleet.cleanupApply` |
| `url` | A link | GitHub billing; `vnc://` to log in at the console |
| `command` | A command to run on the host, with a copy button | `~/actions-runners/dashboard/fleetctl.sh restart` |
| `owner` | A sentence: only a person can do it | "Wake it in person" |
| `reconnect` | **Reconnect now** (cockpit only) | Dashboard reachable, stream failing |
| `none` | Nothing | `clear`, `waiting` |

## When the dashboard does not answer

Two of the fleet's failure modes can never be reported from the runner host: the
host being down takes the dashboard, its watchdog and phone push with it, and a
dashboard that has died cannot announce its own absence.

So after **20 seconds** of failed reconnects (a dashboard restart takes a few
seconds and is not an incident), the cockpit asks three other witnesses, once a
minute, until the stream is back:

1. **Can this Mac reach the host's SSH port** on any configured alias? Each alias
   is resolved with `ssh -G`, so the probe goes where ssh would.
2. **What does GitHub say about the host's runners?** A few of them, taken from
   the last good view, checked with your own `gh` credential — asked for when
   needed, never stored. The targets survive a relaunch: they are read from the
   snapshot file, so an app started while the host is down still asks about the
   right runners.
3. **Is a runner on a different machine online?** One from a *GitHub view only*
   lane. If it is, the house has power and network, and the problem is the host.

When SSH answers, it also asks the host how long it has been up, who owns the
console, and whether the dashboard answers locally. It also checks
githubstatus.com's Actions component.

The answers are read against one table (`CockpitCore/Sentinel.swift`, tested row
by row). The first row that matches wins:

| SSH | GitHub: host's runners | Other machine | `id` | Tone | Verdict |
|---|---|---|---|---|---|
| no, and GitHub unreachable | — | — | `blind` | unknown | **This Mac is offline.** Nothing can be said about the fleet |
| yes, dashboard answers | — | — | `unreachable` | unknown | **Dashboard reachable, stream failing.** Retrying |
| yes | offline, console nobody or up < 30 min | — | `host-down` | critical | **Rebooted and nobody has logged in.** No auto-login strands every LaunchAgent. Next: log in over Screen Sharing |
| yes | offline | — | `dead-service` | critical | **Every runner service is down.** Next: `health.sh --repair` and restart the dashboard |
| yes | online | — | `dashboard-down` | warning | **Dashboard down, fleet working.** Next: restart the dashboard |
| yes | not checked | — | `dashboard-down` | warning | **Dashboard not answering** |
| no | online | — | `off-network` | info | **Fleet working, out of reach from here** |
| no | offline, githubstatus reports an Actions incident | — | `host-down` | warning | **GitHub Actions is having trouble.** The host may be fine |
| no | offline | online | `host-down` | critical | **Host asleep, off or off the network.** Only someone there can wake it |
| no | offline | offline | `host-down` | critical | **Home network or power is out** |
| no | offline | not checked | `host-down` | critical | **Host is down** |
| no | not checked | — | `host-down` | critical | **Host is unreachable** |

These verdicts notify once when they open and once when they clear ("Fleet
reachable again — resolved after 14 min"). `cockpit sentinel` runs the same
probes and table from a terminal.

The probes only run while this Mac is awake. To hear about the host going away
while you are not at the Mac, run the [host sentinel](sentinel.md) on another
machine.

## Runner states

Every runner has exactly one state; the first that applies, in this order:

| `state` | Pill | Meaning |
|---|---|---|
| `host-down` | hatched | Its host is not reporting |
| `dead` | cross | Its service is dead or missing (a drift finding other than an orphan) |
| `misconfigured` | question mark | Orphan, or its siblings carry different labels |
| `draining` | arrow | Finishing its job, taking no new ones |
| `unknown` | dotted | GitHub's state for it was not read this tick |
| `offline` | cross | Offline to GitHub for 5 minutes or more |
| `settling` | dashed ring | Offline under 5 minutes; usually self-resolves |
| `held-disk` | square | Its job is held by the disk floor |
| `held-slot` | ring with a dot | Its job is waiting for an admission slot — normal |
| `overdue` | filled arc, caution | Running past its workflow's 95th-percentile duration |
| `busy` | filled arc | Running a job |
| `lost` | diamond | Lost contact mid-job in the last hour |
| `idle` | hollow ring | Ready |

## ETAs

Queue rows and check rows carry ranges, not points: `etaStartMs` and `etaDoneMs`
are `[p50, p90]`, worked out from the job ahead of the run (how long it has been
going against its workflow's history) and this workflow's own duration
history. `etaBasis` says what the estimate waits behind. Both are absent, and
the row says *won't start on its own*, when the cause never clears by itself; a
public repo's GitHub-hosted queue has no estimate but is *waiting on GitHub*.

## Exit codes

The CLI maps the verdict's tone to an exit code, so scripts do not parse words:

| Tone | `status`, `why`, `brief`, `sentinel` |
|---|---|
| `ok`, `info` | `0` |
| `warning`, `critical` | `1` |
| `unknown` (including unreachable) | `3` |

`cockpit wait` has its own codes; see [Command line](cli.md#cockpit-wait).
