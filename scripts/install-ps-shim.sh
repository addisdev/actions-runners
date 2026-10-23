#!/usr/bin/env bash
# Put shims/ps first on the runners' PATH, so the runner's orphan scan stops
# spawning /bin/ps once per process (see shims/ps for why and what it costs).
#
#   scripts/install-ps-shim.sh            # show what would change
#   scripts/install-ps-shim.sh --apply    # link it
#   scripts/install-ps-shim.sh --remove --apply
#
# It links `ps` in the FIRST directory of the runners' .path (every runner here
# starts with /opt/homebrew/bin), which takes effect on the next process the
# runner starts: no runner restart, no job interrupted. It refuses when the
# runners disagree on that first directory, or when a real file (not our link)
# named ps is already there. The link passes every other ps call to /bin/ps.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"
SHIM="${FLEET_PS_SHIM_SOURCE:-$HERE/shims/ps}"
APPLY=0; REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done
[ -x "$SHIM" ] || { echo "missing or not executable: $SHIM" >&2; exit 1; }

shopt -s nullglob
firsts=()
for p in "$ROOT"/*/.path; do firsts+=("$(cut -d: -f1 < "$p")"); done
[ "${#firsts[@]}" -gt 0 ] || { echo "no runners under $ROOT (no */.path)" >&2; exit 1; }
DIR="$(printf '%s\n' "${firsts[@]}" | sort -u)"
[ "$(printf '%s\n' "$DIR" | wc -l | tr -d ' ')" = 1 ] || {
  echo "runners disagree on the first PATH directory:" >&2; printf '  %s\n' $DIR >&2; exit 1; }
TARGET="$DIR/ps"
echo "${#firsts[@]} runners; first PATH directory: $DIR"

if [ "$REMOVE" -eq 1 ]; then
  if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$SHIM" ]; then
    [ "$APPLY" -eq 1 ] && rm "$TARGET" && echo "removed $TARGET" || echo "would remove $TARGET"
  else
    echo "nothing to remove at $TARGET"
  fi
  exit 0
fi
if [ -e "$TARGET" ] && ! { [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$SHIM" ]; }; then
  echo "refusing: $TARGET exists and is not this shim" >&2; exit 1
fi
if [ -L "$TARGET" ]; then echo "already linked: $TARGET -> $SHIM"; exit 0; fi
if [ "$APPLY" -eq 1 ]; then ln -s "$SHIM" "$TARGET" && echo "linked $TARGET -> $SHIM"; else echo "would link $TARGET -> $SHIM"; fi
