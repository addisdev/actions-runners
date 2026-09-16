#!/usr/bin/env bash
# Shuts down simulators created by selected CI jobs without touching devices
# that were already booted before the first overlapping job began.
#
# A lease per Runner.Worker makes cleanup cancellation-safe. The normal
# job-completed hook releases it; a detached guardian does the same if the
# worker dies before that hook runs. Simulators are shut down only after the
# final selected job ends, so overlapping iOS jobs cannot kill each other.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"
STATE="$ROOT/.simulator-cleanup"
JOBS="$STATE/jobs"
MUTEX="$STATE/mutex"
BASELINE="$STATE/baseline"

[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

sim_enabled() {
  [ "${FLEET_SIMULATOR_CLEANUP:-0}" = "1" ]
}

sim_selected() {
  local selected name
  local -a names
  selected="${FLEET_SIMULATOR_RUNNERS:-}"
  selected="${selected//,/ }"
  read -r -a names <<< "$selected"
  for name in "${names[@]}"; do
    # Entries are shell patterns, so one host-independent selector continues to
    # cover runners registered later with the standard <host>-<repo> name.
    # shellcheck disable=SC2254
    case "${RUNNER_NAME:-}" in
      $name) return 0 ;;
    esac
  done
  return 1
}

simctl_path() {
  if [ -n "${FLEET_SIMCTL:-}" ] && [ -x "$FLEET_SIMCTL" ]; then
    printf '%s' "$FLEET_SIMCTL"
  elif [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/simctl ]; then
    # Bypass xcrun: after an Xcode update it can be blocked by the license
    # prompt even though CoreSimulator itself is available for cleanup.
    printf '%s' /Applications/Xcode.app/Contents/Developer/usr/bin/simctl
  elif command -v xcrun >/dev/null 2>&1; then
    printf '%s' xcrun
  fi
}

sim_pid_live() {
  local status
  kill -0 "$1" 2>/dev/null || return 1
  status="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"
  case "$status" in
    '' | Z*) return 1 ;;
  esac
  return 0
}

sim_key() {
  printf '%s' "${RUNNER_NAME:-unknown}" | tr -c 'A-Za-z0-9._-' '_'
}

sim_owner_pid() {
  local pid="$PPID" depth=0 command parent
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 12 ]; do
    command="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$command" in
      *Runner.Worker*) printf '%s' "$pid"; return 0 ;;
    esac
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$parent" in
      '' | *[!0-9]*) break ;;
    esac
    pid="$parent"
    depth=$((depth + 1))
  done
  printf '%s' "$PPID"
}

sim_lock() {
  local tries=0 holder age now mtime
  mkdir -p "$STATE" 2>/dev/null || return 1
  while ! mkdir "$MUTEX" 2>/dev/null; do
    holder="$(sed -n 's/^pid=//p' "$MUTEX/owner" 2>/dev/null)"
    if [ -n "$holder" ] && ! sim_pid_live "$holder"; then
      rm -rf "$MUTEX" 2>/dev/null
      continue
    fi
    mtime="$(stat -f %m "$MUTEX" 2>/dev/null || stat -c %Y "$MUTEX" 2>/dev/null)"
    now="$(date +%s)"
    age=""
    [ -n "$mtime" ] && age=$((now - mtime))
    if [ -n "$age" ] && [ "$age" -gt 60 ]; then
      rm -rf "$MUTEX" 2>/dev/null
      continue
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 100 ] && return 1
    sleep 0.1
  done
  printf 'pid=%s\n' "$$" > "$MUTEX/owner" 2>/dev/null || true
}

sim_unlock() {
  rm -rf "$MUTEX" 2>/dev/null || true
}

sim_reap() {
  local lease pid
  mkdir -p "$JOBS" 2>/dev/null || return 0
  for lease in "$JOBS"/*; do
    [ -f "$lease" ] || continue
    pid="$(sed -n 's/^pid=//p' "$lease" 2>/dev/null)"
    if [ -z "$pid" ] || ! sim_pid_live "$pid"; then
      rm -f "$lease" 2>/dev/null
    fi
  done
}

sim_has_jobs() {
  local lease
  for lease in "$JOBS"/*; do
    [ -f "$lease" ] && return 0
  done
  return 1
}

sim_booted() {
  local tool
  tool="$(simctl_path)"
  [ -n "$tool" ] || return 0
  if [ "$tool" = xcrun ]; then
    xcrun simctl list devices booted 2>/dev/null
  else
    "$tool" list devices booted 2>/dev/null
  fi | awk '
    /\(Booted\)/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^\([0-9A-Fa-f-]+\)$/) {
          gsub(/[()]/, "", $i)
          print $i
          break
        }
      }
    }'
}

sim_shutdown() {
  local udid="$1" tool
  tool="$(simctl_path)"
  [ -n "$tool" ] || return 0
  if [ "$tool" = xcrun ]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  else
    "$tool" shutdown "$udid" >/dev/null 2>&1 || true
  fi
}

sim_cleanup_new_devices() {
  local udid
  [ -f "$BASELINE" ] || return 0
  sim_booted | while read -r udid; do
    [ -n "$udid" ] || continue
    grep -Fxq "$udid" "$BASELINE" 2>/dev/null || sim_shutdown "$udid"
  done
}

sim_release() {
  local key="$1"
  sim_lock || return 0
  rm -f "$JOBS/$key" 2>/dev/null
  sim_reap
  if ! sim_has_jobs; then
    sim_cleanup_new_devices
    rm -f "$BASELINE" 2>/dev/null
  fi
  sim_unlock
}

sim_start() {
  local owner="${1:-}" key tmp
  sim_enabled && sim_selected || return 0
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] || return 0
  [ -n "$(simctl_path)" ] || return 0
  [ -n "$owner" ] || owner="$(sim_owner_pid)"
  case "$owner" in
    '' | *[!0-9]*) return 0 ;;
  esac

  key="$(sim_key)"
  sim_lock || return 0
  mkdir -p "$JOBS" 2>/dev/null || { sim_unlock; return 0; }
  sim_reap
  if ! sim_has_jobs; then
    # Recover devices left by a prior job whose guardian was itself killed,
    # then preserve whatever the user already had booted as the new baseline.
    sim_cleanup_new_devices
    sim_booted > "$BASELINE"
  fi
  tmp="$JOBS/.${key}.$$"
  printf 'pid=%s\nrunner=%s\n' "$owner" "${RUNNER_NAME:-}" > "$tmp" 2>/dev/null || {
    sim_unlock
    return 0
  }
  mv "$tmp" "$JOBS/$key" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null
    sim_unlock
    return 0
  }
  sim_unlock

  RUNNER_TRACKING_ID="" FLEET_ROOT="$ROOT" \
    nohup bash "$HERE/simulator-control.sh" guard "$key" "$owner" >/dev/null 2>&1 &
}

sim_guard() {
  local key="$1" owner="$2" lease lease_owner
  lease="$JOBS/$key"
  while [ -f "$lease" ]; do
    lease_owner="$(sed -n 's/^pid=//p' "$lease" 2>/dev/null)"
    [ "$lease_owner" = "$owner" ] || return 0
    if ! sim_pid_live "$owner"; then
      sim_release "$key"
      return 0
    fi
    sleep 2
  done
}

case "${1:-}" in
  start) sim_start "${2:-}" ;;
  complete)
    sim_enabled && sim_selected && sim_release "$(sim_key)"
    ;;
  guard) sim_guard "${2:-}" "${3:-}" ;;
  *) exit 0 ;;
esac

exit 0
