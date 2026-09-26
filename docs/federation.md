# Federation (Multiple Macs)

Federation lets the dashboard coordinate runners across several Macs. Each
extra Mac runs a lightweight agent (`agent.js`) that reports outbound to the
coordinator — no inbound port is needed on agent hosts.

## Architecture

```
GitHub Actions
    │  dispatches jobs by runs-on labels
    ▼
Runner Host A (coordinator)   Runner Host B (agent)
  fleetd.js ──────────────── agent.js
  SQLite (decisions)               │
       ▲                           │ heartbeat (outbound)
       └─────── commands in ───────┘
                heartbeat response
```

The coordinator is the single SQLite writer and placement authority. Agents
report outbound-only; the coordinator pushes commands back in the heartbeat
response. Agents never listen for connections.

**GitHub remains the job scheduler.** The fleet coordinates *where matching
runner capacity is created* based on availability and capabilities. Individual
jobs are dispatched by GitHub's own `runs-on:` matching — the fleet does not
intercept or queue them.

## Rollout stages

Start conservatively and expand permissions as trust builds:

| Stage | FLEET_AGENT_ALLOW_COMMANDS | FLEET_AGENT_ALLOW_REGISTER | Effect |
|---|---|---|---|
| 1. Reporting only | 0 | 0 | Agent sends heartbeats, appears in Hosts tab |
| 2. Drain/resume | 1 | 0 | Coordinator can drain or resume runners remotely |
| 3. Remote provisioning | 1 | 1 | Coordinator can register new runners via autoscaling |

Remote deregistration is a fourth, separately destructive opt-in:
`FLEET_AGENT_ALLOW_DEREGISTER=1`.

## Quick start

### 1. Coordinator: open the bind address

By default the coordinator binds to loopback. To accept agent heartbeats, add
to `fleet.env`:

```bash
FLEET_HOST=0.0.0.0   # or your LAN IP; see Security below
```

Then restart the coordinator:

```bash
cd ~/actions-runners/dashboard && ./fleetctl.sh restart
```

### 2. Coordinator: generate an agent token

```bash
cd ~/actions-runners/dashboard
./fleetctl.sh agent-token --host mac-studio-1
# Copy the token it prints to that host's fleet.env.
```

### 3. Agent Mac: clone and configure

```bash
git clone https://github.com/your-org/actions-runners.git ~/actions-runners
cd ~/actions-runners
cp examples/fleet.env.federated-agent fleet.env
# Edit fleet.env — set coordinator(s), token, stable host ID, and display name
```

```bash
# Minimum required in fleet.env:
FLEET_COORDINATOR=http://coordinator-mac:7878
FLEET_AGENT_TOKEN=<token from step 2>
FLEET_HOST_ID=mac-studio-1
FLEET_HOST_NAME=mac-studio-1
```

`FLEET_HOST_ID` is the stable command-routing and token-scope key. It must match
the value passed to `agent-token --host` and should not change when you rename
the display-only `FLEET_HOST_NAME`.

### 4. Agent Mac: install and start

```bash
./install.sh agent
```

The agent appears in the Hosts tab within one heartbeat interval (default 30 s).

### 5. (Optional) Enable remote commands

To allow the coordinator to drain/resume runners on the agent:

```bash
# In fleet.env on the agent:
FLEET_AGENT_ALLOW_COMMANDS=1
./dashboard/agentctl.sh restart
```

To also allow the coordinator to provision new runners via autoscaling:

```bash
# In fleet.env on the agent:
FLEET_AGENT_ALLOW_COMMANDS=1
FLEET_AGENT_ALLOW_REGISTER=1
./dashboard/agentctl.sh restart
```

## Capability labels

Labels declared in `FLEET_HOST_LABELS` are used by the placement engine to
route scale-up decisions to hosts that can serve the job. A host without a
required label is skipped with a visible reason.

```bash
# In fleet.env on the coordinator or agent:
FLEET_HOST_LABELS=xcode-16,macos-15

# In the runner registration:
./register.sh owner/ios-app xcode-16
```

A queued workflow that needs `xcode-16` will be placed on a host that declares
it. A host without the label gets a `missing required labels` refusal in the
placement_decisions table.

## Placement decisions

Every autoscale event is audited. The coordinator records the chosen host, the
reason, and every considered-but-refused host. The Hosts tab surfaces recent
decisions and their outcomes.

To query the audit log directly:

```bash
sqlite3 dashboard/fleet.db \
  "SELECT ts, repo, host_id, reason, dry_run FROM placement_decisions ORDER BY ts DESC LIMIT 10"
```

To query pending and in-flight commands:

```bash
sqlite3 dashboard/fleet.db \
  "SELECT host_id, action, status, ts FROM host_commands ORDER BY ts DESC LIMIT 20"
```

## Capacity limits per host

Each host computes headroom locally — the agent knows its own load, disk, and
runner count at the moment it matters. Configure the gates in `fleet.env` on
each host:

```bash
FLEET_MAX_TOTAL_RUNNERS=8    # cap on runners this host may hold
FLEET_CEILING=3              # do not add while this many jobs are running
FLEET_LOAD_PER_CORE=2        # do not add above this load/core ratio
FLEET_MIN_FREE_DISK_GB=50    # do not add below this free disk threshold
```

## Taking a host out of rotation

```bash
# On any host (coordinator or agent):
echo drained > ~/actions-runners/.drain     # placement skips this host
rm ~/actions-runners/.drain                 # back in rotation

# The agent reports drain state on its next heartbeat.
# Existing runners keep working — only new placement is affected.
```

## Token rotation

**Agent token:**
```bash
# On the coordinator:
cd ~/actions-runners/dashboard
./fleetctl.sh agent-token --host mac-studio-1
# Running it again rotates only that host.
```
Then, on that agent Mac, update `FLEET_AGENT_TOKEN` in `fleet.env` and run
`./dashboard/agentctl.sh install` so the mode-0600 local token file is replaced.

**Control (browser) token:**
```bash
cd ~/actions-runners/dashboard
./fleetctl.sh token   # prints (creates if missing)
```

The two tokens are independent so either can be rotated without invalidating
the other.

## Failure recovery

**Coordinator restarts** do not affect existing runners. They take jobs
directly from GitHub and do not need the coordinator to be running.

**Network loss** between coordinator and agents leaves agents in their last
known state. They keep accepting jobs normally. The coordinator marks their
heartbeats stale after `STALE_HEARTBEAT_MS` (default 2 min) and excludes
them from placement.

**Command delivery failure:** if an agent processes a command but crashes
before posting the result, the coordinator marks the command `sent`. After
5 minutes with no acknowledgement, the command is reset to `pending` and
re-sent on the agent's next heartbeat. Delivery stops after three attempts and
the command is marked failed. Delivery is at-least-once, but the agent keeps an
atomic mode-0600 journal of the last 256 command results and replays a prior
result instead of executing the same command key twice.

**Retries never create duplicates:** the result journal covers every command;
`runner.register` also checks whether the runner directory already exists. The
coordinator's idempotency key prevents the same command from being queued twice
in rapid succession.

## Security

- **Never expose the coordinator port to the public internet.** Use a VPN or
  SSH tunnel for remote access.
- **LAN-only deployment:** set `FLEET_HOST=0.0.0.0` and rely on your network
  perimeter.
- **SSH tunnel:** leave `FLEET_HOST=127.0.0.1` and tunnel on agent hosts:
  ```bash
  ssh -L 7878:localhost:7878 coordinator-mac -N &
  export FLEET_COORDINATOR=http://localhost:7878
  ```
- **Token files** are stored with mode 0600. Never embed tokens in plist
  `ProgramArguments` — they appear in `ps` output.
- The agent token is **narrower** than the control token: it grants heartbeat
  delivery and command acknowledgement only, not the control-plane actions
  available in the browser. Separate them so a compromised agent does not
  grant browser-level access.

## Automatic coordinator failover

For two Macs that should both run CI and either should be able to host the
dashboard, run `fleetd` on both with the same managed PostgreSQL database and a
different `FLEET_REPLICA_ID`.

- Both Macs remain active GitHub runner hosts.
- Both serve the dashboard and shared fleet snapshot.
- PostgreSQL advisory locking allows exactly one fleetd to poll GitHub,
  autoscale, backfill, and reconcile alerts.
- The standby reports its local health, executes commands addressed to it, and
  promotes when the leader's PostgreSQL session disappears.
- Additional agents may set
  `FLEET_COORDINATORS=http://mac-a:7878,http://mac-b:7878` for endpoint failover.

This is not two independent coordinators. Independent SQLite writers would
duplicate polling and commands and split historical state. See
[Configuration](configuration.md#two-replica-high-availability) for cutover.
Do not run `agent.js` on either Mac that is already an HA `fleetd` replica;
`fleetd` performs that host-reporting and command-execution role itself.

## Troubleshooting

**Agent appears offline in the Hosts tab:**
- Check that the coordinator's `FLEET_HOST` is not loopback (set
  `FLEET_HOST=0.0.0.0`)
- Confirm the agent can reach the coordinator:
  `curl http://coordinator-mac:7878/api/health`
- Check `FLEET_AGENT_TOKEN` matches on both ends:
  `dashboard/agentctl.sh status` on the agent shows whether it is reachable

**Commands not reaching the agent:**
- Confirm `FLEET_AGENT_ALLOW_COMMANDS=1` is set and the agent was restarted
- Check agent logs: `dashboard/agentctl.sh logs`

**Remote provisioning not working:**
- Confirm `FLEET_AGENT_ALLOW_REGISTER=1` AND `FLEET_AGENT_ALLOW_COMMANDS=1`
- Confirm `register.sh` exists on the agent host (it should — it is in the repo)
- Check that the coordinator can reach the GitHub API (for registration tokens)

**Placement always choosing the coordinator host:**
- Confirm remote agents are connected: check the Hosts tab for heartbeat age
- Verify agent hosts declare capacity (`FLEET_MAX_TOTAL_RUNNERS`, `FLEET_CEILING`)
- Check `placement_decisions` for refusal reasons

**Runner registered on agent but not visible on coordinator:**
- The runner name appears in GitHub's runner list; the coordinator sees it in
  the `elsewhere` array. It is attributed to the agent host once the agent's
  next heartbeat includes it in its `runners` list.
