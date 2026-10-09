# Install and set up

The cockpit is built from the repository; there is no signed download until a
Developer ID certificate is configured for [releases](development.md#releases).
A build on your own Mac takes a couple of minutes and needs no Apple account.

## Requirements

| On | Needs |
|---|---|
| The Mac you sit at | macOS 14 or later, Xcode 16 or later, [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) |
| The same Mac, for the default route | An SSH alias in `~/.ssh/config` that reaches the runner host with a key (no password prompt) |
| The runner host | The dashboard running (`dashboard/fleetctl.sh status`), version with `/api/glance` |
| For the out-of-band checks | The GitHub CLI (`gh`) signed in on this Mac — optional, and only read when the dashboard is unreachable |

## Build the app

```bash
cd cockpit/App
cp Local.xcconfig.example Local.xcconfig   # optional: your signing identity and team
xcodegen generate
xcodebuild -project FleetCockpit.xcodeproj -scheme FleetCockpit -configuration Release build
```

The `.xcodeproj` is generated and never committed; re-run `xcodegen generate`
after pulling changes to `project.yml` or adding files.

**Signing.** Without `Local.xcconfig` the app is signed ad hoc. That runs on the
Mac that built it, but an ad-hoc build has no team, and so no app group: the
**desktop widgets stay empty** and everything else works. To get widgets, put
your own identity and team in `Local.xcconfig` (it is untracked):

```
CODE_SIGN_IDENTITY = Apple Development
DEVELOPMENT_TEAM = YOURTEAMID
```

A free Apple Development certificate is enough for your own Mac.

## Install the app

Copy the build to `/Applications`, not somewhere under `/tmp` or DerivedData:

```bash
APP="$(xcodebuild -project FleetCockpit.xcodeproj -scheme FleetCockpit -configuration Release \
  -showBuildSettings | awk '/ BUILT_PRODUCTS_DIR /{print $3}')/Fleet Cockpit.app"
rm -rf "/Applications/Fleet Cockpit.app" && cp -R "$APP" /Applications/
open "/Applications/Fleet Cockpit.app"
```

LaunchServices ignores the URL schemes of apps under `/private/tmp`, and every
Xcode build re-registers its DerivedData copy, so `fleetcockpit://` links can
land on a stale build. If they do, unregister the stray copies:

```bash
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSREG -dump | grep -o '/.*DerivedData.*/Fleet Cockpit.app' | sort -u | xargs -I{} $LSREG -u "{}"
```

On first launch macOS asks to allow notifications. Allow them: notifications
are how the cockpit tells you about a transition while the popover is closed.

## Open at login

**Settings → System → Open at login** registers the app with
`SMAppService`. From a setup script, ask for it once instead; the app applies it
at its next launch and clears the request:

```bash
defaults write io.github.addisdev.fleetcockpit pending.loginItem -bool YES
open "/Applications/Fleet Cockpit.app"
```

Check it took with `sfltool dumpbtm | grep -A6 fleetcockpit` (look for
`enabled, allowed`). There is deliberately no URL for this: a web page can open
`fleetcockpit://` links, and it must not be able to add a login item.

## Reach the dashboard

The dashboard binds to loopback on the runner host. The default route needs
nothing changed there: the app opens an SSH tunnel through aliases from your
`~/.ssh/config`, trying each in turn — by default `runner-host`, then
`runner-ts` for a tailnet route. A minimal entry:

```
Host runner-host
  HostName runner-host.local
  User you
  IdentityFile ~/.ssh/id_ed25519
```

Test it the way the app will run it — no prompt allowed:

```bash
ssh -o BatchMode=yes runner-host 'curl -s 127.0.0.1:7878/api/health'
```

If you serve the dashboard over
[Tailscale Serve](../remote-access.md#tailscale-remote-access-over-your-tailnet)
or the LAN instead, choose **Direct URL** in Settings. How the tunnel works,
and why it cannot outlive the app, is under
[Settings and files](settings.md#the-connection).

## Pair, to act

The cockpit is read-only until you pair it.

1. Open **Settings → Control** and check **Fleet root on the host** (default
   `~/actions-runners`).
2. Press **Pair this Mac**. The app runs `fleetctl.sh pair` on the host over your
   first SSH alias, exchanges the six-digit code for this Mac's own device
   token, and keeps it in the Keychain.

`open fleetcockpit://pair` does the same from a terminal. Pairing needs the
tunnel route; with a Direct URL, pair from a Mac that has SSH.

The master token never leaves the host. The cockpit is revocable like any
paired phone:

```bash
# on the runner host
cd ~/actions-runners/dashboard
./fleetctl.sh devices          # list paired devices
./fleetctl.sh revoke <key>     # revoke one
```

**Forget token** in Settings removes it from this Mac.

## Install the command line

```bash
cd cockpit
swift build -c release
mkdir -p ~/.local/lib/fleet-cockpit ~/.local/bin
rm -rf ~/.local/lib/fleet-cockpit/cockpit ~/.local/lib/fleet-cockpit/FleetCockpit_CockpitCore.bundle
cp -R .build/release/cockpit .build/release/FleetCockpit_CockpitCore.bundle ~/.local/lib/fleet-cockpit/
ln -sf ~/.local/lib/fleet-cockpit/cockpit ~/.local/bin/cockpit
cockpit status
```

Two things in that recipe matter:

- **Copy the binary and its resource bundle together.** The bundle holds the
  fixtures; without it `--fixture` and `cockpit fixtures` fail.
- **Remove the old binary before copying.** Copying over a signed binary in
  place (`cp -f`) leaves the kernel's cached signature for the old file on the
  new one, and the next run is killed on launch (exit 137).

The CLI pairs separately, with its own token: `cockpit pair`. See
[Command line](cli.md#cockpit-pair).

## Agent sessions

```bash
claude mcp add --scope user fleet-cockpit -- ~/.local/bin/cockpit mcp
mkdir -p ~/.claude/skills && cp -R cockpit/skills/fleet-cockpit ~/.claude/skills/
```

What these give a session is on [Agent sessions](agents.md).

## Update

```bash
git pull
cd cockpit/App && xcodegen generate && xcodebuild -project FleetCockpit.xcodeproj \
  -scheme FleetCockpit -configuration Release build
```

Then repeat the copy to `/Applications` (quit the app first) and the CLI copy.
Settings, the pairing token and the login item survive a reinstall: they belong
to the bundle id, not the file.

## Uninstall

Turn off **Settings → System → Open at login** first, so no login item is left
pointing at a deleted app. Then:

```bash
osascript -e 'quit app "Fleet Cockpit"'
rm -rf "/Applications/Fleet Cockpit.app"
defaults delete io.github.addisdev.fleetcockpit
rm -rf ~/Library/Application\ Support/FleetCockpit
security delete-generic-password -s io.github.addisdev.fleetcockpit 2>/dev/null
rm -f ~/.local/bin/cockpit && rm -rf ~/.local/lib/fleet-cockpit
claude mcp remove fleet-cockpit -s user; rm -rf ~/.claude/skills/fleet-cockpit
```

Then revoke the app's and the CLI's device tokens on the host with
`./fleetctl.sh revoke`.
