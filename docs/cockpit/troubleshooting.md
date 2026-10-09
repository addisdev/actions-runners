# Troubleshooting

Problems with the cockpit itself. For problems with the fleet, read the verdict
first, then the handbook's [Troubleshooting](../troubleshooting.md).

## The popover says "Dashboard unreachable" or keeps reconnecting

Run the connection by hand, exactly as the app does:

```bash
ssh -o BatchMode=yes runner-host 'curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:7878/api/health'
```

| You see | Cause | Fix |
|---|---|---|
| `Permission denied` or a password prompt error | The alias needs a password; `BatchMode` refuses to ask | Add a key for the alias (`ssh-copy-id`), or add the key to the agent |
| `Could not resolve hostname` | The alias is not in `~/.ssh/config`, or it is a LAN-only name and you are away | Add the alias, or put a tailnet alias second in Settings |
| `000` or connection refused | The dashboard is not running | On the host: `dashboard/fleetctl.sh status`, then `restart` |
| `200` | The route works | **Reconnect now** in the footer, or `open fleetcockpit://reconnect` |

If the host itself does not answer, the cockpit says why within a minute or so
(see [out-of-band verdicts](verdict.md#when-the-dashboard-does-not-answer)), and
`cockpit sentinel` does the same from a terminal.

## The view is greyed out

The connection dropped and the cockpit is showing the last view it had, with its
age. That is deliberate: it never stays green on a dead connection. It clears by
itself when the stream comes back; **Reconnect now** skips the wait.

If it reads **Collector stalled** while connected, the dashboard answers but its
collector has not finished a tick for over 4 minutes — usually a saturated host
(`cockpit top`). The rows on screen are old. `cockpit wait --pr` still works
through it by asking GitHub. If it persists with the host idle, check the
dashboard's log on the host.

## Pairing fails

- **"could not get a pairing code"**: pairing runs
  `cd <fleet root>/dashboard && ./fleetctl.sh pair` over your **first** alias.
  Check **Fleet root on the host** in Settings (or `--fleet-root` for the CLI),
  and that the first alias is one that works.
- **The Pair button is disabled**: pairing needs the SSH tunnel mode and a live
  connection.
- **Paired, but actions fail with an authorization error**: the token was
  revoked on the host (`./fleetctl.sh devices` no longer lists it). **Pair
  again**.

## A `fleetcockpit://` link opens an old build, or nothing

LaunchServices routes the scheme to whichever registered copy it prefers, and
every Xcode build registers its DerivedData copy; it also ignores apps under
`/private/tmp`. Install to `/Applications` and unregister the strays — the
command is under [Install the app](install.md#install-the-app).

## Widgets are empty or say "No current view"

| Widget shows | Cause |
|---|---|
| Empty, or a sample fleet | The build has no team, so no app group. Sign with a team in `Local.xcconfig` ([signing](install.md#build-the-app)) |
| **No current view** | The app has not written a view for over ten minutes: it is not running, or its Mac slept. Open the app |
| **Fleet Cockpit is not running** | No snapshot has ever been written |

## No notifications

1. **System Settings → Notifications → Fleet Cockpit**: allowed, with banners.
2. A Focus is on and its [Fleet Cockpit filter](macos.md#focus-filter) is
   *Critical only* or *None*, or the Focus does not allow time-sensitive
   notifications.
3. Settings → Notifications: *Critical only*, quiet hours, or the rule is muted.
4. The condition was already open when the app started. Only transitions
   notify; open the popover to see what is open now.
5. It was snoozed from a notification in the last hour.

## The hotkey does nothing

Another app has registered ⌃⌥⌘F first, and Carbon gives it to whoever asked
first. Use **Open as a floating window** in the footer menu, or
`open fleetcockpit://panel`.

## The app does not open at login

```bash
sfltool dumpbtm | grep -A6 fleetcockpit
```

`enabled, allowed` is correct. If it is missing, turn **Open at login** off and
on in Settings. If it is listed but `disallowed`, it was turned off in
**System Settings → General → Login Items**; allow it there. An
employer-managed Mac may block login items by policy.

## The CLI

| Symptom | Cause | Fix |
|---|---|---|
| Killed on launch, exit `137` | The binary was copied over a signed one in place | `rm` the old binary, then copy ([install](install.md#install-the-command-line)) |
| `no fixture named …` for every fixture | The resource bundle was not copied beside the binary | Copy `FleetCockpit_CockpitCore.bundle` too |
| `not paired: run cockpit pair first` | The CLI has its own token, separate from the app's | `cockpit pair` |
| A Keychain prompt | An old build that kept its token in the Keychain | Rebuild; current builds use the token file and never prompt |
| Answers look old | It read the app's snapshot (under 90 seconds old) | `--fresh` |
| `status` says **Collector stalled** | The daemon's last finished tick is over 4 minutes old | See [The view is greyed out](#the-view-is-greyed-out) |
| `wait` ends with `(from GitHub; …)` | Cockpit's view had frozen, so GitHub answered | The result stands; the frozen view is the daemon's problem |
| `sentinel` says GitHub checks skipped | No app snapshot yet, so it does not know which runners to ask about | Open the app once while the dashboard is reachable |

## The MCP server is not listed

```bash
claude mcp get fleet-cockpit
```

If it is missing or failing, check the command runs by hand:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | ~/.local/bin/cockpit mcp
```

It should print one JSON line listing four tools. If the path moved, remove and
re-add the server.

## Logs

```bash
/usr/bin/log show --last 1h --info --predicate 'subsystem == "io.github.addisdev.fleetcockpit"'
```

The full path matters: zsh's `log` builtin shadows `/usr/bin/log`.
