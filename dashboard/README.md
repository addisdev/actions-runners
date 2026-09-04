# Fleet Dashboard

A single-page web UI and daemon that answers "is anything broken, and where"
for every self-hosted runner and every CI run across the repos they serve.

## Quick start

```bash
./fleetctl.sh install     # write and load the LaunchAgent
./fleetctl.sh status      # is it up?
./fleetctl.sh token       # print the control token (save this)
# Open http://localhost:7878
```

From another machine:
```bash
ssh -L 7878:localhost:7878 user@runner-host
# Open http://localhost:7878
```

## Running tests

```bash
npm test                          # Node's built-in runner, zero dependencies
../scripts/test-drain.sh          # drain/resume against a fake fleet in /tmp
../scripts/test-ephemeral.sh      # reaper refusals
```

## Documentation

Full documentation is in the [docs handbook](../docs/README.md):

- **[Dashboard guide](../docs/dashboard.md)** — all tabs, queue diagnosis, actions, autoscaling
- **[Architecture](../docs/architecture.md)** — how fleetd works, data flow, trust boundaries
- **[Configuration](../docs/configuration.md)** — every environment variable and live setting
- **[API reference](../docs/api.md)** — HTTP endpoints
- **[Security hardening](../docs/security-hardening.md)** — deployment models and threat model
- **[Federation](../docs/federation.md)** — coordinating across multiple Macs
- **[Operations](../docs/operations.md)** — maintenance, drain/resume, health repair
- **[Admission and scaling](../docs/admission-and-scaling.md)** — throttling concurrent jobs

For deeper implementation rationale (why the grouping logic works the way it
does, why zero dependencies, the auth model, what drift means), see
[dashboard-internals.md](../docs/dashboard-internals.md).

## Design principles

- **Zero runtime dependencies.** `dashboard/package.json` has no dependencies by
  design. `node:sqlite` (Node >= 22.5.0) is the reason for the Node version
  requirement, not an npm package.
- **One process.** The collector and server share the in-memory snapshot. No
  polling between them; one LaunchAgent to reason about at 3 AM.
- **Loopback by default.** The control plane executes shell commands as the
  current user. Binding to loopback is the only deployment where that is safe
  by default. See the security guide before binding to the LAN.
