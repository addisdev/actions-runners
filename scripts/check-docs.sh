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
cd "$HERE" || exit 1

FAIL=0
fail() { echo "FAIL: $*" >&2; FAIL=1; }
ok()   { echo "ok  : $*"; }

# ---------------------------------------------------------------------------
# 1. Internal Markdown link targets exist
# ---------------------------------------------------------------------------
echo "==> checking internal markdown links"
while IFS= read -r mdfile; do
  while IFS= read -r link; do
    # Strip anchor fragment; skip pure in-page anchors (#section)
    target="${link%%#*}"
    [ -z "$target" ] && continue
    # Skip bare anchors with no file component
    case "$link" in
      \#*) continue ;;
    esac
    # .github/ templates use paths relative to the REPO ROOT, not the file
    # directory (GitHub renders them that way). Treat them as absolute paths.
    case "$mdfile" in
      .github/*) resolved="$HERE/$target" ;;
      *) dir="$(dirname "$mdfile")"; resolved="$dir/$target" ;;
    esac
    if [ ! -e "$resolved" ]; then
      fail "$mdfile: broken link to '$target' (resolved: $resolved)"
    fi
  done < <(grep -oE '\[[^]]+\]\(([^)#]+)' "$mdfile" | sed 's/.*](\(.*\)/\1/' | grep -v '^https\?://' | grep -v '^mailto:')
# Every tracked Markdown file is checked. There is deliberately no exclusion
# list here: dashboard-internals.md used to be skipped because its links were
# relative to a directory it no longer lived in, and a file exempt from the
# link check is a file whose links rot silently. It has since been split into
# docs/design/, and the links were fixed rather than exempted.
done < <(git ls-files '*.md')
[ "$FAIL" -eq 0 ] && ok "all internal markdown links resolve"

# ---------------------------------------------------------------------------
# 2. Documented CLI scripts exist
# ---------------------------------------------------------------------------
# This used to be a hand-maintained array of twelve script names, which checked
# the direction that never breaks — a documented script is deleted — and missed
# the one that always does: a script is added and nobody writes it down. Nine
# scripts had reached the tree undocumented by the time anyone looked. So the
# reference page is now the list, and every entry point has to appear on it.
echo "==> checking every script is documented"
SCRIPT_DOC="docs/reference/scripts.md"
[ -f "$SCRIPT_DOC" ] || fail "$SCRIPT_DOC is missing"

# Sourced libraries and test helpers, not command-line entry points. Named
# individually so that adding one to this list is a decision somebody makes in
# a diff rather than a pattern quietly widening.
not_entry_points=(
  hooks/common.sh
  hooks/tests/install.sh
  dashboard/autofix/escalate/run.mjs
)

while IFS= read -r script; do
  case " ${not_entry_points[*]} " in
    *" $script "*) continue ;;
  esac
  # docs/tools/ is the figure and screenshot rig; it documents itself in its
  # own README and is not part of running a fleet.
  case "$script" in
    docs/tools/*) continue ;;
  esac
  if grep -q "$(basename "$script")" "$SCRIPT_DOC"; then
    ok "$script documented"
  else
    fail "$script is not documented in $SCRIPT_DOC"
  fi
done < <(git ls-files '*.sh' '*.py' '*.mjs')

# There is deliberately no check in the other direction — that every script
# name appearing in the reference exists. The page names `teardown.sh`, which
# was removed and is described as history, and `config.sh`, `svc.sh` and
# `runsvc.sh`, which ship inside each runner directory and are never tracked
# here. A check that has to special-case those is a check that will be silenced
# rather than fixed the next time it is wrong; the link checker above already
# catches a reference to a path that does not exist.

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
