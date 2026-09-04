# Configuration Reference

All configuration is optional. On a typical single-host fleet, no variables
need to be set: repos are discovered from runner directories, groups are inferred
from repo names, and the GitHub owner is read from `gh`. The variables below
exist for when a default is wrong, or for advanced setups.

## How to set values

Copy `fleet.env.example` to `fleet.env` in the fleet root and uncomment what
you need:

```bash
cp fleet.env.example fleet.env
```

> **Precedence:** `fleet.env` is sourced by the scripts and **wins** over
> environment variables already in the environment. If you pass
> `FLEET_REPOS='a b' ./runs.sh`, a `FLEET_REPOS=` line in `fleet.env` will
> override it. Comment the line out instead.

Dashboard settings (capacity, autoscaling) are stored in SQLite and editable
from the UI. A value in `fleet.env` seeds the setting on first start but does
not override it once it has been changed in the UI — the UI-stored value wins.
The Capacity tab shows which layer (stored, env, or built-in default) each
value came from.

Restart the daemon after changing `fleet.env`:
```bash
cd dashboard && ./fleetctl.sh restart
```

## Shell script variables

Used by `register.sh`, `health.sh`, `status.sh`, `cleanup.sh`, `runs.sh`,
`preflight.sh` and the hooks.

| Variable | Default | What it does |
|---|---|---|
| `FLEET_ROOT` | Script directory | Fleet root directory. Set if the scripts live outside it. |
| `FLEET_OWNER` | `gh api user --jq .login` | GitHub user or org for bare repo names. |
| `FLEET_REPOS` | All runner directories | Explicit repo list for `runs.sh`. |
| `FLEET_REPO_CACHE` | `.fleet-repos` | Where `runs.sh` caches discovered repos. |
| `FLEET_REPO_CACHE_TTL` | `21600` (6 h) | How long the cache is valid, in seconds. |
| `FLEET_REPO_LIMIT` | `200` | Max repos discovery considers. |
| `FLEET_LABEL_PREFIX` | `com.runner-fleet` | LaunchAgent label prefix. Set **before** install; do not change while loaded. |
| `RUNNER_INSTANCE` | `1` | Instance number for `register.sh`. `RUNNER_INSTANCE=2` adds a second runner. |

## Grouping variables

Used by the dashboard and `runs.sh` to group repos.

| Variable | Default | What it does |
|---|---|---|
| `FLEET_PROJECTS` | (inferred) | Force-create groups in this order, as prefixes. |
| `FLEET_GROUP_IGNORE` | (empty) | Never infer groups for these tokens. |
| `FLEET_GROUP_MIN` | `2` | Minimum repos sharing a prefix to form a group. |
| `FLEET_GROUPS` | `on` | Set to `off` to disable grouping entirely. |

## Dashboard daemon variables

Set in the environment of `fleetd.js`, typically via the LaunchAgent plist
that `fleetctl.sh install` writes. To change after install:

1. Edit `fleet.env` (if the variable is sourced from it), or
2. Edit the plist: `launchctl edit $(./fleetctl.sh label)`, then
   `launchctl kickstart -k gui/$(id -u)/$(./fleetctl.sh label)`

| Variable | Default | What it does | Restart required? |
|---|---|---|---|
| `FLEET_PORT` | `7878` | Dashboard HTTP port. | Yes |
| `FLEET_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` for LAN. | Yes |
| `FLEET_ROOT` | `~/actions-runners` | Fleet root. | Yes |
| `FLEET_DB` | `dashboard/fleet.db` | SQLite database path. | Yes |
| `FLEET_TOKEN_FILE` | `dashboard/.fleet-token` | Browser control token path. | Yes |
| `FLEET_AGENT_TOKEN_FILE` | `dashboard/.fleet-agent-token` | Agent auth token file. Falls back to control token if absent. | Yes |
| `FLEET_AGENT_TOKEN` | (from file) | Agent token value directly in env. Overrides the file. | Yes |
| `FLEET_READ_ONLY` | `0` | Set to `1` to disable the control plane entirely. | Yes |
| `FLEET_FAST_MS` | `15000` | Fast-loop interval while busy, ms. | No |
| `FLEET_IDLE_MS` | `45000` | Fast-loop interval at rest, ms. | No |
| `FLEET_SLOW_MS` | `900000` (15 min) | Slow-loop interval, ms. | No |
| `FLEET_ALERTS` | `1` | Set to `0` to disable the alerts system. | No |
| `FLEET_ALERT_CONFIG` | `dashboard/alerts.config.json` | Alert configuration file. | No |
| `FLEET_ADMISSION_LOG` | `dashboard/logs/admission.ndjson` | Where job-started.sh appends decisions. | Yes |

## Capacity and autoscaling

These live in SQLite and are editable from the Capacity tab without restarting
the daemon. A value in `fleet.env` seeds the setting on first boot.

| Setting | Default | What it does |
|---|---|---|
| `FLEET_CEILING` | `3` | Refuse to add runners while this many jobs are running. |
| `FLEET_MAX_TOTAL_RUNNERS` | `8` | Hard cap on runners per host. |
| `FLEET_LOAD_PER_CORE` | `0.7` | Refuse to add runners above this load-per-core ratio. |
| `FLEET_MIN_FREE_DISK_GB` | `20` | Refuse to add runners below this free-disk threshold. |
| Autoscale on/off | off | Toggle on Capacity tab. |
| Autoscale dry-run | off | Log decisions without acting; toggle on Capacity tab. |
| Idle TTL | 0 (off) | Deregister a duplicate runner idle for this many hours. |

## Job admission variables

Used by `hooks/job-started.sh`. Must be in `fleet.env` — the hooks cannot
reach the daemon's database.

| Variable | Default | What it does |
|---|---|---|
| `FLEET_ADMIT_MODE` | `off` | `off` / `observe` / `enforce`. |
| `FLEET_ADMIT_MAX_CONCURRENT` | `3` | Max concurrent jobs across the host. |
| `FLEET_ADMIT_MAX_WAIT_S` | `600` | Max wait before a held job is admitted anyway. |
| `FLEET_ADMIT_MIN_FREE_DISK_GB` | `40` | Refuse job (then admit after max wait) below this disk level. |
| `FLEET_ADMIT_POLL_S` | `5` | How often a held job re-checks. |
| `FLEET_ADMIT_SLOT_TTL_S` | `21600` | Slot lease TTL in seconds. |

## Agent variables

Used by `dashboard/agent.js` on remote hosts.

| Variable | Default | What it does |
|---|---|---|
| `FLEET_COORDINATOR` | (required) | Coordinator URL, e.g. `http://mac-main:7878`. |
| `FLEET_AGENT_TOKEN` | (required) | Token matching the coordinator's agent token. |
| `FLEET_HOST_NAME` | `$(hostname)` | Name shown in the Hosts tab. |
| `FLEET_ROOT` | `~/actions-runners` | Fleet root on this agent host. |
| `FLEET_AGENT_ALLOW_COMMANDS` | `0` | Set to `1` to allow the coordinator to send commands. |
| `FLEET_MAX_TOTAL_RUNNERS` | `8` | Agent-side runner cap, sent to coordinator for placement. |
| `FLEET_CEILING` | `3` | Agent-side busy-job ceiling. |
| `FLEET_LOAD_PER_CORE` | `0.7` | Agent-side load gate. |
| `FLEET_MIN_FREE_DISK_GB` | `20` | Agent-side disk gate. |
| `FLEET_AGENT_INTERVAL_MS` | `30000` | Heartbeat interval, ms. |

## Secret variables

These should never appear in `fleet.env` or any tracked file. Pass them via the
LaunchAgent environment or a keychain-backed wrapper.

| Variable | Used by |
|---|---|
| `GITHUB_TOKEN` | `register.sh`, if set (otherwise uses `gh` CLI) |
| `FLEET_AGENT_TOKEN` | Agent authentication — treat as a credential |
