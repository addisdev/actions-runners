# Ephemeral Runners

Every standard runner in the fleet is **persistent**: it keeps its checkout,
DerivedData, and build caches between jobs. That is why builds are fast. It is
also why a build can pass on your fleet and fail on GitHub-hosted runners —
your cached state is invisible to anyone else.

Ephemeral runners solve this. Each job gets a fresh directory, a fresh checkout,
and a clean environment. After the job completes, the directory is deleted.

## When to use ephemeral runners

Use ephemeral runners for:
- **Release builds** — certifiable clean-state build
- **Confirming builds from nothing** — "does this actually work on a clean machine"
- **Debugging a suspected cache poisoning** — isolate whether the cache is hiding a problem

Do **not** use ephemeral runners for routine CI. The cost of unpacking the runner,
installing dependencies from scratch, and cloning the full repo is measured in
minutes per job. Persistent runners make CI fast; ephemeral runners make it
reproducible.

## Running an ephemeral runner

```bash
scripts/ephemeral-runner.sh owner/project-ios          # dry run
scripts/ephemeral-runner.sh owner/project-ios --apply  # register, wait for one job, clean up
```

With `--apply`, the script:
1. Creates a temporary directory in the fleet root: `project-ios-eph-<timestamp>`
2. Registers a runner named after the hostname with `-eph-` in the name
3. Waits in the **foreground** for a single job
4. After the job completes, deregisters and removes the directory

The process runs in the foreground on purpose: cleanup happens in a trap, and
the cleanup needs the PID to be alive to catch `SIGTERM`/`SIGINT`. Press
Control-C to cancel; the trap will clean up.

## Recovery from crashes

A `SIGKILL`, a power cut, or an OOM kill can leave an ephemeral directory
behind — the runner is unregistered on GitHub, but the directory (holding an
unpacked runner and a checkout) remains.

```bash
scripts/reap-ephemeral.sh              # list what would be reaped
scripts/reap-ephemeral.sh --apply      # remove it
```

`reap-ephemeral.sh` refuses to touch:
- A directory with a live `Runner.Worker` or `Runner.Listener` process
- A directory younger than two hours

These two checks make it safe to run from a timer — a running ephemeral job
looks exactly like an abandoned one except for those guards.

## Scheduling the reaper

Add a launchd job to run the reaper periodically:

```xml
<!-- See examples/launchd-reap-ephemeral.plist -->
```

A 4-hour interval is reasonable: it catches overnight crashes without reapers
overlapping with active jobs.

## The dashboard view

The dashboard separates ephemeral runners from persistent ones in the "runners
registered elsewhere" section of the Fleet tab. Ephemeral runners are expected
to come and go — they are not tracked as drift.

## Safety with public repos

Ephemeral runners are safer than persistent runners for public repos but are
still not safe: the job still runs as the current macOS user. For a truly
isolated ephemeral runner (network-isolated, filesystem-isolated, no access to
host secrets), you would need a VM or a container runtime, which is outside
the scope of this project.

For public repos, the [GitHub Actions security guidance](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners) applies regardless.
