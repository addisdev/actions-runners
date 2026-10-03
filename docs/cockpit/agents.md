# Agent sessions

An agent session that meets a red or stuck CI run tends to do what people did
before the verdict existed: read the log, decide the test is flaky or the
workflow is wrong, and change code. Most of the time the cause was the host —
the disk floor holding jobs, Spotlight starving the machine, a billing block —
and the change made things worse.

The cockpit gives a session three ways to ask the fleet first: the
[command line](cli.md), an MCP server, and a Claude Code skill that says when to
use them. All three are read-only unless a person says otherwise.

## The MCP server

`cockpit mcp` is an MCP server over stdio (newline-delimited JSON-RPC 2.0) with
no dependencies. Register it once for every project:

```bash
claude mcp add --scope user fleet-cockpit -- ~/.local/bin/cockpit mcp
claude mcp get fleet-cockpit        # Status: ✔ Connected
```

Any MCP client that can launch a stdio server can use the same command.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `fleet_status` | none | `{ verdict, counts, route, posture }`: the [verdict](verdict.md) with evidence and next move, the counts, which route answered, and the standing-risk items |
| `why_queued` | `repo` (required): name or `owner/name` | `{ verdict, runners, queue, checks, failures, incidents }` for that repo, the same as `cockpit why --json` |
| `fleet_queue` | none | The glance's `queue` array: every queued run with cause, confidence, evidence and ETA ranges |
| `wait_for_checks` | `repo` (required), one of `pr`, `sha`, `branch`; `timeout_minutes` (default 10, max 30) | A line starting `green:`, `red:` (naming the checks that did not pass), `pointless:` (with the reason) or `timeout` |

`wait_for_checks` re-reads the fleet every 20 seconds and returns as soon as the
answer is not "still waiting". `pointless` means the same as `cockpit wait`'s
exit `2`: the host is down, the disk floor is holding jobs, GitHub is refusing
jobs, or a check is queued with a cause that never clears. The session should
stop and report it, not keep waiting. The 30-minute cap keeps one tool call from
holding a session hostage; call it again for longer waits.

Every tool reads the app's snapshot when it is under 90 seconds old and
otherwise opens its own tunnel through `runner-host`, then `runner-ts`. An
unreachable dashboard comes back as an `unreachable` verdict rather than an
error, except from `why_queued` and `fleet_queue`, which have nothing to filter
and set `isError`.

### Why there are no action tools

The tools only read. Repairing, restarting, draining and cleaning up stay behind
`cockpit run <action> --yes`, which a session can only run through its shell —
where the person's permission rules see the exact command. An MCP tool that
could restart runners would be one prompt-injected log line away from doing it.

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
