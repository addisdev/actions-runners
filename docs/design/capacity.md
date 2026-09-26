# Capacity and autoscaling

This page argues that queueing on this fleet is a per-repo problem rather than a
fleet-wide one, that adding a runner adds concurrency rather than capacity, and
that every gate around both is set from something measured on this host.

The **Capacity** tab answers one question — *should this fleet have more runners,
and can this machine take them* — and it is built around a fact that was measured
rather than assumed.

## The problem is per-repo, not fleet-wide

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

## Nothing in the dashboard throttles execution — runner count is the limit

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

## Job admission control

The one mechanism that can throttle a job already dispatched to a runner is the
runner's own `ACTIONS_RUNNER_HOOK_JOB_STARTED` hook, which runs before the job's
first step. `hooks/job-started.sh` claims a slot there and holds the job if the
fleet is already at its configured limit; `hooks/job-completed.sh` frees it. See
[Admission control](../admission-and-scaling.md#admission-control) for setup and
the trade-offs, and
[Job admission variables](../configuration.md#job-admission-variables) for the
settings themselves.

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

## What the headroom gate uses, and what it ignores

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

## The autoscaler

Off by default, and dry-run by default when enabled. It makes **one decision per
sweep**, every 60 seconds, and scale-up always wins over scale-down so a single
tick can never both add and remove on contradictory evidence.

To scale **up**, all of these must hold: a repo **and role** is under-provisioned,
it has self-hosted work that has been queued long enough, its per-role cooldown
has elapsed, and the headroom gate passes (except for a repo's first runner — see
[Giving a repo its first runner](#giving-a-repo-its-first-runner)). Automation
cannot override headroom — a person can.

Sizing and scale-up are **per role** (`ci`, `ui-web`, or unroled). A repo with
one `ci` runner and two queued `ui-web` jobs needs another `ui-web` runner, not a
copy of `ci`. The planner picks a same-role sibling to duplicate, or derives
labels from the queued job when that role does not exist yet.

Two scale-up modes exist; **burst mode is off by default** so existing fleets
keep the conservative policy until an operator enables it:

| Mode | When it applies | Queue wait | Cooldown |
|---|---|---|---|
| **Sustained** | Default | `minQueuedMs` (10 minutes) | `scaleCooldownMs` (30 minutes) |
| **Burst** | `burstScale` on and ≥ `burstMinQueuedJobs` jobs queued for one repo+role | `burstMinQueuedMs` (2 minutes) | `burstScaleCooldownMs` (5 minutes) |

The planner returns **one action per sweep** plus a **deficit** count of how many
runners are still wanted fleet-wide after that action. A bounded action list is
available only when the executor sets `revalidate: true` and re-runs the planner
between steps — otherwise stale batch decisions are unsafe.

Complete queue discovery requires paginated GitHub queries. `GitHub.activeRuns()`
and the pure helpers in `lib/github.js` (`filterActiveRuns`, `mergeRunPages`,
`activeRunQueryPaths`) collect every queued and in-progress run instead of only
the latest page of mixed-status results.

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

## Giving a repo its first runner

Everything above describes a **duplicate**: a second or third runner for a repo
that already has one, created by copying a sibling's labels. A repo with *no*
runner has no sibling to copy, so for a long time the fleet could diagnose that
case — the queue classifier has always called it `unserved` and recommended
"register a runner for this repo" — and could not act on it.

`provisionUnserved` closes that gap, off by default like every other scaling
switch. It exists so the fleet can be **trimmed**. The host limit is 32 runners
and the fleet reached 42, but the runners over that line belong to real repos,
so removing them otherwise means choosing which repos silently lose CI. With
this on, a trimmed repo gets a runner back the next time it actually asks for
one, and the steady state becomes "runners for repos building this week".

Three things make it behave, and each exists because the obvious version is
wrong:

- **Only a live queue counts.** A repo is provisioned because it has work queued
  right now, never because its history says it used to be busy. Every trimmed
  repo still has months of job history, so sizing off history would ask for all
  of them back in a single sweep and undo the trim.
- **Only self-hosted work counts.** Most repos with no self-hosted runner are
  meant to have none — of the ten unserved repos this fleet watches, every one
  builds on GitHub-hosted runners. Provisioning for a queued `ubuntu-latest` job
  would create a macOS runner labelled `ubuntu-latest` that no job can match,
  which is the idle-runner mistake reached from the other direction. A job with
  no readable labels is refused too, rather than guessed at.
- **Headroom does not apply.** A first runner decides whether a repo can build
  at all, not whether two of its jobs may run at once, and `runner.register`
  already exempts instance 1 for that reason. Gating it on headroom would mean a
  trimmed repo's CI returned only during the quiet hours. A registered runner is
  not a running job in any case: admission control decides that separately, and
  `FLEET_ADMIT_MAX_CONCURRENT` still caps how many ever execute at once.

Everything else still applies — `minQueuedMs`, the per-repo cooldown, and the
placer's drain and heartbeat checks. Only the headroom test is waived.

Making this work end to end also required the collector to **poll repos that
have no runner directory**, which it previously never did; see
[Discovery](#discovery-what-the-collector-can-see) below.

### Discovery: what the collector can see

The repos polled on each fast tick come from the local runner directories. That
is sufficient while every repo of interest has a runner, and actively wrong once
one does not: a trimmed repo would never be polled, its queued runs would never
enter the snapshot, and the classifier would never get to call it `unserved`.
Trimming without fixing this would not degrade a repo's CI, it would **hide**
it — the queue would grow on GitHub and the dashboard would show nothing.

With `provisionUnserved` on, the poll list is the union of runner repos and the
roster (every non-archived owned repo with workflows). The extra cost is one
runs query per repo per tick, which is small for the reason the collector is
already built around: requests are conditional, and an idle repo answers `304`
without spending rate budget.

The roster is also **loaded from the `repos` table at startup** rather than
starting empty. It is refreshed by the slow loop, which may be fifteen minutes
away, and everything that reads the roster for display tolerated that gap.
Discovery does not: an empty roster means a trimmed repo's work is not merely
late to appear, it is not collected at all. The first live test of provisioning
missed its window for exactly this reason — the daemon restarted, the roster
came back empty, and a run queued for four minutes stopped being visible.

## Checking its work

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

## Settings

Everything above is editable while the daemon runs, on the same tab. No restart,
no plist regeneration. The values and their defaults are in
[Capacity and autoscaling](../configuration.md#capacity-and-autoscaling).

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

## Forecasts are shadow-only

The burst forecast on the Capacity tab is a lookup table, not a model: for each
repo, weekday and hour, the peak concurrent demand observed, and how many
separate *weeks* contributed it. A pattern needs three distinct weeks before it
counts, which is what separates "every Tuesday at 09:00 the mobile team pushes"
from "one Tuesday in March somebody ran a migration". Cron schedules parsed out
of workflow files count immediately, because a cron expression is a statement of
fact rather than a prediction.

Nothing acts on any of it until two independent switches agree. The daemon
predicts, waits for the hour to pass, scores the prediction against what
actually happened, and writes the result to `forecast_evals`. `evaluateGate()`
must report precision ≥ 0.70 and recall ≥ 0.50 over at least 20 scored windows,
and the gate numbers are shown on the Capacity tab. Even after the gate passes,
the **Pre-warm** runtime setting defaults to off — turning it on is deliberate.

When both are true, `planPrewarm()` in `lib/prewarm.js` may propose **one**
duplicate per sweep. It refuses unless every guard passes:

- the predicted window starts within the configured lead time (default one hour)
  but has not started yet;
- forecast confidence meets `prewarmMinConfidence` (`medium` accepts history or
  schedule; `high` requires cron-backed or doubly-confirmed history);
- the repo already has a non-draining runner to clone labels from;
- expected peak strictly exceeds registered runners and the repo is below
  `maxInstancesPerRepo`;
- the repo has no queued or in-progress work (reactive autoscale owns that case);
- the per-repo pre-warm cooldown has elapsed.

The planner returns a single conservative `runner.duplicate` action — repo, source
runner name, human-readable reason, and remaining deficit after the one addition.
It does not register first runners, bypass headroom, or stack multiple pre-warms
in one tick. Fleet integration lives in `autoscaleTick()` and is documented in
the commit that wires it; until then the library and settings are ready but the
daemon does not call the planner.

Precision is weighted above recall deliberately: a missed burst costs a few
minutes of queue wait, while a false positive spends disk and a concurrency slot
on a runner that will idle out.

There is deliberately no machine learning here. The failure mode is expensive and
silent, and a forecast that cannot explain itself gives an operator no way to tell
a broken model from an unusual week.

The forecast and replay endpoints, and the `note` they carry, are in the
[API reference](../api.md).
