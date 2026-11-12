# Promote a build box to coordinator and primary

Runbook for moving the fleet's coordinator (fleetd, `fleet.db`, tokens, the
`/artifacts/` viewer, the hand-off route) from the current host (`ultra`) to a
dedicated build box (`forge`), and making the old host a drained overflow agent.
Written 2026-11-12 from the 10-21 move (another Mac to ultra) and the generic
steps in [federation.md](../federation.md#moving-the-coordinator-to-another-mac).
Read all of it before starting; do it in one evening, at an idle moment.

## Preconditions (check each, write the answer down)

| Check | How | Must be |
|---|---|---|
| The box has run as an agent for a day at heavy 4 or more | `cockpit status`, admission log by host | no `runner-lost` / `host-broken` on a box runner |
| Toolchain parity | `scripts/host-manifest.sh --diff ultra` on the box | hardware lines only |
| Same fleet code on both | `git -C ~/actions-runners rev-parse HEAD` on each | the same commit |
| The box can read GitHub | `gh auth status` on the box, in its desktop session (fleetd runs `gh auth token` under launchd) | logged in (owner's hands, day 0) |
| The box reaches ultra and ultra reaches the box | `curl -s http://<box>:7878/api/health` from ultra after step 4; `ssh ultra true` from the box | both answer |
| An ssh key from ultra to the box for artifact pushes | `ssh -o BatchMode=yes <box> true` from ultra | answers |
| Idle | `cockpit status`: 0 running. If the fleet never goes idle, a busy move is safe: hooks fall back to GitHub while fleetd is down (10-09), but say so in the log | 0 running, or an owner-approved busy move |

## What points at the coordinator today

Every row is something to repoint in step 5. "Moves" means the thing itself
moves to the box; "repoint" means it stays and its target changes.

| Thing | Where | Today | Action |
|---|---|---|---|
| fleetd (LaunchAgent `<prefix>.fleet-dashboard`) | ultra `~/actions-runners/dashboard` | `127.0.0.1:7878`, replica `ultra` | moves |
| `fleet.db` (runs, jobs, admission, settings incl. `maxTotalRunners` 140, autoscale on) | `dashboard/fleet.db` | WAL mode | moves, by `fleetctl.sh backup` (sqlite `.backup`), never `cp` |
| Tokens | `dashboard/.fleet-token`, `.fleet-device-tokens.json`, `.fleet-agent-tokens.json`, `.fleet-vapid.json`, `.fleet-oauth-clients.json` | mode 600 | move; paired devices keep working with a new URL |
| Alerts | `dashboard/alerts.config.json` | ntfy topic inside | moves |
| State | `dashboard/state/` (`billing-guard.json`, `checks.json`) | written by fleetd | moves; the billing guard needs `gh auth refresh -s user` on the box |
| The watchdog (`<prefix>.fleet-watch`) | ultra | watches local fleetd | install on the box (`dashboard/watch/watchctl.sh install`); uninstall on ultra |
| `/artifacts/` viewer and PR gallery links | fleetd serves `~/ci-artifacts` of its own host | ultra's disk | follows fleetd; set `FLEET_CI_ARTIFACTS_PUSH_TO=<box>:ci-artifacts` on ultra |
| Hand-off route (`handoff` label) | GitHub runner labels | ultra's runners | `scripts/handoff-label.sh` add on the box, then remove on ultra (step 6) |
| Each host's `FLEET_ADMIT_STATUS_URL` | both `fleet.env` | ultra: `http://127.0.0.1:7878/api/run-status` | the box: its own loopback; ultra: `http://<box>:7878/api/run-status` |
| Fleet Cockpit app, CLI and MCP | laptop; ssh tunnel aliases default `ultra`, `ultra-ts` (`cockpit/Sources/CockpitCore/Transport.swift`) | ultra | `--via <box>` for the CLI and the MCP registration now; a Cockpit PR for the default aliases; the CLI token file is per alias (`cli:<alias>`): pair again or copy it under the new alias |
| Host sentinel on the Mini | `~/.config/fleet-sentinel.env` (`SENTINEL_TARGET`, `SENTINEL_NAME`) | ultra | a second target for the box (B2), then make the box the primary target |
| The household lake's fleet ingest | reads `fleet.db` from the coordinator's disk on ultra | local file | repoint to a copy pulled from the box, or ingest over `/api/v1`; decide before the move, it is the slowest to change |
| The homelab map's claims and checks | the map's claims for fleetd `:7878`, the fleet's `checks.json` | ultra | update the claims; the box's collector already exists from B2 |
| `ultra-ops restart fleetd` | `~/harness/bin/ultra-ops` on ultra | restarts ultra's fleetd | after the move ultra runs the agent; the command must refuse or target the agent |
| Load Warden's fleet hosts | laptop config | `ultra-ts` | add the box |
| Tiers | ultra `fleet.env` | `FLEET_TIERS_MODE=off` | on the box: `FLEET_TIERS_PRIMARY_HOST=<box>`, `FLEET_TIERS_STANDBY_HOSTS=ultra`, `observe` for a day, then `enforce` |
| Night cap | ultra `fleet.env` `FLEET_NIGHT_CAP_MODE=enforce` | coordinator host only | off on the box; ultra is protected by being drained overflow |

Not the CI fleet, do not move: `<prefix>.fleet`, `.fleet-phone`,
`.fleet-lan-forward` and `.fleet-backup` (`~/backup-brain.sh`) are the device lab
(its brain, executor and backups), which share the `fleet` name only.

## Steps

1. **Freeze.** Note `cockpit status` and the pid start time of ultra's fleetd.
   Pause gui-watch on ultra if console work is planned (`touch ~/.ultra/gui-watch.pause`).
2. **Back up on ultra.** `./dashboard/fleetctl.sh backup`; copy the backup and every
   file in the "moves" rows above into one folder; keep `fleet.env` as
   `fleet.env.bak-<date>-promote`.
3. **Stop the coordinator on ultra.** `./dashboard/fleetctl.sh uninstall` (the
   LaunchAgent, not the runners). Runners keep taking jobs; hooks fall back to
   GitHub for cancellation checks while no daemon answers.
4. **Start it on the box.** Copy the folder into the box's `dashboard/` (the backup as
   `fleet.db`); stop the box's agent (`./dashboard/agentctl.sh uninstall`); in its
   `fleet.env` set `FLEET_HOST=127.0.0.1`, `FLEET_PORT=7878`, `FLEET_REPLICA_ID=<box>`,
   `FLEET_ALLOWED_HOSTS` (the box's names and addresses plus ultra's), tiers in
   `observe`, no night cap; `./install.sh coordinator`. Check `/api/health` and that
   `/api/settings` shows the copied values (`maxTotalRunners` is a stored setting
   and counts only the coordinator's own runners).
5. **Make ultra an agent.** On the box: `./dashboard/fleetctl.sh agent-token --host ultra`.
   On ultra: save it to `FLEET_AGENT_TOKEN_FILE` (mode 600); seed the admission
   offset from the handed-over database
   (`sqlite3 fleet.db "SELECT value FROM meta WHERE key='admission_log_offset'" > dashboard/.fleet-agent-admission-offset`);
   `FLEET_COORDINATOR=http://<box>:7878`, `FLEET_ADMIT_STATUS_URL=http://<box>:7878/api/run-status`;
   agent commands limited to `runner.drain,runner.resume,tiers.drain,tiers.resume`;
   overflow caps heavy 2, light 8, total 10, simulator 1; `FLEET_CI_ARTIFACTS_PUSH_TO=<box>:ci-artifacts`;
   `./install.sh agent`. Then repoint every row in the table.
6. **Move the hand-off route.** `FLEET_HOST_LABELS` on the box gains `handoff`;
   `scripts/handoff-label.sh --host <box> --repos <hand-off repos> --apply`, then
   `--host ultra ... --remove --apply`. Between the two, hand-off jobs may land on
   either host: do it while none is queued.
7. **Prove it.** A queued burst wakes ultra's runners and they drain again after
   ten quiet minutes (tiers decision log); `cockpit status --via <box>` reads from
   the box; one hand-off run green with every job on the box; one ultra job's
   folder appears under the box's `/artifacts/`; stop fleetd on the box once and
   check that jobs keep running and one alert pages.
8. **A day later:** tiers `enforce`. Record the move in the plan's status table.

## Rollback (same evening)

Stop fleetd on the box (`fleetctl.sh uninstall`), start the box's agent again;
on ultra restore `fleet.env.bak-<date>-promote`, copy `fleet.db` back from the
box with `fleetctl.sh backup` there (it holds the evening's rows), `./install.sh
coordinator`; tiers off; caps back to heavy 4; hand-off label back on ultra
(add there first, then remove from the box). Repoint the table's rows back.

## Tiers with the hand-off label (decide before step 8)

`dashboard/lib/tiers.js` counts a standby runner as a primary runner's twin only
when it carries at least the same labels. After step 6 the box's runners carry
`handoff` and ultra's do not, so at cap the box's self-drain finds no twins and
never sheds work to ultra; overflow still wakes for queued runs. Either accept
that (overflow by queue only) or teach the twin check to ignore host-only labels
while the primary keeps at least one online runner with them. Tests for the
coordinator-primary plus agent-standby topology: `node --test test/tiers.test.js`
in `dashboard/` (all pass on 2026-11-12).
