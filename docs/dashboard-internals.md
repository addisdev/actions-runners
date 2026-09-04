# Fleet dashboard

One page that answers "is anything broken, and where" for every self-hosted
runner on this machine and every CI run across the repos they serve.

GitHub has no cross-repo Actions view. Past a handful of repos there is no
single page that answers "is anything running" — and once runners live on a
particular machine, half the question ("is that runner even alive") is not
answerable from GitHub at all. This is that page.

Phases 1–5: **see it**, **understand it**, **manage it**, **be told**, **check it**.

## Running it

```bash
./fleetctl.sh install     # write the LaunchAgent and load it
./fleetctl.sh status      # is it up, and what does it think
./fleetctl.sh logs        # tail the daemon log
./fleetctl.sh run         # foreground, for debugging
./fleetctl.sh token       # print the control token
```

It binds to `127.0.0.1:7878`. From another machine:

```bash
ssh -L 7878:localhost:7878 your-runner-host   # then open http://localhost:7878
```

Loopback is the default because the control plane executes shell commands as
this user. To put it on the LAN, set `FLEET_HOST=0.0.0.0`: read routes are then
open to the network, while every action still needs the bearer token. If that is
not the tradeoff you want, `FLEET_READ_ONLY=1` removes the actions entirely.

## How it works

`fleetd.js` is one process doing two jobs, on purpose: the collector and the
server share the snapshot in memory, so the live view needs no polling between
them, and there is one LaunchAgent to reason about at 3am instead of two.

**Fast loop** (15s while anything is building, 45s when the fleet is asleep):
every repo's runs and runners from the GitHub API, plus the local probes —
`launchctl list`, `ps`, `vm_stat`, `df`. Whether to poll fast is decided from
the *local* `Runner.Worker` check, which answers "is anything building" for free
and with no API call.

**Slow loop** (15 min): the repo roster, so a repo you create tomorrow appears
without anyone editing a config file, and `du` over the runner directories.

**Backfill** (every 10 min until it has caught up, then never again): walks back
through every run GitHub still holds and fetches its jobs and step timings. This
is throttled and resumable — ~1,100 runs need ~1,100 job calls — so it takes a
bounded 350 calls per pass and keeps a floor of rate limit for the fast loop.
Worth doing promptly: measured 2026-08-05, the busy repos only hold a few weeks
before GitHub ages runs out. Whatever is not captured is gone.

**SQLite** (`fleet.db`, via the built-in `node:sqlite`) keeps runs, jobs, runner
state transitions and 1-minute host samples. Runs and jobs are append-only and
tiny — they are kept forever, because GitHub discards run detail after 90 days
and this is the only place the fleet's own history will ever exist.

## Groups are inferred, not configured

Runners and repos are grouped so that `app-ios`, `app-web` and `app-backend`
appear under one `app` heading. Nothing configures this: a repo name is split on
`-`, `_` and `.`, and any first token shared by two or more repos becomes a
group. Repos that share nothing with anything land under `other`.

The rule is the dullest one that works. Run against a real 34-repo fleet it
produced exactly the groups a person would have drawn by hand, and raising the
threshold from two to three changed none of them — so there is no cleverness
here to go wrong later.

**The names come from disk and from SQLite, never from the current tick.** This
is the whole reason the corpus is assembled the way it is. Groups derived from
one tick's API results dissolve the moment a call fails, and a heading that
disappears and comes back moves every tile beneath it — the same class of
failure the drift rules already guard against, where a single 503 once produced
a 46-second phantom orphan alert. Verified by running the collector with every
GitHub call returning 401: the grouping came out byte-identical to a healthy run.

**Only repos the fleet has something to do with get a vote** — those with a
workflow or a runner, the same test the roster uses. An account full of
boilerplates and tutorial checkouts otherwise decides the layout: two unrelated
repos that happened to begin `github-` were enough to invent a `github` heading.

Four escape hatches, all optional and all off by default: `FLEET_PROJECTS` pins
groups and their order, `FLEET_GROUP_IGNORE` suppresses a token that is shared
by accident rather than convention, `FLEET_GROUP_MIN` moves the threshold, and
`FLEET_GROUPS=off` gives one flat list. Pins are matched as prefixes rather than
tokens, which is how `FLEET_PROJECTS` behaved when it was the only mechanism —
so upgrading cannot silently regroup a dashboard someone had already arranged.

## Zero dependencies, on purpose

No npm packages, no build step, no framework. This machine's job is running CI;
a monitoring daemon that breaks unattended because a transitive dependency
changed is worse than no daemon.

The charts are HTML and CSS rather than SVG, which for horizontal bars is the
better tool and not a compromise: percentage widths are responsive for free, and
text stays at its real size instead of being scaled by a viewBox — which is how
SVG charts end up with 9px axis labels on one screen and 20px on another.

## Tests

```bash
cd dashboard && npm test          # Node's built-in runner, no dependencies
../scripts/test-drain.sh          # drain and resume, against a fake fleet
../scripts/test-ephemeral.sh      # the ephemeral reaper's refusals
```

Everything runs against fixtures in `/tmp` with no network and no fleet, so it is
safe on the machine that is also running CI.

The decision-making modules are pure functions for this reason: `queue-cause`,
`autoscale`, `placement`, `simulator` and `forecast` take plain data and return a
decision plus its reasoning, executing nothing. The simulator's tests are
hand-worked timelines — three ten-minute jobs arriving together serialize to waits
of 0, 10 and 20 minutes on one runner — so the expected numbers can be checked by
reading them rather than by trusting the code that produced them.

The shell tests are mostly about what the scripts *refuse* to do, since those are
the paths that cost something: a busy runner is not interrupted by a drain,
`health.sh --repair` does not revive a drained runner, and the reaper never
deletes a directory with a live process in it.

## Auth

`gh` on the runner host keeps its token in the login keychain, which a non-login
session cannot read: `gh auth status` reports an invalid token over SSH while
working fine in the GUI session. LaunchAgents *do* get keychain access — which is
why `health.sh` works from launchd and fails over SSH.

So the daemon resolves the token **once at startup** with `gh auth token` and
uses plain `fetch` after that. Running it under launchd is therefore not a
deployment preference, it is the auth mechanism. `./fleetctl.sh run` over SSH
will fail to get a token; pass `GH_TOKEN=…` for that case.

## What "drift" means

Drift is the set of states where this machine and GitHub disagree. Each one is
silent from whichever side you happen to be looking at:

| Kind | What it catches |
|---|---|
| `launchd-missing` | registered on GitHub, no LaunchAgent loaded — jobs queue forever |
| `launchd-dead` | job loaded but not running; no runner plist sets `KeepAlive`, so launchd will not revive it |
| `offline` | listener alive locally, GitHub says offline |
| `orphan` | running here, deregistered on GitHub — it will never receive a job |
| `label-mismatch` | sibling runners with different extra labels; the odd one out never matches `runs-on:` |
| `stuck-queue` | queued 5+ min while a runner for that repo sits idle |

Two things are deliberately **not** drift, because each has its own section and
listing them twice buries the rows that need acting on: repos with workflows and
no runner here, and runners registered on another machine.

## The control plane

Unlock the Control tab once with `./fleetctl.sh token`. The token is stored in
that browser and **is never served to the page** — read access and the right to
restart runners are different things, so a dashboard someone can see is not a
dashboard they can act on.

Two rules govern `lib/actions.js`, and neither is negotiable:

- **No shell.** Every local action is `execFile` with an argv array, never a
  string handed to `sh -c`. There is no interpolation point, so a runner name
  containing `; rm -rf ~` is a name that fails to match a known runner.
- **No free-form commands.** The registry is the complete set of things this
  daemon can do. Arguments are validated against entities it already knows —
  a runner must be one it discovered, a repo one it polls.

The actions *are* the existing scripts, which keeps them the single source of
truth rather than forking their logic into a web app. Every action, successful
or refused, is recorded in `action_log`.

Three guards are worth knowing about, because each encodes a way to lose the
fleet:

- **Removal names its target.** `scripts/deregister.sh <dir-name>` removes one
  runner and is dry-run by default. It replaced `teardown.sh`, whose only
  selector was `--keep <dir,dir,…>` — to remove one runner you named every
  *other* runner, and an empty or mistyped keep-list removed everything. The
  script refuses a runner that is mid-job, and refuses to leave a repo with no
  runner at all unless `--force` says so.
- **`runner.duplicate` copies labels rather than accepting them.** A second
  runner that does not carry the first one's extra labels never matches the same
  `runs-on:`, so it sits idle forever while the first one queues — which looks
  exactly like the problem it was added to fix. The labels come from the
  lowest-numbered sibling, so there is no opportunity to get them wrong.
- **`runner.register` enforces the same-label rule** for the same reason. The
  form shows the existing labels; the daemon refuses the mismatch regardless of
  what the form sent.

Set `FLEET_READ_ONLY=1` to disable the control plane entirely.

## Capacity and autoscaling

The **Capacity** tab answers one question — *should this fleet have more runners,
and can this machine take them* — and it is built around a fact that was measured
rather than assumed.

### The problem is per-repo, not fleet-wide

Average concurrent jobs across 27 runners is **0.2**. The machine is idle almost
all the time. And yet **21% of 7,631 jobs waited over a minute to start**, and one
repo averaged a **28-minute** wait. Work was queueing while 26 runners sat idle,
because a runner serves one job at a time and each repo had exactly one runner.

So sizing is per repo, and the input is that repo's own *concurrent* demand, not
the length of the fleet-wide queue. `want` is the **p90 of simultaneous jobs for
that repo**, capped by `maxInstancesPerRepo`.

Not the peak: one repo here peaked at **33 simultaneous jobs**, a matrix fan-out,
and 33 concurrent jobs on 12 cores is how this host recorded a load average of
**760**. Sizing to peak encodes the worst moment as the steady state. The queue
is what covers the rest.

### Nothing in the dashboard throttles execution — runner count is the limit

There is no scheduler. Every registered runner listens independently, so if 27 of
them are offered work in the same second, 27 jobs start. Nothing on this page
changes that; the only thing that does is the
[job hooks](#job-admission-control), which live outside the dashboard and are off
by default. This is worth stating plainly because the setting names invite the
opposite reading:

| Setting | What it actually does |
|---|---|
| `maxTotalRunners` | The real cap on concurrency, because it caps how many runners can exist |
| `ceiling` | Refuses to *add* a runner while this many jobs are running. Does not stop a burst across runners that already exist |

Adding a runner does not add capacity; it adds concurrency on fixed capacity. On
this fleet's history each concurrent job is expensive on a 12-core machine:

| Concurrent jobs | Median load1 | Samples |
|---|---|---|
| 0 | 1.7 | 23,490 |
| 1 | 15.1 | 2,593 |
| 2 | 60.4 | 684 |
| 3 | 91.4 | 199 |
| 4 | 127.5 | 98 |
| 5 | 236.4 | 19 |

Two jobs already put load at five times the core count, which is why the default
ceiling is 3 rather than something like one-per-core.

### Job admission control

The one mechanism that can throttle a job already dispatched to a runner is the
runner's own `ACTIONS_RUNNER_HOOK_JOB_STARTED` hook, which runs before the job's
first step. `hooks/job-started.sh` claims a slot there and holds the job if the
fleet is already at its configured limit; `hooks/job-completed.sh` frees it. See
[Capping concurrent jobs](../README.md#capping-concurrent-jobs) for setup and
the trade-offs.

The dashboard neither installs nor configures this — the hooks are read from each
runner's `.env` and the limits from `fleet.env`, both of which are outside the
daemon's control plane. It only reports. The Capacity tab's admission panel shows
the mode, how many runners reference the hooks, a 24-hour decision breakdown, the
total time jobs spent held, and anything waiting right now.

Two states in that panel are worth recognising:

- **"checking"** means the install count has not been taken yet. It comes from
  the slow loop, so for the first few minutes after a restart the daemon does not
  know. It says so rather than reporting `0 of 0`, which would read as *no hooks
  installed* on every restart.
- **`owner_kind` of `fallback`** means the hook could not find its
  `Runner.Worker` ancestor and recorded the immediate parent PID instead. Slots
  are keyed on that PID and reaped when it dies, so a fallback owner can be a
  short-lived shell — the slot then survives only until the TTL rather than the
  job. Rare, and it fails towards admitting jobs, not blocking them.

An event's `waited_s` is time that job spent waiting for a slot; a release's
`ran_s` is how long it then occupied one. Only `waited_s` is time the mechanism
cost, which is why the panel's held total sums that and ignores `ran_s`.

Events arrive by tailing the hook's NDJSON log, not by any call from the hook
into the daemon. A hook that runs while `fleetd` is down still records its
decision, and the events appear at the next ingest. That log is the source of
truth; the `admission_events` table is a cache of it.

### What the headroom gate uses, and what it ignores

Refusals are shown verbatim in the UI, because this gate is expected to say no
often and a silent refusal is indistinguishable from a bug.

It gates on total runners, jobs already running, **load per core**, free disk
(a runner costs 1.3–2.3 GB), and — as late backstops — kernel memory pressure
and the swap-in rate.

It deliberately does **not** gate on swap *used*: that is an accumulator, not a
gauge (see [Why the host tile shows pressure, not
swap](#why-the-host-tile-shows-pressure-not-swap)). Pressure and swap-ins are
backstops rather than the primary test because they arrive late — pressure read
`warning` in 1.3% of 27,093 samples and swap-ins are 0.1/sec at p90. Load is the
early signal precisely because it tracks concurrency so tightly.

### The autoscaler

Off by default, and dry-run by default when enabled. It makes **one decision per
sweep**, every 60 seconds, and scale-up always wins over scale-down so a single
tick can never both add and remove on contradictory evidence.

To scale **up**, all of these must hold: a repo is under-provisioned, it has work
that has been queued longer than `minQueuedMs`, its per-repo cooldown has
elapsed, and the headroom gate passes. Automation cannot override headroom — a
person can.

To scale **down**, a runner must be instance 2 or higher, idle, its repo must
have no active work, the runner must be older than `idleTtlMs`, and it must not
have run a job within that TTL. **Instance 1 is never removed**: that would take
a repo's CI away rather than free contention.

The idle TTL defaults to **three days**, not hours. A dry run at six hours
immediately proposed removing a duplicate that had run 103 jobs and last worked
that morning — six hours does not mean "unused", it means "overnight", and the
runner would be re-added the next working day and removed again the night after.

It lives in the collector rather than in autofix. Autofix remediates *faults* and
should act quickly on a clear one; a scaler spends a shared resource and should
act slowly and reluctantly. Keeping it here also avoids widening autofix's
allowlist to include registration and removal, which it deliberately excludes.

It cannot help a fan-out burst — a runner takes tens of seconds to create, and by
then a 33-job fan-out is over. It is aimed at the sustained case: the repo that
has queued for ten minutes because it owns one runner and wants two.

### Checking its work

The tab reports **p90 queue wait before and after** each repo's second runner
appeared, split on that runner's directory creation time — durable, and it
measures duplicates created by hand as readily as ones the scaler added.

p90 rather than the median because the median wait fleet-wide is about six
seconds, which would make every duplicate look pointless. The waiting is all in
the tail.

It is observational, not a controlled comparison, and the panel says so. The one
repo here with enough history on both sides shows waits getting *worse* after its
duplicate — because its job volume grew sevenfold over the same period, which is
also why the sizing panel now wants four runners for it rather than two.

### Settings

Everything above is editable while the daemon runs, on the same tab. No restart,
no plist regeneration.

Precedence is **stored setting → environment → built-in default**. The
environment *seeds* a setting; it does not override one. That direction is the
only one that works: if the environment won, a value edited in the UI would
silently revert on the next restart. The cost is that editing `fleet.env`
afterwards has no effect on a setting already overridden in the UI, so every
value displays which of the three layers it came from, and any stored value can
be reset back to the environment or default.

`FLEET_PORT`, `FLEET_HOST`, `FLEET_DB` and `FLEET_TOKEN_FILE` stay
environment-only — the first two are bound once at startup, and the database path
is needed to read the settings table in the first place. The UI marks them as
such rather than offering an edit that would not take.

## Workflow lint

Static analysis over every workflow file in every repo. Each rule corresponds to
something that actually went wrong on this fleet, not to a style preference:

| Rule | What it catches |
|---|---|
| `unmatched-label` | a `runs-on:` no live runner satisfies — the job queues until something cancels it |
| `unserved` | the repo has self-hosted jobs and no runner registered anywhere |
| `no-timeout` | a self-hosted job with no `timeout-minutes`; GitHub's 6-hour default never applied to self-hosted |
| `hosted-macos` | a job on GitHub-hosted macOS, which bills at 10x against the included allowance |
| `no-cancel-in-progress` | a `pull_request` workflow that does not supersede its own runs |
| `unparsed` | the parser would not guess — nothing was checked there |

**The YAML is parsed, not grepped.** `lib/yaml.js` is a subset parser sized for
these files. The construct that forces it is the block scalar: there are 79 of
them across 23 files, nearly all `run: |` shell scripts whose contents are
arbitrary text. A line scanner reads `runs-on:` out of a heredoc and reports a
job that does not exist, and one finding like that is enough for someone to stop
believing the whole screen. Anything the parser cannot confidently read is
reported as `unparsed` and skipped rather than guessed.

It was validated against PyYAML across all 22 workflow files in these repos —
123 fields compared (job names, `runs-on` values, timeouts, step counts,
triggers, concurrency), zero mismatches — and against deliberately hostile input:
a `run: |` block containing a fake `jobs:` tree, `timeout-minutes` inside a
comment and inside a heredoc, anchors, merge keys and tabs.

Two scoping rules stop false positives:

- **Reusable workflows** (`on: workflow_call` only) never run in their own repo —
  they execute in the caller's context on the caller's runners. Their labels are
  checked against the whole fleet, and `unserved` does not apply to them.
- **Label matching is a subset test across every runner registered for the repo,
  on any machine.** A repo that splits `ci` and `release` across two hosts on
  purpose would otherwise be flagged as broken by a check that only saw the
  local runners.

### It lints the branches that actually run

GitHub executes the workflow file **from the ref that triggered the run**, so
there is no single file to check. This used to read the default branch only,
which was wrong in a way that took a manual investigation to notice: the repos
it was built against default to `develop`, while `main` is where pull requests
merge. In one of them the two had diverged by 41 commits, `main` already had the
`concurrency` block, and the Lint tab reported the missing one on `develop`
forever — a finding whose fix already existed one branch over.

The refs to check come from the local `runs` table, not the API, so discovering
them costs nothing:

- **`push` events only.** A `pull_request` run's `head_branch` is the PR's own
  branch — 188 distinct ones for a single repo in 30 days, all transient.
  Pushes land on the handful of long-lived branches, which is also the set
  someone can still fix.
- **At least two pushes**, which drops single-push leftovers like a stale `ci/…`
  branch.
- **Semver-looking refs are skipped.** A tag push runs the file as it was at that
  tag, and no finding against an immutable tag is actionable.
- **The default branch is always included**, pushes or not — it is what the next
  PR opens against.

On this fleet that resolves to `{main, develop}` and turns 27 files into 41
file/branch checks. Findings identical across refs are collapsed into one row;
what the screen adds is the refs each finding applies to, because **a finding on
one branch and not another is a different problem** — the file is already correct
somewhere and the branch is behind, so the fix is a merge, not an edit. Empirically
that is rare and worth knowing: across nine repos with both branches, only that
one file differed in anything a rule reads.

## Alerts

Alerts fire on **transitions**, not levels. A rule evaluated every 15 seconds
that notified whenever it was true would send 240 notifications an hour for one
dead runner, and the second one would already be ignored. Each condition opens
once, closes once, and is stored as an interval — so "how long was it down" is a
fact rather than a guess, and a daemon restart reloads what was already open
instead of re-announcing it.

Two more things stop it becoming noise:

- **Sustain windows.** Disk and paging cross their thresholds constantly during
  a build and come straight back. A threshold measures the sample; a threshold
  plus a duration measures the problem.
- **A storm guard.** A reboot puts every runner down at once. Past five at a
  time it sends one notification saying how many, because sixteen is not sixteen
  times more useful than one.

**There is deliberately no load-average rule.** Measured on this host, a single
ordinary Xcode build drives load past 100 on 12 cores. Alerting on that would
fire on healthy behaviour every day, which is how people learn to ignore alerts.

**And deliberately no swap-LEVEL rule**, for the same reason — see below.

What does fire: a runner dead, missing its LaunchAgent, or offline; an orphan;
a sibling label mismatch; a run stuck in the queue; disk low; sustained paging
or kernel-reported memory pressure; the collector unable to reach GitHub; and a
workflow that was green and just went red.

## Auto-remediation

`autofix/` turns alert transitions into action. It is a separate process and a
separate LaunchAgent from the dashboard, because a bug in something that
restarts runners must not be able to take down the thing that tells you runners
are down.

```bash
./autofix/autofixctl.sh wire       # point the alert webhook at the bridge
./autofix/autofixctl.sh install    # LaunchAgent
./autofix/autofixctl.sh dryrun     # decides everything, does nothing
./autofix/autofixctl.sh status     # what it is tracking and how many attempts
curl -s 127.0.0.1:7879/status      # + escalation budget, and whether it is disabled
```

The webhook is treated as a **doorbell, not a message**. Its payload carries
`{severity,title,body}` with no rule and no key, and a storm collapses sixteen
alerts into one summary — so the bridge discards the body and re-reads
`/api/alerts`. Every wake-up is a full reconcile against real state, which
means a missed webhook, a duplicate and a daemon restart all converge to the
same place instead of each needing their own handling.

**It fixes exactly three things**, and they all get the same fix:
`launchd-dead`, `launchd-missing` and `offline` run `health.sh --repair`. That
script is already the correct response to all three, so the bridge is a trigger
for it rather than a second implementation of it.

Everything else — `stuck-queue`, `newly-failing`, `label-mismatch`, `orphan`,
`no-listener` — has no deterministic repair. Those need a workflow file read or
a job log interpreted before anyone knows what the fix is, so nothing is ever
*fixed* automatically for them. They are instead **escalated**: an agent does
the reading and writes down what it found.

### Escalation: the alerts with no mechanical fix

A notification at 03:00 saying `Run is stuck in the queue` is not judgement, it
is a request for someone else to go and read six API endpoints. Escalation does
that reading. The split is **autofix repairs, escalation explains** — nothing in
this path touches the fleet.

```bash
./autofix/escalate.sh --login         # sign in; no API key needed
./autofix/escalate.sh --verify        # does the credential actually work?
./autofix/escalate.sh '<alert-json>'  # diagnose one alert by hand
```

It is **off until a credential exists**, and stays off at no cost. There are two
sources, and `--login` is the one to reach for first because minting an API key
needs dashboard access that a managed team account often does not grant:

```bash
./autofix/escalate.sh --login    # browser login, writes ~/.cursor/sdk/auth.json
./autofix/escalate.sh --verify
```

```bash
# Or, if you can mint an API key, it does not expire:
printf '%s' 'cursor_...' > .cursor-api-key   # cursor.com/dashboard/integrations
chmod 600 .cursor-api-key                    # refused if it is more permissive
```

The key file wins when both exist. **The login credential lasts 90 days**, which
makes expiry a certainty rather than a risk for something running unattended —
`--verify` reports the remaining days and warns under two weeks, and the breaker
below catches it if it lapses anyway.

Output goes three places: a macOS notification with the headline, a full report
in `logs/escalations/`, and — only when it is warranted — a GitHub issue on the
affected repo, labelled `fleet-escalation`.

**Filing policy is enforced in code, not asked of the model.** The agent returns
a verdict with `blame`, `confidence` and `transient`, and it can veto an issue,
but it cannot cause one: nothing is filed at `confidence: low`, nothing
`transient`, and nothing with `blame: account`. That last exclusion is the
important one. 58% of job failures on this fleet over 30 days were the account's
Actions spending limit refusing to start the job — one billing problem, and
filing it as a bug on nine repositories would be nine wrong issues. Recurrence
comments on the existing issue rather than opening another.

**Every budget here is a cost control.** Diagnosis costs money and takes
minutes, so the limits are much tighter than the repair limits above:

| Guard | Value | Why |
|---|---|---|
| `minOpenMs` | 2–10 min | `stuck-queue` has been observed clearing seconds after firing. Don't pay to diagnose something already resolving. |
| cooldown | 6–24 h | Per **condition**, not per alert key. |
| daily cap | 8 / 24 h | Bounds what a bad week costs, regardless of cooldowns. |
| storm | ≥ 6 open | Systemic event; per-alert diagnosis is wrong by construction. |
| concurrency | 1 | Two agents reading the same fleet is spend without information. |

The cooldown being keyed on the condition matters more than it looks. A
`newly-failing` key is `newfail:<repo>:<workflow>:<run id>`, so every push
produces a brand new key for the same broken workflow — keying the cooldown on
that would diagnose the identical failure twenty times before lunch. Escalation
collapses the run id away and treats it as one condition.

> **The first attempt at this was removed, and the reason shaped the design.**
> It spawned `claude -p`. Headless auth on this host resolved to API credits
> rather than the subscription, so across six real alerts over four days it
> returned `Credit balance is too low` every time and never once produced a
> diagnosis. The design was fine; nothing noticed it had stopped working.
>
> So a credential that cannot start a run is now treated as a fault in its own
> right. `--verify` exists to catch it at install time for the price of one API
> call, and three consecutive startup failures **disables escalation** and says
> so in `/status` rather than retrying into the void. Only touching a credential
> re-enables it, which is the action that fixes the underlying problem anyway.
>
> One subtlety worth knowing, because it defeated the first version of the
> breaker: `Agent.create` does **not** validate a local credential. A missing or
> expired one is accepted at construction and rejected ~16 seconds later inside
> the run, arriving as `result.status === "error"` with `Invalid User API Key`
> rather than as a thrown `CursorAgentError`. Reported naively that is a *run*
> failure, which is exactly the category the breaker ignores — so an expired
> login would have failed silently forever, reproducing the original bug through
> a different door. Auth-shaped run errors are therefore reclassified as startup
> failures. Otherwise startup and run failures stay strictly separate, because
> "never started" and "ran and failed" need different people to do different
> things.

Escalation is also the **only** part of this dashboard with a dependency, which
is why it lives in `autofix/escalate/` behind its own `package.json`. The bridge
imports nothing outside the Node standard library. If that subtree fails to
load, dead runners still get repaired and the only thing lost is the
explanation.

**Nothing acts immediately.** Each rule carries a `minOpenMs`, and the value for
`offline` is 5 minutes because that rule is measured to self-resolve: four
`offline` alerts on this host closed on their own after 46s, 195s, 264s and
276s. Repairing the moment one opened would have been fighting a listener that
was already recovering — four times out of four, while looking like the thing
that fixed it.

Past `AUTOFIX_STORM` open alerts (default 6) it acts on nothing. Six at once is
a reboot or a partition, where the per-alert fix is wrong by construction and
sixteen concurrent restarts turn a bad morning into an outage. Attempts are
capped per alert key and recorded *before* the work, so a process that dies
mid-remediation still burns the attempt — otherwise a restart loop becomes a
rerun loop, and the thing that wastes a day of CI is the fix that keeps
retrying. State is cleared when an alert closes, so a genuine recurrence next
week gets a fresh budget.

### Why the blast radius stays small

The bridge decides *when* to act; `fleet-action.sh` decides what may *ever* be
acted on. Keeping those in separate files means the complete set of things an
unattended process can do to sixteen runners is one short list you can read in
a few seconds, rather than something you reconstruct by following control flow:

- **`fleet-action.sh` exact-matches an allowlist.** `runner.deregister`,
  `runner.duplicate`, `runner.register` and `fleet.cleanupApply` are not in it.
  Exact-match, not prefix — a prefix rule accepting `fleet.cleanup` would accept
  `fleet.cleanupApply`. Scaling does not go through this path at all; see
  [Capacity and autoscaling](#capacity-and-autoscaling).
- **The control token is not in the daemon that listens on a socket.** The
  bridge knows a script name; the script holds the credential. A bug in the
  bridge's HTTP handling is not a bug that can tear down the fleet.
- **`run.cancel` is deliberately absent** even though it looks harmless. The
  analytics treat a cancelled run as unmeasurable, so anything cancelling
  automatically would quietly corrupt the percentiles it is judged by.

- **`escalate.sh` is the same pattern for the judgement half.** It exact-matches
  its own allowlist of escalatable rules, refuses the three rules autofix owns
  so a model is never paid to narrate a repair already in progress, and holds
  the API key so the socket-listening daemon never sees it. A local agent runs
  as this user and has a shell, so its read-only posture is an instruction
  rather than a sandbox — what actually bounds it is that this path carries no
  fleet credential, leaving the destructive actions behind the allowlist above.

Both allowlists are wider than the bridge uses — it only ever calls
`fleet.healthRepair`, and it enables three of the five escalatable rules — so
each doubles as the operator's safe manual entry point.

`AUTOFIX_DRY_RUN=1` decides everything and does nothing, which is the honest way
to find out what it would have done before letting it.

## Why the host tile shows pressure, not swap

Swap **used** on macOS is an accumulator, not a gauge. The kernel compresses
before it swaps and never proactively reclaims swap space, so pages written
during any peak in the machine's uptime stay counted long after nothing needs
them.

Measured on this host: **4.3 GB of swap "used" while memory was 71% free, load
was 1.0, and thirty seconds of sampling showed zero swapins and zero swapouts.**
Three hours of samples had swap pinned in a 32 MB band while memory in use swung
by 5 GB and load peaked at 62 — it does not even correlate with what the fleet is
doing. Fifteen days of uptime had written ~8.5 GB to swap and read only ~2.5 GB
back.

The tile originally led with swap used and a 50/75/90% meter, inherited from a
note in the fleet's own README: *"two simultaneous Xcode builds drove free swap
under 1 GB."* That was measured on the **old 16 GB Mac**, where swap really was
the binding constraint. On a 32 GB host it is not, and carrying the framing over
produced an orange tile on a perfectly healthy machine — which teaches you to
ignore the tile.

It now leads with the kernel's own memory-pressure level and free percentage,
and the meter tracks the **swap-in rate**: a page being read back is a thread
stopped waiting for memory, which is the thing you actually feel. Swap level
survives as a muted sub-line, where a number that means very little belongs.

macOS notifications are on by default — they cost nothing and stay on the
machine. The webhook is off until you configure one, because it sends fleet
state to a third party and that is the operator's decision, not a default. Copy
`alerts.config.example.json` to `alerts.config.json` (gitignored — a webhook URL
usually carries a token) for ntfy, Pushover or Slack. `FLEET_ALERTS=0` disables
alerting entirely.

## What the analytics deliberately exclude

Three filters do most of the work of keeping the numbers honest. Each was added
because leaving it out produced a confidently wrong answer:

- **Cancelled runs are out of every duration percentile.** A cancelled run's
  duration measures how long until something killed it. Including them put
  24-hour outliers in the same p50 as a 90-second test suite and reported the
  slowest workflow in the fleet as one that has never successfully run.
- **Jobs that never reached a runner are out of concurrency and duration.** A job
  that queued 24 hours and was then cancelled still carries a `started_at` and a
  `completed_at`, so it presents as a 24-hour interval overlapping everything.
  139 of those reported a peak concurrency of 34 on a host with 16 runners —
  a number that cannot happen.
- **Jobs-per-run is measured only over runs whose job detail was fetched.**
  Dividing by every known run instead makes the ratio track backfill progress,
  which reads as "0.04 jobs per run" and turns the second-runner verdict into
  nonsense. Below five sampled runs it declines to answer at all.

A run cancelled after more than an hour is reported separately as **never
scheduled** — that is a `runs-on:` label no live runner carries, not a slow run.

## Why a job failed, not just that it failed

`conclusion = 'failure'` is one value covering causes that need different people
to do different things. Measured over 30 days on this fleet, **58% of failed jobs
were not about the code at all**:

| Cause | Whose problem | Jobs | Repos |
|---|---|---|---|
| `account-blocked` | billing — Actions refused to start the job | 117 | 9 |
| `job-failed` | yours — a step exited non-zero | 84 | 11 |
| `account-quota` | billing — artifact/storage quota full | 6 | 2 |
| `runner-lost` | this host — CPU/memory starvation or network | 4 | 1 |

The `account-blocked` jobs never reached a runner, never ran a step, and had
nothing to do with the commit that triggered them: *"The job was not started
because recent account payments have failed or your spending limit needs to be
increased."* Between 2026-07-29 and 2026-08-08 that hit nine repos. Note that it
blocks **self-hosted** jobs too, which consume no Actions minutes — the runners
were idle and healthy the whole time.

The cause only exists in a job's **annotations**, one API call per failed job, so
the backfill fetches it in a third phase after runs and jobs. That order is
deliberate: run and job detail is the record GitHub deletes and nobody can
recover, while a cause is a nicety, so it gets the leftover budget rather than
competing for it. Every fetch writes something back — `unknown` when GitHub has
already expired the annotations — so no job is ever asked about twice.

`newly-failing` alerts now name the cause when it is one that redirects you
somewhere else, so the notification reads *"Backend CI — Account blocked"* rather
than *"Backend CI started failing"*. Ordinary step failures deliberately do **not**
get a cause in the title: "started failing" already means that, and a title that
says the same thing twice is one people stop reading.

### The backfill's `done` flag was a latch

Worth recording because the symptom was silence. `scheduleBackfill` skipped the
pass whenever `backfill.progress.done` was true, but `done` is only recomputed
*inside* a pass — so once it went true it could never go false, and job and step
detail stopped accumulating permanently. The daemon reported `complete, 0 pending`
while 17 completed runs had no job detail at all. The gate is now a live
`hasWork()` — three local `COUNT`s, no API calls — which is both correct and
cheaper than being wrong.

## Environment

| Variable | Default |
|---|---|
| `FLEET_PORT` | `7878` |
| `FLEET_HOST` | `127.0.0.1` |
| `FLEET_ROOT` | `~/actions-runners` |
| `FLEET_DB` | `dashboard/fleet.db` |
| `FLEET_FAST_MS` | `15000` (fleet busy) |
| `FLEET_IDLE_MS` | `45000` (fleet asleep) |
| `FLEET_SLOW_MS` | `900000` |
| `FLEET_BACKFILL_MS` | `600000` |
| `FLEET_BACKFILL_CALLS` | `350` per pass |
| `FLEET_BACKFILL_FLOOR` | `1500` rate-limit floor |
| `FLEET_TOKEN_FILE` | `dashboard/.fleet-token` (0600) |
| `FLEET_READ_ONLY` | unset; `1` disables the control plane |
| `FLEET_ALERTS` | unset; `0` disables alerting |
| `FLEET_ALERT_CONFIG` | `dashboard/alerts.config.json` |
| `FLEET_PROJECTS` | unset; pins groups and their order, overriding inference |
| `FLEET_GROUP_MIN` | `2` repos sharing a token before it becomes a group |
| `FLEET_GROUP_IGNORE` | unset; tokens that must never become a group |
| `FLEET_GROUPS` | unset; `off` shows one flat list |
| `FLEET_ADMISSION_LOG` | `dashboard/logs/admission.ndjson`; written by the job hooks, read-only to the daemon |
| `AUTOFIX_PORT` | `7879` |
| `AUTOFIX_DRY_RUN` | unset; `1` decides but never acts |
| `AUTOFIX_SWEEP_MS` | `60000` — required, not a fallback: most rules refuse to act until an alert has aged, and the webhook only fires when it opened |
| `AUTOFIX_COOLDOWN_MS` | `900000` between attempts on one alert |
| `AUTOFIX_STORM` | `6` open alerts, past which it acts on nothing |
| `AUTOFIX_STATE` | `autofix/state.json`; override to run a test instance without clobbering the daemon's counters |
| `AUTOFIX_ESCALATE_CAP` | `8` escalations per rolling 24h |
| `AUTOFIX_ESCALATE_TIMEOUT_MS` | `420000` before the child is killed |
| `CURSOR_API_KEY_FILE` | `dashboard/.cursor-api-key` (0600). Falls back to `~/.cursor/sdk/auth.json` from `--login`; with neither, escalation is off |
| `ESCALATE_MODEL` | `composer-2.5` |
| `ESCALATE_TIMEOUT_MS` | `300000`, enforced with `run.cancel()` so the run is torn down remotely too |
| `ESCALATE_DRY_RUN` | unset; `1` builds the prompt, writes it out, calls nothing |
| `ESCALATE_NO_ISSUE_REPOS` | unset; comma-separated repos that never receive automated issues |

## API

`/api/state` snapshot · `/api/stream` SSE · `/api/runner?name=` detail with
`_diag` tail · `/api/repo?name=` job and step breakdown ·
`/api/analytics?days=` aggregates · `/api/history?repo=&limit=` · `/api/health` ·
`/api/actions` catalogue and audit log · `POST /api/action` (bearer token) ·
`/api/alerts` open and resolved alerts · `/api/lint` workflow findings ·
`/api/admission?limit=` recent hook decisions plus the summary shown on the
Capacity tab · `/api/queue-causes` why each queued run is waiting ·
`/api/concurrency` cross-file workflow concurrency advice ·
`/api/simulate?days=` scenario replay · `/api/forecast?hours=` burst forecast and
its evaluation gate · `/api/hosts` every machine in the fleet ·
`/api/runner/bundle?name=` redacted diagnostic bundle (bearer token) ·
`POST /api/host/heartbeat` and `POST /api/host/results` (bearer token, used by
`agent.js`).

Two shapes worth knowing:

- `/api/lint` reports `files` (distinct workflow files) and `checks` (file×ref
  pairs actually linted) separately — reporting only the latter would claim 41
  workflows exist when there are 27 on two branches each. Each finding carries
  `refs` (the branches it applies to) and `refsChecked` (the branches examined).
- `/api/analytics` carries `failureCauses` — the split above, plus `blame`
  totals. `/api/repo` carries the same per job, so a red sparkline can be read
  without opening GitHub.
- `/api/simulate` and `/api/forecast` return numbers that look like the ones on
  the Analytics tab and are not the same thing. Analytics reports what happened;
  these report what a replay or a baseline says *would* happen. Both carry a
  `note` saying so, and both are rendered below the measured panels for the same
  reason.

## Why a job is queued

A queued job used to produce one drift row — "stuck in the queue" — with a single
question behind it: is a runner idle? That separated two of the seven reasons a
job can wait, and it separated the wrong pair. "Every runner is busy" and "the
host is saturated" both look like *no runner is idle*, and only the first is
fixed by adding a runner.

[`lib/queue-cause.js`](lib/queue-cause.js) classifies each queued run instead,
with the evidence it used and a confidence level:

| Cause | What it means | Adding a runner helps? |
|---|---|---|
| `telemetry-unavailable` | The last GitHub call failed, so nothing here is trustworthy | Unknown — refuses to guess |
| `unserved` | No runner exists for the repo at all | Register one |
| `label-mismatch` | The job's `runs-on:` matches no runner's labels | **No** — a copy has the same labels |
| `runner-down` | A runner exists for the repo and is not running | No — repair it |
| `concurrency-block` | A workflow `concurrency:` group is holding it | No |
| `host-saturation` | Runners are free but the host is out of headroom | No — it would be refused |
| `repo-capacity` | Every runner for the repo is busy, and there is headroom | **Yes** |
| `github-delay` | Nothing is wrong here; dispatch is slow | No |

Only `repo-capacity` at **high** confidence lets the autoscaler act, and only
that combination shows an **Add a runner** button. This is the concrete failure
it prevents: cloning a runner whose labels do not match produces a second runner
that also never matches, which is how one idle runner became two.

Causes are persisted as *transitions* in `queue_events`, not once per tick, so
"how long was this a label mismatch before anyone noticed" is answerable without
storing a value that rarely moves.

## Forecasts are shadow-only

The burst forecast on the Capacity tab is a lookup table, not a model: for each
repo, weekday and hour, the peak concurrent demand observed, and how many
separate *weeks* contributed it. A pattern needs three distinct weeks before it
counts, which is what separates "every Tuesday at 09:00 the mobile team pushes"
from "one Tuesday in March somebody ran a migration". Cron schedules parsed out
of workflow files count immediately, because a cron expression is a statement of
fact rather than a prediction.

Nothing acts on any of it. The daemon predicts, waits for the hour to pass,
scores the prediction against what actually happened, and writes the result to
`forecast_evals`. Pre-warming stays locked until precision reaches 0.70 and
recall 0.50 over at least 20 scored windows — and the gate, with its current
numbers, is shown on the tab. Precision is weighted above recall deliberately: a
missed burst costs a few minutes of queue wait, while a false positive spends
disk and a concurrency slot on a runner that will idle out.

There is deliberately no machine learning here. The failure mode is expensive and
silent, and a forecast that cannot explain itself gives an operator no way to tell
a broken model from an unusual week.

## Diagnostic bundles

The **Diagnostics** button in the runner drawer downloads a text bundle that is
safe to paste into an issue. It is built from an **allowlist**, never a denylist:

A runner directory holds `.credentials` and `.credentials_rsaparams` — the private
key that authenticates it to GitHub — and `_work`, which holds whole checkouts of
private repositories plus whatever secrets a job wrote to disk. A denylist gets
those wrong exactly once, and by then the result has already been pasted into a
public issue.

So nothing is included unless [`lib/bundle.js`](lib/bundle.js) names it, and
everything that survives goes through a redactor that matches on key *names*
(`*TOKEN*`, `*SECRET*`, `*KEY*`…), GitHub token formats, `Bearer` headers, PEM
blocks and long base64 runs. `.env` is allowlisted because `PATH` and the hook
wiring are genuinely useful, and it is exactly the file somebody eventually puts
a token in — which is why the redactor exists rather than trusting the list. The
bundle ends with everything it excluded, so a reader can see the filter ran.

## Hosts

The Hosts tab shows every machine, with the local one as a first-class member
rather than a special case. Extra hosts run [`agent.js`](agent.js), which reports
**outbound** on a 30-second heartbeat — see
[More than one Mac](../README.md#more-than-one-mac).

Staleness is the most prominent thing on the page. A coordinator's picture of a
remote host is only as fresh as its last heartbeat, and a runner list from four
minutes ago rendered like a live one invites decisions based on state that has
already changed. A host silent for over two minutes is marked stale, its runners
are marked rather than dropped — dropping them makes a partitioned host's runners
look like they were removed, which is the most alarming possible way to render a
network blip — and placement refuses it.

A host is taken out of rotation with a `.drain` file at its fleet root — the same
file name and contents that drain a single runner, because a second convention
for the same idea is one more thing to remember at the moment somebody is taking a
machine out of service in a hurry. The host reports it, so the decision stays with
the machine that owns it. Its existing runners keep working; placement just stops
choosing it. The state is persisted, so restarting the coordinator does not put a
drained host back into rotation before its next heartbeat.

Agents may only run the actions in their own allowlist, and only with
`FLEET_AGENT_ALLOW_COMMANDS=1`. Deregistration is deliberately absent: it is
irreversible, and a coordinator bug that deregistered a fleet would be a bad
afternoon. The host decides, which is the only arrangement where a mistake on the
coordinator cannot become a shell on every machine.

The agent's capacity limits are `FLEET_MAX_TOTAL_RUNNERS`, `FLEET_CEILING`,
`FLEET_LOAD_PER_CORE` and `FLEET_MIN_FREE_DISK_GB`, which are the same limits the
coordinator applies to itself. Each host computes its own headroom, because it is
the only place that knows its load and disk, and a coordinator deciding from a
30-second-old copy would be deciding from stale data at exactly the moment it
matters.
