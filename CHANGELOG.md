# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not use Semantic Versioning — it uses simple sequential
version numbers (`v0.1.0`, `v0.1.1`, etc.).

## [v0.3.0] — unreleased

Portable, mobile-first dashboard.

### Added

- `scripts/join-host.sh` preflight also checks the Xcode license (`xcodebuild
  -version` answers without it, then `swiftc` exits 69 in the first job), an
  optional `FLEET_XCODE_VERSION` every host must match (a second host with an
  older Xcode builds the same job against a different SDK), and PyYAML for both
  `python3` interpreters a job can reach. All three were hit adding a second
  host.

- **Preflight checks plain CLI tools.** `preflight.sh` checked Xcode, Postgres,
  Java, node and gh but nothing a Makefile calls, so a repo's `make lint` met
  `make: shellcheck: No such file or directory` on a new host (2026-10-09).
  `scripts/cli-tools.txt` lists the tools (shellcheck, jq, make always; deno
  and ruby when a self-hosted workflow runs them, via `infer-checks.py`), and
  `scripts/check-tools.sh` looks them up on the runners' PATH. `join-host.sh`
  checks every listed tool and `--install-tools` brew-installs the missing
  ones. Preflight also warns when the runners' python3 is PEP 668 externally
  managed. Tests: `scripts/test-preflight-tools.sh`.

- **Admission decisions from every host.** An agent host's hooks log locally
  like the coordinator's, and nothing read that file, so holds on a second host
  never reached the dashboard or the admission-hold alert. The agent now ships
  the lines added since its last accepted heartbeat (`lib/admission-ship.js`,
  at-least-once, offset advanced only by the coordinator's count), and the
  coordinator stores them by host: `admission_events.host_id`, `waiting[].host`
  and `admission.byHost`. The headline mode and limit stay the coordinator's
  own. `host_samples.host_id` records which machine a vitals row describes, so
  moving the coordinator does not splice two machines' load into one history.
  Runbook: docs/federation.md, "Moving the coordinator to another Mac".

- **One-command second host.** `scripts/join-host.sh` joins a Mac to the fleet:
  preflight (including the toolchains jobs use), the agent, mirrored runners and
  the health timer, dry run unless `--apply`. `scripts/mirror-runners.sh` and
  `dashboard/lib/mirror.js` copy the coordinator's runners one per distinct
  label set, skipping what the host cannot run (a missing label, Simulator
  runners without Xcode, `FLEET_MIRROR_SKIP_REPOS`), with registration tokens
  optionally minted elsewhere (`--tokens-from`). Template:
  `examples/fleet.env.second-host`. The agent and installer accept the token
  from `FLEET_AGENT_TOKEN_FILE`. Runner pin 2.336.0 → 2.337.0.

- **Fleet verdict.** `lib/verdict.js` reduces drift, queue causes, failure
  classes, admission holds and alerts to one ordered ladder — cannot read
  GitHub, host down, disk floor, dead service, saturated, account blocked,
  config drift, waiting, clear — with evidence and one next move, plus a state
  for every runner. Published as `verdict` on `/api/state`. Checked against
  recorded incidents in `test/fixtures/scenarios.js`.
- **`GET /api/glance`** and **`/api/stream?view=glance`**: a versioned
  (`schema: 1`) ~10 KB payload for small screens and slow links, where the full
  state is ~130 KB.
- **`admission-hold` alert.** A job held by the admission disk floor opens a
  critical alert after 2 minutes — previously jobs sat at "Set up runner" with
  no error anywhere. A slot wait past `FLEET_ADMIT_MAX_WAIT_S` opens a warning.
- **`host-saturated` alert.** Two `runner-lost` jobs inside an hour — the
  signature of a starved host — open a warning while it is happening.
- `scripts/scrub-snapshot.mjs` turns a live snapshot into a committable fixture.
- **Fleet Cockpit** (`cockpit/`), a macOS menu bar client of `/api/glance`:
  verdict, per-host vitals with the disk floor drawn on the gauge, a pill per
  runner, the queue. Reaches a loopback-only dashboard through an SSH tunnel
  that dies with the app; reconnects on wake and network change; keeps a stale
  view greyed rather than green. Bundled incident fixtures, `--render` for
  screenshots, a `cockpit` CLI, and a snapshot file for other tools. See
  [docs/cockpit/](docs/cockpit/index.md).
- `scripts/make-glance-fixtures.mjs` keeps the cockpit's fixtures in step with
  the daemon (checked in CI).
- **Out-of-band sentinel** in the cockpit: when the dashboard does not answer it
  reads SSH reachability, GitHub's view of the host's runners, a runner on
  another machine and githubstatus.com against one table — host asleep, power
  or network out, rebooted with nobody logged in, every service dead, dashboard
  down with the fleet working, this Mac offline — and notifies on transitions.
  `cockpit sentinel` runs the same check from a terminal.
- The cockpit's **Why?** ladder, **Copy brief** (markdown incident brief, also
  `cockpit brief`), and **Failed in the last 2 hours** with a *not your code*
  mark. `/api/glance` gains `failures`.
- **Queue ETAs** (`lib/eta.js`): each queued run's start and finish as
  p50–p90 ranges from the job ahead of it and the workflow's history; none for
  causes that never clear. `/api/glance` gains `runs`, `recent` and the ETA
  fields.
- **Checks rollup and watches** in the cockpit: one row per commit with
  progress and time to green; a bell to be notified when it finishes.
- **Agent CLI**: `cockpit why <repo>`, `cockpit queue`, and `cockpit wait` (exit
  `2` the moment waiting is pointless), plus a Claude Code skill in
  `cockpit/skills/fleet-cockpit`.

- **Cockpit control.** Pair a Mac (device token in the Keychain, minted with
  `fleetctl.sh pair` over SSH); buttons from the action catalogue with its
  confirmation text; a runner panel with recent jobs, events and restart /
  drain / resume. Alert notifications on transitions with Repair, Dismiss
  everywhere and Snooze actions, a storm summary, critical-only mode, quiet
  hours and muted rules. `fleetcockpit://` URLs (pair, why, runner, reconnect,
  fixture). CLI: `cockpit pair`, `cockpit run <action>` (`--yes` for anything
  that changes the fleet).

- **Disk floor forecast** (`lib/disk-forecast.js`): 6 h and 72 h fits against
  the admission floor, backtested on the 2026-09-28 freeze (warned 6+ hours
  ahead); a `disk-floor-soon` alert under 12 hours.
- **`GET /api/posture`** (`lib/posture.js`): standing risks with the fix and who
  can apply it. **`GET /api/timeline`** (`lib/timeline.js`): incident intervals
  per ladder rung, today's queue vs build time, the week, flaky runners,
  sparkline samples.
- Cockpit: History panel, sparklines, standing-risks list, weekly digest,
  "What is using disk?", top CPU with a Spotlight detector (`cockpit top`),
  diagnostic bundle download.

- **Verdict banner** on the web dashboard's Fleet and Runs tabs.
- Cockpit: desktop widgets (app group snapshot), App Intents (Fleet Status, Why
  Is a Repo Queued, Repair Fleet) with Siri/Spotlight phrases, a Focus filter,
  a ⌃⌥⌘F floating panel, an incident replay window, and a sound on green.

- **Host sentinel** (`scripts/host-sentinel.sh`): from another machine, an ntfy
  message when the runner host stops answering and when it returns.
- **`cockpit mcp`**: an MCP server with `fleet_status`, `why_queued`,
  `fleet_queue` and `wait_for_checks`.
- **Release workflow** for signed, notarized cockpit builds, gated on secrets.

### Changed

- **Automated agents stay off the operator's Waiting Board.** `register.sh`
  writes `WB_SKIP=1` into each new runner's `.env`, and `autofixctl.sh install`
  sets it for the bridge, so CI jobs and the Cursor SDK fix and escalation
  agents, which load the same user-level Claude Code and Cursor hooks as
  interactive sessions, never file waits or inbox items. Existing runners need
  the line added once; `install-hooks.sh` preserves it.
- The `saturated` verdict no longer fires on a run the headroom gate is
  holding; on a busy host that is most of the day, and it is `waiting`.
- **Offline alerts: one per host outage, one per flap episode.** Three or more
  runners offline in the same tick (`offlineHostThreshold`) now open a single
  `offline-host` critical, "N of M runners offline — host unreachable or
  saturated", and every offline runner folds into it while it is open. One or
  two runners still alert on their own. Offline alerts stay open for
  `offlineDebounceMs` (15 min) after the runner reconnects and close dated at
  the reconnect, so a runner that flaps is one alert; autofix skips an alert
  that is only clearing. Replayed over the recorded intervals, 2026-09-20 goes
  from 1,284 offline alerts (264 notifications) to 21 (41).

### Fixed

- **`cockpit wait` outlived its deadline by hours.** On 2026-10-09 three
  `cockpit wait --pr` sessions (aliquant-backend #54, aliquant-web #116,
  homelab-map #11) ran 1 h 37 min with no timeout while all three PRs were
  merged and green. `sample` put each one in `-[NSConcreteTask waitUntilExit]`
  inside the GitHub cross-check, with the `gh` child already gone: `gh` had
  overrun its 20 s budget, the timer called `terminate()` while a worker sat
  in `waitUntilExit()`, and Foundation never marked the task finished (a
  stand-alone repro hangs within a few tries). The loop awaited that ask
  inline, so neither the deadline nor cockpit's own (live) stream could end
  the wait, and the wait's SSH tunnel stayed up with it. Now `Subprocess` runs
  every short-lived program without `waitUntilExit` and always answers by its
  deadline; the wait's deadline is a wall-clock timer of its own
  (`Deadline.race`), each GitHub ask has its own budget, and the CLI exits `3`
  thirty seconds past `--timeout` whatever else is happening. A stream silent
  for 75 s is torn down and its tunnel reopened, and a view with no runs for
  the PR asks GitHub at once instead of after two minutes (short `--fresh`
  retries had exited "no runs seen" on a green PR).

- Runners ran jobs with whatever PATH the shell that registered them had:
  `config.sh` copies the caller's `$PATH` into `.path`, and the runner gives
  jobs that, not `.env`'s. runner-host had six PATHs (17 runners with no
  Homebrew, nine with nvm's Node and SnowSQL from an interactive shell), and a
  second host's `python3` resolved to Homebrew's 3.14 where its twin's was
  Xcode's 3.9, which broke kit-ci there. `register.sh` writes
  `FLEET_RUNNER_PATH` into `.path` after `config.sh`; `scripts/runner-path.sh`
  aligns existing runners (idle ones only, dry run by default) and join-host's
  preflight reports drift.

- **Lint and queue-cause false positives.** The Lint tab reported an archived
  repo CRITICAL ("no runner is registered") because the roster skipped archived
  repos without recording them, so their cached workflow files lived on; files of
  deleted repos (workflow list 404) were also kept forever. Both are now dropped,
  and the lint skips archived and unknown repos. `hosted-macos` no longer fires
  on public repos (the upsert never refreshed `private`, so a repo made public
  stayed private in the table) and is info when the job's `if:` reads the repo's
  visibility. `no-cancel-in-progress` accepts an expression that reads the event
  or the ref (any other expression is info) and counts job-level concurrency;
  cached workflow files of repos gone from the roster are dropped even when the
  old name still redirects, and the upsert refreshes `name` too. Label findings on a
  job gated by `if: vars.*` are info. The queue-cause classifier matched lint
  findings per repo, so a queued `CI` run behind a busy runner was called
  `label-mismatch` because a different workflow had a finding; it now matches
  the finding's workflow file, branch and job labels (`lintFindingForRun`).

- An agent configured with `FLEET_COORDINATOR` alone reported to nobody:
  `agentctl.sh` writes both coordinator keys into the plist, the unused one
  empty, and `agent.js` read them with `??`, which takes an empty string as set.
  Found by the first real second host.

- **`health.sh` no longer goes red when GitHub does not answer.** A failed
  runner API call was read as "this runner is unhealthy", so a rate-limit or
  network blip turned the health job red for every runner at once (red in 147
  of 2617 runs on runner-host; every recent one was such a blip). It now says GitHub did not answer and still judges
  launchd; a runner missing from a real answer is reported `not-registered`
  and stays a fault. Covered by `scripts/test-health.sh`.
- **`cockpit wait` sat on a frozen view and never returned.** On 2026-10-07
  runner-host's fast loop finished its last tick about 12:32Z under load.
  fleetd publishes only after a tick, so every client kept that glance
  (greenfolio-ios PR #445 "0 of 1 done", greenfolio-android PR #280
  "instrumentation · 12 min") while keepalives held the stream open, and both
  checks went green on GitHub minutes later. The wait decided, and checked its
  deadline, only when a glance arrived, so it could neither finish nor time
  out. `WaitLoop` (CLI and MCP) runs on a timer. With `--pr` it also asks
  GitHub itself (`gh pr view --json statusCheckRollup`): every 30 s while
  cockpit's view is over 4 minutes old or the dashboard is unreachable, every
  2 minutes otherwise. GitHub's finished answer ends the wait and is labelled
  as GitHub's. An unreachable dashboard no longer ends a PR wait with exit 3.
  A view whose last tick is over 4 minutes old now reads "Collector stalled" in
  the app, `status` and `why`, instead of the old verdict. `why` also shows
  the same verdict as `status` now; it had printed the daemon's verdict even
  when the app knew the host was down.
- **The disk floor held the fleet with tens of GB to spare.** `df` counts macOS's
  purgeable caches as used, and macOS purges only under real pressure, which a
  held, idle fleet never creates: on runner-host `df` said 101 GB free while
  macOS offered 163 GB (2026-10-07). The admission floor, `cleanup.sh` and the
  dashboard now measure usable space (plain free plus purgeable,
  `hooks/free-disk.sh`) with a 15 GB hard floor on plain free
  (`FLEET_ADMIT_MIN_PLAIN_FREE_GB`). The hook tests now run the hook under
  `bash -e` as the runner does. That exposed two ways a failed disk read could
  exit the hook, whose EXIT trap then admitted the job without a slot; both are
  closed.
- **runner-host kept reaching the disk floor.** The weekly cleanup reclaimed
  1–2 GB, refused to run while any job was building, and never touched the
  largest growing thing: each runner's `ci-` simulator, 48 → 62 GB across 41
  devices in three days. `cleanup.sh --auto` now runs every 15 minutes and
  acts under a pressure line (floor + 20 GB) or once a day. It erases idle CI
  simulators over 3 GB (1 GB under pressure), under pressure removes idle
  runners' Playwright browsers, and skips only the runners that are building.
- **The fast loop stopped for good when one tick never finished.** A tick
  overran at 2026-10-06 16:31Z and every tick after it was skipped as an
  "overlap" (235 on 10-06, 1,034 on 10-07), while health read ok because
  the slow loop also runs the tick. `lib/tick-guard.js` now waits a stuck
  tick out for `FLEET_FAST_ABANDON_MS` (4 min), then abandons it and starts
  the next. At most `FLEET_FAST_MAX_ABANDONED` (3) may be outstanding;
  past that health goes not-ok. Every overrun, skip and abandon names the
  stage the tick was in, and `/api/health` reports `fastLoop`.
- **A cancelled job held by admission kept its runner for minutes.** The
  worker never signals the job-started hook, and GitHub keeps the run and the
  job `in_progress` until it force-completes the job, about four minutes later
  (measured 2026-10-07, homelab-map run 37236945666), so the run-status poll
  could not fire sooner. The hook now reads its worker's `_diag` log every
  poll and leaves as soon as the worker logs the cancel.
- **`cockpit wait --pr` read red from a commit that was no longer the PR.** It
  picked whichever of the PR's commits had the latest update, and nothing said
  which commit was the head. On taylab-launch-kit PR #79 (2026-10-03) the branch
  was force-pushed back off a failing commit, and before the daemon saw the new
  run, the wait answered "red" from the old commit. A wait on the re-pushed sha
  answered "cancelled" from that sha's first run. The glance's runs now carry
  `prHead`, the PR's head as GitHub reported it on that tick (from
  `pull_requests[].head.sha`, no extra API call). A PR's checks are the head's
  checks, and a head with no run yet is still waiting. A head whose result is
  older than a run of the same workflow on another of the PR's commits was left
  and re-pushed, so that result waits for the new run. Within a commit, the
  newest run of a workflow is now chosen by run id, not `updatedAt`: a run that
  concurrency cancelled after its replacement was created used to win.
- **Held jobs never noticed their run had ended.** Runner LaunchAgents set
  `SessionCreate`, so `gh` inside a job has no keychain token; the hook's
  cancellation poll went out anonymously and never saw `completed`. No held
  job had ever logged `cancelled`, and waits for runs that ended hours earlier
  stayed in the queue. The hook now asks the daemon first
  (`GET /api/run-status`, cached 20 s, fleet repos only), then `gh`, then
  `curl`. `FLEET_ADMIT_STATUS_URL=` (empty) skips the daemon.
- **`cleanup.sh` missed superseded runner versions.** A runner self-update
  leaves the previous `bin.<version>` and `externals.<version>` in place. At
  59 runners that was 25 GB, and it held the 40 GB disk floor shut for most of
  2026-10-05. Cleanup now removes pairs older than the linked version and
  leaves a newer, unlinked pair (an update in progress) alone.
- **Admission stalled with every slot free.** Every held job polled through the
  admission mutex, and each holder spent seconds reading the whole waiter queue
  on a loaded host, so the lock was never free and the oldest waiter, the only
  one that can be admitted, almost never won it. runner-host admitted nothing
  for a day with 40 jobs held, `busy=0` and an empty reason (2026-10-03/04). A
  waiter with a live, non-Simulator waiter ahead of it now skips the mutex.
- Job rows froze at their last in-progress snapshot. The fast loop fetches
  jobs only for active runs and the backfill only for runs with no job rows, so
  a run's final jobs never got a conclusion, `completed_at` or duration once
  the run completed — about a third of the history (5,966 rows on runner-host),
  which made every build-hours figure undercount. `lib/settle.js` re-fetches
  each such job by id: on the tick its run is first seen completed, and in a
  new backfill phase for anything missed. The job upsert also now fills
  `started_at` and `runner_id` for a job first seen queued.
  `scripts/settle-stale-jobs.mjs` clears existing history in one go.

- Runs froze too. A run that finished after it dropped off GitHub's active
  lists and its repo's newest page kept its last active status (23 on
  runner-host, back to 2026-08-06), so its jobs never qualified for settling.
  The fast tick now refreshes up to four runs a tick that are active in the
  database but unseen for 10 minutes (`RunSettler`), then settles their jobs.
- `settle-stale-jobs.mjs` read its budget from `gh api rate_limit`, which kept
  answering 5000/5000 while four workers spent the per-user quota and got the
  daemon's token penalised for ~45 minutes. It now reads each response's
  rate-limit headers, defaults to one worker and a 2500 floor, and waits out a
  primary-limit error instead of exiting.

- A public repo queued for GitHub-hosted runners read as configuration drift
  ("will never be picked up") and made `cockpit wait` give up; it is ordinary
  waiting on GitHub. Private repos asking for hosted runners still count.

- The verdict counted jobs held by the admission hook as running ("8 running"
  on a host admitting 2); only busy runners count now.
- A standing-risk check that could not run (Spotlight's `mdfind`, which takes
  ~14 s over the fleet root and timed out under load) was dropped from the
  glance, which read as fixed. The probe now has a minute, and unchecked items
  are carried and shown as "unchecked".
- Workflows on hosted macOS in public repos (free) no longer count as a
  billing risk.

- **Disk-floor deadlock.** `cleanup.sh` counted runners held by the admission
  hook as busy, so during a disk-floor freeze the held jobs stopped the one
  script that frees disk (seen live 2026-09-30). Held runners are no longer
  counted, and the dry run always runs.
- A job held while disk was under the floor kept reading as disk-held after the
  disk was freed (the hold's reason is recorded once); the verdict and the
  `admission-hold` alert now count a disk reason only while disk is still under
  the floor.

- The coordinator was listed twice in `hosts` when a heartbeat under its own id
  had been recorded (an `agent.js` run on the coordinator); once that record
  aged out it read as a second host that had stopped reporting.
- `dashboard/.fleet-vapid.json`, the web-push private key, was not ignored.

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
