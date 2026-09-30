# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not use Semantic Versioning — it uses simple sequential
version numbers (`v0.1.0`, `v0.1.1`, etc.).

## [v0.3.0] — unreleased

Portable, mobile-first dashboard.

### Added

- **LAN access.** `./fleetctl.sh remote lan on|off` sets `FLEET_HOST` in
  `fleet.env` and regenerates the LaunchAgent, which is where the bind address
  actually lives. `./fleetctl.sh remote status` shows the running daemon's real
  bind, every reachable URL, the Serve config, and the firewall state.
- **Tailscale Serve integration.** `./fleetctl.sh remote tailscale on|off`
  configures Tailscale Serve for HTTPS access on your tailnet, finding the CLI
  in Homebrew or the Mac App Store app bundle. `off` removes only the
  dashboard's listener. Never Funnel — the dashboard is never exposed to the
  public internet.
- **DNS-rebinding protection.** Browser requests are validated against the
  server's own identity (hostname, Bonjour name, LAN IPs, Tailscale MagicDNS,
  coordinator URLs, `FLEET_ALLOWED_HOSTS`). Unknown `Host` headers get 421
  before any route logic runs, and the refused name is logged. Agent routes are
  exempt; they are token-authenticated.
- **Per-device pairing.** `./fleetctl.sh pair` generates a 6-digit pairing code
  (+ terminal QR if `qrencode` is installed) and a link on an address the phone
  can reach. It warns if no such address exists. Remote devices scan, tap, or
  type the code to get their own revocable bearer token; the master token never
  leaves the host. Guessing is capped per client and globally. The Control tab
  shows a QR code with a countdown, notices when pairing succeeds, and detects a
  revoked token. `./fleetctl.sh devices` and `./fleetctl.sh revoke <name>`
  manage devices from the terminal.
- **Mobile bottom nav.** Below 640 px: fixed bottom bar (Fleet, Runs, Alerts,
  Hosts, More), More sheet for secondary tabs, collapsing top bar.
- **Mobile glance card.** Busy / Idle / Queued / Alerts at the top of Fleet,
  counted the same way as the KPI row, each tappable to its tab.
- **Hash routing.** URLs like `#/runs`, `#/alerts`, `#/hosts` are bookmarkable,
  restorable on refresh, and shareable. The Back gesture closes an open drawer
  before it leaves the tab.
- **Resilient SSE.** Jittered exponential backoff on reconnect (1s → 30s cap).
  On return to a suspended tab it reconnects only if the stream has gone quiet.
  The last snapshot stays on screen through an outage. Elapsed timers pause
  while the tab is hidden.
- **PWA improvements.** `viewport-fit=cover` + safe-area padding for notches.
  `apple-touch-icon` PNG (180 px). Manifest shortcuts (Runs, Alerts). Service
  worker (`sw.js`) registered only on secure contexts (localhost / Tailscale
  HTTPS). It fetches the shell network-first, so upgrades reach phones
  immediately, and keeps the last `/api/state` for offline launch.
- **Touch-friendly controls.** Dismiss buttons always visible and 44 px targets
  under `@media (hover: none)`. `tip.js` shows `title` text on tap, which touch
  browsers otherwise never display.
- **Scrolling tables.** Every table is wrapped in a `table-scroll` container
  with edge shadows, so wide tables scroll inside their panel on a phone.
- **Connection pill states.** "Offline", "Reconnecting…" (stream down, last
  data shown), "Stale" / "Collector stalled" (health check), "Live".
- **Access banner.** Non-local viewers see their connection context (LAN /
  Tailscale user) and a link to the pairing flow.
- **Web push notifications.** Paired phones can subscribe from
  **Control → Notifications on this device** and get alerts on the lock screen
  with the dashboard closed and off the tailnet. Works on iOS 16.4+ from the
  Home Screen and on Android browsers. There is no native app and no relay: the
  daemon mints its own VAPID key and sends RFC 8291-encrypted messages straight
  to the browser vendor's push service, using only `node:crypto`. Push is a
  third channel in `Alerts.notify()`, so the transitions, storm guard and
  dismissals apply as they do elsewhere. Each device chooses a minimum severity.
  A resolution replaces the notification it resolves, and the Home Screen icon
  shows the open-alert count. Endpoints are limited to known push services to
  prevent request forgery. Revoking a device removes its subscriptions.
  Subscriptions are pruned on `404`/`410` or after five consecutive failures.
  New routes are under `/api/push/*`. New settings are `FLEET_VAPID_FILE`,
  `FLEET_PUSH_CONTACT`, `FLEET_PUSH_ALLOWED_HOSTS`, and `"push"` in
  `alerts.config.json`.
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
- `lib/capacity.js` — the rationale for `maxTotalRunners` said that nothing
  throttles execution and therefore the runner count *is* the concurrency
  limit. That has not been true since job admission control went to enforce, and
  reading the count as concurrency is what refused scale-ups while 43 idle
  listeners executed nothing. Documented as a disk and memory bound, with the
  refusal text corrected to match.

### Fixed

- **The coordinator never recorded its own heartbeat.** `reportSelfToHa()`
  returns early unless a shared database is configured, and it was the only
  writer, so on a single-host install `hosts` and `host_heartbeats` stayed
  empty. The placer read the coordinator's heartbeat off the published
  snapshot instead, so any stall in publishing aged the host out of its own
  placer and every scale-up was refused with `last heartbeat 923s ago` —
  a number counting up from a timestamp nothing was refreshing. The Hosts tab
  hid it by hardcoding `hostStale: false` for runners with no `hostId`. The
  beat is now taken on its own 30 s interval, independent of the collection
  loop, and `buildHostList()` takes it as `coordinatorHeartbeat`.
- **A fast tick that never settled stopped collection for the life of the
  process.** `fastInFlight` was cleared only by the task's own `.finally()`,
  so a hung tick blocked every later one — observed at 82,144 s (22.8 h) while
  `fastDeadlineMs` "fired" on the first 120 s and changed nothing: the deadline
  rejects the race, not the task. A tick past its deadline is now abandoned and
  a fresh one starts. Safe because every write is an upsert keyed by id, and the
  `fastInFlight === task` guard stops a late finisher clearing a live slot.
- **`runner_state` and `repos` were never pruned.** Neither table had a `DELETE`
  anywhere, so a runner taken off the machine and a repo that was deleted or
  renamed both kept their rows forever. Those rows feed the repo roster and the
  `runner-unused` rule, so eight deleted repos were still polled weeks later —
  a 404 each per refresh and a collector `lastError` that could never clear —
  and runners with no directory, no LaunchAgent and no process still raised
  "idle for over 7 days". Both are now pruned: runners each pass against this
  host's fleet root, repos after a week unseen by discovery. Both guarded on a
  non-empty pass, so a failed read deletes nothing.
- **A configured limit was reported as host saturation.** Any headroom refusal
  became `host-saturation` at high confidence, so a fleet with 42 of 43 runners
  idle was called saturated and told not to add the runner its queue needed.
  Count-based refusals on a host below its busy ceiling are now a distinct
  `fleet-limit` cause with the opposite advice. Busyness is read host-wide from
  the headroom result, not from the queued repo's own runners.
- **No alert existed for a host that stops reporting.** The placer refuses any
  host whose beat is over 120 s old, so a silent host silently stopped being
  placeable. Now a critical `host-stale` alert.
- **Billing usage never worked on a personal account.** The user fallback called
  the retired `/users/{user}/settings/billing/actions`, which answers `410
  Gone`; 410 was not in the expected-status list, so the probe threw on every
  tick. Both paths now use `/settings/billing/usage`, and 410 is treated as
  "unavailable" rather than an error.
- **`cancel-in-progress` set to an expression was reported as missing.**
  `${{ github.ref != 'refs/heads/main' }}` — cancel superseded PR runs, never a
  push to the default branch — is a string, not `true`, and a strict `!== true`
  test flagged the most careful spelling of the setting as the absence of it.

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
