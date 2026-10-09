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

Drains are graceful. `drain-runner.sh --drain` stops an idle runner and marks a
busy one `draining`, and the completion hook stops it after its job.

## Primary self-drain

The primary's runners all look idle to GitHub while its admission hook lets two
jobs run, so GitHub keeps assigning it work that then waits at "Set up runner",
where it cannot move to another host. While a primary lane is at its cap, the
controller drains the primary's **idle** runners in that lane, so new jobs go to
the standby host instead, and resumes them once the lane has had room for
`FLEET_TIERS_SELF_RESUME_AFTER_S` (30 s).

It never strands a repo. A primary runner is drained only while a standby
runner for the same repo, carrying every one of its labels, is online and not
being drained; if that twin goes away, the primary runner is resumed at once.
A runner with no such twin (a repo the standby host deliberately does not
serve, such as one needing a database label) is never self-drained, and
`FLEET_TIERS_PRIMARY_ONLY_REPOS` pins a repo to the primary explicitly. The
overflow twin a self-drained primary runner leans on is not drained until the
primary runner is back.

A job already held on the primary still finishes there. Self-drain limits how
many such jobs exist; it does not move them.

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
