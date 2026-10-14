# Release Checklist

Use this checklist before tagging any release on the public repository.
Versions are `v0.N.0` for feature releases and `v0.N.M` for patches; see the
end of the [changelog](https://github.com/addisdev/actions-runners/blob/main/CHANGELOG.md).

## Pre-release gates (all must pass)

### CI

- [ ] Every job in `.github/workflows/ci.yml` is green on the commit you will
      tag: Node unit tests, JS syntax, Shell checks, Shell tests, Release check,
      Docs consistency, CRLF check, Preflight smoke test and Fleet Cockpit.

To run the same gates locally:

```bash
(cd dashboard && npm ci && npm test && node scripts/make-glance-fixtures.mjs --check)
(cd cockpit && swift test)
for t in scripts/test-*.sh hooks/tests/{run,audio,simulator,shm}.sh; do bash "$t" || echo "FAILED: $t"; done
bash scripts/check-docs.sh
mkdocs build --strict
```

### Code quality

- [ ] `git ls-files -z '*.sh' | xargs -0 shellcheck --severity=warning` — clean
- [ ] `git ls-files -z '*.js' | grep -vz node_modules | xargs -0 -I{} node --check {}` — clean
- [ ] CRLF check: `git ls-files -z '*.sh' '*.js' '*.md' | xargs -0 grep -lU $'\r'` — empty

### Security

- [ ] `scripts/release-check.sh` (full, not `--offline`) — clean
- [ ] Secret scan of the commits since the last tag (e.g.
      `trufflehog git file://. --since-commit <last-tag> --only-verified`) — clean
- [ ] `git archive HEAD | tar t` — no `fleet.db`, no `.credentials`, no `fleet.env`

### Documentation

- [ ] `CHANGELOG.md`: the `[Unreleased]` entries move under a new
      `## [vX.Y.Z] — YYYY-MM-DD` heading with a one-paragraph summary, an empty
      `[Unreleased]` stays on top, and the compare links at the bottom gain the
      new version
- [ ] `dashboard/package.json` and `package-lock.json` versions match the tag
      (`cd dashboard && npm version X.Y.Z --no-git-tag-version`)
- [ ] `docs/upgrading.md` lists any one-time steps an existing host needs
- [ ] Quick start in `docs/getting-started.md` still works on a clean Mac

## Tagging

Tag the merge commit on `main` that carries the changelog and version bump:

```bash
git fetch origin && git switch --detach origin/main
git tag -a vX.Y.Z -m "vX.Y.Z — <summary line>"
git push origin vX.Y.Z
```

## GitHub Release

```bash
# The changelog section for this version, without its heading:
awk '/^## \[vX.Y.Z\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > /tmp/notes.md
gh release create vX.Y.Z --title "vX.Y.Z — <summary line>" --notes-file /tmp/notes.md --verify-tag
```

Credit outside contributors by GitHub handle at the top of the notes.

## Fleet Cockpit

The menu bar app versions separately, on `cockpit-v*` tags, and its signed
build is gated on the Developer ID secrets. To release it alongside, bump
`MARKETING_VERSION` in `cockpit/App/project.yml` and push a `cockpit-vX.Y.Z`
tag; see [Development](cockpit/development.md#releases).

## Post-release

- [ ] CI passes on `main` after the tag
- [ ] The docs site shows the new version's pages
- [ ] Anonymous clone works: `git clone https://github.com/addisdev/actions-runners.git`
- [ ] 24–48 h watch for failed CI, broken links, Dependabot alerts, and new issues

## Hotfix procedure

If a critical issue is found after tagging:
1. Do **not** rewrite the tag; a pushed tag is immutable
2. Fix on a branch, open a PR, merge to `main`
3. Tag the next patch (`v0.3.0` → `v0.3.1`) and create a GitHub Release from
   its CHANGELOG entry
4. If the issue is a security vulnerability, follow `SECURITY.md` and use
   private reporting before any public disclosure
