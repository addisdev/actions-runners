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

The forecast and replay endpoints, and the `note` they carry, are in the
[API reference](../api.md).
