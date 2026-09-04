# Security Hardening

This document covers the fleet's security model, deployment options, and
recommended hardening steps.

## Deployment models

### Default: loopback only (recommended)

The dashboard binds to `127.0.0.1:7878` by default. Access from another machine
requires an SSH tunnel:

```bash
ssh -L 7878:localhost:7878 user@runner-host
```

This is the right model for most operators. The control plane executes shell
commands as the current macOS user. Binding to loopback means only processes on
the runner host can reach the control plane, which is the same set that already
has shell access.

### LAN access with a reverse proxy

If you need LAN access without SSH tunnels, put a reverse proxy (nginx, Caddy,
or Apache) in front of `fleetd.js`:

```
Browser → HTTPS reverse proxy (LAN) → http://127.0.0.1:7878
```

The proxy should:
- Terminate TLS (Let's Encrypt or a private CA)
- Add `Content-Security-Policy` with appropriate script-src restrictions
- Add `Strict-Transport-Security`
- Restrict access to known client IPs or require mTLS

Without TLS, the bearer token (and any data) is visible in plaintext on the LAN.

### Read-only LAN status board

For a read-only status board accessible on the LAN without authentication:

```bash
FLEET_HOST=0.0.0.0 FLEET_READ_ONLY=1 node fleetd.js
```

No bearer token exists in read-only mode. Read routes are still unauthenticated
(see below).

## Unauthenticated read routes

The following routes do not require a bearer token, by design:

- `GET /api/state` — live snapshot
- `GET /api/stream` — SSE stream
- `GET /api/runner?name=X` — runner detail (log tail is redacted)
- `GET /api/analytics`, `/api/billing`, `/api/autoscale`, `/api/admission`
- `GET /api/actions` — action catalogue (knowing which buttons exist ≠ pressing them)
- All static files under `/public/`

**Accepted risk:** on loopback, any process on the machine can read this data.
On a LAN binding, any network peer can. This is appropriate for the default
loopback deployment but should be reviewed for LAN deployments.

Log tails returned by `/api/runner` are passed through the same redactor as
diagnostic bundles — secret patterns (tokens, keys, bearer headers, long
base64 runs) are replaced with `<redacted>` before serving.

## Token handling

### Control token

The browser control token (`dashboard/.fleet-token`) is generated randomly on
first start (32 bytes, hex-encoded). It authenticates every mutating action.
The token is:
- Stored in a `0o600` file on disk
- Checked via `timingSafeEqual` against the `Authorization: Bearer` header
- Cross-origin requests are rejected even with a valid token

To rotate it:
```bash
rm dashboard/.fleet-token
cd dashboard && ./fleetctl.sh restart
./fleetctl.sh token    # print the new token
```

### Agent token

The agent token (`dashboard/.fleet-agent-token`) authenticates remote agents.
By default it falls back to the control token for single-host backward
compatibility. For multi-host deployments, create a separate agent token:

```bash
openssl rand -hex 32 > dashboard/.fleet-agent-token
chmod 600 dashboard/.fleet-agent-token
cd dashboard && ./fleetctl.sh restart
```

Separating them lets you rotate agent credentials without invalidating
browser sessions, and prevents an agent host compromise from granting
control-plane access.

## Runner credentials

Each runner directory contains:
- `.credentials` — GitHub API credentials
- `.credentials_rsaparams` — RSA private key authenticating this runner to GitHub
- `_work/` — job checkouts (may contain secrets written by workflows)

These are excluded from git by an allowlist `.gitignore` that excludes
everything by default and explicitly includes only tracked fleet files.
A denylist would leak credentials the first time a new file appeared in
a runner directory.

**Never run `git add .` or `git add --all` in the fleet root.** Always add
files explicitly. `scripts/release-check.sh` enforces this before publish.

## Runner threat model

Each runner runs as the current macOS user. This means:
- A job can read files accessible to that user, including SSH keys and other
  runner credentials
- A job can call `gh api` using the authenticated `gh` session
- A job can reach the dashboard (if it knows the port and token)

For private repos with trusted code owners, this is an acceptable risk.
For public repos or repos with external contributors, it is not — use
GitHub-hosted runners.

## Autofix and escalation

`autofix/` modifies job hook behavior. `autofix/escalate/` is an opt-in
third-party subtree that wraps an external agent binary.

**Accepted risk for `autofix/escalate/`:**
- The third-party binary has not been independently audited for telemetry
  or network behaviour outside of what it advertises
- It is disabled by default (`FLEET_ESCALATE_ENABLED` not set)
- CI never exercises it
- See `THIRD_PARTY_NOTICES.md` for its declared network and telemetry behaviour

Do not enable `autofix/escalate/` without reviewing `THIRD_PARTY_NOTICES.md`
and the lockfile.

## localStorage risk

The control token is stored in `localStorage` in the browser. If another
page on `localhost` can run JavaScript (e.g. a local dev server), it can read
the token from `localStorage`. Only open the dashboard in a browser where no
other pages are running on `localhost:7878`, or use a separate browser profile.

## Federation security

Agent tokens authenticate agents to the coordinator. The coordinator never
authenticates itself to agents. A man-in-the-middle between an agent and the
coordinator can:
- Send fake heartbeat responses (including fake commands, if commands are enabled)
- Suppress real commands

For a LAN deployment where agents and coordinator are on the same network, this
is a low-probability risk. For agents over untrusted networks, put a TLS proxy
in front of the coordinator and have agents connect to the HTTPS endpoint.

## SSH access

The recommended operator workflow is SSH + port forward. Keep the runner host's
SSH configured with key authentication only (`PasswordAuthentication no` in
`sshd_config`).

## Security contact

See [SECURITY.md](../SECURITY.md) for the vulnerability reporting process.
