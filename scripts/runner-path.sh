#!/usr/bin/env bash
# Give every runner on this host the same job PATH.
#
#   scripts/runner-path.sh            # list runners whose job PATH differs
#   scripts/runner-path.sh --apply    # rewrite those that are idle, restart them
#
# A job's PATH comes from the runner's .path file, which config.sh fills with
# whatever $PATH the shell that registered it had. So runners registered from a
# login shell, an SSH session or a script each ran jobs differently: on
# runner-host there were six PATHs, 17 runners with no Homebrew at all and nine
# with nvm's Node and SnowSQL from an interactive shell. register.sh now writes
# the fleet PATH itself (FLEET_RUNNER_PATH, default below); this brings the
# runners registered before that in line.
#
# Changing a runner's PATH changes which python3, node or git its jobs find.
# Dry run by default; --apply touches only runners with no job running
# (no Runner.Worker under their directory) and restarts each so .path is read
# again; a drained runner gets the new PATH but stays stopped. A busy runner is reported and left for the next run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"
WANT="${FLEET_RUNNER_PATH:-/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin}"

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  '') ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

echo "fleet job PATH: $WANT"
same=0; changed=0; busy=0; failed=0
for dir in "$ROOT"/*/; do
  dir="${dir%/}"
  [ -f "$dir/.runner" ] || continue
  name="$(basename "$dir")"
  have="$(cat "$dir/.path" 2>/dev/null || true)"
  if [ "$have" = "$WANT" ]; then
    same=$((same + 1)); continue
  fi
  if pgrep -f "$dir/bin[^/]*/Runner.Worker" >/dev/null 2>&1; then
    echo "  busy  $name  (${have:0:60}…)"
    busy=$((busy + 1)); continue
  fi
  if [ "$APPLY" -ne 1 ]; then
    echo "  would $name  ${have:0:70}"
    changed=$((changed + 1)); continue
  fi
  printf '%s\n' "$WANT" > "$dir/.path"
  if grep -q '^PATH=' "$dir/.env" 2>/dev/null; then
    tmp="$(mktemp)"
    sed "s|^PATH=.*|PATH=$WANT|" "$dir/.env" > "$tmp" && cat "$tmp" > "$dir/.env"
    rm -f "$tmp"
  fi
  # A drained runner (scripts/drain-runner.sh) is stopped on purpose: give it the
  # PATH for when it is resumed, but starting it here would undo the drain.
  if [ -f "$dir/.drain" ]; then
    echo "  set   $name (drained: left stopped)"
    changed=$((changed + 1)); continue
  fi
  if (cd "$dir" && ./svc.sh stop >/dev/null 2>&1; ./svc.sh start >/dev/null 2>&1); then
    echo "  set   $name"
    changed=$((changed + 1))
  else
    echo "  !!    $name: PATH written but svc.sh start failed — check ./svc.sh status" >&2
    failed=$((failed + 1))
  fi
done
verb=$([ "$APPLY" -eq 1 ] && echo "rewritten" || echo "would change")
echo "$same already match, $changed $verb, $busy busy (re-run later), $failed failed"
[ "$failed" -eq 0 ]
