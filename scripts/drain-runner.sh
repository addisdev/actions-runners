#!/usr/bin/env bash
# Mark one runner as draining or drained, and optionally stop it.
#
#   scripts/drain-runner.sh <dir-name>               # show current drain state
#   scripts/drain-runner.sh <dir-name> --drain        # stop if idle, mark draining if busy
#   scripts/drain-runner.sh <dir-name> --stop         # stop service immediately (--drain does this too when idle)
#   scripts/drain-runner.sh <dir-name> --resume       # clear drain marker and start service
#
# The drain marker is a .drain file written to the runner's directory. The
# dashboard daemon reads it on every tick and reports the runner as drained/
# draining instead of raising a "dead" drift alert. health.sh --repair skips
# drained runners intentionally — the whole point of a drain is that you want
# it stopped.
#
# A drained runner is NOT deregistered from GitHub. It remains on the roster,
# still accepting the runner_events that would be sent to it — it just will not
# pick them up. That is best-effort by design: GitHub has no temporary-disable
# API, so the runner continues to show as "online" until it misses enough
# heartbeats to be declared offline. The dashboard explains this wherever drain
# state is shown.
#
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED
# When this script adds a drain marker while the runner is BUSY, it also
# writes a .drain-stop file as a flag for a completion hook. That hook is
# configured by register.sh via ACTIONS_RUNNER_HOOK_JOB_COMPLETED: the hook
# checks for .drain-stop and calls `./svc.sh stop` if it exists, which stops
# the service cleanly after the in-flight job reports completion. This prevents
# killing a job mid-run while still guaranteeing the runner stops.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(dirname "$HERE")}"
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

TARGET=""
MODE=show
for a in "$@"; do
  case "$a" in
    --drain)  MODE=drain ;;
    --stop)   MODE=stop ;;
    --resume) MODE=resume ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) [ -z "$TARGET" ] && TARGET="$a" || { echo "one runner at a time" >&2; exit 2; } ;;
  esac
done

[ -n "$TARGET" ] || { echo "usage: drain-runner.sh <dir-name> [--drain|--stop|--resume]" >&2; exit 2; }

case "$TARGET" in
  */*|..|.) echo "refusing: '$TARGET' is not a plain directory name" >&2; exit 2 ;;
esac

DIR="$ROOT/$TARGET"
[ -f "$DIR/.runner" ] || { echo "no runner at $DIR" >&2; exit 1; }

NAME=$(python3 -c "import json;print(json.load(open('$DIR/.runner',encoding='utf-8-sig'))['agentName'])" 2>/dev/null)
DRAIN_FILE="$DIR/.drain"
DRAIN_STOP_FILE="$DIR/.drain-stop"

# ---- show -------------------------------------------------------------------
if [ "$MODE" = show ]; then
  if [ -f "$DRAIN_FILE" ]; then
    cat "$DRAIN_FILE"
  else
    echo "$NAME: not draining"
  fi
  exit 0
fi

# ---- resume -----------------------------------------------------------------
if [ "$MODE" = resume ]; then
  rm -f "$DRAIN_FILE" "$DRAIN_STOP_FILE"
  echo "==> drain marker removed"
  cd "$DIR" && ./svc.sh start && echo "==> service started"
  echo "done: $NAME is resumed"
  exit 0
fi

# ---- drain or stop ----------------------------------------------------------
BUSY=0
if pgrep -f "$DIR/bin/Runner.Worker" >/dev/null 2>&1; then
  BUSY=1
fi

if [ "$MODE" = drain ]; then
  if [ "$BUSY" = 1 ]; then
    # Write the marker now so the dashboard reports "draining" immediately.
    # Write the stop-flag so the completion hook calls svc.sh stop after the job.
    printf 'draining\nrequested_at=%s\n' "$(date -u +%s)" > "$DRAIN_FILE"
    touch "$DRAIN_STOP_FILE"
    echo "$NAME is busy — marked as draining"
    echo "The service will stop automatically after the current job completes."
    echo "(Requires ACTIONS_RUNNER_HOOK_JOB_COMPLETED to be configured — see register.sh)"
  else
    printf 'drained\nrequested_at=%s\n' "$(date -u +%s)" > "$DRAIN_FILE"
    cd "$DIR" && ./svc.sh stop >/dev/null 2>&1 && echo "==> service stopped"
    echo "done: $NAME is drained"
  fi
elif [ "$MODE" = stop ]; then
  printf 'drained\nrequested_at=%s\n' "$(date -u +%s)" > "$DRAIN_FILE"
  cd "$DIR" && ./svc.sh stop >/dev/null 2>&1 && echo "==> service stopped"
  echo "done: $NAME stopped and marked drained"
fi
