# Alerts and auto-remediation

This page argues that an alert is only worth sending if it marks a transition,
that only the faults with a deterministic repair should ever be fixed
automatically, and that everything an unattended process may do to the fleet
belongs on one short list.

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

**And deliberately no swap-LEVEL rule**, for the same reason — see
[Why the host tile shows pressure, not
swap](capacity.md#why-the-host-tile-shows-pressure-not-swap).

What does fire: a runner dead, missing its LaunchAgent, or offline; an orphan;
a sibling label mismatch; a run stuck in the queue; disk low; sustained paging
or kernel-reported memory pressure; the collector unable to reach GitHub; and a
workflow that was green and just went red.

macOS notifications are on by default — they cost nothing and stay on the
machine. The webhook is off until you configure one, because it sends fleet
state to a third party and that is the operator's decision, not a default. Copy
`alerts.config.example.json` to `alerts.config.json` (gitignored — a webhook URL
usually carries a token) for ntfy, Pushover or Slack. `FLEET_ALERTS=0` disables
alerting entirely; it and `FLEET_ALERT_CONFIG` are in
[Dashboard daemon variables](../configuration.md#dashboard-daemon-variables).

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
below catches it if it lapses anyway. Credentials of this kind are covered by
[Secret variables](../configuration.md#secret-variables), and the posture the
whole path assumes is in
[Autofix and escalation](../security-hardening.md#autofix-and-escalation).

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
explanation. The rest of the rule is in
[Zero dependencies, on purpose](zero-dependencies.md).

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

The bridge decides *when* to act;
[`fleet-action.sh`](https://github.com/addisdev/actions-runners/blob/main/dashboard/autofix/fleet-action.sh)
decides what may *ever* be
acted on. Keeping those in separate files means the complete set of things an
unattended process can do to sixteen runners is one short list you can read in
a few seconds, rather than something you reconstruct by following control flow:

- **`fleet-action.sh` exact-matches an allowlist.** `runner.deregister`,
  `runner.duplicate`, `runner.register` and `fleet.cleanupApply` are not in it.
  Exact-match, not prefix — a prefix rule accepting `fleet.cleanup` would accept
  `fleet.cleanupApply`. Scaling does not go through this path at all; see
  [Capacity and autoscaling](capacity.md).
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

The allowlist a person with the control token works behind instead is in
[The control plane](control-plane.md).
