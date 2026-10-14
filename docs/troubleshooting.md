# Troubleshooting

Symptom → evidence → cause → safe fix.

## A runner shows `offline` on GitHub

**Evidence:** `./health.sh` shows `running` in the launchd column but `offline`
in the GitHub column.

**Cause:** The runner process is alive locally but has lost its connection to
GitHub. This usually means:
- The runner's registration token expired and it could not re-register
- A network issue is preventing the runner from reaching `api.github.com`
- The runner is too old and GitHub dropped the connection

**Fix:**
```bash
# Check the runner's own logs:
ls -lt ~/actions-runners/project-ios/_diag/Runner_*.log | head -3
tail -100 ~/actions-runners/project-ios/_diag/Runner_<newest>.log

# Re-register (this removes and re-creates the registration):
scripts/deregister.sh project-ios --apply
./register.sh owner/project-ios
```

## A runner shows `dead` in launchd

**Evidence:** `./health.sh` shows `dead` in the launchd column.

**Cause:** The LaunchAgent is loaded but `RunnerService.js` exited. launchd
does not restart it. This can be an OOM kill (check `log show --last 1h --predicate
'eventMessage contains "out of memory"'`) or a crash.

**Fix:**
```bash
./health.sh --repair    # restarts dead services
```

On a production host, install automatic repair so the next silent death closes
without manual intervention:

```bash
./healthctl.sh install
./healthctl.sh logs     # confirm sweeps are running
```

If it keeps dying:
```bash
# Check the runner log for the crash reason:
tail -200 ~/actions-runners/project-ios/_diag/Runner_<newest>.log
```

## Jobs queue forever for one repo

**Evidence:** The Runs tab shows jobs queued. Other repos' jobs run normally.

**Cause:** The runner for this repo is dead, draining, or offline.

**Steps:**
1. Open the Fleet tab → find the repo → check the runner status badge.
2. If `drained`: use the Resume button in the drawer, or
   `scripts/drain-runner.sh project-ios --resume`.
3. If `dead`: `./health.sh --repair` (or install `./healthctl.sh` so this
   happens automatically).
4. If `offline`: re-register (see above).
5. If `online` but jobs still queue → check the **Lint** tab for a label
   mismatch: the workflow may require a label the runner does not have.

## Label mismatch: jobs queue but runner is online

**Evidence:** Queue diagnosis shows `label-mismatch`. Runner shows `online`.

**Cause:** The workflow's `runs-on:` includes a label the runner does not have
(e.g. `runs-on: [self-hosted, macos, xcode-16.3]` but the runner was registered
without the `xcode-16.3` label).

**Fix:** Either update the workflow to remove the extra label, or re-register
the runner with the required label:
```bash
scripts/deregister.sh project-ios --apply
./register.sh owner/project-ios xcode-16.3
```

If you have a second runner for this repo, it must have the same label.

## High load or swap pressure during builds

**Evidence:** The dashboard's load or swap meters are red. Builds may be failing
with OOM or timeout errors.

**Cause:** Too many concurrent Xcode builds. A single build on a 12-core Mac can
push load to 80+; two concurrent builds saturate memory.

**Fix:**
1. Enable admission control to cap concurrent jobs:
   ```bash
   # In fleet.env:
   FLEET_ADMIT_MODE=enforce
   FLEET_ADMIT_MAX_CONCURRENT=2   # or 1 if builds are very heavy
   FLEET_ADMIT_MAX_WAIT_S=600
   ```
2. Install the hooks: `scripts/install-hooks.sh --apply --restart`

Run in `observe` mode for a week first to understand impact before enforcing.

## Dashboard shows stale data (clock not updating)

**Evidence:** The footer timestamp is not advancing. The SSE stream is
disconnected.

**Cause:** The daemon crashed or the connection was dropped (e.g. Mac slept).

**Fix:** Reload the page. The browser reconnects to the SSE stream automatically
on reload. If the page does not update after reload:
```bash
cd dashboard && ./fleetctl.sh status   # is the daemon alive?
cd dashboard && ./fleetctl.sh logs     # what happened?
cd dashboard && ./fleetctl.sh restart  # if it is not running
```

## Dashboard error: "auth required" on every action

**Evidence:** Every action button returns "missing bearer token".

**Cause:** The token was cleared from `localStorage` (browser cleared storage,
or you opened a private window).

**Fix:**
```bash
cd dashboard && ./fleetctl.sh token    # print the token
```
Paste it into the token dialog in the dashboard. The browser stores it in
`localStorage` for future sessions.

## Database migration error on startup

**Evidence:** Daemon log shows `migration failed` or `table already exists`.

**Cause:** An interrupted startup left the schema in a partially-migrated state.

**Fix:**
```bash
# Back up first
sqlite3 dashboard/fleet.db ".backup dashboard/fleet.db.bak"
# Then check what migrations have run:
sqlite3 dashboard/fleet.db "SELECT * FROM schema_migrations ORDER BY id DESC LIMIT 10;"
# If a migration is half-applied, the safest path is to restore the backup
# and restart from a known good state.
```

## GitHub API rate limit errors

**Evidence:** Daemon log shows `rate limit` or `403`. The Runs tab shows fewer
repos than expected.

**Cause:** The `gh` session or the GitHub token is hitting the API rate limit
(60 req/hr for unauthenticated, 5000 for authenticated).

**Fix:**
```bash
gh auth status   # confirm authenticated
gh api rate_limit --jq '.rate | {limit, remaining, reset}'
```

The backfill throttles itself to leave rate limit headroom for the fast loop.
If the fast loop is also hitting limits, check that `FLEET_REPOS` is not set
to a very large list, and that no other script is hammering the API concurrently.

## DNS or VPN issues with `gh` API

**Evidence:** `gh api user` times out. Dashboard shows "API unavailable".

**Cause:** The runner host is behind a VPN that intercepts GitHub API calls, or
DNS is resolving `api.github.com` incorrectly.

**Fix:**
```bash
curl -I https://api.github.com/     # should return 200
nslookup api.github.com              # should resolve to GitHub's IPs
```

If behind a corporate proxy, set `https_proxy` in `fleet.env`.

## Stale hosts in the Hosts tab

**Evidence:** A remote agent shows in orange with "stale heartbeat".

**Cause:** The agent on that Mac stopped sending heartbeats. The coordinator
marks a host stale after 2 minutes without a heartbeat.

**Fix:**
```bash
# On the agent Mac:
launchctl list | grep fleet-agent    # is the agent running?
# If not, restart it or reload the LaunchAgent plist
```

The coordinator retains the last-known state for a stale host. It will not be
chosen for placement while stale.

## A Postgres test fails in `shmget`

**Evidence:** A job that starts a Postgres cluster fails with
`could not create shared memory segment` or `shmget: No space left on device`.
The verdict shows `shm-low`, or the host card shows few free segments.

**Cause:** macOS has a small System V shared memory table
(`kern.sysv.shmmni`). A Postgres cluster killed mid-job (a cancelled run, a
timeout) leaves its segments behind, and once the table is full every new
cluster fails. It reads as a broken test, not a host problem.

**Fix:** The job hooks remove orphaned segments before and after every job, so
reinstall them if this host predates `hooks/shm-reap.sh`:
```bash
scripts/install-hooks.sh --apply --restart
ipcs -m -o -p          # what is still attached, and by which pid
```
See [Shared memory variables](configuration.md#shared-memory-variables) for the
`FLEET_SHM_LOW_FREE` threshold.

## A job passed every step but never finishes

**Evidence:** The run stays `in_progress` with every work step green and the
job stuck at "Complete job" (or "Complete runner" cancelled). `gh run cancel`
does nothing. `cockpit why` lists it under *Orphaned by a draining runner*.

**Cause:** The runner was drained or stopped while it finished the job, and the
job's result never reached GitHub. This is not the code.

**Fix:**
```bash
gh api -X POST repos/<owner>/<repo>/actions/runs/<run-id>/force-cancel
# about a minute later, once the run shows completed:
gh run rerun <run-id> -R <owner>/<repo>
```
`cockpit wait --pr <n> --recover` does both for a PR's own orphaned runs. See
[A job orphaned by a draining runner](cockpit/cli.md#a-job-orphaned-by-a-draining-runner).

## `swiftc` exits 69 on a new host

**Evidence:** The first Xcode job on a newly added Mac fails at its first
compile with exit code 69, though `xcodebuild -version` works.

**Cause:** The Xcode license has not been accepted on this host.
`xcodebuild -version` answers without it; the compiler does not.

**Fix:**
```bash
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
```
`scripts/join-host.sh` checks this, and `FLEET_XCODE_VERSION` makes it refuse a
host whose Xcode differs from the rest of the fleet.

## `make: shellcheck: No such file or directory`

**Evidence:** A job that runs fine on one host fails on another because a
plain CLI tool (shellcheck, jq, deno) is missing.

**Cause:** Preflight checks toolchains (Xcode, Node, Java, Postgres), and a
Makefile also calls tools nobody listed. The runners' PATH may also differ
from your shell's.

**Fix:**
```bash
scripts/check-tools.sh $(scripts/check-tools.sh --list all)   # each listed tool, on the runners' PATH
scripts/join-host.sh --install-tools       # brew-install the missing ones (dry run without --apply)
scripts/runner-path.sh                     # runners whose job PATH differs from the rest
```

## A drained runner came back after a reboot

**Evidence:** A runner you drained shows online again after the Mac restarted.

**Cause:** Its LaunchAgent starts it at login whatever the drain marker says.

**Fix:** None needed while fleetd or the agent is running: it stops the runner
again within one heartbeat and logs `drain held`. If it stays online, check
that `FLEET_HOLD_DRAINS` is not `0` in `fleet.env`.

## Primary runners drain and resume over and over

**Evidence:** With [standby tiers](design/tiers.md) on, the primary host's idle
runners drain and resume every few minutes, and `./fleetctl.sh logs` shows a
`tiers[enforce]:` line for each batch.

**Cause:** Primary self-drain sheds idle runners while a lane is at its
admission cap, and a busy primary sits right at the cap. Versions before the
hysteresis change drained on the first tick at cap.

**Fix:** Upgrade. If it still churns, lengthen the hold
(`FLEET_TIERS_SELF_MIN_HOLD_S`) or turn self-drain off with
`FLEET_TIERS_SELF_DRAIN=0`. See
[Primary self-drain](design/tiers.md#primary-self-drain).
