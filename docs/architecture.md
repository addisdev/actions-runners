# Architecture

## Overview

The fleet is a collection of shell scripts, a Node daemon, and the GitHub
runner binary — one runner process per repo, each living in its own directory.
There is no container orchestration, no Kubernetes, and no cloud control plane.
The unit of deployment is a macOS user account.

```
~/actions-runners/                  ← fleet root
├── fleet.env                       ← host-local overrides (optional)
├── project-ios/                    ← one runner directory per repo
│   ├── .runner                     ← runner config and credentials
│   ├── .env                        ← PATH and hook env vars
│   ├── _work/                      ← job checkouts and build output
│   └── _diag/                      ← runner diagnostic logs
├── project-web/
├── project-backend/
│   ...
└── dashboard/
    ├── fleetd.js                   ← the daemon
    ├── fleet.db                    ← SQLite: runs, jobs, runner state
    └── public/                     ← browser UI (plain HTML+JS, no build step)
```

## Component diagram

```mermaid
graph TD
    GH["GitHub API\n(api.github.com)"]
    Collector["Collector\n(fast + slow loops)"]
    DB[("SQLite\nfleet.db")]
    Server["HTTP Server\n:7878"]
    Browser["Browser UI\n(localhost:7878)"]
    Runner1["Runner Process\nproject-ios"]
    Runner2["Runner Process\nproject-web"]
    Hooks["Job Hooks\njob-started / job-completed"]
    Agent["agent.js\n(remote host)"]

    GH -- "runs + runner state" --> Collector
    Collector -- "snapshot" --> Server
    Collector -- "persist" --> DB
    DB -- "analytics / history" --> Server
    Server -- "SSE stream" --> Browser
    Browser -- "actions (token)" --> Server
    Runner1 -- "triggers" --> Hooks
    Runner2 -- "triggers" --> Hooks
    Hooks -- "admission log" --> DB
    Agent -- "heartbeat POST" --> Server
```

## Data flow and trust boundaries

```mermaid
graph LR
    subgraph "macOS host (your hardware)"
        Runners["Runner processes\n(one per repo)"]
        Daemon["fleetd.js\n(loopback only)"]
        DB2[("fleet.db")]
        Hooks2["Job hooks"]
    end

    subgraph "Browser (SSH tunnel or loopback)"
        UI["Dashboard UI"]
    end

    subgraph "GitHub"
        API["GitHub API"]
        Jobs["CI Jobs"]
    end

    Jobs -- "dispatch (HTTPS)" --> Runners
    Runners -- "report" --> API
    Daemon -- "poll" --> API
    Daemon --- DB2
    Hooks2 -- "log admission" --> DB2
    UI -- "read (unauth on loopback)" --> Daemon
    UI -- "actions (bearer token)" --> Daemon
```

## Runner processes

Each runner directory contains the GitHub Actions runner binary. The runner
is managed by a macOS LaunchAgent (`~/Library/LaunchAgents/actions.runner.*.plist`),
which:
- Launches `runsvc.sh`, which launches `RunnerService.js`
- `RunnerService.js` supervises the listener (`Runner.Listener`) and restarts it
  on crash
- The listener waits for jobs and forks a worker (`Runner.Worker`) to run them

LaunchAgents are loaded at login and survive process crashes, but **not**
`RunnerService.js` crashes — that is what `health.sh --repair` fixes.

## Dashboard daemon (fleetd)

`fleetd.js` is a single Node process that does two things:
1. **Collects** state on a timer and stores it in SQLite
2. **Serves** an HTTP API and the browser UI

**Fast loop** (15 s busy / 45 s idle): GitHub API for runs and runners, plus
local probes (launchctl, ps, vm_stat, df).

**Slow loop** (15 min): repo roster, directory sizes, forecast evaluation.

**Backfill** (every 10 min until caught up): historical runs and job timings.

The fast and slow loops share one in-memory snapshot. The server reads from
this snapshot; there is no per-request database read for the live view.

## Hooks

The job hooks (`ACTIONS_RUNNER_HOOK_JOB_STARTED` and
`ACTIONS_RUNNER_HOOK_JOB_COMPLETED`) run inside the runner process:

- **job-started**: checks the admission gate (if `enforce` mode), then exits 0
  to allow the job to proceed. A non-zero exit would cancel the job.
- **job-completed**: checks for a `.drain-stop` file left by `drain-runner.sh`;
  if found, stops the service once the worker has exited.

Neither hook is installed by default. `scripts/install-hooks.sh --apply` wires
them up.

## SQLite database

`fleet.db` stores:
- **runs** and **jobs**: append-only; kept forever (GitHub discards run detail
  after 90 days — this is the only long-term record)
- **runner_state**: one row per runner, updated each fast loop
- **host_samples**: 1-minute host vitals (load, memory, swap, disk)
- **queue_events**: queue-cause transitions per queued run
- **forecast_evals**, **autoscale_decisions**, **admission_log**: decision records
- **hosts**, **host_heartbeats**, **host_commands**: federation

Schema is managed by forward-only migrations in `lib/db.js`. There is no
downgrade path — back up `fleet.db` before upgrading.

## Autofix and admission

`autofix/` runs inside each job's started hook, keyed on the admission module.
`autofix/escalate/` is an optional third-party subtree that must be opted into
separately (see [Security Hardening](security-hardening.md)).

## Data flow

```
GitHub API ──► collector (fast loop) ──► in-memory snapshot ──► SSE stream ──► browser
                     │
                     ▼
               SQLite (fleet.db) ◄── backfill ◄── GitHub API (historical)
                     │
                     ▼
               analytics / simulation / forecasting
```

The browser never polls the database directly. Every live update flows through
the SSE stream; historical data (analytics, simulations) is fetched on demand
via the REST API.

## Trust boundaries

```
[GitHub API]          ← authenticated by gh CLI (runner registration)
                         authenticated by runner credentials (job dispatch)
      │
      ▼
[macOS host]          ← your physical security boundary
  ├── runner processes  (one per repo, registered to that repo)
  ├── fleetd.js         (loopback only by default; see Security Hardening)
  │     ├── read routes — unauthenticated on loopback
  │     └── write routes — bearer token required
  └── agent.js          (optional, outbound to coordinator; agent token required)
```

The dashboard's control plane executes shell commands as the current macOS user.
This is intentional — it is the same user running the runners. The consequence
is that the control token grants the same access as an SSH session to that user.
Protect it accordingly.

## Agents (federation)

When a second Mac joins the fleet, `agent.js` runs on it and reports outbound
to the coordinator dashboard. No inbound port is needed on the agent host. The
coordinator never initiates a connection to agents; commands flow back via the
polling response to the agent's heartbeat.

See [Federation](federation.md) for the operational details.
