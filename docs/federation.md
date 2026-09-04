# Federation (Multiple Macs)

Federation lets the dashboard coordinate runners across several Macs. Each
extra Mac runs a lightweight agent (`agent.js`) that reports outbound to the
coordinator — no inbound port is needed on agent hosts.

## Architecture

```
Mac A (coordinator)          Mac B (agent)           Mac C (agent)
┌──────────────────┐         ┌───────────────┐       ┌───────────────┐
│ fleetd.js        │         │ agent.js      │       │ agent.js      │
│ fleet.db         │ ◄──────── POST /heartbeat│       │               │
│ dashboard UI     │         │               │       │               │
│                  │ ──────── commands ───────►       │               │
└──────────────────┘         └───────────────┘       └───────────────┘
```

The coordinator never initiates a connection. Agents poll on their heartbeat
interval and receive any pending commands in the response.

## Setting up an agent

On the agent Mac:

```bash
# One-time: copy the repo
git clone https://github.com/addisdev/actions-runners.git ~/actions-runners
cd ~/actions-runners

# Get the agent token from the coordinator
ssh user@coordinator-mac 'cd ~/actions-runners/dashboard && ./fleetctl.sh token'
# Use this token as FLEET_AGENT_TOKEN
```

Start the agent:

```bash
FLEET_COORDINATOR=http://coordinator-mac:7878 \
FLEET_AGENT_TOKEN=<token-from-above> \
FLEET_HOST_NAME=mac-studio \
  node dashboard/agent.js
```

The coordinator must be reachable at the URL you give. By default the
coordinator binds to loopback — set `FLEET_HOST=0.0.0.0` in its
`fleet.env` to listen on the LAN.

## Making the agent persistent

Install as a LaunchAgent on the agent Mac:

```bash
# Save to ~/Library/LaunchAgents/com.runner-fleet.agent.plist
# See examples/launchd-agent.plist for a template
launchctl load ~/Library/LaunchAgents/com.runner-fleet.agent.plist
```

## Capacity limits

The agent computes headroom on its own machine (only the host knows its load
and disk at the moment it matters) and reports the result to the coordinator.
Configure the gates with environment variables on the agent:

```bash
FLEET_MAX_TOTAL_RUNNERS=8    # cap on runners this host may hold
FLEET_CEILING=3              # do not add while this many jobs are running
FLEET_LOAD_PER_CORE=0.7      # do not add above this load/core ratio
FLEET_MIN_FREE_DISK_GB=20    # do not add below this free disk threshold
```

These match the coordinator's variable names. If you add more agents, set
them per-host to match each machine's capacity.

## Remote commands

Commands from the coordinator to an agent are **opt-in**. An agent that joins
a fleet without enabling commands cannot be asked to do anything:

```bash
FLEET_AGENT_ALLOW_COMMANDS=1 \
  node dashboard/agent.js
```

With commands enabled, the coordinator can:
- `runner.drain` / `runner.resume` — drain or resume a specific runner
- `health.check` — run `health.sh` on the remote host

Deregistration is deliberately **not** in the agent command list. It is
irreversible, and a coordinator bug that deregistered a fleet would be a bad
afternoon. The host decides.

## Authentication

The agent authenticates to the coordinator with `FLEET_AGENT_TOKEN`. This is
a separate token from the browser control token, so agent credentials can be
rotated without invalidating browser sessions.

If you have not set a separate agent token file on the coordinator
(`FLEET_AGENT_TOKEN_FILE`), the coordinator falls back to the browser control
token. For a single-host setup this is fine; for a multi-host setup, use a
separate token so that compromising an agent host does not grant browser
control-plane access.

```bash
# On the coordinator: create a separate agent token
openssl rand -hex 32 > ~/actions-runners/dashboard/.fleet-agent-token
chmod 600 ~/actions-runners/dashboard/.fleet-agent-token
# Restart the coordinator daemon
cd ~/actions-runners/dashboard && ./fleetctl.sh restart
# Print the new agent token for use on each agent Mac
cat ~/actions-runners/dashboard/.fleet-agent-token
```

## Placement

When the autoscaler decides to add a runner, it uses the placement module to
choose which host should receive it. The scoring considers:

- Free runner slots (`maxTotalRunners` minus current runner count)
- Load per core (lower is better)
- Repo locality (prefer a host already running that repo)
- Heartbeat age (stale hosts are excluded)
- Host drain state (drained hosts are excluded)

The Hosts tab shows placement decisions for recent autoscale events.

## Taking a host out of rotation

```bash
# On the agent host:
echo drained > ~/actions-runners/.drain     # stops placement choosing this host
rm ~/actions-runners/.drain                 # back in rotation
```

The agent reports drain state on its next heartbeat. Existing runners keep
working; only placement is affected.

## Troubleshooting federation

**Agent appears offline in the Hosts tab:**
- Check that the coordinator's `FLEET_HOST` is not loopback (set
  `FLEET_HOST=0.0.0.0`)
- Confirm the agent can reach the coordinator: `curl http://coordinator-mac:7878/api/state`
- Check `FLEET_AGENT_TOKEN` matches on both ends

**Commands not reaching the agent:**
- Confirm `FLEET_AGENT_ALLOW_COMMANDS=1` is set on the agent
- Check that the agent's token is correct (the heartbeat would have failed
  with 401/403 and the agent logs would show it)

**Placement always choosing the coordinator host:**
- Confirm remote agents are reporting capacity correctly
- Check the coordinator's Hosts tab — stale heartbeats are marked orange
