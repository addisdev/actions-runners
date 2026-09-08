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
| `npm run demo-db` | Builds `demo.db`, the fixture fleet the screenshots are taken against |
| `npm run shoot` | Starts `fleetd` on a spare port against `demo.db` and captures every tab |
| `npm run motion` | Records the drift-and-repair loop as a GIF. Needs a real fleet |

The rendered PNGs are committed, so building the documentation site needs
neither Node nor a browser — only `mkdocs`.

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
