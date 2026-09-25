#!/usr/bin/env bash
# Periodic health repair entry point for launchd.
#
# Called by the LaunchAgent that healthctl.sh installs — not meant for manual
# use. Uses a lock directory so a slow sweep (many runners, gh latency) cannot
# overlap the next StartInterval tick.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"
ROOT="${FLEET_ROOT:-$ROOT}"
LOG="${FLEET_HEALTH_LOG:-$ROOT/logs/fleet-health-repair.log}"
LOCKDIR="${FLEET_HEALTH_LOCK:-$ROOT/.health-repair.lock.d}"

mkdir -p "$(dirname "$LOG")"

if [ -d "$LOCKDIR" ]; then
  oldpid="$(cat "$LOCKDIR/pid" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    printf '%s skip — previous repair still running (pid %s)\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$oldpid" >> "$LOG"
    exit 0
  fi
  rm -rf "$LOCKDIR"
fi

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  printf '%s skip — could not acquire lock\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCKDIR/pid"
trap 'rm -rf "$LOCKDIR"' EXIT INT TERM

printf '%s start health.sh --repair\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
set +e
"$ROOT/health.sh" --repair >> "$LOG" 2>&1
rc=$?
set -e
printf '%s finish exit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >> "$LOG"
exit "$rc"
