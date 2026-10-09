# Settings and files

## Settings

**Settings…** in the footer menu. Changes are drafted and take effect on
**Apply**; **Revert** throws the draft away. Nothing host-specific is compiled
into the app: when the runner host is replaced, it is a new alias here, not a
new build.

### Connection

| Setting | Default | Meaning |
|---|---|---|
| Reach the dashboard by | SSH tunnel | **SSH tunnel**, **Direct URL** or **Fixture (demo)** |
| SSH aliases, in order | `runner-host, runner-ts` | Aliases from `~/.ssh/config`, comma- or space-separated, tried in turn |
| Dashboard port on the host | `7878` | Where the dashboard listens on the host's loopback |
| Dashboard URL | `http://127.0.0.1:7878` | For Direct URL: a dashboard served over Tailscale Serve or bound to the LAN |
| Scenario | `live` | For Fixture: which recorded state to show |

### Control

| Setting | Default | Meaning |
|---|---|---|
| Pair this Mac / Pair again | — | Mints a code with `fleetctl.sh pair` over the first alias and stores this Mac's device token. Tunnel mode only |
| Forget token | — | Deletes the token from the Keychain; the app is read-only again |
| Fleet root on the host | `~/actions-runners` | Where pairing finds `dashboard/fleetctl.sh` |

### Notifications

| Setting | Default | Meaning |
|---|---|---|
| Notify for | Critical and warning | Or critical only |
| Quiet hours | Off | When on (22:00–07:00 by default, adjustable), only critical alerts notify. A range may cross midnight |
| Muted rules | none | Alert rule names, comma-separated, that never notify — for example `stuck-queue, runner-unused`. The rule names are on the dashboard's Alerts tab |

A [Focus filter](macos.md#focus-filter) narrows these further while a Focus is
on.

### Display

| Setting | Default | Meaning |
|---|---|---|
| Show running and queued counts in the menu bar | On | `3▸ 2◷` beside the mark |
| Compact runner dots | Off | Dots instead of pills, for a crowded fleet |
| Play a sound when a watched commit goes green | Off | For commits watched with the bell |

### System

| Setting | Meaning |
|---|---|
| Open at login | Registers the app as a login item with `SMAppService`. See [Open at login](install.md#open-at-login) |

## The connection

### SSH tunnel

For each alias in turn, the app starts:

```
/usr/bin/ssh -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o ControlMaster=no -o ControlPath=none \
  -L 127.0.0.1:<free local port>:127.0.0.1:<dashboard port> <alias> 'cat >/dev/null'
```

and uses the first whose forward answers `/api/health` within 10 seconds.

- **`BatchMode`** makes an alias that would prompt for a password fail fast
  instead of hanging the app. Key-based login only.
- **No connection sharing** (`ControlMaster=no`). A shared master connection
  from your own `~/.ssh/config` would outlive the app and keep the forward
  alive after it.
- **The tunnel cannot outlive the app.** It runs `cat` on the host, fed from a
  pipe only the app holds. However the app ends — quit, crash, `kill -9` — the
  pipe closes, `cat` sees end of file, and ssh exits. (With `-N` instead, a
  killed app left its tunnel running forever, reparented to launchd.)
- **Nothing changes on the host.** The dashboard keeps listening on loopback
  only.

### Reconnecting

The live view is a server-sent event stream (`/api/stream?view=glance`). When it
drops, the app retries with jittered exponential backoff — 1 second doubling to
a 30-second cap, ±20% — and immediately on wake from sleep and on a network
change, when waiting out the backoff would be silly. After 20 seconds of
failure it starts the [out-of-band checks](verdict.md#when-the-dashboard-does-not-answer).

A stream that answers while the daemon's collector has stopped (the glance says `stale: true` and its
`ageMs` keeps growing) shows as stale, never as current.

## Files and keys

### Written by the app

| Path | Contents |
|---|---|
| `~/Library/Application Support/FleetCockpit/glance.json` | The current view, for the CLI, MCP, Shortcuts and local tools. Mode `0600`. See [the snapshot file](agents.md#the-snapshot-file-for-your-own-tools) |
| `~/Library/Group Containers/<team>.io.github.addisdev.fleetcockpit/glance.json` | The same, for the widgets (signed builds only). macOS protects group containers from other processes: read the other copy |
| `~/Library/Preferences/io.github.addisdev.fleetcockpit.plist` | Settings (`settings.v1`, JSON), the Focus filter's level (`focus.level`), the last weekly digest sent (`digest.lastWeek`) |
| Keychain: service `io.github.addisdev.fleetcockpit` | The app's device token, available after first unlock |

### Written by the CLI

| Path | Contents |
|---|---|
| `~/Library/Application Support/FleetCockpit/cli-token-cli:<host>` | The CLI's own device token, mode `0600` |

### Defaults keys you may set

| Key | Type | Effect |
|---|---|---|
| `pending.loginItem` | Bool | Applied once at next launch through the same call as the Settings toggle, then deleted |

```bash
defaults write io.github.addisdev.fleetcockpit pending.loginItem -bool YES
```

### Logs

The app logs to the unified log under subsystem `io.github.addisdev.fleetcockpit`:

```bash
/usr/bin/log show --last 1h --info --predicate 'subsystem == "io.github.addisdev.fleetcockpit"'
```

Use the full path: zsh has a `log` builtin that shadows `/usr/bin/log`, and
without `--info` the info-level lines are left out.
