# Security

## Supported versions

Only the latest release tag is actively maintained. There is no long-term
support for older versions.

## Reporting a vulnerability

Please report security issues privately using GitHub's
[private vulnerability reporting](https://github.com/addisdev/actions-runners/security/advisories/new)
rather than opening a public issue.

**Expected response:** acknowledgement within 7 days. For critical issues that
need immediate coordination, open the private advisory and we will arrange a
timeline together.

## What this software has access to

Read this before deploying it. The tooling here is deliberately privileged, and
the defaults are chosen accordingly.

**Self-hosted runners should not be used on public repositories.** This is
GitHub's own guidance, and it is the most important item here. A fork's pull
request can run arbitrary code on your runner, and these runners execute as your
user on your machine with no sandbox between jobs. This project is designed for
private repos with trusted contributors only.

**The dashboard's control plane executes shell commands as the invoking user.**
Restarting a runner, running `cleanup.sh` and similar actions are real local
commands. Consequently:

- It binds to `127.0.0.1` by default. Reach it from elsewhere over an SSH
  tunnel (`ssh -L 7878:localhost:7878 your-runner-host`) rather than by binding
  to `0.0.0.0`.
- Every action requires a bearer token, held in `dashboard/.fleet-token` with
  `0600` permissions and generated on first start. Read routes do not require
  it, so exposing the dashboard to a network exposes read access.
- `FLEET_READ_ONLY=1` removes the control plane entirely. Use it for any
  deployment that should only ever look.

## Unauthenticated read routes

The following routes serve data without a bearer token, intentionally:

| Route | Data served |
|---|---|
| `GET /api/state` | Live runner status, run list, host vitals |
| `GET /api/stream` | SSE stream of the above |
| `GET /api/runner?name=X` | Runner detail; log tail is **redacted** before serving |
| `GET /api/analytics` | Aggregate job counts and durations |
| `GET /api/billing` | GitHub billing snapshot |
| `GET /api/autoscale` | Autoscale decision log |
| `GET /api/admission` | Job admission log |
| Static files | The browser UI assets |

On the default loopback deployment, any process on the runner host can read
this data. On a LAN deployment (`FLEET_HOST=0.0.0.0`), any network peer can.
See [Security Hardening](docs/security-hardening.md) for deployment guidance.

Log tails returned by `/api/runner` are passed through the secret redactor —
token patterns, bearer headers, long base64 runs, and PEM blocks are replaced
with `<redacted>` before serving. The `/api/runner/bundle` endpoint (which
returns a more complete bundle) is token-gated.

## Diagnostics policy

Diagnostic bundles (`/api/runner/bundle`) use an allowlist, not a denylist.
Only files explicitly named in `dashboard/lib/bundle.js`'s `ALLOW` set are
included, and every line passes through `REDACT_PATTERNS`. A file added in a
future runner release is excluded by default — the correct failure direction.

## Federation credentials

Agent tokens (`FLEET_AGENT_TOKEN`) authenticate remote hosts to the coordinator.
They should be treated as credentials: not committed, not logged, and rotated
if compromised. Use a separate agent token file (`dashboard/.fleet-agent-token`)
from the browser control token so each can be rotated independently.

The coordinator does not authenticate itself to agents — the agent decides
whether to trust the coordinator's address. On a LAN with a trusted network,
this is acceptable. For agents over untrusted networks, use a TLS proxy.

## localStorage risk

The browser control token is stored in `localStorage`. Any JavaScript running
on the same origin can read it. Do not open other pages on `localhost:7878`;
use a dedicated browser profile for the dashboard if you have other dev servers
running.

## Autofix bridge

`autofix/` modifies job hook behaviour. `autofix/escalate/` wraps a third-party
agent binary.

**Accepted risks:**
- The agent binary's telemetry and network behaviour outside its documented
  scope have not been independently audited
- It can open branches and pull requests on your repositories
- It is disabled by default and requires `FLEET_ESCALATE_ENABLED=1`
- CI never exercises it

See `THIRD_PARTY_NOTICES.md` and the lockfile before enabling it.
Run `autofixctl.sh dryrun` first to see what it would do without acting.

## Credentials this repo deliberately does not track

`.gitignore` is a deny-by-default allowlist, not a denylist, specifically so
that a new file in a runner directory cannot be committed by accident.

| Path | What it is |
|---|---|
| `<runner>/.credentials`, `<runner>/.credentials_rsaparams` | RSA private key authenticating the runner to GitHub |
| `dashboard/.fleet-token` | Browser control token |
| `dashboard/.fleet-agent-token` | Agent authentication token |
| `dashboard/alerts.config.json` | Alert webhook URL (may carry a token) |
| `dashboard/fleet.db*` | Run history, including repo and branch names |
| `dashboard/autofix/state.json`, `runs/`, `repos/` | Agent state, transcripts, scratch clones |
| `fleet.env` | Host-local config (owner, repo list, launchd prefix) |

## Registration tokens

`register.sh` mints a short-lived registration token (about one hour) via
`gh`. Prefer setting `RUNNER_TOKEN` in the environment over passing it in
argv, where `ps` can see it.

## Runner threat model

Each runner runs as the current macOS user. A job can:
- Read files accessible to that user (including SSH keys and other runner credentials)
- Call `gh api` using the authenticated `gh` session
- Reach `localhost:7878` if it knows the port (read routes are unauthenticated)

Mitigations:
- Use private repos with trusted code owners only
- Set `FLEET_READ_ONLY=1` if dashboard access from jobs is a concern
- Use an ephemeral runner for release builds or untrusted code review
