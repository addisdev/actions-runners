# Self-hosted GitHub Actions runner fleet

Register, supervise, and observe many self-hosted GitHub Actions runners on
one Apple Silicon Mac — one runner per repo, each its own directory and
LaunchAgent — plus a dashboard that puts every runner and every repo's CI
on a single page.

**Platform:** macOS on Apple Silicon only. One Mac, no Kubernetes, no cloud
control plane. If you want cloud autoscaling, use
[actions-runner-controller](https://github.com/actions/actions-runner-controller)
instead.

> ⚠️ **Self-hosted runners on public repos are a security risk.** Any fork PR
> can execute code on your Mac. This project is designed for private repos with
> trusted contributors. Read the [security guide](docs/security-hardening.md)
> before proceeding.

## Why self-host on Apple Silicon

GitHub-hosted macOS minutes bill at **10×** against the included allowance on
private repos. More critically, one iOS repo exhausting the allowance blocks
Actions **account-wide**, which takes down cheap Ubuntu jobs in unrelated repos.
A fleet on hardware you own removes that shared fate.

The cost you pay is owning the host's health. Idle listeners are nearly free
(~7 MB each); two simultaneous Xcode builds are not. The dashboard and admission
control exist to make that visible and manageable.

## Requirements

- macOS 14+ on Apple Silicon, with Homebrew at `/opt/homebrew`
- [`gh` CLI](https://cli.github.com) authenticated with `gh auth login`
- `python3` (any version) — used by scripts for JSON handling
- Node **>= 22.5.0** — dashboard only (uses `node:sqlite`)

## Five-minute quick start

```bash
git clone https://github.com/addisdev/actions-runners.git ~/actions-runners
cd ~/actions-runners
./preflight.sh                          # check this host
./register.sh owner/project-ios         # register first runner
cd dashboard && ./fleetctl.sh install   # start the dashboard
./fleetctl.sh token                     # save this token
# Open http://localhost:7878
```

Point your workflow at the runner:

```yaml
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/build.sh
```

## Feature map

| What you need | Where to go |
|---|---|
| First runner, dashboard up | [Installation guide](docs/installation.md) |
| Workflow labels and caching | [Workflows guide](docs/workflows.md) |
| Understand the dashboard tabs | [Dashboard guide](docs/dashboard.md) |
| Health checks and cleanup schedules | [Operations guide](docs/operations.md) |
| Stop a runner gracefully | [Drain/resume](docs/operations.md#draining-a-runner-for-maintenance) |
| Cap concurrent builds | [Admission and scaling](docs/admission-and-scaling.md) |
| Add a second Mac | [Federation guide](docs/federation.md) |
| Isolate a release build | [Ephemeral runners](docs/ephemeral-runners.md) |
| LAN access or SSH tunnels | [Security hardening](docs/security-hardening.md) |
| All config variables | [Configuration reference](docs/configuration.md) |
| Something is broken | [Troubleshooting](docs/troubleshooting.md) |
| Upgrade or roll back | [Upgrading guide](docs/upgrading.md) |

## Scripts

| Script | What it does |
|---|---|
| `preflight.sh` | Check a host for what the workflows assume. `--explain` shows inference. |
| `register.sh` | Register a runner for a repo. `RUNNER_INSTANCE=2` adds a second. |
| `status.sh` | Fleet at a glance: every runner, its status, and what it costs idle. |
| `health.sh` | Per-runner launchd + GitHub state. `--repair` restarts dead services. |
| `runs.sh` | Fleet-wide view of what is building. `--watch` to follow. |
| `cleanup.sh` | Prune stale DerivedData, dead simulators, old `_diag`. Dry run unless `--apply`. |
| `scripts/deregister.sh` | Remove one named runner. Dry run unless `--apply`. |
| `scripts/drain-runner.sh` | Stop a runner after its current job. |
| `scripts/install-hooks.sh` | Point every runner at the job hooks. Dry run unless `--apply`. |
| `scripts/ephemeral-runner.sh` | One job in a fresh directory, then delete it. |
| `scripts/reap-ephemeral.sh` | Remove ephemeral directories a crash left behind. |
| `scripts/release-check.sh` | Fail if anything host-specific reached a tracked file. |
| `dashboard/` | The fleet dashboard. See [dashboard/README.md](dashboard/README.md). |

## Documentation

Full handbook at **[docs/README.md](docs/README.md)**.

## License

[MIT](LICENSE).
