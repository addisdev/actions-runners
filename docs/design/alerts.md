# Alerts

This page argues that an alert is only worth sending if it marks a transition,
and that the rules worth having are the ones that stay quiet on a healthy
fleet.

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

Turning a rule's threshold up and turning alerting off are both blunt: one
blinds a rule across the whole fleet, the other blinds everything. For the case
where a single condition is correct, understood and not going to change —
a runner attached to a repo that has gone quiet — there is an `×` on the row.
See [Dismissing alerts](dismissing.md), which suppresses the noise without
closing the interval.

## Nothing acts on an alert unattended

An alert notifies; it does not repair. The response to `launchd-dead`,
`launchd-missing` and `offline` is `./health.sh --repair`, which the Control tab
runs as `fleet.healthRepair`. Everything else — `stuck-queue`, `label-mismatch`,
`orphan`, `no-listener`, `newly-failing` — needs a workflow file read or a job log
interpreted before anyone knows what the fix is.

The allowlist a person with the control token works behind is in
[The control plane](control-plane.md).
