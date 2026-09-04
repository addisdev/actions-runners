## Summary

<!-- What does this PR do, and why? Link any related issues. -->

## Platform tested on

<!-- macOS version and Node version. This is the part hardest to infer from a diff. -->
- macOS:
- Node: `node -v` →

## Checklist

- [ ] Tests pass: `cd dashboard && npm test`
- [ ] Shell syntax clean: `shellcheck *.sh` (or equivalent)
- [ ] No host-specific data: `scripts/release-check.sh --offline`
- [ ] Docs updated if behaviour changed (add a note to the relevant `docs/*.md`)
- [ ] Schema migration in `lib/db.js` if a table changed, with a note in `docs/upgrading.md`
- [ ] New environment variables documented in `docs/configuration.md` and `fleet.env.example`
- [ ] Security-sensitive change? If so, I have re-read [security-hardening.md](docs/security-hardening.md)
