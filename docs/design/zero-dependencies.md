# Minimal dependencies, on purpose

This page argues that minimizing dependencies is a reliability decision rather
than a preference, and that the test suite is shaped by the same constraint.

Single-host mode has no required installed npm package, build step, or
framework. This machine's job is running CI; a monitoring daemon that breaks
unattended because a transitive dependency changed is worse than no daemon.

The charts are HTML and CSS rather than SVG, which for horizontal bars is the
better tool and not a compromise: percentage widths are responsive for free, and
text stays at its real size instead of being scaled by a viewBox — which is how
SVG charts end up with 9px axis labels on one screen and 20px on another.

There are two isolated exceptions:

- Optional PostgreSQL HA dynamically loads the locked `pg` driver. A normal
  single-host start never imports it, and `fleetctl.sh install` installs it only
  when a database URL file is configured.
- Escalation lives behind its own `package.json`; see
  [Alerts and auto-remediation](alerts.md#escalation-the-alerts-with-no-mechanical-fix).

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
