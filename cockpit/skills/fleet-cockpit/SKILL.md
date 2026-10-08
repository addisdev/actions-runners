---
name: fleet-cockpit
description: Diagnose self-hosted GitHub Actions CI with the `cockpit` CLI instead of re-deriving the runner diagnostic ladder. Use whenever CI is queued, slow, stuck, red for no obvious reason, or you are about to wait on a PR's checks — before blaming a workflow, a test or the code.
---

# Fleet Cockpit

`cockpit` reads the fleet dashboard's verdict (one ordered ladder over drift, queue
causes, failure classes, admission holds and alerts) and answers from it. It reads the
menu bar app's snapshot when fresh and otherwise opens its own SSH tunnel.

## Before diagnosing CI

```bash
cockpit why <repo>          # runners, queue with cause + ETA, failures, alerts for one repo
cockpit status              # the whole-fleet verdict
```

Read the verdict before anything else. It is ordered so the first rung makes the others
meaningless:

| Verdict | Meaning | Do |
|---|---|---|
| `host-down` / `blind` | host asleep, rebooted with nobody logged in, or this Mac offline | stop; tell the user — only a person can wake the host |
| `disk-floor` | jobs held at "Set up runner" because disk is under the floor; looks like load | tell the user; cleanup is theirs to approve |
| `dead-service` | a runner service died; launchd will not revive it | `cockpit run fleet.healthRepair --yes` only if the user allowed repairs |
| `saturated` | jobs lost contact mid-step: host starvation, not code | do not re-run or "fix" the test; wait or tell the user |
| `account-blocked` | GitHub refused jobs (billing) or a storage quota is full | not the code; tell the user |
| `config-drift` | labels match no runner / repo unserved | fix `runs-on:` or ask for a runner |
| `waiting` | queued behind a busy runner; a queue is not a stall | wait (below) |
| `clear` | nothing wrong | the failure is likely real |

A failed run marked **not your code** (`runner-lost`, `account-blocked`, `account-quota`,
`no-runner`) was the host's or the account's doing. Do not change code to fix it.

## Waiting on checks

```bash
cockpit wait <repo> --pr <n> [--timeout 45m]
```

Exit codes: `0` green, `1` red (failed checks listed), `2` waiting is pointless (host
down, disk floor, billing block, or a check queued with a cause that never clears) — stop
and report the reason, `3` timed out or nothing readable. Prefer this to
`gh pr checks --watch`, which waits forever on a check that will never start. `--pr`
judges the PR's head commit only, so a red from a commit you pushed over (or force-pushed
off) does not end the wait.
With `--pr` it also asks GitHub directly when cockpit's view is stale (a stalled
collector), so it returns when GitHub's checks finish; a result marked `(from GitHub; …)`
means cockpit's own view had frozen — mention it, it is a daemon problem, not your PR's.
"Collector stalled" from `status`/`why` means the same: the rows on screen are old.

## When the dashboard itself does not answer

```bash
cockpit sentinel            # SSH reachability, GitHub's view of the host's runners, another machine
```

## Rules

- Never run an action that changes the fleet (`--yes`) unless the user asked for it.
- `cockpit brief` prints a markdown incident brief to paste into a report.
- Everything supports `--json`.
