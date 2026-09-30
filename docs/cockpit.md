# Fleet Cockpit

Fleet Cockpit is a macOS menu bar app for the Mac you sit at. It shows the
fleet's verdict at a glance, keeps telling the truth when the runner host or its
dashboard is the thing that is down, and gives scripts and agent sessions one
command in place of a diagnostic ladder.

It is a client of the dashboard, not a second monitoring engine. Everything it
says about the fleet comes from [`GET /api/glance`](api.md#get-apiglance); the
only thing it works out for itself is what no process on the runner host can
report — that host's own absence.

## What it shows

**The menu bar** carries one mark for the verdict, and optionally the number of
running (`▸`) and queued (`◷`) jobs.

**The popover**, top to bottom:

- **The verdict** in words, with one button for the next move — *Preview
  cleanup* when the disk floor is holding jobs, *Health check and repair* for a
  dead service, *Open billing* for an account block.
- **Everything else that is open**, one line each, in ladder order.
- **One lane per host.** The coordinator first, with load per core, memory
  pressure, swap-in rate and a disk gauge that draws the admission floor on it.
  Runners registered on machines the dashboard does not supervise get a lane of
  their own marked *GitHub view only*.
- **A pill per runner**, grouped by project. The shape carries the state, so the
  grid reads the same without colour:

  | Pill | State |
  |---|---|
  | hollow ring | idle |
  | filled arc | busy; the arc is elapsed time against the workflow's usual duration |
  | ring with a dot | held for an admission slot, which is normal |
  | square | held by the disk floor |
  | dashed ring | offline for under five minutes, which usually self-resolves |
  | cross | offline for longer, or the runner service is dead |
  | diamond | lost contact mid-job in the last hour |
  | arrow | draining |
  | question mark | misconfigured (orphan, label mismatch) |
  | hatched | its host is not reporting |
  | dotted | state unknown |

  Hover a pill for its detail; click it to open its running job on GitHub.
- **The queue**, oldest first, with the classifier's cause in plain words.

When the stream drops, the last view stays on screen, greyed, with its age. It
never stays green.

## When the dashboard does not answer

After 20 seconds of failed reconnects the cockpit starts asking three other
witnesses, once a minute, until the stream is back:

- **Can this Mac reach the host's SSH port** on any of the configured aliases
  (resolved with `ssh -G`, so it goes where ssh would)?
- **What does GitHub say about the host's runners?** A few of them, taken from
  the last good view, checked with your own `gh` credential — asked for when
  needed and never stored.
- **Is a runner on a different machine online?** One from a *GitHub view only*
  lane. If it is, the house has power and network, and the problem is the host.

When SSH answers, it also asks the host when it booted, who owns the console,
and whether the dashboard answers locally. The answers are read against one
table:

| SSH | GitHub: host's runners | Other machine | Verdict |
|---|---|---|---|
| no | offline | online | **Host asleep, off or off the network.** Only someone there can wake it. |
| no | offline | offline | **Home network or power is out.** |
| no | offline | — | **GitHub Actions is having trouble**, when githubstatus.com reports an Actions incident |
| yes | offline | — | **Rebooted and nobody has logged in** when the console belongs to nobody (no auto-login strands every LaunchAgent); otherwise **every runner service is down** |
| yes | online | — | **Dashboard down, fleet working.** Restart the dashboard. |
| no | online | — | **Fleet working, out of reach from here.** |
| no GitHub and no SSH | | | **This Mac is offline.** |

These verdicts notify once when they open and once when they clear, with how
long they lasted.

## Why, and the brief

**Why?** under the verdict opens the whole ladder with the verdict's rung lit,
the evidence under it, and every other rung that is currently true.

**Copy brief** puts a markdown incident brief on the clipboard: the verdict,
its evidence and next move, everything else open, host vitals, any runner that
is neither idle nor busy, the queue and open alerts. It is written to paste
into an agent session or an issue.

Below the queue, **Failed in the last 2 hours** lists red runs with the reason
the daemon recorded, and marks the ones that were the host's or the account's
doing — lost runner, refused by billing, storage quota — as *not your code*.

## Getting it

Build it from the repository. It needs Xcode 16 or later, macOS 14 or later,
and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
cd cockpit/App
cp Local.xcconfig.example Local.xcconfig   # optional: your signing identity and team
xcodegen generate
xcodebuild -project FleetCockpit.xcodeproj -scheme FleetCockpit -configuration Release build
```

Without `Local.xcconfig` the app is signed ad hoc, which runs on the Mac that
built it.

## Reaching the dashboard

The dashboard binds to loopback on the runner host. The cockpit's default route
needs nothing changed there: it opens `ssh -L` through aliases from your
`~/.ssh/config`, trying each in turn (by default `runner-host`, then
`runner-ts` for a tailnet route). Key-based login only; `BatchMode` makes an
alias that would prompt fail fast instead of hanging.

The tunnel runs `cat` on the host, fed from a pipe only the app holds, so
however the app ends the tunnel ends with it.

If you serve the dashboard over [Tailscale Serve](remote-access.md#tailscale-remote-access-over-your-tailnet)
or the LAN, choose *Direct URL* in Settings instead.

The app reconnects with jittered backoff (1 s doubling to 30 s), immediately on
wake from sleep, and immediately when the network changes.

## Fixture mode

Every recorded incident the verdict is tested against ships inside the app as a
fixture: `live`, `quiet`, `waiting`, `dead`, `diskHold`, `diskBelowIdle`,
`saturated`, `accountBlocked`, `drift`, `agentDown`, `blind`. Pick one in
Settings, or launch with `--fixture <name>`. Fixture mode never writes the
snapshot file.

`--render <file.png>` draws the popover for a fixture and exits, which is how the
screenshots on this page are made:

```bash
"Fleet Cockpit.app/Contents/MacOS/Fleet Cockpit" --fixture diskHold --render disk.png [--dark] [--hover ember-ios]
```

## The command line

`cockpit` reads the app's live view when it is fresh (under 90 seconds old) and
otherwise opens its own tunnel.

```bash
cd cockpit
swift run cockpit status            # the verdict, one screen
swift run cockpit status --json     # the same, for scripts
swift run cockpit status --fixture saturated
swift run cockpit sentinel          # the out-of-band check, from this Mac
swift run cockpit brief             # the markdown incident brief
```

Exit codes: `0` fine or healthy waiting, `1` a real fault, `3` nothing could be
read.

## The snapshot file

The app writes its current view to
`~/Library/Application Support/FleetCockpit/glance.json` (mode `0600`) on every
update: the verdict it is showing, the route, the connection state, and the
glance itself, stamped with `writtenAt`. Other tools can read it without
touching the network; treat a `writtenAt` older than 90 seconds as a dead app.
