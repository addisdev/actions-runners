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

Full live snapshot: runners, active runs, groups, host vitals, capacity, drift
alerts, queue causes, alerts. This is what the browser's SSE stream delivers on
every tick.

### `GET /api/stream`

Server-Sent Events stream. The browser subscribes to this for live updates.
Each event is a full `GET /api/state` payload.

### `GET /api/runner?name=<runner-name>`

Detail for one runner: recent events, recent jobs, utilization, diagnostic log
summary (redacted), and version info.

### `GET /api/queue-causes`

Queue cause classifications for all currently queued runs.

### `GET /api/concurrency`

Concurrency advisor findings: unbounded matrices, missing concurrency groups,
static group collisions.

### `GET /api/analytics?days=30`

Aggregate job history by repo: count, duration percentiles, failure rate.
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

### `GET /api/actions`

The action catalogue: which actions exist and their labels. Available without
authentication so the UI can render buttons before the token is entered.

### `GET /api/repo?name=<owner/repo>`

30-day detail for one repo: job count, duration, failure rate, and concurrent
job peak.

## Write endpoints (require bearer token)

### `POST /api/action`

Execute a control-plane action.

**Body:**
```json
{
  "id": "runner.duplicate",
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
