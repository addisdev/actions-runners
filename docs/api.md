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

## Read endpoints

### `GET /api/state`

Full live snapshot: local and fleet-wide runners, per-host summaries, active
runs, host vitals, capacity, drift alerts, queue causes, alerts, federation
counts, the fleet `verdict` (see `GET /api/glance`), and control-plane
leader/standby metadata. This is what the browser's
SSE stream delivers on every tick.

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
absent when the line is flat or rising) and `diskRateGbPerHour`. `runs` carries the active runs and `recent` the runs finished in the last two
hours, compact (id, repo, workflow, status, conclusion, branch, sha, prNumber,
url, timing), which is enough to roll a commit's checks into one row. Queue
entries carry `etaStartMs` and `etaDoneMs` as `[p50, p90]` ranges and
`etaBasis` saying what the estimate waits behind; both are absent when the
cause never clears on its own. `failures` lists failed runs from the last two hours with their
failure class (see `lib/failures.js`); `notYourCode` is true for `runner-lost`,
`account-blocked`, `account-quota` and `no-runner`, the classes whose first move
is not reading the diff. `schema` changes only on a breaking change; new fields may appear at
any time and decoders should ignore what they do not know.

**`verdict.id`** is the first matching rung of the ladder, in this order:

| Rung | `id` | Tone | Opens when |
|---|---|---|---|
| 0 | `unknown` | unknown | the collector has not finished a pass, or every repo failed to read |
| 1 | `host-down` | critical | a federated agent host has stopped heartbeating |
| 2 | `disk-floor` | critical | a job is held by the admission disk floor, or disk is under the floor while admission enforces |
| 3 | `dead-service` | critical | a runner service is dead or missing, or a runner has been offline for 5 min, or work is queued behind a down runner |
| 4 | `saturated` | warning | two or more `runner-lost` jobs in an hour, sustained paging, or critical memory pressure. A run queued because the headroom gate is at capacity is `waiting`, not this |
| 5 | `account-blocked` | warning | an `account-blocked` or `account-quota` job in the last 6 hours |
| 6 | `config-drift` | warning | an orphan or label mismatch, or a queue cause that waiting cannot fix (`unserved`, `role-unserved`, `label-mismatch`, `github-hosted`) |
| 7 | `waiting` | ok | runs are queued or held for an admission slot, and nothing above explains them |
| 8 | `clear` | ok | none of the above |

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

Job admission decisions. `limit` defaults to 60, max 500.

### `GET /api/run-status?repo=owner/name&run=123`

`{ "status": "completed", "conclusion": "cancelled" }` for one workflow run,
fetched with the daemon's token and cached for 20 s. Held admission hooks poll
this to notice a run that ended while they waited: runner LaunchAgents set
`SessionCreate`, so `gh` inside a job cannot read the keychain token. 400 for a
malformed query, 404 for a repo this fleet does not serve.

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
host's runners, capacity, load, and heartbeat age.

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

### `GET /api/remediation-candidates`

Recently failed runs classified by remediation strategy. Used by the autofix
bridge to decide whether to rerun a run or request an AI fix. Available without
authentication (the bridge holds no control token).

Each entry in the response array contains:

| Field | Type | Description |
|---|---|---|
| `repo` | string | `owner/name` |
| `runId` | number | GitHub run ID |
| `runAttempt` | number | Attempt number (1 = first try) |
| `runStartedAt` | string\|null | Run start time used by remediation age gates |
| `workflowName` | string\|null | Workflow display name |
| `workflowPath` | string\|null | `.github/workflows/...yml` |
| `event` | string\|null | Trigger event (push, pull_request, …) |
| `branch` | string\|null | Head branch |
| `sha` | string\|null | Head commit SHA |
| `prNumber` | number\|null | PR number, if triggered by pull_request |
| `url` | string\|null | Run URL on GitHub |
| `conclusion` | string | `failure` or `timed_out` |
| `defaultBranch` | string\|null | Repo default branch |
| `strategy` | string | `infra-rerun`, `ai-fix`, `diagnose`, or `skip` |
| `jobs` | array | Failed jobs with `failureClass`, `failureDetail`, `runnerName` |

At most one entry per `(repo, workflow_name)` pair is returned, and only when
the newest run of that workflow inside the 2-hour window is itself a completed
failure. A workflow that failed and then went green on a re-run or re-dispatch
is therefore absent, as is one whose retry is still queued or in progress — in
both cases the failure has already been handled and there is nothing to act on.

A strategy of `diagnose` means the bridge will not act but the escalation path
may diagnose it; it is also what a run gets while its job rows are still
unclassified, so an entry can move from `diagnose` to a real strategy on a
later sweep. `skip` means neither path will act (wrong event type, or a failed
run whose jobs all concluded without failing).

### `GET /api/autofix/status`

Read-only proxy to the loopback autofix bridge. Reports whether remediation is
available, paused because collector data is stale, running in dry-run mode, or
disabled/exhausted by its safety budgets. Returns `503` with
`{"available":false}` when the bridge is not running.

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
not the condition, and a consumer that filtered them out would also stop the
autofix bridge repairing them. Dismissed entries carry a `dismissed_at`
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

Stop a condition notifying, without closing its interval or stopping autofix
repairing it.

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
