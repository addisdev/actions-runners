# Design notes

The rest of the handbook says what this fleet does and how to run it. This
section says why it does it that way. Each page is one argument, and each
argument is grounded in something that actually went wrong on a real fleet — a
single 503 that produced a 46-second phantom orphan alert, a load average of 760
from a matrix fan-out, 4.3 GB of swap "used" on a machine with 71% of its memory
free, a backfill flag that latched true and quietly stopped collecting, a
diagnosis agent that returned `Credit balance is too low` for four days without
anyone noticing.

Nothing here is required reading to operate the fleet. It is here so that a
decision that looks arbitrary — why the idle TTL is three days rather than six
hours, why there is no load-average alert, why the YAML is parsed rather than
grepped — can be checked against the measurement that produced it, and changed
by someone who has a better one. For what to set and where, see the
[Configuration reference](../configuration.md); for the endpoints behind these
screens, the [API reference](../api.md).

<div class="grid cards" markdown>

-   __[Zero dependencies](zero-dependencies.md)__

    ---

    A monitoring daemon that breaks unattended because a transitive dependency changed is worse than no daemon.

-   __[Groups are inferred, not configured](groups.md)__

    ---

    The dullest grouping rule that works, fed from disk and SQLite so a failed API call cannot rearrange the page.

-   __[The control plane](control-plane.md)__

    ---

    Read access and the right to restart runners are different things, and everything else is behind an allowlist.

-   __[Workflow lint](lint.md)__

    ---

    Parse the YAML rather than grep it, and check the branches that actually run.

-   __[Alerts and auto-remediation](alerts.md)__

    ---

    Alerts fire on transitions, only three faults have a deterministic repair, and the rest get explained rather than fixed.

-   __[Capacity and autoscaling](capacity.md)__

    ---

    Queueing here is per-repo, adding a runner adds concurrency rather than capacity, and every gate came from a measurement.

-   __[Honest analytics](analytics.md)__

    ---

    Most of the work is deciding what to leave out, and why a job failed matters more than that it failed.

</div>
