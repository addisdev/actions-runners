# Development

How the cockpit is put together, and how to change it without breaking the
promise that every surface tells the same story.

## Shape

```
dashboard/lib/verdict.js        the ladder, runner states, buildGlance()      (on the runner host)
        │  GET /api/glance · /api/stream?view=glance
        ▼
cockpit/Sources/CockpitCore     decode, connect, decide, present             (Swift package, no UI)
        ├── cockpit/Sources/cockpit      the CLI and the MCP server
        └── cockpit/App                  the menu bar app, widgets, intents   (links CockpitCore)
```

The rule that shapes the code: **the daemon decides, the cockpit presents.**
The cockpit never recomputes a rung from raw parts. Its only judgements are the
ones the daemon cannot make — whether the view it holds is still current, and,
when it cannot reach the daemon at all, what the out-of-band witnesses say.

Everything with logic lives in `CockpitCore`, which builds and tests with
`swift test` alone: no Xcode project, no simulator, no signing. The app is a
thin SwiftUI layer over it.

## Code map

### `cockpit/Sources/CockpitCore/`

| File | Responsibility |
|---|---|
| `Glance.swift` | The `/api/glance` model: verdict, counts, hosts, runners, queue, failures, incidents, posture, runs. Tolerant decoding: unknown fields are ignored |
| `Transport.swift` | Routes to the daemon: `TunnelTransport` (ssh with a stdin lifeline), `DirectTransport`, fixtures; the `/api/health` probe |
| `Connection.swift` | `ConnectionState` and the jittered `Backoff` |
| `SSE.swift` | A minimal server-sent events line parser |
| `FleetClient.swift` | HTTP to one daemon: glance, stream, timeline, actions, runner detail, bundle, dismiss |
| `GlanceStore.swift` | Owns the connection and the latest glance; keeps a stale view greyed rather than replacing it |
| `CockpitVerdict.swift` | What the top of the popover shows: the daemon's verdict when it can be trusted, otherwise an honest unknown or the out-of-band verdict |
| `Ladder.swift` | The rungs as the Why view shows them, with the two client-only rungs on top; the markdown incident brief |
| `Presenter.swift` | Glance → view models: lanes, pills and their shapes, queue rows, cause labels, ETA ranges, the menu bar mark, the posture chip |
| `Rollup.swift` | A commit's checks as one row; `Waiter.decide` for `cockpit wait`; watches |
| `History.swift` | `/api/timeline` → incident lanes, today's line, the weekly digest |
| `IncidentTracker.swift` | Successive glances' incidents → notifications: transitions, storms, snoozes, severity, quiet hours |
| `Sentinel.swift` | The out-of-band classification table, as one pure function |
| `SentinelProbe.swift` | The probes behind it: SSH reachability, `gh` runner checks, githubstatus.com, host uptime and console user; `HostProbe.topCPU` |
| `Control.swift` | The action catalogue and the subset the cockpit accepts; pairing; Keychain and file token stores |
| `SnapshotFile.swift` | `glance.json`: write atomically, read, age |
| `Replay.swift` | The recorded incident sequences for the replay window |
| `Fixtures.swift`, `Fixtures/` | The bundled glance payloads, generated from the daemon (below) |
| `Format.swift` | Durations, ages, clocks |

### `cockpit/App/`

| File | Responsibility |
|---|---|
| `project.yml` | XcodeGen spec: the app, the widget extension, the app group, the URL scheme |
| `Signing.xcconfig`, `Local.xcconfig` | Ad-hoc by default; your identity and team when the untracked local file exists |
| `FleetCockpit/FleetCockpitApp.swift` | Scenes (menu bar, floating panel, replay, settings); the Apple Event URL handler |
| `FleetCockpit/AppModel.swift` | App state: store, settings, pairing, actions, sentinel loop, notifications, snapshot writing, login item, URL routes |
| `FleetCockpit/PopoverView.swift`, `Components.swift`, `PillView.swift` | The popover |
| `FleetCockpit/ControlViews.swift` | A runner's panel, inline confirmations, action results |
| `FleetCockpit/HistoryViews.swift` | History, sparklines, standing risks |
| `FleetCockpit/Notifier.swift` | `UNUserNotificationCenter`, categories and buttons |
| `FleetCockpit/Intents.swift` | App Intents: the three shortcuts and the Focus filter |
| `FleetCockpit/Hotkey.swift` | ⌃⌥⌘F through Carbon |
| `FleetCockpit/Renderer.swift` | `--render`: draw the popover to a PNG |
| `FleetCockpit/ReplayView.swift` | The incident replay window |
| `FleetCockpitWidgets/FleetWidgets.swift` | The widget extension (sandboxed, reads the app group copy of the snapshot) |

## Build and test

```bash
cd cockpit
swift test                                   # CockpitCore
swift run cockpit status --fixture diskHold  # the CLI against a fixture

cd App && xcodegen generate
xcodebuild -project FleetCockpit.xcodeproj -scheme FleetCockpit -configuration Debug build

cd ../../dashboard && npm test               # the daemon, including verdict.js
```

CI's **Fleet Cockpit (macOS)** job runs `swift test`, smoke-tests the CLI
against two fixtures, and builds the app unsigned. The **Node unit tests** job
runs the daemon's tests and checks the fixtures are current.

The tests that carry the most weight:

| Test | Holds |
|---|---|
| `dashboard/test/verdict.test.js` | Every rung against every recorded incident, and the cases that must **not** open a rung |
| `CoreTests` | Decoding real glances (and refusing a newer schema with a reason), the SSE parser, backoff, the presenter, never-stale-green, the snapshot file, transports and the store against a stub daemon |
| `ControlTests` | Notification transitions, storms, quiet hours, mutes and snoozes; the accepted-action subset; parsing a pairing code |
| `SentinelTests` | The out-of-band table, row by row; the Why ladder; the brief |
| `RollupTests` | Check rollups and `Waiter.decide`: green, red, cancelled, reruns, pointless, a public repo worth waiting for |
| `HistoryTests` | Timeline lanes, today's line and the digest, posture and forecast, unchecked probes named rather than hidden, every replay step being a real fixture |

## Fixtures: one contract, two languages

The cockpit's fixtures are not hand-written. Each is the daemon's own
`/api/glance` output for one recorded scenario in
`dashboard/test/fixtures/scenarios.js`, written by:

```bash
cd dashboard
node scripts/make-glance-fixtures.mjs          # regenerate
node scripts/make-glance-fixtures.mjs --check  # exit 1 if any is out of date (CI runs this)
```

So a change to `verdict.js` that changes the contract fails CI until the
fixtures are regenerated, and the regenerated fixtures then run through the
Swift decoder and presenter tests. The two sides cannot drift silently.

To add a scenario: add it to `scenarios.js`, assert its verdict in
`verdict.test.js`, regenerate, and add its name to `Fixtures.names` in
`Fixtures.swift`. If it is an incident worth learning from, add a sequence to
`Replay.swift`.

## Changing the ladder

The ladder is the product. Change it in this order:

1. **Write the incident down first** as a scenario: the snapshot the daemon saw,
   and the verdict it should have given.
2. **Change `verdict.js`** and its tests, including a case for what must *not*
   open the rung. Most past bugs here were rungs that opened on something
   normal: pressure "warning", a stale hold reason, a public repo's queue.
3. **Regenerate the fixtures.**
4. **Check every surface reads the new rung**: the Swift `Ladder` (its title
   and blurb), the presenter's mark and cause labels, the skill's table in
   `cockpit/skills/fleet-cockpit/SKILL.md`, and the tables in
   [Verdict reference](verdict.md) and [`api.md`](../api.md#get-apiglance).
5. **Deploy the daemon** to the runner host. Restart it only when no job is
   running: a restart under load drops the stream every client is reading.

The glance's `schema` changes only on a breaking change. Adding a field is not
breaking; decoders ignore what they do not know, and so must yours.

## Screenshots

The images in these pages are drawn by the app itself from fixtures, so they
are reproducible and never show a real fleet:

```bash
APP="/Applications/Fleet Cockpit.app/Contents/MacOS/Fleet Cockpit"
"$APP" --fixture diskHold --render docs/img/cockpit-disk-floor.png --dark
"$APP" --fixture saturated --render docs/img/cockpit-why.png --why
```

See [launch arguments](macos.md#launch-arguments) for `--hover`, `--select` and
`--pending`.

## Releases

`.github/workflows/cockpit-release.yml` runs on a `cockpit-v*` tag:

1. Imports a Developer ID certificate into a throwaway keychain.
2. Builds the app (hardened runtime) and the CLI, signs both.
3. Packages a DMG and a CLI zip, notarizes both with `notarytool`, staples.
4. Publishes them to a GitHub release named after the tag.
5. Deletes the keychain.

It is **gated on secrets**: until they are set, the job notes that and succeeds
without building, so forks and fresh clones run CI without anybody's
certificate.

| Secret | Contents |
|---|---|
| `DEVELOPER_ID_P12` | The Developer ID Application certificate and key, base64 `.p12` |
| `DEVELOPER_ID_P12_PASSWORD` | Its password |
| `APPLE_TEAM_ID` | The team |
| `APPLE_ID` | The Apple ID that notarizes |
| `APPLE_APP_PASSWORD` | An app-specific password for that Apple ID |

To cut a release, bump `MARKETING_VERSION` in `project.yml`, add a
[CHANGELOG](https://github.com/addisdev/actions-runners/blob/main/CHANGELOG.md)
entry, then:

```bash
git tag cockpit-v0.2.0 && git push origin cockpit-v0.2.0
```

## Conventions

- **Swift 6, strict concurrency.** Core types are `Sendable`; the app's model is
  `@MainActor`.
- **No dependencies** in the package or the app. The MCP server is under 150
  lines of JSON-RPC over stdio rather than an SDK.
- **Words come from the daemon.** A label written in Swift for something the
  daemon also names is a second source of truth; prefer the daemon's string.
- **Nothing that changes the fleet behind a URL, an MCP tool, or a
  confirmation-free CLI call.** See the [design rules](index.md#design-rules).
