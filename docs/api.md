# API Reference

The dashboard exposes a simple HTTP API consumed by its own browser UI. The
base URL is `http://localhost:7878` (or wherever you have deployed it).

All endpoints return JSON unless noted. Read routes are unauthenticated on
loopback by design (see [Security Hardening](security-hardening.md)).

## Authentication

Mutating routes and the diagnostic bundle download require a bearer token:

```
Authorization: Bearer <token>
```

Print the token: `cd dashboard && ./fleetctl.sh token`

## Version 1 (`/api/v1`)

Use the routes under `/api/v1` when you write a script, a CLI or an agent tool.
The unversioned routes further down belong to the browser UI and can change
whenever the UI does.

Every v1 route follows the same rules:

- A repository is always `owner/repo`, in the path or as `?repo=owner/repo`,
  never a bare name. Names are compared case-insensitively, as GitHub does.
- A list comes back as `{ "items": [...] }`.
- An error comes back as `{ "error": { "code", "message", "hint" } }` with a
  4xx or 5xx status. `code` is stable and meant for programs. `hint` says what
  to try next.
- A query parameter the route does not take is refused with
  `400 unknown_param`, not ignored.
- Every response carries a `fleet-api-version: 1` header.

`GET /api/v1/openapi.json` is the full description as OpenAPI 3.1. It is
generated from the same route table (`dashboard/lib/api.js`) that validates
requests, so it can't drift from what the daemon accepts. Each operation's
`operationId` is a stable snake_case name, and `x-fleet-scope` is the scope
it needs (`read` for everything in this version).

| Route | What it returns |
|---|---|
| `GET /api/v1/status` | The fleet verdict, counts, standing risks (`posture`) and `freshness` (`generatedAt`, `ageMs`, `stale`). |
| `GET /api/v1/repos/{owner}/{repo}/diagnosis` | One repository: its runners, queued runs with cause and ETA, active and recent runs, recent failures (each with `notYourCode`), orphaned jobs and incidents that mention it, beside the fleet verdict. `404 unknown_repo` if the fleet has never seen it. |
| `GET /api/v1/repos/{owner}/{repo}/checks?pr=&wait=` | A PR's, commit's (`sha=`) or branch's (`branch=`) checks as `green`, `red`, `pending` or `pointless`, optionally held open until they finish (see below). |
| `GET /api/v1/queue?repo=` | Queued runs, each with its cause, confidence, evidence and ETA range. |
| `GET /api/v1/orphans?repo=` | Jobs orphaned by a runner that went away while they were finishing (see below). |
| `GET /api/v1/runners?repo=&host=&state=` | Every runner across every host. |
| `GET /api/v1/hosts` | Every host with `stale`, `off`, `drained` and vitals. |
| `GET /api/v1/actions` | The action catalogue: `id`, `label`, `danger`, `confirm`, the `scope` it needs and the `args` it takes. |
| `POST /api/v1/actions/{id}` | Preview an action, then run it with the confirmation the preview returned (see below). |
| `GET /api/v1/me` | Who the token is, and its scopes. |
| `POST /api/v1/tokens` | Issue a named token with chosen scopes (needs `act:danger`). |

v1 reads follow the same rules as the routes below: no token on loopback.
A token sent with a read must still be valid. A revoked or mistyped token gets
`403 bad_token`, so a client finds out at once rather than on its first
action.
For example:

```sh
curl -s localhost:7878/api/v1/repos/acme/comet-web/diagnosis | jq '.verdict.id, .failures'
```

### Tokens and scopes

A token holds one or more of three scopes:

| Scope | Allows |
|---|---|
| `read` | Every `GET` under `/api/v1`. |
| `act` | Actions an agent may take on its own judgement: `fleet.health`, `fleet.status`, `fleet.preflight`, `fleet.cleanupPreview`, `runner.deregisterPreview`, `runner.drain`, `runner.resume`, `host.drain`, `host.resume`, `run.rerun`, `run.cancel`, `run.recoverOrphan`. |
| `act:danger` | Every other action: restart, repair, switching a host off or on, cleanup apply, register, duplicate, deregister, workflow dispatch. Also minting tokens. |

`act:danger` includes `act`, and both include `read`. The master token and
devices paired before scopes existed hold all three.

Issue a token for an agent:

```sh
./dashboard/fleetctl.sh api-token "claude code on laptop" --scopes read,act
```

The token is printed once on stdout. `./fleetctl.sh devices` lists it beside
paired devices, and `./fleetctl.sh revoke <key>` revokes it.

### Running an action

An action takes two calls. The first changes nothing:

```sh
curl -s -X POST localhost:7878/api/v1/actions/runner.drain \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"args":{"name":"build-host-comet-web-2"}}'
```

```json
{
  "status": "confirm_required",
  "action": "runner.drain",
  "command": "./scripts/drain-runner.sh build-host-comet-web-2 --drain",
  "effect": "This will stop the runner after its current job finishes…",
  "confirm": "q3k…",
  "expiresAt": 1791234567890
}
```

The second call sends the same `args` plus `"confirm": "q3k…"` and runs it.
The confirmation:

- works once;
- expires after 5 minutes;
- is tied to the caller, the action and the exact arguments, so a preview for
  one runner can't be spent on another.

`"dryRun": true` returns the preview without a confirmation. Arguments the
action doesn't declare are refused. Every run is written to the action log
with the caller's name.

`run.recoverOrphan` (`repo`, `runId`) is for a job listed by
`/api/v1/orphans`. It refuses a run that isn't orphaned, or whose work had
already failed. It force-cancels the run and returns. Once GitHub has
completed the run, about a minute later, the daemon requests the re-run
itself.

### Waiting on checks

`GET /api/v1/repos/{owner}/{repo}/checks?pr=73&wait=300` holds the request
open until the PR's checks finish, for at most `wait` seconds (300 at most).
It returns one of four states:

- `green`: every check passed, and GitHub agrees: every workflow run it has
  for the head commit is completed, every job of each run passed, and nothing
  new appeared for 30 seconds. Only `success`, `skipped` and `neutral` count
  as a pass. `verified` says what GitHub's side covered
  (`{ head, runs, jobs, checks }`).
- `red`: a check finished without passing. `cancelled` is red, and `hint`
  says so.
- `pending`: the wait ran out. Ask again.
- `pointless`: waiting can't end well. `reason` says why: the host is down,
  the disk floor is holding jobs, GitHub is refusing the account's jobs, a
  queued check has a cause that never clears on its own, the repo's only
  runner is dead, or a job was orphaned (`orphans` lists them with their
  recovery).

A PR's checks are its head commit's checks, and GitHub names the head (the
PR's branch ref while it is open, since the PR's own `head.sha` catches up a
moment after a push). An older commit's result never answers for the PR, even
right after a push or a force-push.

A green is never the fleet view's alone. The view rolls up the runs it has
seen, and right after a push it has not seen them all: runs for `push` and
`pull_request` register separately, a `workflow_run` run only after the run it
follows completes, and a job behind `needs:` only when its needs finish. So
before a green ends the wait the daemon reads `actions/runs?head_sha=` and each
completed run's jobs, and holds the green (`pending`, with `reason`) until all
of them are done and GitHub has been quiet for 30 seconds. If GitHub does not
answer, the wait stays pending rather than trust the view.

The answer comes from the fleet view (`source: "fleet"`) unless the view is
stale, has no runs for the target, or is behind a re-run. In those cases the
daemon asks GitHub directly (`source: "github"`), at most every 30 seconds per
target. Before a red ends the wait, each failed run is checked on GitHub in
case it is already running again.

A CLI that wants to wait longer than 300 seconds calls again with the same
query.

### Orphaned jobs

A job is orphaned when its runner was drained or lost while the job was
finishing. Every work step passed, but GitHub still shows the job in progress,
stuck at "Complete runner" or "Complete job". Anything waiting on that check
waits forever, and `gh run cancel` doesn't clear it. The way out is a
force-cancel, then a re-run about a minute later. Each orphan lists the exact
commands under `recovery`.

The daemon flags a job when all of these hold:

- every work step has completed;
- a "Complete …" step has been cancelled or unfinished for at least 3 minutes;
- the runner is draining, offline, dead, lost or on a down host, or a
  "Complete …" step was cancelled.

`workPassed: false` means a work step had already failed, so a re-run would
only repeat the failure. The daemon reads the steps from the job lists it
already fetches for active runs, so this costs no extra GitHub calls. `cockpit
why` and `cockpit wait` show the daemon's orphans; they no longer look for
their own. The rules are tested against lake-api PR #73's jobs as GitHub
recorded them (`cockpit/Sources/CockpitCore/Fixtures/orphaned-jobs.json`).

### MCP (`/mcp`)

The daemon is also an MCP server, over Streamable HTTP at `/mcp`. Its tools
are the v1 routes. Each tool has the route's id as its name, the route's
description, and the route's parameters as its input. A tool call is answered
by the route itself, so validation, scopes and errors are the same as REST:

| Tool | Route |
|---|---|
| `fleet_status` | `GET /api/v1/status` |
| `diagnose_repo` | `GET /api/v1/repos/{owner}/{repo}/diagnosis` |
| `wait_for_checks` | `GET /api/v1/repos/{owner}/{repo}/checks` |
| `list_queue`, `list_orphans`, `list_runners`, `list_hosts`, `list_actions` | the matching list |
| `run_action` | `POST /api/v1/actions/{id}`, with the same preview and confirmation |

`repo` may be given as `owner/name` in place of separate `owner` and `repo`.
A route's error comes back as a tool result with `isError: true` and the v1
error under `structuredContent.error`, so the model can read the hint.

Access is the same as `/api/v1`. Reads need no token on loopback, and actions
need `Authorization: Bearer` with a token holding the action's scope. For
Claude Code on the host, or through an SSH forward of port 7878:

```sh
TOKEN=$(./dashboard/fleetctl.sh api-token "claude code" --scopes read,act)
claude mcp add --transport http fleet http://localhost:7878/mcp \
  --header "Authorization: Bearer $TOKEN"
```

The server is stateless. It answers each POST with one JSON response and
opens no event stream, so `GET /mcp` is 405 and a daemon restart doesn't drop
a client's session.

For a chat tool's connector (claude.ai, ChatGPT), the same server is published
through a tunnel on a separate listener that requires OAuth sign-in. See
[Chat tools](remote-access.md#chat-tools-claudeai-chatgpt).

### Command line (`fleet`)

`dashboard/bin/fleet.mjs` is `/api/v1` from a shell: one file, Node 22, no
dependencies. It has no command list of its own. It reads the daemon's
`/api/v1/openapi.json` on each run and offers one command per route, so it
always matches the daemon it is talking to. Copy or link it anywhere:

```sh
ln -s "$PWD/dashboard/bin/fleet.mjs" ~/.local/bin/fleet
export FLEET_URL=http://localhost:7878     # the default; or a forwarded port
export FLEET_TOKEN=...                     # only for actions; reads need none on loopback
```

```console
$ fleet
usage: fleet <command> [args] [--flag value ...]

commands (from the daemon's /api/v1/openapi.json):
  status                     The fleet verdict
  why owner/repo             Why one repository's CI is queued, slow or red
  checks owner/repo          A PR's or commit's checks as green, red, pending or pointless, optionally waiting
  queue                      Queued runs, each with why it is waiting
  …
  wait owner/repo            checks, asked again until they finish or --timeout (default 45m)
```

- `fleet help <command>` prints the route's description, the scope it needs
  and its flags.
- Path parameters are positional (`owner/repo`, an action id). Query
  parameters and body fields are `--flags`, written in kebab case
  (`--dry-run`).
- A flag the route doesn't declare is sent anyway, so the daemon refuses it
  with its usual hint rather than the CLI guessing. For `run`, extra flags are
  the action's arguments: `fleet run runner.drain --name build-host-web-2`.
- `fleet run` previews first. An action whose danger isn't `none` stops at the
  preview, exits `2` and prints the command it would run; `--yes` confirms it.
- `fleet wait owner/repo --pr N` asks `checks` again until the checks finish.
  Exits `0` green, `1` red, `2` pointless, `3` timed out.
- Output is the daemon's JSON on stdout (`--compact` for one line), and
  errors also go to stderr as message and hint. Other exits: `1` refused,
  `3` unreachable, `64` usage.

## Read endpoints

### `GET /api/state`

Full live snapshot: local and fleet-wide runners, per-host summaries, active
runs, host vitals, capacity, drift alerts, queue causes, alerts, federation
counts, the fleet `verdict` (see `GET /api/glance`), and control-plane
leader/standby metadata. This is what the browser's
SSE stream delivers on every tick.

`tiers` is the standby-tiers controller's latest decision
([Standby tiers](design/tiers.md)): `mode`, `overflow` (`active` or `standby`),
`since` and `reason` for the last change, current `triggers`, per-lane busy and
cap on the primary (`lanes`), `quietForMs` and `drainInMs`, runner counts per
tier, the `actions` this tick took (enforce) or would take (observe), what was
`deferred` and why, and the recent `history`. The glance carries a compact
`tiers` object (mode, overflow, since, reason, triggers, drainInMs, lanes,
counts, lastAction) whenever the mode is not `off`.

### `GET /api/stream`

Server-Sent Events stream. The browser subscribes to this for live updates.
Each event is a full `GET /api/state` payload. With `?view=glance`, each event
is a `GET /api/glance` payload instead.

### `GET /api/glance`

The compact view: one verdict for the whole fleet, one state per runner, the
queue, open incidents and per-host vitals, in roughly 10 KB where `/api/state`
is 130 KB. Built for small screens and slow links — the macOS cockpit, a
phone, a script. `GET /api/stream?view=glance` streams the same payload on
every tick.

```json
{
  "schema": 1,
  "ts": 1790781986956,
  "generatedAt": 1790781990012,
  "ageMs": 3056,
  "stale": false,
  "verdict": {
    "id": "disk-floor",
    "tone": "critical",
    "rung": 2,
    "title": "Disk floor is holding jobs",
    "sentence": "3 jobs held because free disk is under the admission floor. It looks like load; it is disk.",
    "evidence": ["36.6 GB free, floor 40 GB", "3 jobs held at Set up runner: web, backend, ios"],
    "next": { "label": "Preview cleanup", "kind": "action", "action": "fleet.cleanupPreview", "then": "fleet.cleanupApply" },
    "open": [ { "id": "disk-floor", "...": "..." } ]
  },
  "counts": { "running": 0, "queued": 0, "held": 3, "runners": 54 },
  "hosts": [ { "id": "build-host", "name": "build-host", "local": true, "stale": false, "ghOnly": false,
               "vitals": { "cores": 12, "load1": 4.2, "memPressure": "normal", "swapinsPerSec": 0,
                           "diskFreeGb": 36.6, "diskTotalGb": 926, "diskFloorGb": 40 } } ],
  "runners": [ { "name": "build-host-web", "repo": "owner/web", "project": "web", "host": "build-host",
                 "state": "held-disk", "detail": "held: 36 GB disk free, below the 40 GB floor", "since": 1790780126000 } ],
  "queue": [],
  "failures": [ { "runId": 901, "repo": "owner/web", "workflow": "web-e2e", "cls": "runner-lost",
                  "notYourCode": true, "at": 1790779986956, "url": "https://github.com/owner/web/actions/runs/901" } ],
  "incidents": [ { "key": "admission:disk-floor", "rule": "admission-hold", "severity": "critical",
                   "title": "Disk floor is holding 3 jobs", "openedAt": 1790780246000, "dismissed": false } ],
  "admission": { "mode": "enforce", "limit": 2, "waiting": 3 },
  "collector": { "lastError": null, "failedRepos": 0 },
  "api": { "remaining": 4282, "limit": 5000 }
}
```

Fields that would be `null` are omitted from runners, queue entries, failures
and incidents. Host vitals carry `diskFloorEtaMs` (when free disk reaches the admission
floor at the current rate: the nearer of a 6-hour and a 72-hour linear fit, or
absent when the line is flat or rising) and `diskRateGbPerHour`, and the System
V shared memory table: `shmLimit`, `shmUsed`, `shmOrphaned` (segments the next
job hook will remove), `shmLowFree` and `shmReaped24h` (orphans the hooks
removed in the last 24 hours, the leak rate); null where the host could not
sample it. `runs` carries the active runs and `recent` the runs finished in the last two
hours, compact (id, repo, workflow, status, conclusion, branch, sha, prNumber,
url, timing), which is enough to roll a commit's checks into one row. Queue
entries carry `etaStartMs` and `etaDoneMs` as `[p50, p90]` ranges and
`etaBasis` saying what the estimate waits behind; both are absent when the
cause never clears on its own. `failures` lists failed runs from the last two hours with their
failure class (see `lib/failures.js`); `notYourCode` is true for `runner-lost`,
`host-broken`, `account-blocked`, `account-quota`, `no-runner` and
`admission-hold`, the classes whose first move
is not reading the diff. `schema` changes only on a breaking change; new fields may appear at
any time and decoders should ignore what they do not know.

**`verdict.id`** is the first matching rung of the ladder, in this order:

| Rung | `id` | Tone | Opens when |
|---|---|---|---|
| 0 | `unknown` | unknown | the collector has not finished a pass, or every repo failed to read |
| 1 | `host-down` | critical | a federated agent host has stopped heartbeating |
| 2 | `disk-floor` | critical | a job is held by the admission disk floor, or disk is under the floor while admission enforces |
| 3 | `dead-service` | critical | a runner service is dead or missing, or a runner has been offline for 5 min, or work is queued behind a down runner |
| 4 | `shm-low` | warning | fewer than `FLEET_SHM_LOW_FREE` System V shared memory segments are free on a reporting host, counting orphans the next job hook will remove as free, or that host's `hooks/shm-reap.sh` logged a `low` event in the last 30 min. Critical, titled "full", when none are free |
| 5 | `saturated` | warning | two or more `runner-lost` jobs in an hour, sustained paging, or critical memory pressure. A run queued because the headroom gate is at capacity is `waiting`, not this |
| 6 | `account-blocked` | warning | an `account-blocked` or `account-quota` job in the last 6 hours |
| 7 | `config-drift` | warning | an orphan or label mismatch, or a queue cause that waiting cannot fix (`unserved`, `role-unserved`, `label-mismatch`, `github-hosted`) |
| 8 | `waiting` | ok | runs are queued or held for an admission slot, and nothing above explains them |
| 9 | `clear` | ok | none of the above |

`verdict.open` lists every rung that is currently true, in ladder order.
`verdict.next.kind` is `action` (an id from `GET /api/actions`), `url`,
`command` (to run on the host), `owner` (only a person can do it) or `none`.
A client that cannot reach this daemon at all is expected to add its own
out-of-band rungs; the macOS cockpit uses `blind` and `host-down` for that.

**`runners[].state`** is one of `host-down`, `unknown`, `dead`,
`misconfigured`, `draining`, `offline`, `settling` (offline under 5 minutes,
which usually self-resolves), `held-disk`, `held-slot`, `overdue` (running past
its workflow's p95), `busy`, `lost` (lost contact mid-job in the last hour) or
`idle`. Runners registered on machines this daemon does not supervise appear in
a host with `ghOnly: true`, named after their shared runner-name prefix.

### `GET /api/posture?refresh=1`

Standing risks: conditions that are fine today and have caused an outage before.
Each item is `{ id, title, ok, detail, fix, who }`, where `ok` is `true`,
`false`, or `null` when the probe could not answer, and `who` is `owner` (a
system setting only a person can change, possibly blocked by MDM), `command`
or `button`. Checked on the slow loop; `refresh=1` checks now. Items: Spotlight
indexing the fleet root, auto-login, system sleep, admission hooks on every
runner, runner version drift, the periodic health-repair agent, workflows still
targeting GitHub-hosted macOS, this checkout behind `origin/main`, and GitHub
API headroom. Every probe is a read. The glance carries the open ones as
`posture`.

### `GET /api/timeline?days=7`

History in the verdict's terms: alert intervals (`incidents`, each with the
ladder `rung` it belongs to), today's job count with queue time against build
time, admission-held time and jobs lost to the host (`today`), the week's
incident count, per-rung counts, mean time to clear and longest-waiting repos
(`week`), runners that lost jobs (`flaky`), and two hours of host samples
downsampled for sparklines (`samples`: `[ts, load per core, swap-ins/s, disk
free GB, busy runners]`). `days` is 1–30.

### `GET /api/runner?name=<runner-name>`

Detail for one runner: recent events, recent jobs, utilization, diagnostic log
summary (redacted), and version info. Remote runners return `remote: true` and
their heartbeat/GitHub-fused state; host-local logs and diagnostic bundles are
available only from the owning host.

### `GET /api/queue-causes`

Queue cause classifications for all currently queued runs.

### `GET /api/queue-history?repo=&runId=&hours=24`

Cause-transition history from `queue_events`, newest first. `repo` and `runId`
are optional filters; `hours` is bounded to 90 days and responses to 500 rows.

### `GET /api/concurrency`

Concurrency advisor findings: unbounded matrices, missing concurrency groups,
static group collisions.

### `GET /api/analytics?days=30`

Aggregate job history by repo: count, duration percentiles, failure rate.
Includes a `playwright` object with browser-install step timings and E2E job
queue/duration metrics derived from recorded step and job names only.
`days` defaults to 30, max 365.

### `GET /api/billing`

GitHub Actions billing snapshot (if accessible).

### `GET /api/autoscale`

Recent autoscale decisions.

### `GET /api/admission?limit=60`

Job admission decisions. `limit` defaults to 60, max 500. With
[lanes](admission-and-scaling.md#lanes) on, rows carry `lanes`, `lane`,
`lane_source`, `heavy_busy`, `light_busy`, `heavy_limit`, `light_limit`,
`total_limit`, `lane_would_hold`, `lane_wait_s` and `lane_reason`, waiting
entries carry `lane`, and the summary has a `lanes` block: `mode`, `limits`,
`running` and `waiting` per lane, and over 24 h `heldLanesWouldAdmit`,
`admittedLanesWouldHold`, `waitedS` against `laneWaitS` and `byLane`.

### `GET /api/run-status?repo=owner/name&run=123`

`{ "status": "completed", "conclusion": "cancelled" }` for one workflow run,
fetched with the daemon's token and cached for 20 s. Held admission hooks poll
this to notice a run that ended while they waited: runner LaunchAgents set
`SessionCreate`, so `gh` inside a job cannot read the keychain token. 400 for a
malformed query, 404 for a repo this fleet does not serve.

### `GET /api/job-class?repo=owner/name&job=<id>&short_s=90`

`{ "repo", "job", "class": "light"|"heavy"|"unknown", "p50Ms", "n", "source", "shortJobS" }`:
the [admission lane](admission-and-scaling.md#lanes) for a job, which
`hooks/job-started.sh` asks for every job its patterns do not name. `job` is
`GITHUB_JOB` (the job's YAML id); a display name such as `ios / test` also
works. The median is over the job's newest 30 releases in the last 14 days
from the admission log (`ran_s`, which leaves the hold out), or, with fewer
than 5 of those, its successful GitHub job rows matched by name or by
`% / <id>` (whose durations include any hold). `light` when the median is
under `short_s` seconds (the hook's `FLEET_ADMIT_SHORT_JOB_S`; the host's
`fleet.env` when omitted); `unknown` with fewer than 5 samples, which the hook
treats as heavy. `source` is `admission`, `jobs` or `none`. Cached for 60 s.
400 for a malformed query. No auth, like `/api/run-status`.

### `GET /api/load-by-busy?days=7`

`{ "days", "host", "since", "samples", "cores", "rows": [{ "busy", "n", "p50", "p90" }], "lanes" }`:
this host's load1 p50 and p90 per number of busy runners over the window
(1–90 days), from the per-minute `host_samples`. `busy` counts runners GitHub
shows busy, which includes jobs the admission hook is holding. `lanes` is the
`lanes` block of `/api/admission` (null while lanes are off). `cockpit load`
prints it.

### `GET /api/simulate` (POST)

Replay historical job data against a hypothetical runner configuration.

**Body:**
```json
{
  "repo": "owner/project-ios",
  "runnerCounts": [1, 2, 3],
  "sloSec": 60
}
```

**Response:** comparison of queue metrics across the specified runner counts.

### `GET /api/forecast`

Next-hour demand forecast by repo, based on weekday/time-of-day patterns and
workflow schedules.

### `GET /api/hosts`

Merged view of all federation hosts (coordinator + agents). Includes each
host's runners, capacity, load, and heartbeat age. `drained` is true when the
host takes no new runners (paused or off), `off` when it is switched off, and
`drainingCount`/`activeCount` count its runners still finishing a job and still
taking jobs. `impact` is what switching it off would do:
`{ runners, active, busy: [runner names], stranded: [repos no other host serves] }`.
The same object per host ID is `hostImpact` on `/api/state`.

### `GET /api/health`

Serving and collector health, snapshot age, and HA role. In PostgreSQL mode the
response includes `role`, `replicaId`, `leaderId`, `leaderSince`, `servingOk`,
and `collectorOk`. A standby may be healthy for reads while `collectorOk` is
`null`, because only the leader collects.

### `GET /api/leader`

Compact HA discovery response: whether HA is enabled, this replica's ID and
role, and the current leader ID.

### `GET /api/actions`

The action catalogue: which actions exist and their labels. Available without
authentication so the UI can render buttons before the token is entered.

### `GET /metrics`

Prometheus text exposition for collector age/staleness, queue count and worst
age by cause, runner utilization, admission waiters, local and fleet capacity,
autoscale mode/deficit, and federation host health. This endpoint follows the
same read-access posture as `/api/state`; protect it with the same VPN, tunnel,
or reverse-proxy policy on non-loopback deployments.

### `GET /api/repo?name=<owner/repo>`

30-day detail for one repo: job count, duration, failure rate, and concurrent
job peak.

### `GET /api/alerts`

What is open now and what fired recently. `open` contains every condition that
is currently true, including dismissed ones — dismissing suppresses notification,
not the condition. Dismissed entries carry a `dismissed_at`
timestamp; `counts` separates `open` from `dismissed` for anything rendering a
badge. See [Dismissing alerts](design/dismissing.md).

## Write endpoints (require bearer token)

### `POST /api/action`

Execute a control-plane action.

**Body:**
```json
{
  "action": "runner.duplicate",
  "args": { "name": "project-ios" }
}
```

**Actions:**
| ID | Effect |
|---|---|
| `runner.duplicate` | Register a second runner for a repo |
| `runner.drain` | Mark a runner draining |
| `runner.resume` | Resume a drained runner |
| `runner.deregister` | Remove a runner |
| `host.off` | Switch a host off: every runner drains, busy ones after their job (`args.hostId` for an agent) |
| `host.on` | Switch it back on: resumes the runners `host.off` drained |
| `host.drain` / `host.resume` | Pause or allow new-runner placement on a host |
| `health.check` | Run `health.sh` |

### `GET /api/runner/bundle?name=<runner-name>` (requires token)

Download a redacted diagnostic bundle as a plain text file. Uses an allowlist
(only named files are included) and passes every line through the secret
redactor.

### `POST /api/settings`

Update a live setting (capacity, autoscale, etc.). No restart required.

**Body:**
```json
{
  "key": "ceiling",
  "value": 4
}
```

### Remote browser pairing

- `GET /api/access` reports how the viewer is connected
  (`via`: `local`, `lan`, `tailscale`, or `proxy`), the Tailscale login when
  proxied through Serve, the reachable dashboard URLs
  (`[{ kind, label, url }]`), the bind `host` and `port`, and `readOnly`.
- `POST /api/pair/start` requires an existing control or device token and
  creates a single-use six-digit code valid for five minutes. Response:
  `{ code, url, alternatives, warning, expiresAt }`. `url` is the pairing
  link on the best address another device can reach. `warning` is set when no
  such address exists.
- `POST /api/pair` with `{ code, name }` exchanges that code for an
  individually revokable device token: `{ token, name }`. Needs no token, but
  is subject to the Origin check. A wrong code returns `403`. Too many failures
  returns `429`: more than 5 a minute from one client, or 20 a minute in total,
  which also invalidates all pending codes. Duplicate names get a numeric
  suffix rather than replacing the earlier device.
- `GET /api/devices` lists paired devices; `POST /api/devices/revoke` with
  `{ key }` revokes one. Both require an existing control or device token.

Device tokens are refused when the daemon runs with `FLEET_READ_ONLY=1`.

Only token hashes are stored in the mode-0600 device store. The master control
token does not need to leave the coordinator.

### `POST /api/alerts/dismiss`

Stop a condition notifying, without closing its interval.

**No token is required from the machine the daemon runs on** — this changes what
the dashboard tells you rather than anything about the fleet, and it is a `×` on
a row. From any other address the bearer token applies as usual. The Origin check
applies in both cases.

**Body:** `{ "key": "drift:offline:host-web" }`. The key must name a currently
open alert; anything else is a `404`, since a dismissal nobody can see is a
dismissal nobody can undo.

The dismissal is recorded against the alert's *scope* rather than its key, so
dismissing a failing workflow is not undone by the next push minting a new run
id. It lasts until the condition clears and is then forgotten. There is nothing
else to supply — no reason, no duration.

### `POST /api/alerts/restore`

**Body:** `{ "key": "drift:offline:host-web" }`. Undoes a dismissal; the
condition starts notifying again on its next transition. `404` if that key is not
a dismissed open alert.

## Agent endpoints (require agent token)

These are used by `agent.js` on remote hosts. They accept the agent token
rather than the control token.

### `POST /api/host/heartbeat`

Report a host's state to the coordinator.

### `POST /api/host/results`

Report the result of a command sent by the coordinator.

## Error responses

| Status | Meaning |
|---|---|
| `400` | Missing or malformed parameter |
| `401` | Missing bearer token |
| `403` | Wrong token or cross-origin request |
| `404` | Unknown resource |
| `413` | Request body too large |
| `500` | Internal error (check the daemon log) |
