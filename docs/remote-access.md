# Remote access and mobile

The dashboard was originally loopback-only by design: the control plane can
restart runners and delete caches, so keeping it on `127.0.0.1` was the safest
default. The setup here extends that safely to your local network and to your
tailnet — without ever putting the dashboard on the public internet.

## Reading vs controlling

**Read routes** (fleet state, runs, alerts, hosts) remain open to any address
that reaches the server. A phone on the same Wi-Fi can watch the fleet without
credentials.

**Write routes** (actions, settings, alert dismiss from a remote device) require
a bearer token. The original flow — paste the master token into the Control tab
once — still works locally. For remote devices, use **device pairing** so they
get their own revokable token without the master token ever leaving the machine.

## LAN access

Enable LAN access with one command:

```sh
./dashboard/fleetctl.sh remote lan on
```

This sets `FLEET_HOST=0.0.0.0` in `fleet.env` and regenerates the LaunchAgent.
The bind address is written into the plist at install time, so a plain restart
would not pick it up. If the macOS Application Firewall is on, the command
prints the line that allows `node` through it:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(which node)" --unblockapp "$(which node)"
```

The dashboard is then reachable at:

- `http://<hostname>.local:7878` — mDNS, works from any device on the same network
- `http://<lan-ip>:7878` — explicit IP address

Run `./fleetctl.sh remote status` to see all reachable URLs.

To revert:

```sh
./dashboard/fleetctl.sh remote lan off
```

## Tailscale (remote access over your tailnet)

[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve/) wraps the
dashboard in HTTPS and makes it reachable from anywhere on your tailnet. It is
**not** Tailscale Funnel — the dashboard never reaches the public internet.

Requirements: Tailscale installed and logged in on the runner host.

```sh
./dashboard/fleetctl.sh remote tailscale on
```

This runs `tailscale serve --bg --https=443 http://127.0.0.1:7878`. The daemon
stays bound to loopback (or the LAN if you enabled that separately); Tailscale
acts as a reverse proxy. The CLI is found on `PATH`, in Homebrew's locations, or
inside `/Applications/Tailscale.app` for the Mac App Store build; set
`FLEET_TAILSCALE_BIN` if yours lives elsewhere. If Serve has never been enabled
for your tailnet, Tailscale prints a link to enable it; follow it and rerun.

The daemon notices Serve being switched on without a restart. It re-reads its
Tailscale identity every five minutes, and immediately when a request arrives
under a name it does not yet know.

The dashboard is then reachable at:

```
https://<hostname>.<tailnet-name>.ts.net
```

To disable:

```sh
./dashboard/fleetctl.sh remote tailscale off
```

This removes only the HTTPS listener on port 443. Anything else the machine
serves on your tailnet is left alone.

### Offline/PWA install over Tailscale

Because Tailscale Serve provides HTTPS, the service worker is active when
accessing the dashboard from a tailnet URL. This enables:

- **"Add to Home Screen"** on iOS and Android
- **Offline launch** — the last snapshot is shown, labelled as offline, if the
  host is unreachable
- **App shortcuts** in the home-screen launcher (Runs, Alerts)

The page itself is always fetched from the network first, with the cached copy
used only when the network fails or takes longer than four seconds. Upgrading
the dashboard therefore reaches phones on their next load, with no cache to
clear.

The service worker is deliberately not active on plain LAN HTTP, where
`isSecureContext` is false (except for localhost).

## Pairing a device for controls

Viewing is open. To use controls (restart runners, change settings, dismiss
alerts) from a remote device, pair it:

**From the terminal on the runner host:**

```sh
./dashboard/fleetctl.sh pair
```

This prints a 6-digit code and a URL. If `qrencode` is installed it also renders
a terminal QR code. The code expires in 5 minutes and is single-use.

The link uses an address the other device can actually open. It prefers the
Tailscale HTTPS name, then the `.local` Bonjour name, then a LAN IP. If the
dashboard is only reachable from this machine, the command says so instead of
handing out a `localhost` link that would fail on the phone.

**From the Control tab in the dashboard:**

1. Open the Control tab on an already-unlocked session
2. Click **Pair a device**
3. Scan the QR code, or share or copy the link to the remote device

The panel counts down to the code's expiry and reports "Paired" as soon as the
other device has used it.

**On the remote device, either:**

- open the link (scan the QR code or tap the shared link), or
- open the dashboard, go to Control, choose **Enter pairing code**, and type
  the six digits.

The device is asked for a name (a sensible default such as "iPhone · Safari" is
offered), exchanges the code for its own token, and stores it in
`localStorage`. The master token never leaves the host machine.

If a device's token is later revoked, its Control tab says **Token no longer
accepted** and offers to forget it, rather than showing controls that fail.

### Managing devices

```sh
# List paired devices
./dashboard/fleetctl.sh devices

# Revoke a device
./dashboard/fleetctl.sh revoke <name-or-key>
```

Device tokens can also be revoked from the Control tab → Remote devices panel.

## Security model

### What is open

All GET read routes are open to any address that can reach the server:
`/api/state`, `/api/stream`, `/api/health`, `/api/alerts`, etc. This matches the
loopback model — anyone who could `curl` the loopback could already read the
fleet. LAN and tailnet access extend that to trusted network peers.

### What requires auth

All mutating routes require a bearer token:

- The **master token** (`./fleetctl.sh token`) — never leaves the host
- A **device token** — issued via pairing, stored in `.fleet-device-tokens.json`
  as SHA-256 hashes, revokable individually

Alert dismiss from the local machine (loopback, no proxy) still works without a
token — this is unchanged from the original design.

### Pairing limits

A pairing code is six digits, so guessing is capped:

- each client gets 5 failed attempts a minute, after which it receives `429`;
- 20 failures a minute from all clients combined invalidates every pending code.
  Behind Tailscale Serve every client shares one address, and on a LAN an
  attacker can change address, so the per-client cap alone would not be enough;
- `POST /api/pair` is also subject to the Origin check, so a page open in another
  tab cannot spend guesses on your behalf.

### DNS-rebinding protection

Browser requests must carry a `Host` header the server recognises as its own
identity: hostname, `.local` mDNS name, local IP addresses, Tailscale MagicDNS
name, the host names in `FLEET_COORDINATOR`/`FLEET_COORDINATORS`, and anything
in `FLEET_ALLOWED_HOSTS`. An unrecognised `Host` gets a 421 response before any
route logic runs, and the refused name is written to the daemon log (at most
once every ten minutes per name) so you can see what to add.

Agent routes (`/api/host/*`) are exempt. They are machine-to-machine calls that
need a bearer token a rebinding page cannot have, and agents reach the
coordinator by whatever name their `fleet.env` holds.

### Tailscale reverse-proxy trust

When a request arrives from loopback with `X-Forwarded-*` or Tailscale headers,
`isLocalRequest()` returns `false`. This means a phone accessing the dashboard
via Tailscale Serve cannot dismiss alerts without a token, even though the TCP
connection comes from loopback — the proxy headers disclose its true origin.

### Adding custom DNS names

If you access the dashboard through a custom DNS name or a reverse proxy that
adds its own hostname, add the name to `fleet.env`:

```sh
FLEET_ALLOWED_HOSTS=my-mac.example.com,192.168.1.50
```

## Mobile layout

The dashboard detects narrow screens and switches to:

- **Bottom navigation bar** (Fleet, Runs, Alerts, Hosts, More)
- **More sheet** for secondary tabs (Analytics, Lint, Capacity, Control)
- **Glance card** at the top of Fleet: busy, idle, queued, and open alerts, each
  tappable to jump to the matching tab
- **Full-screen drawer** for runner and repo details; the Back gesture closes it
- **Touch-friendly controls**: dismiss buttons always visible, 44 px tap targets,
  and tap-to-show explanations for anything that has a hover tooltip on desktop
- **Scrollable tables**: wide tables scroll sideways inside their panel, with a
  shadow on whichever edge has more
- **Hash-routable tabs**: `#/runs`, `#/alerts`, etc. — shareable and bookmarkable

Phones suspend background tabs. When you return to the dashboard it reconnects
only if the live stream has actually gone quiet, and it keeps the last snapshot
on screen, labelled **Reconnecting…**, until fresh data arrives.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Browser shows `421` / "not a recognised address" | You reached the daemon by a name it does not know. The daemon log names it; add it to `FLEET_ALLOWED_HOSTS` and run `./fleetctl.sh install`. |
| Phone cannot connect at all on the LAN | Check `./fleetctl.sh remote status`. If it says loopback only, run `remote lan on`. If the firewall is on, allow `node` with the command it prints. |
| Tailscale URL refused right after `remote tailscale on` | Reload once. The daemon re-reads its Tailscale name when it sees an unknown one. |
| Control tab says **Token no longer accepted** | The device was revoked or the master token rotated. Choose **Forget token** and pair again. |
| Pairing says "too many failed attempts" | Wait a minute. If codes keep being invalidated, someone else is guessing; check the daemon log. |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `FLEET_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` for LAN. |
| `FLEET_PORT` | `7878` | Port. |
| `FLEET_ALLOWED_HOSTS` | _(empty)_ | Extra hostnames to accept in `Host` header. |
| `FLEET_DEVICE_TOKENS_FILE` | `.fleet-device-tokens.json` | Paired device token store. |
| `FLEET_TAILSCALE` | `auto` | `off` stops the daemon from calling the Tailscale CLI. |
| `FLEET_TAILSCALE_BIN` | auto-detected | Path to the Tailscale CLI when it is not in a standard place. |
