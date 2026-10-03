# Around macOS

The popover is where you look on purpose. These are the ways the fleet reaches
you when you are not looking, and the ways other parts of macOS can ask about
it.

## Desktop widgets

Add **Fleet** from the widget gallery in three sizes:

| Size | Shows |
|---|---|
| Small | The verdict's mark and title, running and queued counts, how long ago it updated |
| Medium | The same, plus a dot per runner |
| Large | The same, plus the verdict's sentence, up to three commits' checks, and the first four queued runs with their ETA or cause |

Clicking a widget opens the **Why?** ladder.

Widgets never touch the network. They read the snapshot the app shares through
its app group, redraw whenever the verdict changes, and otherwise refresh every
five minutes, so a dead app's last view visibly ages: a view older than ten
minutes says **No current view** instead of a verdict.

Widgets need a build signed with a team (an app group cannot exist without one);
on an ad-hoc build they stay empty. See [signing](install.md#build-the-app).

## Shortcuts, Spotlight and Siri

| Shortcut | Does | Needs |
|---|---|---|
| **Fleet Status** | Says the verdict, its sentence and the counts; returns the verdict `id` | A snapshot under 5 minutes old |
| **Why Is a Repo Queued** | For one repository: its runners by state, and each queued run's age, cause and start ETA | A snapshot |
| **Repair Fleet** | Asks for confirmation, then runs `fleet.healthRepair` | The app running and paired |

The read shortcuts answer from the snapshot file, so they return in a fraction
of a second and never open a tunnel. Fleet Status and Repair Fleet are also
offered as App Shortcuts, with the phrases "Fleet status in Fleet Cockpit",
"How is the fleet in Fleet Cockpit" and "Repair the fleet in Fleet Cockpit".

Because they return values, they compose. For example, a shortcut that runs
*Fleet Status* and, if the result is not `clear` or `waiting`, sends you a
message.

## Focus filter

In **System Settings → Focus → (a Focus) → Focus filters → Fleet Cockpit**,
choose which fleet alerts reach you while that Focus is on:

| Setting | Notifies |
|---|---|
| Critical and warning | Everything your Settings allow (the default) |
| Critical only | Critical alerts only |
| None | Nothing |

The filter narrows your Settings; it never widens them. Critical alerts are
time-sensitive, so they still need the Focus to allow time-sensitive
notifications from Fleet Cockpit to break through.

## The floating panel

**⌃⌥⌘F**, from any app, opens the popover as an ordinary window that floats
above the others and follows you across Spaces — for a second display during an
incident. Press it again to close it. The footer menu's **Open as a floating
window** does the same.

The hotkey uses Carbon's `RegisterEventHotKey`, which needs no Accessibility
permission. If another app already holds ⌃⌥⌘F, the registration silently fails;
use the footer menu or `open fleetcockpit://panel`.

## The `fleetcockpit://` URL scheme

| URL | Does |
|---|---|
| `fleetcockpit://why` | Opens the Why? ladder |
| `fleetcockpit://panel` | Toggles the floating panel |
| `fleetcockpit://reconnect` | Reconnects now, skipping any backoff |
| `fleetcockpit://runner/<name>` | Selects that runner and opens its panel (full name or the short name shown on the pill) |
| `fleetcockpit://fixture/<name>` | Switches the app to a [fixture](cli.md#cockpit-fixtures) — saved to Settings; switch back to SSH tunnel there |
| `fleetcockpit://pair` | Starts pairing (it still runs `fleetctl.sh pair` over your own SSH alias, and gains nothing a web page could use) |

```bash
open fleetcockpit://runner/build-host-comet-web-2
```

Any web page can open a `fleetcockpit://` link, so the scheme only ever **shows**
things. Nothing that changes the fleet — repair, restart, drain, cleanup — and
nothing that changes this Mac, such as adding a login item, has a URL.

## Incident replay

**Incident replay…** in the footer menu steps through the recorded incidents
with the real popover, one recorded state at a time, with a caption saying what
changed and when:

| Incident | Steps |
|---|---|
| Disk floor freeze (2026-09-29) | Quiet → disk under the floor with nothing waiting → three jobs held at *Set up runner*, no error anywhere → after cleanup |
| Dead runner service | Healthy → the service exits 137 and launchd does not restart it → after `health.sh --repair` |
| Saturated host (2026-09-12) | A busy night, healthy waiting → a second job lost mid-step while Spotlight indexed the work trees → after the burst |
| Billing block | Healthy → GitHub refuses jobs before they reach any runner |
| Agent host stops reporting | Healthy → a federated agent's heartbeat stops |
| Label drift | A runner whose labels will never match `runs-on` |

**Play** advances every three seconds; the slider steps by hand. Replay uses its
own model: it never touches the live connection, notifications or the snapshot
file. It is the quickest way to learn what each verdict looks like before you
meet it for real, and the steps are the same fixtures the verdict's tests hold
it to.

## Launch arguments

For demos, screenshots and checking a layout change without clicking the menu
bar:

| Argument | Does |
|---|---|
| `--fixture <name>` | Shows a fixture for this run only, without touching saved settings |
| `--render <file.png>` | Draws the popover to a PNG and exits |
| `--dark` | With `--render`: dark appearance |
| `--why` | With `--render`: the ladder open |
| `--hover <runner>` | With `--render`: that runner's pill hovered (matches the end of the name) |
| `--select <runner>` | With `--render`: that runner's panel open |
| `--pending` | With `--render`: the inline *Apply cleanup* confirmation |

```bash
"/Applications/Fleet Cockpit.app/Contents/MacOS/Fleet Cockpit" \
  --fixture diskHold --render disk.png --dark --hover ember-ios
```

## The web dashboard

The web dashboard shows the same verdict as a banner above its KPI row, with the
next move as a button and the evidence under **Why**. The phone's push alerts
come from the same alert rules. What you see in the menu bar, in a browser and
on a phone is one verdict, not three.
