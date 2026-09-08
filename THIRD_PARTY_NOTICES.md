# Third-Party Notices

This file documents the third-party software bundled in this repository, its
license, and any known telemetry or network behaviour.

## `dashboard/autofix/escalate/` — AI escalation bridge

| Field | Value |
|---|---|
| Location | `dashboard/autofix/escalate/` |
| Purpose | Optional AI agent that opens fix branches/PRs for failing CI |
| Enabled by | `FLEET_ESCALATE_ENABLED=1` (disabled by default) |
| Required credential | `CURSOR_API_KEY` |

### License

See `dashboard/autofix/escalate/package.json` for the declared license.

### Network and telemetry behaviour

The escalation bridge makes outbound HTTPS calls to the Cursor API
(`api.cursor.sh` or as configured) to invoke the AI agent. It does not make
other outbound network calls. No telemetry is sent to this project's
maintainers.

**What it sends to the Cursor API:**
- The failing CI job's log output
- A checkout of the affected repository (in a scratch clone under
  `dashboard/autofix/repos/`)
- The prompt constructed from the CI failure

**What it writes locally:**
- `dashboard/autofix/runs/` — agent transcripts (may contain code snippets)
- `dashboard/autofix/state.json` — per-alert retry counts

None of these directories are tracked by git. They are excluded from
diagnostic bundles by the allowlist in `lib/bundle.js`.

### Supply-chain note

The lockfile (`dashboard/autofix/escalate/package-lock.json`) is committed to
ensure reproducible installs. Review it before running `npm install` in that
directory, as this project has not independently audited the dependency tree.

The escalation feature has not been exercised by CI; CI uses
`FLEET_ESCALATE_ENABLED=0` (the default). See `SECURITY.md` for the full
accepted-risk statement.

---

## GitHub Actions Runner binary

| Field | Value |
|---|---|
| Source | https://github.com/actions/runner/releases |
| Installed by | `register.sh` (download + checksum verification) |
| License | MIT |

The runner binary is downloaded at registration time. Its checksum is verified
against the signed release on GitHub before installation. The binary is not
bundled in this repository.

---

## Node.js built-in modules

This project uses `node:sqlite`, `node:test`, `node:crypto`, `node:http`, and
other built-in Node modules. These are part of the Node.js runtime and are
governed by the Node.js license (MIT/OpenSSL).

---

## Inter and JetBrains Mono

| Field | Value |
|---|---|
| Source | https://github.com/rsms/inter and https://github.com/JetBrains/JetBrainsMono |
| Bundled at | `docs/figures/fonts/Inter-latin.woff2`, `docs/figures/fonts/JetBrainsMono-latin.woff2` |
| License | SIL Open Font License 1.1 |

Both are **bundled in this repository**, unlike everything else in this file.
The documentation figures are rendered to PNG by headless Chromium, and a
figure whose type falls back to whatever face the renderer happens to have
installed is a different image on every machine. Self-hosting the two faces is
what makes `npm run assets` reproducible.

Each licence travels with its font as `docs/figures/fonts/OFL-Inter.txt` and
`docs/figures/fonts/OFL-JetBrainsMono.txt`. Both files are the latin subset in
variable-weight `woff2`, taken from the Google Fonts CDN.

Neither font is used by the dashboard, which renders in the system stack and
loads no font at all.

---

## Documentation toolchain

| Field | Value |
|---|---|
| `mkdocs-material`, `mkdocs-redirects` | BSD 2-Clause and MIT; pinned in `requirements-docs.txt` |
| `playwright` | Apache 2.0; a devDependency of `docs/tools/` only |

None of these is bundled, and none is needed to run a fleet. `dashboard/` still
has **no dependencies** — that is why the figure and screenshot rig lives in
`docs/tools/` behind its own `package.json` rather than beside the daemon.
