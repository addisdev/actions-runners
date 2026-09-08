# Release Checklist

Use this checklist before tagging any release on the public repository.

## Pre-release gates (all must pass)

### Tests
- [ ] `cd dashboard && npm test` — all unit and route tests pass
- [ ] `bash scripts/test-drain.sh` — drain/resume tests pass
- [ ] `bash scripts/test-ephemeral.sh` — reaper tests pass
- [ ] `bash scripts/check-docs.sh` — docs consistency passes

### Code quality
- [ ] `git ls-files -z '*.sh' | xargs -0 shellcheck --severity=warning` — clean
- [ ] `git ls-files -z '*.js' | grep -vz node_modules | xargs -0 -I{} node --check {}` — clean
- [ ] CRLF check: `git ls-files -z '*.sh' '*.js' '*.md' | xargs -0 grep -lU $'\r'` — empty

### Security
- [ ] `scripts/release-check.sh` (full, not `--offline`) — clean
- [ ] Full-history secret scan (e.g. `trufflehog git file://. --only-verified`) — clean
- [ ] `git archive HEAD | tar t` — no `fleet.db`, no `.credentials`, no `fleet.env`
- [ ] Dependency audit: `cd dashboard/autofix/escalate && npm audit`

### Documentation
- [ ] `CHANGELOG.md` updated with release notes
- [ ] `dashboard/package.json` version matches the release tag
- [ ] Quick start in `docs/getting-started.md` has been tested on a clean Mac
- [ ] All links in `docs/*.md` resolve (run `scripts/check-docs.sh`)

### Repository state
- [ ] The private archive has been renamed to `addisdev/actions-runners-archive`
- [ ] Fresh `addisdev/actions-runners` has only clean history
- [ ] `git ls-remote https://github.com/addisdev/actions-runners.git` — reachable
- [ ] Known pre-scrub SHA cannot be fetched from the fresh public repo

## Tagging

```bash
# On the fresh public repo checkout only — never on the private archive
git tag -a v0.1.0 -m "v0.1.0 — initial public release"
git push origin v0.1.0
```

## GitHub Release

1. Go to **Releases → Draft a new release**
2. Target the tag just pushed
3. Paste the relevant section from `CHANGELOG.md` as the release body
4. Add checksums if any project-generated artifacts are attached (none for v0.1.0)
5. Publish

## Post-release

- [ ] CI passes on the fresh repo's `main` after the tag
- [ ] Branch protection is set: PRs required, required checks, no force push
- [ ] Issues, security reporting, and Dependabot alerts are enabled
- [ ] Anonymous clone works: `git clone https://github.com/addisdev/actions-runners.git`
- [ ] Quick start from the clone completes without errors
- [ ] 24–48 h watch for failed CI, broken links, Dependabot alerts, and first issues

## Hotfix procedure

If a critical issue is found after tagging:
1. Do **not** rewrite the tag (`v0.1.0` is immutable once pushed)
2. Fix on a branch, open a PR, merge to `main`
3. Tag `v0.1.1`, create a GitHub Release from the next CHANGELOG entry
4. If the issue is a security vulnerability, follow `SECURITY.md` and use
   private reporting before any public disclosure
