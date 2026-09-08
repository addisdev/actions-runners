# Contributing

Bug reports and patches are welcome. Please read
[SECURITY.md](SECURITY.md) before reporting anything that looks like a
vulnerability — use private reporting, not a public issue.

## Scope

This is deliberately small tooling for **one macOS host** with many runners on
it. Things that fit: better host checks, more accurate drift detection,
clearer reporting, macOS version compatibility, bug fixes.

Things that do not fit, and why:

- **Cloud autoscaling or Kubernetes.**
  [actions-runner-controller](https://github.com/actions/actions-runner-controller)
  already does that well, and this exists for the case where it is overkill.
- **Runtime dependencies in the dashboard.** `dashboard/package.json` has none,
  on purpose: it is an unattended daemon, and every dependency is a thing that
  can break on a Tuesday. `node:sqlite` is why Node >= 22.5.0 is required. The
  one exception is `autofix/escalate/`, which is opt-in and has its lock file
  committed for exactly this reason.

  **Accepted-risk note:** `autofix/escalate/` wraps a third-party agent binary
  whose supply-chain provenance and telemetry/network behaviour have not been
  independently audited for this project. It is disabled by default
  (`FLEET_ESCALATE_ENABLED` is not set) and is never exercised by CI. Before
  enabling it in production, review the lockfile (`autofix/escalate/package-lock.json`)
  and the `THIRD_PARTY_NOTICES.md` entry for its telemetry behaviour.
- **Linux or Windows runner hosts.** The scripts are built on `launchd`,
  `scutil`, `vm_stat` and `xcrun`. A port is a bigger change than a patch;
  open an issue to discuss it first.

## Ground rules

**Do not commit anything host-specific.** `.gitignore` is a deny-by-default
allowlist — if you add a file, you must un-ignore it explicitly, which is the
point. Machine- or account-specific values belong in `fleet.env`
(untracked); document any new variable in `fleet.env.example`.

**Do not hardcode a username, hostname, serial number, owner or repo name.**
Derive it (`scutil --get LocalHostName`, `gh api user`, the runner's `.runner`
file) or read it from `fleet.env`. There is a check for this:

```bash
scripts/release-check.sh                # every tracked file
scripts/release-check.sh --list         # what it looks for, and why
scripts/release-check.sh --install-hook # run it on every commit
scripts/release-check.sh --offline      # skip the gh lookups
```

If `gh repo list` fails — rate limit, expired auth — the check **exits non-zero
rather than passing**. Your account's repo names are most of what it looks for,
so a pass without them would be meaningless, and a green line you cannot trust is
worse than a red one. `--offline` says you know, and checks only what the machine
itself can supply.

It derives what to look for from the machine it runs on — your serial, your
username, your hostname, your account's repo names — rather than from a list in
the file, because a hardcoded list of forbidden strings would go stale on the
next rename and could not ship publicly without publishing the strings it was
meant to hide. It knows to ignore this repo's own name and clone URL.

Worth installing the hook before your first commit. The scrub that made this
repo publishable found the host's serial in 26 blobs and its username in 11,
all committed by someone with no intention of publishing them.

**Comments should explain why, not what.** The existing comments are long
because they record failures that were expensive to diagnose — a stub
`WatchOS.platform` that passes a naive check, a UTF-8 BOM that empties a
report, a VPN making DNS a race. Keep the lesson; that is the most useful part
of this repo. Do not add comments that narrate the code.

## Testing a change

The pure logic in `dashboard/lib/` has unit tests. Everything else is verified
by hand, because it reads a real host or a real API:

```bash
cd dashboard && npm test                          # dashboard/test/*.test.js
shellcheck *.sh dashboard/*.sh dashboard/*/*.sh   # if installed
node --check dashboard/fleetd.js                  # and any edited .js
./preflight.sh                                    # on a real macOS host
cd dashboard && ./fleetctl.sh run                 # dashboard in the foreground
```

The job hooks are bash, so their tests are too. Run both if you touch `hooks/`
or `scripts/install-hooks.sh`:

```bash
hooks/tests/run.sh        # slots, limits, stale-slot reaping, fail-open
hooks/tests/install.sh    # the installer, against a fake fleet
```

These are worth the trouble because the hooks are the only thing here that can
hold a build, and their failure modes are ones review does not catch: a slot
outliving its job under-counts concurrency forever, and a hook that exits
non-zero fails a job whose steps all passed. Both run against a throwaway fleet
root under `TMPDIR`, so no real runner, `.env` or database is touched. Writing
the installer's test first is what found it aborting silently on a runner with
no `.env`, having already rewritten the ones before it.

For anything touching the control plane or autofix, exercise the dry-run path
first (`autofixctl.sh dryrun`, `cleanup.sh` without `--apply`). Both default to
deciding without acting, and changes should preserve that.

Please say in the pull request which macOS and Node versions you ran on, since
that is the part hardest to infer from a diff.

## Architecture references

Before touching a module, read its docs entry. The design notes say *why* it is
shaped the way it is, and most of those arguments are grounded in something
that went wrong — changing one without reading it usually reintroduces the
failure that produced it.

- `lib/queue-cause.js` → [Why a job is queued](docs/concepts.md#why-a-job-is-queued) and [Honest analytics](docs/design/analytics.md)
- `lib/state.js` (`deriveDrift`) → [Drift](docs/concepts.md#drift-when-this-machine-and-github-disagree)
- `lib/groups.js` → [Inferred groups](docs/design/groups.md)
- `lib/actions.js` / `lib/bundle.js` → [The control plane](docs/design/control-plane.md)
- `lib/alerts.js` / `autofix/` → [Alerts and autofix](docs/design/alerts.md)
- `lib/yaml.js` / `lib/lint.js` → [Workflow lint](docs/design/lint.md)
- `lib/placement.js` → [Federation placement](docs/federation.md#placement)
- `lib/autoscale.js` / `lib/sizing.js` / `lib/capacity.js` → [Capacity and autoscaling](docs/design/capacity.md)
- `lib/simulator.js` / `lib/forecast.js` → [Forecasts are shadow-only](docs/design/capacity.md#forecasts-are-shadow-only)
- `lib/analytics.js` / `lib/failures.js` → [Honest analytics](docs/design/analytics.md)
- `lib/auth.js` → [Security hardening](docs/security-hardening.md#token-handling)
- `lib/db.js` → [Upgrading](docs/upgrading.md#verifying-migration-success)

## Documentation

The handbook in `docs/` is published at
[addisdev.github.io/actions-runners](https://addisdev.github.io/actions-runners/).
Build it the way CI does:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-docs.txt
.venv/bin/mkdocs serve          # http://127.0.0.1:8000, live reload
.venv/bin/mkdocs build --strict # what the docs workflow runs
```

`--strict` turns a link to a page that does not exist into a failed build, and
a page that exists but is absent from the `nav` in `mkdocs.yml` fails it too.

Figures are rendered from source rather than drawn, so a change to the mark or
the palette can be pushed through all of them:

```bash
cd docs/tools && npm install && npx playwright install chromium
npm run assets                        # every figure in docs/figures/
npm run assets -- --only architecture # one of them
npm run shoot                         # the dashboard screenshots
```

That rig is deliberately outside `dashboard/`, which has **no dependencies** by
design. Do not add one to it for a documentation reason. The rendered PNGs are
committed, so building the site itself needs neither Node nor a browser.

[`docs/brand.md`](docs/brand.md) records the palette, the mark, the type
pairing, and which images came from a real fleet rather than from fixtures.

## Schema migrations

`dashboard/lib/db.js` applies forward-only migrations using `addColumn` and
`createTable` helpers. Rules:
- Every schema change goes through a migration — no manual `ALTER TABLE`
- Migrations must be idempotent (check `IF NOT EXISTS` / column existence)
- Add a matching `SELECT` test in `test/admission-migrate.test.js` if the change
  affects a table the admission module reads

**There is no rollback path.** Document any breaking change in
[docs/upgrading.md](docs/upgrading.md) and remind operators to back up before
upgrading.

## Security-sensitive files

These files require extra review:
- `lib/auth.js` — token generation and comparison
- `lib/bundle.js` — the diagnostic bundle allowlist and redactor
- `fleetd.js` routes that serve data without authentication
- Any shell script that takes external input

A change to `ALLOW` in `lib/bundle.js` that adds a file without adding
a corresponding redaction rule in `REDACT_PATTERNS` is almost certainly wrong.
The allowlist exists precisely because it is small and auditable.

## UI changes

The dashboard UI has no build step — `public/` is plain HTML, CSS, and ES
modules. Changes should:
- Work with `<script type="module">` in modern browsers (Safari, Chrome, Firefox)
- Preserve the CSS variable theming (light/dark toggle)
- Not introduce third-party CDN scripts (no external network calls from the page)

## Release process

Before tagging a release:
1. Run `scripts/release-check.sh` (full, not `--offline`)
2. Run all tests: `cd dashboard && npm test`
3. Run shell tests: `scripts/test-drain.sh && scripts/test-ephemeral.sh`
4. Run docs check: `scripts/check-docs.sh`
5. Build the docs: `.venv/bin/mkdocs build --strict`
6. Update `CHANGELOG.md` and `dashboard/package.json` version
7. Follow the [fresh repository procedure](docs/upgrading.md) for the public repo

**Never tag a release on the private archive repository.** Tags go on the
clean public fork only. See [fresh-repository procedure](docs/upgrading.md).
