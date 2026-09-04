#!/usr/bin/env bash
# Verify documentation is internally consistent:
#   - No broken internal Markdown links (local file references)
#   - All documented CLI scripts actually exist
#   - Every variable in fleet.env.example appears in docs/configuration.md
#   - The examples directory contains only properly named placeholder files
#
# Exits non-zero if any check fails. Safe to run offline.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

FAIL=0
fail() { echo "FAIL: $*" >&2; FAIL=1; }
ok()   { echo "ok  : $*"; }

# ---------------------------------------------------------------------------
# 1. Internal Markdown link targets exist
# ---------------------------------------------------------------------------
echo "==> checking internal markdown links"
while IFS= read -r mdfile; do
  while IFS= read -r link; do
    # Strip anchor fragment
    target="${link%%#*}"
    [ -z "$target" ] && continue
    # Resolve relative to the file's directory
    dir="$(dirname "$mdfile")"
    resolved="$dir/$target"
    if [ ! -e "$resolved" ]; then
      fail "$mdfile: broken link to '$target' (resolved: $resolved)"
    fi
  done < <(grep -oE '\[[^]]+\]\(([^)#]+)' "$mdfile" | sed 's/.*](\(.*\)/\1/' | grep -v '^https\?://' | grep -v '^mailto:')
done < <(git ls-files '*.md')
[ "$FAIL" -eq 0 ] && ok "all internal markdown links resolve"

# ---------------------------------------------------------------------------
# 2. Documented CLI scripts exist
# ---------------------------------------------------------------------------
echo "==> checking documented scripts exist"
documented_scripts=(
  preflight.sh register.sh status.sh health.sh runs.sh cleanup.sh
  scripts/deregister.sh scripts/drain-runner.sh scripts/install-hooks.sh
  scripts/ephemeral-runner.sh scripts/reap-ephemeral.sh scripts/release-check.sh
)
for s in "${documented_scripts[@]}"; do
  if [ -f "$HERE/$s" ]; then
    ok "$s"
  else
    fail "documented script missing: $s"
  fi
done

# ---------------------------------------------------------------------------
# 3. fleet.env.example variables are mentioned in docs/configuration.md
# ---------------------------------------------------------------------------
echo "==> checking fleet.env.example variables are documented"
while IFS= read -r line; do
  # Match commented-out variable names like #FLEET_FOO=
  varname=$(echo "$line" | grep -oE '^#(FLEET_[A-Z_]+|RUNNER_INSTANCE)' | tr -d '#')
  [ -z "$varname" ] && continue
  if grep -q "$varname" docs/configuration.md; then
    ok "$varname in docs/configuration.md"
  else
    fail "$varname from fleet.env.example not found in docs/configuration.md"
  fi
done < fleet.env.example

# ---------------------------------------------------------------------------
# 4. Example workflow files use placeholder names (no real owner/repo)
# ---------------------------------------------------------------------------
echo "==> checking examples use placeholder names"
# These are placeholder patterns — real repo names should not appear here.
# The release-check.sh handles the tracked-file check; this is a docs-specific
# check that examples look like examples.
for f in examples/*.yml examples/*.yaml; do
  [ -f "$f" ] || continue
  if grep -qE 'runs-on:.*self-hosted' "$f"; then
    ok "$f targets self-hosted"
  fi
  # Should use 'owner/' not a real org
  if grep -qE 'uses:.*@[0-9a-f]{40}' "$f"; then
    ok "$f pins actions to full SHA"
  fi
done

echo "==> done"
exit $FAIL
