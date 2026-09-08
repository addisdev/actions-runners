# Documentation tools

Everything that produces an image in `docs/img/`. It lives here, and not in
`dashboard/`, because `dashboard/package.json` having **no dependencies** is a
design principle of the daemon and a claim on the front page — a docs
screenshot rig is not a reason to break it. Nothing here is needed to run a
fleet, and CI never installs it.

```bash
cd docs/tools && npm install
npx playwright install chromium     # once
```

| Command | What it does |
|---|---|
| `npm run assets` | Renders every `docs/figures/*.html` to `docs/img/<name>.png` at 2x |
| `npm run assets -- --only architecture` | One figure, by file name without `.html` |
| `npm run shoot` | Serves the real dashboard against the fixture fleet and captures every tab |
| `npm run motion -- --runner <dir>` | Records `drift-repair.gif` and `.mp4` against a **real** fleet — see below |

The rendered PNGs are committed, so building the documentation site needs
neither Node nor a browser — only `mkdocs`.

## How the screenshots are possible without a fleet

`fleetd` builds its runner list from `discoverRunnerDirs`, `launchctl list`,
`ps` and the GitHub API. None of those exist on a machine that is only writing
documentation, which is why this repository shipped v0.1.0 with no screenshot
of any of its eight tabs.

`shoot-dash.mjs` serves the real `dashboard/public/` and answers every `/api/`
route from `fixture-fleet.mjs`. The page is unmodified product code; only its
data is fixture. The snapshot comes from calling the daemon's own
`buildRunners`, `deriveDrift` and `deriveGroups` rather than from hand-writing
what they return — a hand-written snapshot stops matching the code the first
time somebody changes it, and does so silently.

The fleet root is a real temporary directory, because `runnerVersions`,
`diagSummary` and `diagTail` have to read actual files. It is presented as
`/Users/testowner/actions-runners` on the way out so no capture carries this
machine's own temp path.

## The one tool here that needs a fleet

`shoot-motion.mjs` records `drift-repair.gif`, and it is the exception to
everything above: a runner dying and being repaired needs a real LaunchAgent to
lose a real process. A fixture fleet can hold a dead runner but cannot die, and
a recording of a state machine being stepped by a script is a recording of the
script.

So it drives a fleet host over SSH. It serves `dashboard/public/` from this
working tree, proxies `/api/` to the `fleetd` already running there, replaces
repository and host names on the way through, kills the named runner's service,
runs `health.sh --repair` into a terminal strip over the page, and waits for the
runner to come back — capturing frames throughout.

```bash
npm run motion -- --runner <dir-name>     # the take
npm run motion -- --runner <dir-name> --dry-run
npm run motion -- --serve                 # the redacted dashboard, no take
```

It stops the auto-remediation bridge for the length of the take and starts it
again afterwards, because `autofix/bridge.js` would otherwise repair the runner
within seconds of the alert. `--runner` has no default: it should name a runner
whose repository has a second runner still serving it, which is a judgement
about a particular fleet rather than a constant, and it is why there is no
repository name anywhere in the file. `docs/brand.md` has the rest, including
why fifteen seconds is the length of the GIF and not of the take.

## Why the figures are PNG and not SVG

GitHub serves an SVG in a README through a proxy, as an `<img>`. Web fonts
never load through it, so the text falls back to whatever the reader happens to
have installed and the careful line breaks turn into overlapping labels. A PNG
rendered by headless Chromium with the self-hosted faces in
`docs/figures/fonts/` is identical on every machine and in CI.

Each figure also carries its own dark ground rather than a transparent one,
because it gets dropped onto surfaces this repository does not control: the
README in GitHub's light theme, the docs site in either scheme, a portfolio
page, a slide.

## Why the diagrams are placed by hand

Mermaid is a layout engine for people who do not want to place boxes, and it
renders in GitHub's own theme — pale boxes, a default font, edges routed
differently in light and dark. It was the one element on the architecture page
that could not be made to match anything else. A diagram somebody looks at for
ten seconds is placed boxes.
