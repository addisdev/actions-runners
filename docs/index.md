# Actions Runners

Many self-hosted GitHub Actions runners on one Mac, and the page that says
whether any of them is broken.

One runner per repo, each its own directory and its own LaunchAgent. One Node
daemon with no dependencies and no build step polls GitHub and the machine,
keeps everything it learns in SQLite forever, and serves a single page: Fleet,
Runs, Analytics, Lint, Alerts, Capacity, Hosts and Control.

![One macOS host running the runner LaunchAgents, the job hooks and local probes alongside the fleetd daemon, whose collector and server share one in-memory snapshot backed by SQLite; GitHub above it, and below it a browser dashboard reading over SSE and a second Mac's agent reporting inbound over a heartbeat](img/architecture.png)

## Start here

<div class="grid cards" markdown>

-   __[Get started](getting-started.md)__

    ---

    A runner registered, the dashboard up, and a real workflow job running on
    your own Mac. Half an hour, and one machine.

-   __[Concepts](concepts.md)__

    ---

    What a runner actually is here, what launchd will not do for it, what drift
    means, and why a job is queued.

-   __[Dashboard](dashboard.md)__

    ---

    Every tab, what each one is for, and the actions the control plane will and
    will not perform.

-   __[Operations](operations.md)__

    ---

    Health checks, draining a runner for maintenance, disk cleanup, and the
    incident checklist.

-   __[Design notes](design/index.md)__

    ---

    Why it is shaped this way. Each argument is grounded in something that
    actually went wrong on a real fleet.

-   __[Security](security-hardening.md)__

    ---

    Deployment models, the token, the runner threat model, and what binding to
    the LAN costs you.

</div>

## Why self-host on Apple Silicon

GitHub-hosted macOS minutes bill at **10x** against the included allowance on
private repos. More critically, one iOS repo exhausting that allowance blocks
Actions **account-wide**, which takes down the cheap Ubuntu jobs in unrelated
repos with it. A fleet on hardware you own removes that shared fate.

The cost you pay is owning the host's health. Idle listeners are nearly free at
about 7 MB each; two simultaneous Xcode builds are not. The dashboard and
admission control exist to make that visible and manageable.

## The half of the question GitHub cannot answer

GitHub has no cross-repo Actions view. Past a handful of repos there is no
single page that answers *is anything running* — and once runners live on a
particular machine, *is that runner even alive* is not answerable from GitHub
at all.

So the interesting state is the state where the two disagree.
[Drift](concepts.md#drift-when-this-machine-and-github-disagree) is the six
ways launchd and GitHub can silently stop agreeing about a runner, and each one
is invisible from whichever side you happen to be looking at. A runner
registered on GitHub with no LaunchAgent queues jobs forever. A listener GitHub
calls offline looks fine locally. No runner plist sets `KeepAlive`, so a
crashed service is never revived, and the only symptom is one repo's jobs
queuing while every other repo looks healthy.

## A warning worth reading before you deploy anything

!!! danger "Self-hosted runners and public repositories do not mix"

    Any fork's pull request can execute code on your Mac. This project is built
    for **private repos with trusted contributors**. Read the
    [security guide](security-hardening.md) before you register anything.

The dashboard binds to loopback by default, because its control plane executes
shell commands as the user running it. Putting it on the LAN opens the read
routes to the network; every action still needs the bearer token, and
`FLEET_READ_ONLY=1` removes the actions entirely.

## What runs where

**macOS 14 or later on Apple Silicon.** One Mac, no Kubernetes, no cloud
control plane. The runner binary is `osx-arm64` only and the scripts assume
Homebrew at `/opt/homebrew`; there is no Intel support and no plan to add it.
If you want cloud autoscaling, use
[actions-runner-controller](https://github.com/actions/actions-runner-controller)
instead.

A second Mac joins by running [`agent.js`](federation.md), which reports
outbound on a heartbeat. No inbound port is opened on it, and it computes its
own headroom, because it is the only machine that knows its own load.
