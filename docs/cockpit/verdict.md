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
| 4 | `saturated` | warning | Host is saturated | Two or more `runner-lost` jobs in an hour, sustained paging, or critical memory pressure | Show top CPU on the host |
| 5 | `account-blocked` | warning | GitHub is refusing jobs | An `account-blocked` or `account-quota` failure in the last 6 hours | **Open billing** |
| 6 | `config-drift` | warning | Configuration drift | An orphan runner or label mismatch, or a queue cause that waiting cannot fix | Open the Lint tab |
| 7 | `waiting` | ok | Working | Runs are queued or held for an admission slot, and nothing above explains them | Nothing to do |
| 8 | `clear` | ok | All clear | None of the above | Nothing to do |

`verdict.open` lists every rung that is true right now, in ladder order; the
popover shows the first as the verdict and the rest as *also open*.

### What does not open a rung

These were each read as an incident at least once, and are deliberately not:

- **A disk-floor hold whose disk has since recovered.** A held job's reason is
  logged once, when the hold starts. `disk-floor` needs free disk to actually be
  under the floor now, not a stale reason saying it was.
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
