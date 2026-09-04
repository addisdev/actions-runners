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
