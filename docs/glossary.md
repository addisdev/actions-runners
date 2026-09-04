# Glossary

**Admission control**  
The mechanism that holds a job at the `job-started` hook until a concurrent
execution slot is free. Separate from autoscaling — admission gates running
jobs, not runner count.

**Agent**  
`dashboard/agent.js`. A lightweight process running on a remote Mac that
reports its runners, load, and capacity to the coordinator dashboard. Agents
connect outbound; no inbound port is needed.

**Autoscaling**  
The dashboard feature that adds runners when the queue classifier returns a
`repo-capacity` verdict and removes idle duplicates after an idle TTL.

**Backfill**  
The process that walks back through historical GitHub run data to populate
`fleet.db`. Runs periodically until it has captured everything GitHub still
holds, then stops.

**Burst forecast**  
A next-hour demand estimate based on weekday/time-of-day baselines and workflow
schedules. Shadow-only — predictions are evaluated against reality but never
acted on automatically.

**Ceiling**  
The `FLEET_CEILING` / `ceiling` setting: do not add a new runner while this
many jobs are currently running. A "not right now" gate, not a hard cap.
See also: max total runners.

**Concurrency advisor**  
The dashboard component that analyses workflow YAML for unbounded matrices,
missing concurrency groups, and static group collisions.

**Control token**  
The bearer token required for all mutating dashboard actions. Stored in
`dashboard/.fleet-token` (0600). Print it with `./fleetctl.sh token`.

**Coordinator**  
The Mac running `fleetd.js` and the main `fleet.db`. In a single-host setup,
this is also the only host. In a federated setup, it is the host that other
agents report to.

**Diagnostic bundle**  
A redacted plain-text dump of one runner's configuration, recent events, and
log summary. Created by `lib/bundle.js` using an allowlist. Safe to paste into
a GitHub issue.

**Drain**  
The graceful shutdown state for a runner. A draining runner completes its
current job and then stops. A drained runner is stopped and will not accept
new jobs. Managed by `scripts/drain-runner.sh`.

**Drift**  
A discrepancy between what the local host and GitHub believe about a runner's
state. Shown on the Fleet tab. Categories: `launchd-missing`, `launchd-dead`,
`offline`, `orphan`, `label-mismatch`, `stuck-queue`.

**Ephemeral runner**  
A runner that registers for a single job, runs it in a fresh directory, and
then self-destructs. Created by `scripts/ephemeral-runner.sh`.

**Fast loop**  
The collection cycle that runs every 15 s while anything is building, and every
45 s when the fleet is at rest. Fetches runs and runners from the GitHub API,
plus local probes.

**Fleet root**  
The directory containing the runner subdirectories. Defaults to the directory
containing the scripts. Override with `FLEET_ROOT`.

**fleetctl**  
The shell wrapper (`dashboard/fleetctl.sh`) for managing the dashboard daemon:
install, start, stop, restart, status, logs, token.

**fleetd**  
The dashboard daemon process (`dashboard/fleetd.js`).

**LaunchAgent**  
A macOS launchd job loaded in the user's session. Each runner is managed by one
LaunchAgent plist in `~/Library/LaunchAgents/`.

**Max total runners**  
The `FLEET_MAX_TOTAL_RUNNERS` / `maxTotalRunners` setting: hard cap on the
total number of runners a host may hold. Different from `ceiling` — this is the
hard limit, not the "not right now" gate.

**Persistent runner**  
A runner that keeps its working directory (`_work/`) across jobs, retaining
checkouts and build caches. All standard fleet runners are persistent.

**Placement**  
The module (`lib/placement.js`) that chooses which host should receive the next
runner when the autoscaler decides to add one. Considers free slots, load per
core, repo locality, and host drain state.

**Queue cause**  
The classifier verdict for a queued job: why is it waiting? One of
`telemetry-unavailable`, `unserved`, `label-mismatch`, `runner-down`,
`concurrency-block`, `host-saturation`, `repo-capacity`, `github-delay`.

**Runner instance**  
When a repo has more than one runner, they are distinguished by instance number
(`RUNNER_INSTANCE=2`, etc.). The first runner is always instance 1. The
autoscaler adds instance 2, 3, etc.

**Slow loop**  
The collection cycle that runs every 15 minutes. Updates the repo roster and
directory sizes.

**SSE (Server-Sent Events)**  
The live update mechanism: the browser subscribes to `/api/stream` and receives
a full snapshot payload on every fast-loop tick.
