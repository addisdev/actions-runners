# Installation

This guide covers everything you need to get the first runner registered and the
dashboard running on a fresh Apple Silicon Mac.

## Prerequisites

| Requirement | Version / notes |
|---|---|
| macOS | 14 Sonoma or later, Apple Silicon (`arm64`) |
| [Homebrew](https://brew.sh) | Must be at `/opt/homebrew` (the default arm64 location) |
| [`gh` CLI](https://cli.github.com) | Authenticated to GitHub (`gh auth login`) |
| `python3` | Any version; used by register/status/health/cleanup scripts |
| Node.js | >= 22.5.0 for the dashboard (`node:sqlite` is the requirement) |

> **Intel Mac?** Not supported. The runner binary is `osx-arm64` only and the
> scripts assume Homebrew at `/opt/homebrew`. There is no plan to add Intel
> support.

## 1. Install prerequisites

```bash
# Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# gh CLI and Node
brew install gh node@22

# Authenticate gh to GitHub (opens a browser or shows a device code)
gh auth login
```

Verify `gh` works for the repositories you want to run:

```bash
gh api user --jq .login
gh repo list --limit 5
```

If this is a headless server (no browser), use:

```bash
gh auth login --hostname github.com --git-protocol ssh --web
# Follow the device-code prompt
```

## 2. Clone the fleet repository

```bash
git clone https://github.com/addisdev/actions-runners.git ~/actions-runners
cd ~/actions-runners
```

The directory you clone into becomes the **fleet root** — each runner is
registered in a subdirectory of it, and the dashboard database lives here.
You can put it anywhere; `~/actions-runners` is the default.

## 3. Run preflight

Before registering anything, check the host against what your workflows
actually need:

```bash
./preflight.sh            # checks this host against the fleet's workflow history
./preflight.sh --explain  # shows what it inferred from those workflows
./preflight.sh --all      # ignores inference, checks everything
```

`preflight.sh` exits non-zero on any miss. Fix misses before continuing —
most of what it catches otherwise surfaces as a red build whose diagnostic
points somewhere other than the real cause.

## 4. Register the first runner

```bash
./register.sh owner/project-ios
```

Replace `owner/project-ios` with `<github-org-or-user>/<repo-name>`.

What this does:
1. Downloads the latest GitHub Actions runner binary (verified checksum)
2. Configures it for the repo, naming it after this Mac's hostname
3. Creates a LaunchAgent plist and loads it with `launchctl`
4. The runner is now listening and appears on GitHub under
   **Settings → Actions → Runners** for that repository

Check it registered:

```bash
./status.sh
```

And confirm GitHub sees it:

```bash
gh api repos/owner/project-ios/actions/runners --jq '.runners[] | [.name, .status] | @tsv'
```

## 5. Register additional runners

Each runner is per-repo. Add one for every repository that should use this Mac:

```bash
./register.sh owner/project-web
./register.sh owner/project-backend
```

A second runner on the same repo needs `RUNNER_INSTANCE=2`:

```bash
RUNNER_INSTANCE=2 ./register.sh owner/project-ios
```

Pass the same extra label (e.g. `xcode-16.3`) as the first runner, or the
second one will not match the same `runs-on:` and will sit idle. The
dashboard's **Duplicate** button does this automatically.

## 6. Install the dashboard

```bash
cd dashboard
./fleetctl.sh install     # write and load the LaunchAgent
./fleetctl.sh status      # verify it started
./fleetctl.sh token       # print the control token (save this)
```

Open [http://localhost:7878](http://localhost:7878).

## 7. Verify

```bash
./health.sh               # every runner's launchd + GitHub state
./status.sh               # one-line summary of what each runner is doing
```

The dashboard should show your runners on the **Fleet** tab within one polling
interval (15 seconds while anything is building, 45 seconds at rest).

## Headless SSH setup

If you are managing the Mac over SSH and will access the dashboard from another
machine, forward the port at connection time:

```bash
ssh -L 7878:localhost:7878 user@runner-host
```

Then open [http://localhost:7878](http://localhost:7878) on your laptop. The
dashboard stays on loopback on the host; the tunnel carries only your session.

## What to do next

- [Configure your workflows](workflows.md) to use `runs-on: self-hosted`
- [Set up maintenance schedules](operations.md#scheduled-maintenance) for
  health checks and cleanup
- Read about [security deployment models](security-hardening.md) before
  putting the dashboard on a LAN
