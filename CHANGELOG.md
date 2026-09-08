# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not use Semantic Versioning — it uses simple sequential
version numbers (`v0.1.0`, `v0.1.1`, etc.).

## [v0.2.0] — unreleased

The documentation release. No behaviour changes to the daemon or the scripts,
beyond one corrected name and two corrected doc claims.

### Added

- **A documentation site** at
  [addisdev.github.io/actions-runners](https://addisdev.github.io/actions-runners/),
  built with MkDocs Material and published from `main`. `mkdocs build --strict`
  and a lychee link check gate every pull request that touches `docs/`.
- **Concepts** (`docs/concepts.md`): what a runner is here, what launchd will
  and will not do for it, drift, why a job is queued, admission against
  autoscaling, inferred groups, and why alerts fire on transitions. The
  handbook had no page that introduced any of this.
- **Design notes** (`docs/design/`): `dashboard-internals.md` split into seven
  arguments, each one grounded in something that went wrong on a real fleet.
- **A scripts reference** (`docs/reference/scripts.md`): every script, every
  flag read out of the parsing code, and what each one refuses to do. Nine
  scripts had reached the tree undocumented, and several flags the README
  described did not behave as described.
- **Figures**, rendered from source in `docs/figures/` by `docs/tools/`:
  architecture, the drift matrix, the queue-cause paths, the daemon's loops,
  federation, a banner and a social card.
- **Screenshots** of every dashboard tab, captured from a fixture fleet by
  `docs/tools/shoot-dash.mjs`. The repository previously contained no image of
  any kind.
- `docs/brand.md`, recording the palette, the mark, the type pairing and how
  every asset is produced.

### Changed

- **One name.** The dashboard tab title, the web manifest, the package
  description and the mark's own `<title>` said "Runner Fleet"; the repository
  and the README said other things. Everything now says **Actions Runners**.
  `fleetd`, `fleetctl.sh` and `fleet.env` are unchanged — those are a daemon
  and its files, not the product.
- `docs/architecture.md` carries a rendered figure instead of two Mermaid
  blocks.
- `docs/installation.md` became `docs/getting-started.md`, ending on a job
  running rather than on a `curl`. The old URL redirects.
- `scripts/check-docs.sh` no longer exempts any file from the link check, and
  derives the list of scripts that must be documented from the reference page
  rather than from a hand-maintained array.

### Fixed

- **`.is-hidden` did not hide.** It and `.kpis` are both single-class
  selectors, and `.kpis` comes later in `style.css`, so it won on source
  order — `#kpis.is-hidden` stayed a grid and the live KPI row rendered on
  every tab. On Analytics that stacked two different meanings of "runs" on one
  screen, which `app.js` has a comment saying must not happen, directly above
  the toggle that was not working.
- `docs/configuration.md` gave the autoscaler's idle TTL as `0 (off)`;
  `settings.js` defaults it to 259,200,000 ms, which is three days.
- `docs/dashboard.md` described the `telemetry-unavailable` queue cause as
  "collector last ran > 2 min ago", which
  [`lib/queue-cause.js`](dashboard/lib/queue-cause.js) does not do, and
  `host-saturation` as "runners are free but the host is out of headroom",
  which cannot happen — that branch is only reachable once the idle-runner
  branch has already returned.

## [v0.1.0] — 2026-09-04

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
