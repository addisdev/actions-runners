# Honest analytics

This page argues that most of the work in reporting a fleet honestly is deciding
what to leave out, and that "it failed" and "it is queued" are each one word
covering causes that need different people to do different things.

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

## Why a job is queued

A queued job used to produce one drift row — "stuck in the queue" — with a single
question behind it: is a runner idle? That separated two of the seven reasons a
job can wait, and it separated the wrong pair. "Every runner is busy" and "the
host is saturated" both look like *no runner is idle*, and only the first is
fixed by adding a runner.

[`lib/queue-cause.js`](https://github.com/addisdev/actions-runners/blob/main/dashboard/lib/queue-cause.js)
classifies each queued run instead,
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

How the causes are rendered is in
[Queue diagnosis causes](../dashboard.md#queue-diagnosis-causes); the endpoints
that carry them are in the [API reference](../api.md).
