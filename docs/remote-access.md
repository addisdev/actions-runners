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

This sets `FLEET_HOST=0.0.0.0` in `fleet.env`, restarts the daemon, and reminds
you to allow `node` through the macOS Application Firewall if it is on:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)
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

This runs `tailscale serve --https=443 http://127.0.0.1:7878`. The daemon stays
bound to loopback (or the LAN if you enabled that separately); Tailscale acts as
a reverse proxy.

The dashboard is then reachable at:

```
https://<hostname>.<tailnet-name>.ts.net
```

To disable:

```sh
./dashboard/fleetctl.sh remote tailscale off
```

### Offline/PWA install over Tailscale

Because Tailscale Serve provides HTTPS, the service worker is active when
accessing the dashboard from a tailnet URL. This enables:

- **"Add to Home Screen"** on iOS and Android
- **Offline launch** — the last snapshot is shown if the host is unreachable
- **App shortcuts** in the home-screen launcher (Runs, Alerts)

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

**From the Control tab in the dashboard:**

1. Open the Control tab on an already-unlocked session
2. Click **Pair a device**
3. Scan the QR code or share the link to the remote device

**On the remote device:**

Open the URL (scan the QR code or tap the shared link). The dashboard exchanges
the code for a device token and saves it to `localStorage`. The master token
never leaves the host machine.

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

### DNS-rebinding protection

All requests must carry a `Host` header the server recognises as its own
identity: hostname, `.local` mDNS name, local IP addresses, Tailscale MagicDNS
name, and anything in `FLEET_ALLOWED_HOSTS`. An unrecognised `Host` gets a 421
response before any route logic runs.

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
- **Glance card** at the top of Fleet: busy, idle, queued runner counts
- **Full-screen drawer** for runner and repo details
- **Touch-friendly controls**: dismiss buttons always visible, 44 px tap targets
- **Hash-routable tabs**: `#/runs`, `#/alerts`, etc. — shareable and bookmarkable

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `FLEET_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` for LAN. |
| `FLEET_PORT` | `7878` | Port. |
| `FLEET_ALLOWED_HOSTS` | _(empty)_ | Extra hostnames to accept in `Host` header. |
| `FLEET_DEVICE_TOKENS_FILE` | `.fleet-device-tokens.json` | Paired device token store. |
