# Uninstalling

Removing the fleet from a host. This is irreversible — back up `fleet.db`
first if you want to keep the historical run data.

## 1. Deregister all runners

Each runner must be deregistered from GitHub before removing its directory.
If you skip this, the runner will show as offline permanently on GitHub until
it ages out.

```bash
./health.sh    # see all runners

# For each runner, deregister it:
scripts/deregister.sh project-ios --apply
scripts/deregister.sh project-web --apply
# ...
```

`deregister.sh` refuses if a runner is mid-job. Wait for jobs to finish, or
drain the runner first (`scripts/drain-runner.sh <name> --drain`).

To deregister the last runner for a repo (the script refuses), use GitHub's UI:
**Settings → Actions → Runners → Remove**.

## 2. Unload the dashboard LaunchAgent

```bash
cd ~/actions-runners/dashboard
./fleetctl.sh uninstall    # unload and remove the plist
```

## 3. Unload runner LaunchAgents

The runner LaunchAgents were loaded by `register.sh`. To unload them:

```bash
# List all fleet LaunchAgents:
launchctl list | grep actions.runner

# Unload each one:
launchctl unload ~/Library/LaunchAgents/actions.runner.*.plist

# Remove the plist files:
rm ~/Library/LaunchAgents/actions.runner.*.plist
```

## 4. Remove the fleet root

```bash
rm -rf ~/actions-runners
```

This removes everything: runner binaries, credentials, databases, and caches.

> **Note:** If you want to keep the run history, back up `fleet.db` first:
> ```bash
> cp ~/actions-runners/dashboard/fleet.db ~/fleet-history.db
> ```

## 5. Verify cleanup

```bash
launchctl list | grep runner       # should return nothing
ls ~/Library/LaunchAgents/ | grep runner   # should return nothing
gh api user/installations --jq '.installations[].app_slug'  # runners removed
```

## Partial removal (one runner)

To remove a single runner without touching the rest:

```bash
scripts/deregister.sh project-ios --apply   # deregister
rm -rf ~/actions-runners/project-ios        # remove directory
launchctl unload ~/Library/LaunchAgents/actions.runner.owner-project-ios.*.plist
rm ~/Library/LaunchAgents/actions.runner.owner-project-ios.*.plist
```
