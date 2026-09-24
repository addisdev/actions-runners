# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not use Semantic Versioning — it uses simple sequential
version numbers (`v0.1.0`, `v0.1.1`, etc.).

## [v0.3.0] — unreleased

Portable, mobile-first dashboard.

### Added

- **LAN access.** `./fleetctl.sh remote lan on|off` binds the daemon to
  `0.0.0.0` and restarts it. `./fleetctl.sh remote status` shows all reachable
  URLs. `FLEET_HOST=0.0.0.0` in `fleet.env` also works.
- **Tailscale Serve integration.** `./fleetctl.sh remote tailscale on|off`
  configures Tailscale Serve for HTTPS access on your tailnet. Never Funnel —
  the dashboard is never exposed to the public internet.
- **DNS-rebinding protection.** Every request is validated against the server's
  own identity (hostname, `.local`, LAN IPs, Tailscale MagicDNS). Unknown
  `Host` headers get 421 before any route logic runs.
- **Per-device pairing.** `./fleetctl.sh pair` generates a 6-digit pairing code
  (+ terminal QR if `qrencode` is installed). Remote devices exchange the code for
  their own revokable bearer token; the master token never leaves the host. The
  Control tab shows a QR code + pairing panel. `./fleetctl.sh devices` and
  `./fleetctl.sh revoke <name>` manage them from the terminal.
- **Mobile bottom nav.** Below 640 px: fixed bottom bar (Fleet, Runs, Alerts,
  Hosts, More), More sheet for secondary tabs, collapsing top bar.
- **Mobile glance card.** Busy / Idle / Queued counts at the top of Fleet —
  sized for a quick check from the lock screen.
- **Hash routing.** URLs like `#/runs`, `#/alerts`, `#/hosts` are bookmarkable,
  restorable on refresh, and shareable. Back closes the drawer on mobile.
- **Resilient SSE.** Exponential backoff on reconnect (1s → 30s cap). Reconnects
  immediately on `visibilitychange`. Elapsed timers pause while the tab is hidden.
- **PWA improvements.** `viewport-fit=cover` + safe-area padding for notches.
  `apple-touch-icon` PNG (180 px). Manifest shortcuts (Runs, Alerts). Service
  worker (`sw.js`) registered only on secure contexts (localhost / Tailscale
  HTTPS); caches app shell + last `/api/state` for offline launch.
- **Touch-friendly alerts.** Dismiss button always visible under
  `@media (hover: none)`. `tip.js` tap-to-reveal popovers for `data-tip` attributes.
- **Table-scroll containers** (`table-scroll`) for wide tables on narrow viewports.
- **Three-state connection pill.** "Offline" (browser offline), "Can't reach
  dashboard" (SSE down), "Collector stalled" (health check failed).
- **Access banner.** Non-local viewers see their connection context (LAN /
  Tailscale user) and a link to the pairing flow.
- **Alerts tab** now polls every 30 s while open, matching Hosts.
- **`/api/access`** endpoint returns viewer context (via, tailscale user, URLs).
- **`lib/remote.js`** — host allowlist, proxy-aware origin/sameOrigin, reachable
  URL list. **`lib/devices.js`** — pairing codes, hashed device tokens, rate limiting.
- **`dashboard/public/tip.js`** — tap-to-reveal popovers for touch devices.
- **`dashboard/public/sw.js`** — service worker for offline/PWA support.
- **`dashboard/public/vendor/qrcodegen.js`** — vendored Nayuki QR Code generator
  (MIT licensed, no npm dependency, no build step).
- **New docs:** `docs/remote-access.md` covering LAN, Tailscale, pairing, and
  the security model. `mkdocs.yml` nav updated.

### Changed

- `lib/auth.js` `authorize()` now accepts a `checkDevice` parameter so it can
  validate device tokens alongside the master token.
- `isLocalRequest()` and `sameOrigin()` moved from `lib/auth.js` to
  `lib/remote.js`. They are re-imported in `fleetd.js` — no external API change.
- `isLocalRequest()` now returns `false` when a loopback request carries proxy
  headers (Tailscale Serve). Previously, Tailscale requests looked local.

## [v0.2.0] — unreleased

The documentation release, plus a dismiss button — writing the alerts page down
made it obvious that the fleet had no way to say "yes, I know" about a condition
that is real, understood and not going to change. Otherwise: one corrected name
and two corrected doc claims.

### Added

- **Two-replica control-plane HA.** Optional managed PostgreSQL state, advisory
  lock leader election, shared snapshots/commands/settings/cooldowns, standby
  dashboard serving, automatic promotion, and agent endpoint failover.
- **Host-first fleet controls.** Fleet and Runs identify the owning Mac,
  Capacity separates local and fleet headroom, Hosts shows live vitals and
  remote drain/restart/repair/removal actions, and agent credentials can be
  scoped per host.
- **Complete live queue discovery and per-role capacity planning.** The fast
  collector now paginates queued and in-progress runs, sizes `ci` and `ui-web`
  pools independently under one repo-wide cap, and distinguishes a known
  `role-unserved` condition from an unsafe arbitrary label mismatch.
- **Burst-aware autoscaling and evidence-gated pre-warming.** Burst thresholds
  remain opt-in; pre-warming remains off until its forecast precision/recall
  gate passes and every placement, cooldown and active-work guard succeeds.
- **Long-running job detection**, queue-cause history, fleet-wide placement
  visibility, autofix status, and a Prometheus `/metrics` endpoint.
- **Safe database backup/restore commands** and `healthctl.sh`, which installs a
  non-overlapping launchd repair sweep without modifying GitHub runner plists.
- **Hardened admission control.** Enforce mode no longer fails open on mutex
  contention, cancellation can fall back to GitHub's API through `curl`, and
  concurrent hook tests are isolated and deterministic.
- **Remediation safety gates.** Autofix pauses on stale collector state, honours
  minimum run age, classifies timed-out jobs, writes state atomically, and treats
  mixed infrastructure/code failures conservatively.
- **A first runner for a repo that has none**, off by default as
  `provisionUnserved`. Everything the autoscaler did until now was a *duplicate*,
  built by copying a sibling's labels, so the one queue cause the fleet could
  name and not fix was the repo with no sibling to copy — `unserved`, which the
  classifier has reported and recommended "register a runner for this repo" for
  since it was written. It exists so the fleet can be **trimmed**: the host limit
  is 32 runners and the fleet reached 42, but the runners over that line belong
  to real repos, so trimming otherwise means choosing which repos silently lose
  CI. Now a trimmed repo gets a runner back the next time it asks for one.
  It provisions only for work queued *right now* (every trimmed repo still has
  months of history, and sizing off history would undo the trim in one sweep),
  only for jobs that asked for a **self-hosted** runner (all ten unserved repos
  on this fleet build on GitHub-hosted ones, where having no runner is correct
  and permanent), and without the headroom gate, which `runner.register` already
  waives for instance 1 on the grounds that a first runner decides whether a repo
  can build at all rather than how many of its jobs may run at once. Proven end
  to end by removing an example backend's only runner, pushing a build, and
  watching the fleet register a replacement and run the job. The argument is in
  [Giving a repo its first runner](docs/design/capacity.md#giving-a-repo-its-first-runner).
- **Queue diagnosis reads one job's labels, not every job's at once.** A run's
  jobs each carry their own `runs-on:`, and the diagnosis was merging them.
  An example Android repo has a branch whose `build` runs on `ubuntu-latest` and
  whose `instrumentation` runs on `[self-hosted, macOS]`; merged, that became
  `[self-hosted, macOS, ubuntu-latest]` — a set no machine can carry, which
  slipped past the GitHub-hosted check because it contains `self-hosted` and
  then failed the label check, reporting a **critical** mismatch against a
  workflow that is correct. Autoscale read the same merged set, so the runner it
  wanted to register would have advertised `ubuntu-latest`. Diagnosis now uses a
  single queued job's labels, preferring a self-hosted one, and ignores jobs that
  have already found a runner.
- **A `github-hosted` queue cause.** A job whose `runs-on:` names a GitHub-hosted
  image was being diagnosed as a **critical** `label-mismatch` against this
  fleet's runners — "Job needs labels [ubuntu-latest] / Runners carry
  [self-hosted, macOS, ARM64]", which is accurate, and a recommendation to go and
  reconcile those labels, which would mean editing a workflow that is behaving
  correctly. It is now its own cause, decided before the repo's runners are
  considered because the answer does not depend on them, and it recommends the
  three places the answer actually is: minutes, spending limits, and GitHub's
  status page. It is also what keeps first-runner provisioning away from the ten
  repos here that build on GitHub-hosted runners and should.
- **An `×` on every alert row.** Clicking it stops that condition notifying
  until it clears. No reason to type, no duration to pick, nothing to expire —
  the condition going away *is* the expiry, which is what keeps the whole
  feature to a two-column `dismissals` table. What it deliberately does not do
  is close the alert, which would be a notification loop, since the next tick
  would find the condition still true and open it again; or hide it from
  `GET /api/alerts`, which would stop the autofix bridge repairing it and
  silently reset its retry budget. Dismissals are recorded against the alert's
  scope rather than its key, so dismissing a failing workflow is not undone by
  the next push minting a new run id. `POST /api/alerts/dismiss` and `/restore`
  take no token from the local machine — they change what the dashboard tells
  you, not the fleet, and a control whose point is being one click cannot open
  with "run this shell command and paste the output" — and a Dismissed panel
  that is always visible,
  because with no expiry that visibility is the only thing between a dismissal
  and a fault hidden for ever. The argument is in
  [Dismissing alerts](docs/design/dismissing.md).
- **First unit tests for the alert engine** (`dashboard/test/alerts.test.js`),
  covering the transition, restart and storm behaviour that had been asserted
  only in comments until something needed to layer on top of it.
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

- **Three alert counts now report what is speaking rather than what is true.**
  The header badge, `watch/fleet-watch.mjs`'s fault signature and the autofix
  bridge's storm threshold all counted every open alert. Left alone, four
  dismissed conditions would sit at four of the bridge's six permanently, so two
  real failures would disable all remediation — and the badge would disagree
  with the page it links to. Dismissed conditions still appear in
  `GET /api/alerts` and are still repaired.
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

- **Every labelled scale-up was refused, and would have been the first time
  anyone turned autoscaling on.** `FLEET_HOST_LABELS` was empty, and placement
  requires a host to advertise every label a new runner needs, so a host that has
  served `ci`, `ui-web`, `postgres` and `xcode-26` continuously advertised none
  of them and matched nothing. The refusal even says so — `missing required
  label(s): ci` — while naming a label the machine plainly has. Scale-up being
  off by default is the only reason this went unnoticed. The value is now set
  from the labels the host's own runners already carry, and
  `docs/configuration.md` explains why empty means "matches nothing" rather than
  "no constraints".
- **The repo roster was lost on every restart**, and with it the daemon's only
  way to see a repo that has no runner directory. It was rebuilt solely by the
  slow loop, up to fifteen minutes away; anything reading it for display
  tolerated that, but discovery cannot, because a repo that is not polled has no
  queued runs to classify. It is now hydrated from the `repos` table at startup —
  the same loop's last answer, reused until it produces a new one.
- **Spotlight was indexing the entire fleet's build output**: 84 GB of `_work`
  across 42 runners plus 4.7 GB of artifacts, rewritten by every job and re-read
  by `mdworker`, holding `mds_stores` at 112% CPU on the 12-core host those jobs
  were queueing for. Excluded now, and `register.sh` marks `_work` at creation so
  runners made unattended by autoscale are covered without anyone remembering.
- **The federation route tests depended on the machine they ran on.** They
  authenticate with the control token, which agent routes accept only while no
  agent token is configured — and the daemon looks for one at
  `dashboard/.fleet-agent-token`, outside the temp `FLEET_ROOT` the tests
  otherwise isolate everything into. They passed for as long as that file
  happened not to exist and turned into four `403 !== 200` failures the moment
  `fleetctl.sh install` created it. The token is now passed explicitly.
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
