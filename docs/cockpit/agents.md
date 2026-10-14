# Agent sessions

An agent session that meets a red or stuck CI run tends to do what people did
before the verdict existed: read the log, decide the test is flaky or the
workflow is wrong, and change code. Most of the time the cause was the host —
the disk floor holding jobs, Spotlight starving the machine, a billing block —
and the change made things worse.

The cockpit gives a session three ways to ask the fleet first: the
[command line](cli.md), an MCP server, and a Claude Code skill that says when to
use them. All three are read-only unless a person gives them a token that may act.

## The MCP server

`cockpit mcp` carries the dashboard's own [MCP server](../api.md#mcp-mcp) over
stdio, through the same SSH tunnel as every other command. The tools, their
descriptions and their answers all come from the daemon, generated from its
`/api/v1` route table, so they can't drift from the API. Register it once for
every project:

```bash
claude mcp add --scope user fleet-cockpit -- ~/.local/bin/cockpit mcp
claude mcp get fleet-cockpit        # Status: ✔ Connected
```

Any MCP client that can launch a stdio server can use the same command. On the
host itself, or through an SSH forward of port 7878, a client can talk to
`http://localhost:7878/mcp` directly instead.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `fleet_status` | none | The [verdict](verdict.md) with evidence and next move, the counts, standing risks and how fresh the view is |
| `diagnose_repo` | `repo` as `owner/name` | The repo's runners, queue with causes and ETAs, runs, checks, failures (marked `notYourCode`), orphaned jobs and incidents; the same as `cockpit why --json` |
| `wait_for_checks` | `repo`; one of `pr`, `sha`, `branch`; `wait` seconds (0 to 300) | `state`: `green`, `red` (with the failed runs), `pending` (ask again) or `pointless` (with `reason`, and `orphans` with their recovery commands) |
| `list_queue`, `list_orphans`, `list_runners`, `list_hosts`, `list_actions` | optional filters | `{ items }` |
| `run_action` | `id`, `args`, then `confirm` | A preview with a confirm token, then the result. Refused without a token (below) |

`wait_for_checks` is `cockpit wait`'s question: the daemon holds the call until
the checks finish or `wait` runs out, judges a PR by its head commit, checks a
red against the run's latest attempt, and asks GitHub when its own view is
behind. `pointless` means the same as `cockpit wait`'s exit `2`. The host is
down, the disk floor is holding jobs, GitHub is refusing jobs, a check is
queued with a cause that never clears, or a job was
[orphaned by a draining runner](cli.md#a-job-orphaned-by-a-draining-runner).
The session should stop and report it, not keep waiting.

A route's refusal (an unknown repo, a missing scope) comes back as a tool
result with `isError` and the error's `hint`. A dashboard that doesn't answer
comes back as a JSON-RPC error that points at `cockpit sentinel`.

### Actions need a scoped token

By default `cockpit mcp` sends no token, so every tool reads and `run_action`
is refused. The token `cockpit pair` saves holds every scope, and an agent
holding it could confirm its own preview of anything, switching a host off
included. To let a session take the low-risk actions (checks, previews, drain
and resume, re-run, cancel, orphan recovery), give it a token with only those:

```bash
# on the host
./dashboard/fleetctl.sh api-token "claude code on laptop" --scopes read,act
# where the session runs
claude mcp add --scope user fleet-cockpit -e FLEET_API_TOKEN=<token> -- ~/.local/bin/cockpit mcp
```

Every action is previewed first. The preview returns the exact command and what
it will do, and only a second call with the preview's single-use confirmation
runs it. The daemon records each run in its action log under the token's name.
Restarting, repairing, cleaning up and switching hosts off need `act:danger`,
which an agent token shouldn't hold; those stay behind `cockpit run <action>
--yes`, which a session can only run through its shell, where the person's
permission rules see the exact command.

## The skill

`cockpit/skills/fleet-cockpit/SKILL.md` is a Claude Code skill that teaches a
session when to reach for the tools: whenever CI is queued, slow, stuck, red for
no obvious reason, or it is about to wait on a PR's checks — before blaming a
workflow, a test or the code.

```bash
mkdir -p ~/.claude/skills && cp -R cockpit/skills/fleet-cockpit ~/.claude/skills/
```

It carries the verdict table with what a session should **do** on each rung:

| Verdict | Do |
|---|---|
| `host-down`, `blind` | Stop and tell the person: only someone at the host can wake it |
| `disk-floor` | Tell the person; the cleanup is theirs to approve |
| `dead-service` | `cockpit run fleet.healthRepair --yes`, only if the person allowed repairs |
| `saturated` | Do not re-run or "fix" the test; wait or tell the person |
| `account-blocked` | Not the code; tell the person |
| `config-drift` | Fix `runs-on:` or ask for a runner |
| `waiting` | Wait, with `cockpit wait` |
| `clear` | The failure is likely real |

and the rule that a failure marked **not your code** (`runner-lost`,
`account-blocked`, `account-quota`, `no-runner`) is never fixed by changing
code.

To make it a standing instruction rather than something a session discovers,
add a line to your global `CLAUDE.md`:

```markdown
- Before diagnosing self-hosted CI, run `cockpit why <repo>`; use `cockpit wait <repo> --pr <n>`
  instead of `gh pr checks --watch` (see the fleet-cockpit skill).
```

## The snapshot file, for your own tools

The app writes its current view to
`~/Library/Application Support/FleetCockpit/glance.json` on every update. Any
local tool can read the fleet from it without a network call. It is how the CLI,
the MCP server, the Shortcuts and other local dashboards answer in milliseconds.

```json
{
  "writtenAt": 1790781990012,
  "route": "runner-host",
  "connection": "live",
  "verdict": { "id": "waiting", "tone": "ok", "title": "Working", "...": "..." },
  "glance": { "schema": 1, "...": "the full GET /api/glance payload" }
}
```

| Field | Meaning |
|---|---|
| `writtenAt` | When the app wrote it, in epoch milliseconds |
| `route` | The SSH alias or URL that answered |
| `connection` | The app's connection state: `live`, `connecting`, `collectorStale` (the stream answers but the daemon's collector has stalled), or `reconnecting(attempt: N, error: "…")`. Match on the prefix |
| `verdict` | What the cockpit is **showing**, which may be an out-of-band verdict (`host-down`, `blind`) the glance inside cannot carry |
| `glance` | The last [`/api/glance`](../api.md#get-apiglance) payload; absent when there has never been one |

Rules for readers:

- **Check its age.** Treat `writtenAt` older than 90 seconds as a dead app and
  either connect yourself or say you do not know. Never present an old snapshot
  as the fleet's current state.
- **Read `verdict`, not `glance.verdict`.** When the host is down the glance is
  the last one the host sent, and its verdict is from before the outage.
- **Ignore what you do not know.** `glance.schema` changes only on a breaking
  change; new fields appear at any time.

The file is written atomically with mode `0600` because it names repositories
and run titles. Fixture mode never writes it.

```bash
# The verdict, if the app's view is fresh.
f=~/Library/Application\ Support/FleetCockpit/glance.json
jq -r --argjson now "$(date +%s000)" \
  'if ($now - .writtenAt) < 90000 then .verdict.title else "stale" end' "$f"
```
