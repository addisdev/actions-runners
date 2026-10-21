---
name: fleet-cockpit
description: Diagnose self-hosted GitHub Actions CI by asking the runner fleet's dashboard — through its MCP tools, the `fleet` command or the `cockpit` command — instead of re-deriving the runner diagnostic ladder. Use whenever CI is queued, slow, stuck, red for no obvious reason, or you are about to wait on a PR's checks, before blaming a workflow, a test or the code.
---

# Runner fleet

The fleet dashboard reads every runner, queue, failure and admission hold and
orders them into one verdict. Ask it instead of rebuilding that from `gh`.
Every way in asks the same API (`/api/v1`), so the answers match; use whichever
this session has.

<!-- generated:surfaces -->
| Way in | Fleet verdict | One repository | Wait on a PR | Run an action |
|---|---|---|---|---|
| MCP tools | `fleet_status` | `diagnose_repo` | `wait_for_checks` | `run_action` |
| `fleet` (Node) | `fleet status` | `fleet why owner/repo` | `fleet wait owner/repo --pr N` | `fleet run <action>` |
| `cockpit` (macOS) | `cockpit status` | `cockpit why owner/repo` | `cockpit wait owner/repo --pr N` | `cockpit run <action>` |
<!-- /generated:surfaces -->

`fleet` talks to `FLEET_URL` (default `http://localhost:7878`) and sends
`FLEET_TOKEN` for actions. `cockpit` finds the dashboard itself, from the menu
bar app's snapshot or its own SSH tunnel. `fleet` prints JSON; `cockpit` takes
`--json`.

## Order

<!-- generated:order -->
1. `fleet status` or `cockpit status`: the whole-fleet verdict. Read it before anything else.
2. `fleet why owner/repo` or `cockpit why owner/repo`: one repository's runners, queue with cause and ETA, recent failures, orphaned jobs and checks.
3. `fleet wait owner/repo --pr N` or `cockpit wait owner/repo --pr N`: wait on a PR's checks until green, red, or pointless.
<!-- /generated:order -->

## Verdicts

The ladder is ordered so that the first rung makes the ones below it meaningless.

<!-- generated:verdicts -->
| Verdict | Meaning | Do |
|---|---|---|
| `unknown` | the dashboard has not read GitHub yet, or cannot | wait a minute and ask again; if it persists, tell the user — nothing it shows is current |
| `host-down` | the host is asleep, rebooted with nobody logged in, or offline (`blind`: this machine is offline) | stop and tell the user; only a person can wake the host |
| `disk-floor` | jobs held at "Set up runner" because free disk is under the floor; it looks like load | tell the user; cleanup is theirs to approve |
| `dead-service` | a runner service died and launchd will not revive it | tell the user; run the `fleet.healthRepair` action only if they ask |
| `shm-low` | the host's shared memory table is (nearly) full; Postgres suites fail with `could not create shared memory segment: No space left on device` | not the code: do not "fix" the test; tell the user and re-run once there is room |
| `saturated` | jobs lost contact mid-step: host starvation, not code | do not re-run or "fix" the test; wait, or tell the user |
| `account-blocked` | GitHub refused jobs (billing) or a storage quota is full | not the code; tell the user |
| `config-drift` | a workflow's labels match no runner, or a repo has none | fix `runs-on:` or ask the user for a runner |
| `waiting` | queued behind a busy runner; a queue is not a stall | wait on the checks |
| `clear` | nothing wrong with the fleet | the failure is probably real; read its log |
<!-- /generated:verdicts -->

## Waiting on checks

A wait ends in one of four states. The command lines exit with the code in
brackets:

- **green** (0).
- **red** (1), with the failed checks listed. Only the PR's head commit
  counts, so a red from a commit you pushed over does not end the wait.
  Cancelled is red.
- **pointless** (2): waiting cannot end well. The host is down, the disk floor
  is holding jobs, GitHub is refusing jobs, a check is queued for a reason that
  never clears, or a job was orphaned. Stop and report the reason.
- **pending** (3): time ran out. Over MCP, `wait_for_checks` holds the call up
  to `wait` seconds and then says `pending`; call it again.

**Orphaned by a draining runner, not your code.** The job passed every step,
then its runner stopped before reporting, so GitHub keeps it in progress
forever and `gh run cancel` does nothing. Each orphan lists its recovery: a
force-cancel, then a re-run. For the PR you are waiting on,
`cockpit wait owner/repo --pr N --recover` or the `run.recoverOrphan` action
runs both.

`cockpit wait --pr` also asks GitHub directly when the dashboard is unreachable
or stale. A result marked `(from GitHub; …)` means the dashboard's view had
frozen; mention it.

## Rules

<!-- generated:rules -->
- Never watch checks with `gh pr checks --watch` or a `gh run view` loop: it waits forever on a check that will never start. Use `fleet wait owner/repo --pr N`, which says when waiting is pointless and why.
- Never change code or tests for a failure marked not your code (`notYourCode`: `runner-lost`, `host-broken`, `account-blocked`, `account-quota`, `no-runner`, `admission-hold`) or for an orphaned job whose work passed (`workPassed`). The host or the account caused it.
- Never cancel or force-cancel runs other than the PR you are waiting on, and never cancel fleet-wide: those runs are other sessions' work. Recover only your own PR's orphan.
- Actions (`fleet run <action>` or `cockpit run <action>`) preview first. Show the user the preview, and confirm (`--yes`) only an action they asked for. If the token lacks the scope (`insufficient_scope`), report it; do not look for another token.
- A stale view (`freshness.stale`, "Collector stalled") is the dashboard's problem, not the PR's: say so.
<!-- /generated:rules -->

## When the dashboard does not answer

- `cockpit sentinel` checks SSH reachability, GitHub's view of the host's
  runners, and another machine.
- `fleet` reports `unreachable`: check `FLEET_URL`, or forward the port with
  `ssh -L 7878:localhost:7878 <runner host alias>`.
- `cockpit brief` prints a markdown incident brief to paste into a report.
