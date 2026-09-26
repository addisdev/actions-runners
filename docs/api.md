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
counts, and control-plane leader/standby metadata. This is what the browser's
SSE stream delivers on every tick.

### `GET /api/stream`

Server-Sent Events stream. The browser subscribes to this for live updates.
Each event is a full `GET /api/state` payload.

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
