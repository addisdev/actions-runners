# Third-Party Notices

This file documents the third-party software bundled in this repository, its
license, and any known telemetry or network behaviour.

## `pg` — optional PostgreSQL HA driver

| Field | Value |
|---|---|
| Location | `dashboard/package.json` and `dashboard/package-lock.json` |
| Purpose | Shared state and leader election for optional two-replica HA |
| License | MIT; `pg-int8` and `split2` transitive packages use ISC |
| Network behaviour | Connects only to the operator-configured `FLEET_DATABASE_URL` |

Single-host mode dynamically avoids loading this package. `fleetctl.sh install`
uses the committed lockfile when PostgreSQL HA is configured. The complete,
pinned transitive dependency list and integrity hashes are in
`dashboard/package-lock.json`.

## Nayuki QR Code generator

| Field | Value |
|---|---|
| Location | `dashboard/public/vendor/qrcodegen.js` |
| Purpose | Render device-pairing QR codes locally in the dashboard |
| License | MIT |
| Network behaviour | None |

The copyright and complete MIT license text are retained at the top of the
vendored source file.

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

None of these is bundled, and none is needed to run a fleet. The documentation
toolchain remains isolated in `docs/tools/` rather than adding browser tooling
to the dashboard runtime.
