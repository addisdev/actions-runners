#!/usr/bin/env bash
# Switch this host off as a CI host, or pause new-runner placement on it.
#
#   scripts/host-drain.sh --status   # on, new runners paused, or off
#   scripts/host-drain.sh --off      # take no CI jobs here: every runner drains
#   scripts/host-drain.sh --on       # undo --off
#   scripts/host-drain.sh --drain    # pause new runners only; existing ones keep taking jobs
#   scripts/host-drain.sh --resume   # undo --drain
#
# Both states live in one .drain file at the fleet root, the same file name a
# runner directory uses for its own drain. Its first line is `off` for a host
# that is switched off and `drained` for one with new runners paused. Either
# keeps autoscale from placing a runner here.
#
# --off drains every runner with `drain-runner.sh --drain --by=host`: an idle
# runner stops now, a busy one finishes its current job first. A runner already
# drained by somebody else (an operator, the tiers controller) is left alone.
#
# --on resumes only the runners --off drained (markers with by=host). A runner
# that was drained before the host went off, or was drained by hand while it
# was off, stays drained.
#
# Nothing is deregistered. GitHub keeps each runner on its roster and shows it
# offline once it stops, so jobs for repos with no runner anywhere else queue
# until the host is back on.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(dirname "$HERE")}"
MARKER="$ROOT/.drain"
OWNER=host

state() {
  if [ ! -f "$MARKER" ]; then echo on; return; fi
  case "$(head -1 "$MARKER" 2>/dev/null | tr -d '\r')" in
    off) echo off ;;
    *) echo paused ;;
  esac
}

runner_dirs() {
  for d in "$ROOT"/*/; do
    [ -f "$d.runner" ] && basename "$d"
  done
}

case "${1:-}" in
  --status)
    case "$(state)" in
      off) echo "host is off: no runner here takes CI jobs" ;;
      paused) echo "host is on, new runners paused: existing runners take jobs, autoscale adds none" ;;
      on) echo "host is on" ;;
    esac
    ;;

  --off)
    printf 'off\nrequested_at=%s\nby=%s\n' "$(date -u +%s)" "$OWNER" > "$MARKER"
    echo "==> host marked off"
    FAILED=0
    COUNT=0
    for dir in $(runner_dirs); do
      COUNT=$((COUNT + 1))
      if ! OUT="$("$HERE/drain-runner.sh" "$dir" --drain --by="$OWNER" 2>&1)"; then
        FAILED=$((FAILED + 1))
      fi
      echo "$dir: $(printf '%s' "$OUT" | tail -1)"
    done
    if [ "$FAILED" -gt 0 ]; then
      echo "host is off, but $FAILED of $COUNT runner(s) could not be drained — see above" >&2
      exit 1
    fi
    echo "done: host is off ($COUNT runner(s)); busy runners stop after their current job"
    ;;

  --on)
    rm -f "$MARKER"
    echo "==> host marked on"
    FAILED=0
    RESUMED=0
    for dir in $(runner_dirs); do
      [ "$(sed -n 's/^by=//p' "$ROOT/$dir/.drain" 2>/dev/null | head -1 | tr -d '\r')" = "$OWNER" ] || continue
      if OUT="$("$HERE/drain-runner.sh" "$dir" --resume --by="$OWNER" 2>&1)"; then
        RESUMED=$((RESUMED + 1))
      else
        FAILED=$((FAILED + 1))
      fi
      echo "$dir: $(printf '%s' "$OUT" | tail -1)"
    done
    if [ "$FAILED" -gt 0 ]; then
      echo "host is on, but $FAILED runner(s) could not be resumed — see above" >&2
      exit 1
    fi
    echo "done: host is on; $RESUMED runner(s) resumed"
    ;;

  --drain)
    if [ "$(state)" = off ]; then
      echo "host is off, which already stops new runners — nothing to do"
      exit 0
    fi
    printf 'drained\n' > "$MARKER"
    echo "host drained: new runner placement is disabled"
    ;;

  --resume)
    if [ "$(state)" = off ]; then
      echo "refusing: host is off — use --on, which also resumes its runners" >&2
      exit 1
    fi
    rm -f "$MARKER"
    echo "host resumed: new runner placement is enabled"
    ;;

  -h|--help)
    sed -n '2,25p' "$0"
    ;;

  *)
    echo "usage: host-drain.sh --status|--off|--on|--drain|--resume" >&2
    exit 2
    ;;
esac
