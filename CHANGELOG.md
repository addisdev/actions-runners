# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not use Semantic Versioning — it uses simple sequential
version numbers (`v0.1.0`, `v0.1.1`, etc.).

## [v0.1.0] — unreleased

First public release. The project was originally developed as private tooling
for a macOS runner fleet; this release generalises it for public use.

### Scope

This release supports **one Apple Silicon Mac** running many self-hosted GitHub
Actions runners — one per repo, each its own LaunchAgent — with a dashboard
for monitoring and managing them. The dashboard binds to loopback by default.

### Features

- **Runner registration and management:** `register.sh`, `status.sh`,
  `health.sh`, `cleanup.sh`, `scripts/deregister.sh`
- **Preflight check:** `preflight.sh` infers what a host needs from cached
  workflow data; always checks Apple Silicon and Node >= 22.5
- **Dashboard daemon:** `fleetd.js` with live fleet view, run history, drift
  detection, analytics, lint/concurrency advisor, alerts, and autoscaling
- **Queue cause classification:** diagnoses queued jobs by eight causes
- **Drain and resume:** graceful runner shutdown via `scripts/drain-runner.sh`
  and the `ACTIONS_RUNNER_HOOK_JOB_COMPLETED` hook
- **Admission control:** job execution throttling via `hooks/job-started.sh`
- **Historical simulation:** replay job history against hypothetical
  configurations on the Capacity tab
- **Burst forecasting:** next-hour demand estimate with shadow evaluation
- **Diagnostic bundles:** allowlist-based, redacted runner diagnostics
- **Ephemeral runners:** `scripts/ephemeral-runner.sh` for one-job clean runs
- **Federation:** `dashboard/agent.js` for coordinating multiple Macs
- **Autofix bridge:** optional AI-assisted PR fix generation (`autofix/`)

### Known limitations

- macOS on Apple Silicon only; no Intel Mac, Linux, or Windows support
- Dashboard UI requires JavaScript; no server-side rendering
- Federation token is a shared secret (per-host scoped tokens are a planned
  enhancement, not blocking this release)
- Screenshots and demo mode are not included in v0.1.0; see `docs/images/README.md`
- `autofix/escalate/` (the AI escalation subtree) has not been independently
  audited; it is disabled by default

### Security model

Read [SECURITY.md](SECURITY.md) and [docs/security-hardening.md](docs/security-hardening.md)
before deploying. Self-hosted runners on public repositories are explicitly
not supported.

### Migration from private deployment

If you are upgrading from the private version of this project:

1. Back up `dashboard/fleet.db`
2. Run `git pull` on the fleet root
3. Stop the daemon: `cd dashboard && ./fleetctl.sh stop`
4. Start the daemon: `./fleetctl.sh start` (applies schema migrations automatically)
5. Reinstall hooks if needed: `scripts/install-hooks.sh --apply --restart`
6. Verify: `./health.sh` and check the dashboard

### Upgrade path

No breaking schema changes from the last private commit. Migrations are
applied automatically on daemon startup. There is no downgrade path —
back up `fleet.db` before upgrading.

---

Releases after v0.1.0 use the format `v0.1.N` for patches and `v0.N.0` for
backwards-compatible feature releases. Tags are only applied to the public
repository (`addisdev/actions-runners`).
