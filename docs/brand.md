# Brand

One palette, one mark, one type pairing. Written down so the next asset matches
the last one, and so that somebody who is not the author can regenerate any
image in this repository.

## Colour

The palette is not a decision made for the documentation. It is
[`dashboard/public/style.css`](https://github.com/addisdev/actions-runners/blob/main/dashboard/public/style.css),
dark scheme, copied exactly — a docs site in a different blue from the product
is a docs site for a different product. When the dashboard's colours change,
these change with them.

| | Hex | Where |
|---|---|---|
| **Plane** | `#0b0f17` | The ground of every figure, and the dashboard's page behind everything |
| **Surface** | `#121925` | Panels and cards |
| **Raised** | `#18212f` | Chips and inset elements on a surface |
| **Ink** | `#f6f8fb` | Text |
| **Muted** | `#7f8a9b` | Secondary text, structural lines, arrowheads |
| **Hairline** | `#253142` | Panel borders |
| **Accent** | `#60a5fa` | The one highlight, on dark |
| **Accent, dark-on-light** | `#2563d9` | Links and accents on a light ground, where `#60a5fa` fails contrast |

Four more colours exist, and each one may **only** be used with its meaning.
They are states, not decoration, and using `--good` because a box needed to be
green is how a reader stops believing that green means anything.

| | Hex (dark) | Hex (light) | Means |
|---|---|---|---|
| **Good** | `#4ade80` | `#15803d` | Online, idle, healthy |
| **Busy** | `#60a5fa` | `#2563d9` | A job is running |
| **Warning** | `#f5b942` | `#c97900` | Draining, degraded, needs attention eventually |
| **Serious** | `#fb8155` | `#d65a2f` | Drifted, offline |
| **Critical** | `#f36a6a` | `#c93636` | Dead, failed |

## The mark

Two nodes feeding one node that carries a tick: work arriving at a runner, and
the runner reporting a verdict. It reads at 16 px, which is the size it was
drawn for — the favicon is the same geometry, not a simplified redraw.

| File | What it is | Use for |
|---|---|---|
| `dashboard/public/assets/fleet-mark.svg` | The mark on a rounded `#111827` tile | The dashboard header |
| `docs/img/mark.svg` | The same file, copied | The documentation site favicon, and anywhere it sits on an unknown ground |
| `docs/img/mark-mono.svg` | Strokes only, `currentColor`, no tile | The documentation site header, which inherits its foreground colour |
| `dashboard/public/assets/app-icon.svg` | Full-bleed square, no rounded corners | The installed-web-app icon |
| `dashboard/public/assets/favicon.svg` | The mark at tab size | The dashboard tab |

The monochrome mark drops the tick's green and cuts it out of the node instead.
A monochrome mark with a second colour in it is two marks.

## Type

| Role | Face | Notes |
|---|---|---|
| Display and body | Inter | Headings and prose in generated figures |
| Mono | JetBrains Mono | Runner names, repo names, commands, environment variables, metrics |

These are the two faces Material for MkDocs is configured with, so the site and
the figures are one pairing rather than two. The dashboard itself uses the
system stack (`system-ui` and `ui-monospace`) and deliberately still does: it is
a local operations page that must render instantly with no network, and Inter
at 14 px is not distinguishable enough from San Francisco to be worth a font
load on a machine that is busy compiling.

Figures load the copies in
[`docs/figures/fonts/`](https://github.com/addisdev/actions-runners/tree/main/docs/figures/fonts).
Both families are SIL OFL 1.1, both licences travel with them, and both are
recorded in
[`THIRD_PARTY_NOTICES.md`](https://github.com/addisdev/actions-runners/blob/main/THIRD_PARTY_NOTICES.md).

Any number that sits in a column gets `font-variant-numeric: tabular-nums`. A
table of durations whose digits do not line up is harder to read than one with
fewer digits in it.

## The figures, and how they are made

Everything is rendered from a source in this repository rather than drawn by
hand in a tool, so it can be regenerated when the mark or the palette changes.

A figure is an HTML file in
[`docs/figures/`](https://github.com/addisdev/actions-runners/tree/main/docs/figures) —
one per figure, each an inline SVG on the tokens in `figures/brand.css`, with
the shared shapes in `figures/symbols.js`. `npm run assets` in `docs/tools/`
opens each one in headless Chromium and screenshots the `.figure` element at
2x into `docs/img/`; `npm run assets -- --only architecture` does one.

| Asset | Size | Source |
|---|---|---|
| `img/architecture.png` | 2560x1600 | `figures/architecture.html` |
| `img/drift.png` | 2560x1360 | `figures/drift.html` |
| `img/queue-causes.png` | 2560x1400 | `figures/queue-causes.html` |
| `img/loops.png` | 2560x900 | `figures/loops.html` |
| `img/federation.png` | 2560x1200 | `figures/federation.html` |
| `img/banner.png` | 2560x1280 | `figures/banner.html` |
| `img/social-preview.png` | 2560x1280 (2x of GitHub's 1280x640) | `figures/social-preview.html` |
| `img/fleet-tab.png` and the rest of the tab captures | 1440x900 | `npm run shoot`, against the fixture fleet |
| `img/fleet-live.png`, `img/analytics-live.png` | 2880x1800 | A real fleet, names replaced. See below |
| `img/drift-repair.gif` | 1280 wide | `npm run motion`, against a real fleet |

### Why PNG, and why each figure carries its own ground

GitHub serves an SVG in a README through a proxy, as an `<img>`. Web fonts
never load through that proxy, so the text falls back to whatever the reader
happens to have installed and the line breaks the figure was laid out around
turn into overlapping labels. A PNG rendered by headless Chromium with the
self-hosted faces is the same image on every machine.

Each figure carries its own `#0b0f17` ground rather than a transparent one,
because it gets dropped onto surfaces this repository does not control: the
README in GitHub's light theme, the documentation site in either scheme, a
portfolio page, a slide.

**Nothing in a figure is smaller than 13 px at 1x.** GitHub renders the README
column at about 830 px, so a 1280 px figure is shown at roughly two thirds of
its size, and 13 px is the floor for reading it there. A figure that needs more
words than fit at that size is two figures.

### Why the diagrams are placed by hand

The architecture page used to carry two Mermaid blocks. Mermaid renders inside
GitHub's own theme — pale boxes, a default font, edges routed differently in
light and dark — so it was the only element on the page that could not be made
to match anything else, and it sat in the section a reader uses to decide
whether to keep reading. No amount of `%%{init}%%` theming fixes that, because
the layout engine is the problem rather than the colours.

Mermaid is a layout engine for people who do not want to place boxes. A diagram
somebody looks at for ten seconds is placed boxes.

## The screenshots

`npm run shoot` in `docs/tools/` starts `fleetd` on a spare port with
`FLEET_READ_ONLY=1` against `demo.db`, a fixture fleet built by
`npm run demo-db` from the same shapes the test suite uses. Every runner in it
is visibly a fixture — `testowner/app-ios`, `testowner/app-web` — so no reader
can mistake it for a measurement.

!!! warning "Two screenshots are not from fixtures, on purpose"

    `fleet-live.png` and `analytics-live.png` come from a **real fleet**, with
    repository and host names replaced.

    The Analytics tab is the reason. A thirty-day success rate, a p90 queue
    wait and an hosted-macOS allowance saved are numbers a reader would
    believe, and generating them from seeded runs would mean publishing
    invented measurements under a heading that says measured. The Fleet tab is
    shown live alongside it so the two agree about the same fleet.

    Everything else in `docs/img/` is fixture data and says so in its alt text.

The convention for both, taken from the project this documentation borrows its
method from: a number that gets believed and turns out to be wrong costs more
than one that was never reported.
