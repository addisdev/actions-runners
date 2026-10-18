# Standby tiers

A fleet with two hosts usually wants one of them to carry the baseline and the
other to take bursts: a workstation that is idle at night first, a shared
build box only when the workstation is full. GitHub has no setting for that. A
queued job goes to the first online, idle runner whose labels match, and a
personal account has no runner groups, so nothing can say "prefer this host".
The one lever the fleet has is **which runners are online**. The standby tiers
controller (`dashboard/lib/tiers.js`) pulls it on every fast tick.

## Three tiers

| Tier | Runners | Default | Online when |
|---|---|---|---|
| Primary | the primary host's runners | online | always, up to the primary's admission cap (see self-drain) |
| Overflow | the standby host's runners not in the floor | drained | the primary is busy, has stuck work, or is unfit (below) |
| Floor | the standby host's runners for `FLEET_TIERS_FLOOR_REPOS` | online | always; the controller never drains them |

The floor exists for work the primary can barely take: on a host whose
admission hook lets one Simulator job run at a time, an iOS repo's second job
would otherwise wait out a resume every time.

## When the overflow tier comes online

Any one of these resumes it at once:

- a primary lane (build, or Simulator when `FLEET_TIERS_SIMULATOR_CAP` > 0) has
  had busy ≥ cap for `FLEET_TIERS_RESUME_AFTER_S` (60 s). Busy counts jobs with a
  `Runner.Worker` on the primary, which includes jobs the admission hook is
  holding;
- a queued run has waited `FLEET_TIERS_QUEUE_AGE_S` (120 s) with no idle,
  matching primary runner, and some standby runner could take it;
- the primary is unfit: the verdict shows `disk-floor`, `saturated` or a dead
  primary runner (`dead-service`), its memory pressure is critical, or (for a
  primary that is an agent) its heartbeat is older than
  `FLEET_TIERS_PRIMARY_STALE_S`.

It never comes online on a standby host whose memory pressure is critical, and
a standby host that reaches critical has its overflow drained early.

## When it is drained again

After `FLEET_TIERS_DRAIN_AFTER_S` (10 min) in which every primary lane was below
cap, nothing servable was queued and no trigger above was present. Resume is
immediate and drain is slow on purpose: a resumed runner is online in seconds,
while a tier that flaps stops and starts dozens of listeners each time.

A queued run nothing in the fleet can serve (a label no runner carries) does
not hold the tier online; that is config drift, and the Lint tab reports it.
Neither does a run the queue classifier says is waiting on GitHub rather than
on a runner (`concurrency-block`, `github-hosted`, `label-mismatch`,
`telemetry-unavailable`): more runners online would not start it.

Drains are graceful. `drain-runner.sh --drain` stops an idle runner and marks a
busy one `draining`, and the completion hook stops it after its job.

## Primary self-drain

The primary's runners all look idle to GitHub while its admission hook lets two
jobs run, so GitHub keeps assigning it work that then waits at "Set up runner",
where it cannot move to another host. While a primary lane is at its cap, the
controller drains the primary's **idle** runners in that lane, so new jobs go to
the standby host instead, and resumes them once the lane has had room again.

### Hysteresis

The cap is where a busy primary lives: with a build cap of 2, the lane crosses
it every time a job starts or ends. The first version drained on the first tick
at cap and resumed after 30 s with room, and on runner-host (10-10 to 10-13)
that meant 489 drain batches of up to 55 runners, a median hold of 2.9 minutes,
and 88 drains that reached a runner after it had taken a job. Each lane now
carries a shedding state with four timers:

| | Default | |
|---|---|---|
| `FLEET_TIERS_SELF_DRAIN_AFTER_S` | 60 s | at cap this long before shedding starts |
| `FLEET_TIERS_SELF_RESUME_AFTER_S` | 5 min | room this long, without a tick back at cap, before it ends |
| `FLEET_TIERS_SELF_MIN_HOLD_S` | 10 min | shedding never ends sooner than this after it started |
| `FLEET_TIERS_SELF_MIN_OPEN_S` | 5 min | shedding never starts sooner than this after it ended |

While a lane is shedding its drained runners stay drained, and idle runners
are drained only while the lane is also at cap at that moment: a hold delays
resumes, it does not drain more of a lane with room. A fleetd restart that
finds the controller's drains in a lane treats it as shedding from the
restart, so the hold starts again rather than resuming everything at once.
The safety resumes below never wait for a hold.

A primary runner drains onto a **twin**: a standby runner for the same repo,
carrying every one of its labels, online and not being drained. The overflow
twin a self-drained primary runner leans on is not drained until the primary
runner is back. `FLEET_TIERS_PRIMARY_ONLY_REPOS` pins a repo to the primary:
it never drains onto a twin.

A job already held on the primary still finishes there. Self-drain limits how
many such jobs exist; it does not move them.

### Parking (no twin)

A runner with no twin used to stay online at the cap ("never strand a repo").
GitHub then gave it jobs the hook could only hold, and **a held job is in
progress as far as GitHub is concerned: the hold counts against its
`timeout-minutes`.** On 2026-10-16 ultra was under its disk floor, so no
homelake runner had a twin. runner-host's lane sat at its cap of 2, and every
job its homelake runners took waited in the hook. `release-check` (30 min)
timed out after a 26 min hold for a 4 min job, with every step green, and
`words` (10 min) timed out six times. Of the 94 holds on runner-host that day
that ended cancelled, 54 had waited 28 min or more.

So a runner with no twin (the standby host is drained, cannot admit, or does
not serve the repo, primary-only repos included) is now **parked** instead:
drained the same way, by the same hysteresis, with the reason
`parked, no standby twin`. Its jobs wait in GitHub's queue, where waiting does
not count against `timeout-minutes` (GitHub keeps a job queued for up to 24 h
while a runner that fits is registered, even if offline).

Bringing every parked runner back when a slot frees would only move the hold
back into the hook, because each one takes a queued job at once. While the
lane sheds, parked runners come back **one per free slot**:

- a lane's free slots are its cap minus the Workers on the primary (jobs held
  in the hook included), minus runners GitHub has handed a job whose Worker
  has not started; a runner in the Simulator lane needs a slot in both lanes;
- the slots go to the oldest queued runs a twinless primary runner fits,
  first to a runner already online and idle for it, else to a parked one
  (preferring one whose resume is already in flight);
- a run GitHub itself is holding (`concurrency-block`) gets no slot;
- a primary that cannot admit has no slots, so its parked runners wait until
  it can.

When shedding ends (room for `FLEET_TIERS_SELF_RESUME_AFTER_S` after the
minimum hold), every parked runner comes back as before. The decision's
`release` block shows the slots left and which runner each slot is for.
`FLEET_TIERS_PARK=0` restores the old rule.

What parking cannot close: a job GitHub hands a runner in the seconds before
its drain lands, or during the `FLEET_TIERS_SELF_DRAIN_AFTER_S` wait before a
lane starts shedding, is still held in the hook. When such a hold ends in a
timeout, the daemon classes the job `admission-hold`, and the cockpit lists it
as **not your code** (`lib/failures.js`): the job concludes `cancelled`, the
same as a superseded run, and only its "exceeded the maximum execution time"
annotation plus a hold of 2 min or more on its runner tells them apart.

Two costs. A parked repo's next job starts a tick plus a runner start later
(about 15–30 s) than a held one would have been admitted. And if fleetd stops,
parked runners stay parked until it is back, where twin drains at least left
the twin serving.

## A host that cannot admit

The admission hook runs only after a runner has taken a job, so it cannot hand
the job back. A full lane clears in minutes. The disk floor does not: while a
host's usable disk is under its `FLEET_ADMIT_MIN_FREE_DISK_GB` (or plain free
under `FLEET_ADMIT_MIN_PLAIN_FREE_GB`), every job one of its runners takes sits
at "Set up runner" until disk is freed or GitHub cancels it. On 2026-10-15 ultra
sat at 97 GB under its 100 GB floor for hours. The controller kept its runners
online, and even self-drained the primary's runners onto them as twins, so its
jobs were held 30–60 min and cancelled while runner-host had room.

Each host now reports whether it can admit. The agent's heartbeat carries an
`admission` block, and the coordinator computes the same for itself. Both read
the host's own `fleet.env` and the disk figure the hook uses
(`lib/admit-gate.js`). While a host cannot admit:

- every runner on it is drained, floor runners and busy ones included (a busy
  one stops when its job ends);
- it is no overflow target and no twin, so the primary's runners that leaned
  on it are parked (or, with `FLEET_TIERS_PARK=0`, resumed);
- a primary that cannot admit wakes the overflow tier (`primary-cannot-admit`)
  and drains its own runners onto online twins, busy ones included.

It counts as able to admit again only after reporting no blocker for
`FLEET_TIERS_ADMIT_RESUME_AFTER_S` (5 min). Every checkout and cleanup crosses
the floor, and without the wait each crossing would drain or resume the whole
host. An agent too old to send the block counts as able to admit. Mode `off`
drains nothing and releases what it drained.

## Whose drain is it

Every drain the controller makes goes through `drain-runner.sh --by=tiers`,
which writes `by=tiers` into the runner's `.drain` marker, and the controller
only ever resumes runners whose marker says so. An operator's drain (no `by=`
line) is never touched by the controller on either host, and
`drain-runner.sh --resume --by=tiers` refuses it even if asked. An operator
draining a runner the controller drained takes it over. The completion hook
keeps the owner when a `draining` runner becomes `drained`.

## Where it runs, and what happens when that host is gone

The controller lives in the coordinator's daemon, so it is down exactly when
the coordinator's host is. The standby host's agent therefore has its own rule
(`dashboard/lib/agent-autonomy.js`): after `FLEET_AGENT_AUTONOMY_S` (180 s)
without a successful heartbeat it resumes every runner the controller drained
on that host, and when heartbeats succeed again it goes back to following the
controller. Without that rule a dead coordinator would leave the standby host
in whatever state it was last told.

## Modes

`observe` computes and logs every decision (`tiers[observe]: ...` in
`fleetd.log`) and shows it on `/api/state` and `/api/glance`, and changes
nothing. `enforce` acts. `off` stops deciding and resumes any runner the
controller had drained; it is the off switch. A fleetd restart keeps no timers:
the tier starts from what the runners report, and an active tier waits a full
quiet period before draining.

## What it reads, and what it does not change

Every input already exists: admission caps (`FLEET_ADMIT_*`, passed to the
daemon by `fleetctl.sh install`), local `Runner.Worker` processes, agent
heartbeats, the queue classifier's queued runs and labels, and the verdict. It
never changes admission caps; those protect the host, and the tiers use the
primary up to them, never beyond.

Each action is a `runner_events` row of kind `tiers` (and one per tier change,
named `(tiers)`), so held minutes, queue time and job split per host can be
compared before and after.
