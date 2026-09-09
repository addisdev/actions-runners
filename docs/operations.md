# Operations

Day-to-day maintenance, health repair, drain/resume, and routine procedures
for a live fleet.

## Health check

```bash
./health.sh               # report: launchd + GitHub state per runner
./health.sh --repair      # also restart any service that is loaded but dead
```

`health.sh` exists because **no runner plist sets `KeepAlive`**. `runsvc.sh`
supervises the listener (`Runner.Listener`), so a crashed listener recovers on
its own. A crashed or OOM-killed `RunnerService.js` does not. LaunchD will not
revive it, and the only symptom is one repo's jobs queueing forever while every
other repo looks fine.

`health.sh --repair` restarts dead services. It skips draining and drained
runners intentionally — a repair that undoes a deliberate drain is worse than
no repair.

## Scheduled maintenance

Add two LaunchAgents on a real fleet:

```xml
<!-- ~/Library/LaunchAgents/com.runner-fleet.health.plist -->
<!-- health.sh --repair every 30 minutes -->
```

```xml
<!-- ~/Library/LaunchAgents/com.runner-fleet.cleanup.plist -->
<!-- cleanup.sh --apply weekly (e.g. Sunday 02:00) -->
```

See `examples/launchd-health.plist` and `examples/launchd-cleanup.plist` for
ready-to-install templates.

## Draining a runner for maintenance

Stopping a runner with `svc.sh stop` kills whatever it is building, leaving a
red build on GitHub. `drain-runner.sh` drains gracefully instead.

```bash
scripts/drain-runner.sh project-ios-2 --drain    # stop after current job
scripts/drain-runner.sh project-ios-2             # check drain state
scripts/drain-runner.sh project-ios-2 --resume   # put it back
```

An **idle** runner stops immediately. A **busy** runner is marked `draining`
and stops after its job, which requires the completion hook installed:

```bash
scripts/install-hooks.sh --apply
```

Without the hook, the drain intent is recorded but the service is not stopped
automatically — drain the runner again once it is idle.

The dashboard shows `draining` / `drained` badges and offers Drain/Resume
buttons in the runner drawer.

## Taking a whole host out of rotation

Put a `.drain` file at the fleet root:

```bash
echo drained > ~/actions-runners/.drain     # this Mac takes no new runners
rm ~/actions-runners/.drain                 # back into rotation
```

The agent reports this state on its next heartbeat. Placement will not choose a
drained host. Runners already on the host keep working — this stops the fleet
putting *new* work there, not existing work.

## Disk cleanup

```bash
./cleanup.sh              # dry run: shows what would be deleted
./cleanup.sh --apply      # actually delete
```

What it cleans:
- DerivedData older than 7 days (keyed on mtime, so actively used projects are
  never candidates)
- Unavailable simulators (`xcrun simctl delete unavailable`)
- Runner `_diag` logs older than 14 days
- Playwright browser cache sizes (reported every run)
- Stale Playwright `__dirlock` files older than 6 hours (skipped while an
  install is in flight)

**Refuses to run while any job is in flight.** Deleting DerivedData under a
live xcodebuild produces a failure that looks like a code problem — the worst
kind of CI flake to chase. Stale Playwright locks are only removed when no
`playwright install` is running.

Playwright caches can be several gigabytes per runner. If disk alerts fire
repeatedly, check cache sizes in the cleanup dry-run output and confirm
workflows export `PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright`
so each runner keeps its own copy.

## Backup

```bash
# Stop the daemon while copying, or use SQLite's online backup:
sqlite3 dashboard/fleet.db ".backup dashboard/fleet.db.bak"
```

The only thing worth backing up is `fleet.db` — it holds every run and job ever
recorded, and GitHub discards run detail after 90 days. The scripts are in git.
The runner registrations are in `actions-runners/*/. runner` but can be
re-registered; the database history cannot be recovered once GitHub's copy ages
out.

## Logs

```bash
cd dashboard && ./fleetctl.sh logs              # tail daemon log (stdout+stderr)
cd dashboard && ./fleetctl.sh logs --lines 200  # last 200 lines
ls ~/actions-runners/project-ios/_diag/         # runner's own diagnostic logs
```

The runner writes a new `_diag/Runner_` log for every started listener. These
grow without bound and are cleaned by `cleanup.sh`.

## Deregistering a runner

```bash
scripts/deregister.sh project-ios-2             # dry run
scripts/deregister.sh project-ios-2 --apply     # actually remove it
```

`deregister.sh` refuses if:
- The runner is currently busy (mid-job)
- It is the last runner for its repo (removing the last would leave the repo
  with no runner at all)

To deregister the last runner for a repo, you need to do it from the
[GitHub UI](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/removing-self-hosted-runners).

## Re-registering a stale runner

A runner whose token has expired or that missed too many GitHub heartbeats shows
as `offline` permanently. Re-register it:

```bash
scripts/deregister.sh project-ios --apply    # remove old registration
./register.sh owner/project-ios              # fresh registration
```

If the runner directory is healthy but the registration is stale, the same
command will overwrite it — `register.sh` detects an existing registration and
removes it before creating a new one.

## Incident checklist

If a job has been queued for more than a minute:

1. Open the **Runs** tab — hover the queued indicator to see the classifier
   verdict.
2. Open the **Fleet** tab — find the runner(s) for that repo. Are they online?
3. If `runner-down`: open the runner drawer → recent events show why it stopped.
   Try `./health.sh --repair`.
4. If `label-mismatch`: the job's `runs-on` requires a label no runner has.
   Register a runner with that label or update the workflow.
5. If `repo-capacity`: the queue is longer than the runner count can absorb.
   Use the Capacity tab to add a runner, or enable autoscaling.
6. If `host-saturation`: the host is too busy. Check the load/swap meters.
7. If `github-delay`: the runner is ready; GitHub is slow to dispatch. Wait.

If the dashboard is not updating (collector lapsed):
```bash
cd dashboard && ./fleetctl.sh status    # is the daemon alive?
cd dashboard && ./fleetctl.sh logs      # what did it last say?
```
