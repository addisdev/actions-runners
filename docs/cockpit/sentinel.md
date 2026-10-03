# Host sentinel

The cockpit can only watch while the Mac it runs on is awake. The one failure
nothing on the runner host can report is the host itself being gone — asleep,
off, or rebooted with nobody logged in (runner LaunchAgents start at login, so a
reboot while nobody is home strands every one of them). The dashboard, its
watchdog and its phone push all go down with it.

`scripts/host-sentinel.sh` runs on **a second machine in the same house** — a
Mac mini, say — once a minute, and sends one message to
[ntfy](https://ntfy.sh) when the host stops answering and one when it comes
back, with how long it was gone:

| Title | Body | Priority |
|---|---|---|
| **runner-host is down** | Has not answered for 3 minutes. Asleep, off, or rebooted with nobody logged in — runners start at login. Only someone there can wake it. | urgent |
| **runner-host is back** | Answers again after 23 min. Queued jobs start on their own; dead services may need a repair. | default |

Messages carry the host's name and nothing else about the fleet.

## Set it up

On the other machine, with a clone of this repository:

1. **Pick a topic.** On ntfy.sh anyone who knows a topic can read it, so the
   topic name is the secret. Make it random.
2. **Write the config** (mode `0600`):

    ```bash
    printf '%s\n' 'SENTINEL_NAME=runner-host' 'SENTINEL_TARGET=runner' \
      "SENTINEL_NTFY=https://ntfy.sh/fleet-$(openssl rand -hex 12)" > ~/.config/fleet-sentinel.env
    chmod 600 ~/.config/fleet-sentinel.env
    cat ~/.config/fleet-sentinel.env        # note the topic URL
    ```

3. **Subscribe** to that topic URL in the ntfy app on your phone.
4. **Test delivery**, then install:

    ```bash
    scripts/host-sentinel.sh --test-notify
    scripts/host-sentinel.sh --install
    ```

`--install` writes a LaunchAgent that runs the probe every 60 seconds and loads
it. `--uninstall` unloads and removes it.

## Configuration

`~/.config/fleet-sentinel.env` is sourced as shell; set `SENTINEL_ENV` to read
another file.

| Variable | Default | Meaning |
|---|---|---|
| `SENTINEL_NAME` | `runner-host` | What the messages call the host |
| `SENTINEL_TARGET` | `runner` | Tailnet name or IP to probe |
| `SENTINEL_PROBE` | `tailscale` | `tailscale` (`tailscale ping` over the tailnet) or `tcp` (`nc -z <target> 22`) |
| `SENTINEL_TAILSCALE` | `/opt/homebrew/opt/tailscale/bin/tailscale` | The `tailscale` binary |
| `SENTINEL_TS_SOCKET` | empty | `--socket` for a userspace `tailscaled` |
| `SENTINEL_NTFY` | empty | The topic URL. Empty means log what would have been sent, send nothing |
| `SENTINEL_FAILS` | `3` | Consecutive failed probes before announcing |
| `SENTINEL_STATE` | `~/.fleet-sentinel.state` | Where it remembers up/down and since when |
| `SENTINEL_LABEL` | `com.runner-fleet.host-sentinel` | The LaunchAgent's label |
| `SENTINEL_LOG` | `~/Library/Logs/fleet-host-sentinel.log` | Its log |

## Choosing a probe

- **`tailscale`** asks the tailnet whether the host answers. It works from
  anywhere on the tailnet, and with a userspace `tailscaled` (no system
  extension, typical on a headless mini) through `SENTINEL_TS_SOCKET`. A
  `tailscale ping` that succeeds proves the host's network stack is up.
- **`tcp`** checks port 22 on the LAN. Simpler, but it needs the two machines on
  routes where the sentinel can reach the host — on a home network where only
  one side can open connections to the other, run the sentinel on the side that
  can.

Three failed probes in a row (three minutes, by default) before announcing
keeps a Wi-Fi blip or a quick reboot from paging you.

## What it does not do

It says the host is not answering; it does not say why. For that, open the
cockpit, which runs the full [out-of-band check](verdict.md#when-the-dashboard-does-not-answer)
(rebooted with nobody logged in, asleep, network or power out), or run
`cockpit sentinel` from any Mac that can reach the host.

## Testing it

`scripts/test-sentinel.sh` runs the probe through its transitions with the
probe and delivery replaced by commands (`SENTINEL_PROBE_CMD`,
`SENTINEL_NOTIFY_CMD`), so it needs no network. CI runs it on every push.
