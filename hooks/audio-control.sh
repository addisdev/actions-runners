#!/usr/bin/env bash
# Mutes host output while selected runners execute jobs. Apple simulators do not
# expose a supported per-simulator mute, so this wraps the job instead and puts
# the host's previous mute state back when the job ends.
#
# A detached guardian follows Runner.Worker. If a cancelled job never reaches
# job-completed.sh, the guardian releases its lease when that worker exits. Each
# selected job owns one lease so overlapping jobs cannot unmute one another.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"
AUDIO_STATE="$ROOT/.audio-mute"
AUDIO_JOBS="$AUDIO_STATE/jobs"
AUDIO_MUTEX="$AUDIO_STATE/mutex"
AUDIO_ORIGINAL="$AUDIO_STATE/original"

[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

audio_key() {
  local raw="${RUNNER_NAME:-unknown}"
  printf '%s' "$raw" | tr -c 'A-Za-z0-9._-' '_'
}

audio_selected() {
  local selected name
  selected="${FLEET_MUTE_RUNNERS:-}"
  selected="${selected//,/ }"
  for name in $selected; do
    [ "$name" = "${RUNNER_NAME:-}" ] && return 0
  done
  return 1
}

audio_pid_live() {
  local status
  kill -0 "$1" 2>/dev/null || return 1
  status="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"
  case "$status" in
    '' | Z*) return 1 ;;
  esac
  return 0
}

audio_lock() {
  local tries=0 holder age now mtime
  mkdir -p "$AUDIO_STATE" 2>/dev/null || return 1
  while ! mkdir "$AUDIO_MUTEX" 2>/dev/null; do
    holder="$(sed -n 's/^pid=//p' "$AUDIO_MUTEX/owner" 2>/dev/null)"
    if [ -n "$holder" ] && ! audio_pid_live "$holder"; then
      rm -rf "$AUDIO_MUTEX" 2>/dev/null
      continue
    fi
    mtime="$(stat -f %m "$AUDIO_MUTEX" 2>/dev/null || stat -c %Y "$AUDIO_MUTEX" 2>/dev/null)"
    now="$(date +%s)"
    age=""
    [ -n "$mtime" ] && age=$((now - mtime))
    if [ -n "$age" ] && [ "$age" -gt 60 ]; then
      rm -rf "$AUDIO_MUTEX" 2>/dev/null
      continue
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 100 ] && return 1
    sleep 0.1
  done
  printf 'pid=%s\n' "$$" > "$AUDIO_MUTEX/owner" 2>/dev/null || true
}

audio_unlock() {
  rm -rf "$AUDIO_MUTEX" 2>/dev/null || true
}

audio_reap() {
  local lease pid
  mkdir -p "$AUDIO_JOBS" 2>/dev/null || return 0
  for lease in "$AUDIO_JOBS"/*; do
    [ -f "$lease" ] || continue
    pid="$(sed -n 's/^pid=//p' "$lease" 2>/dev/null)"
    if [ -z "$pid" ] || ! audio_pid_live "$pid"; then
      rm -f "$lease" 2>/dev/null
    fi
  done
}

audio_has_jobs() {
  local lease
  for lease in "$AUDIO_JOBS"/*; do
    [ -f "$lease" ] && return 0
  done
  return 1
}

audio_owner_pid() {
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

audio_restore_if_idle() {
  local muted
  audio_reap
  audio_has_jobs && return 0
  [ -f "$AUDIO_ORIGINAL" ] || return 0
  muted="$(sed -n 's/^muted=//p' "$AUDIO_ORIGINAL" 2>/dev/null)"
  case "$muted" in
    true) osascript -e 'set volume with output muted' >/dev/null 2>&1 ;;
    false) osascript -e 'set volume without output muted' >/dev/null 2>&1 ;;
  esac
  rm -f "$AUDIO_ORIGINAL" 2>/dev/null
}

audio_release() {
  local key="$1"
  audio_lock || return 0
  rm -f "$AUDIO_JOBS/$key" 2>/dev/null
  audio_restore_if_idle
  audio_unlock
}

audio_start() {
  local owner="${1:-}" key current tmp
  audio_selected || return 0
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  [ -n "$owner" ] || owner="$(audio_owner_pid)"
  case "$owner" in
    '' | *[!0-9]*) return 0 ;;
  esac

  key="$(audio_key)"
  audio_lock || return 0
  mkdir -p "$AUDIO_JOBS" 2>/dev/null || { audio_unlock; return 0; }
  audio_reap
  if [ ! -f "$AUDIO_ORIGINAL" ]; then
    current="$(osascript -e 'output muted of (get volume settings)' 2>/dev/null)"
    case "$current" in
      true | false) printf 'muted=%s\n' "$current" > "$AUDIO_ORIGINAL" ;;
      *) audio_unlock; return 0 ;;
    esac
  fi
  tmp="$AUDIO_JOBS/.${key}.$$"
  printf 'pid=%s\nrunner=%s\n' "$owner" "${RUNNER_NAME:-}" > "$tmp" 2>/dev/null || {
    audio_unlock
    return 0
  }
  mv "$tmp" "$AUDIO_JOBS/$key" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null
    audio_unlock
    return 0
  }
  if ! osascript -e 'set volume with output muted' >/dev/null 2>&1; then
    rm -f "$AUDIO_JOBS/$key" "$AUDIO_ORIGINAL" 2>/dev/null
    audio_unlock
    return 0
  fi
  audio_unlock

  # The runner kills descendants carrying its tracking token during cleanup.
  # Clear it so the guardian survives long enough to observe an abrupt worker
  # exit and restore audio.
  RUNNER_TRACKING_ID="" FLEET_ROOT="$ROOT" \
    nohup bash "$HERE/audio-control.sh" guard "$key" "$owner" >/dev/null 2>&1 &
}

audio_guard() {
  local key="$1" owner="$2" lease lease_owner
  lease="$AUDIO_JOBS/$key"
  while [ -f "$lease" ]; do
    # A new job on the same runner may replace this lease before an old
    # guardian wakes. Never let the old guardian release the new job's lease.
    lease_owner="$(sed -n 's/^pid=//p' "$lease" 2>/dev/null)"
    [ "$lease_owner" = "$owner" ] || return 0
    if ! audio_pid_live "$owner"; then
      audio_release "$key"
      return 0
    fi
    sleep 2
  done
}

case "${1:-}" in
  start) audio_start "${2:-}" ;;
  complete) audio_release "$(audio_key)" ;;
  guard) audio_guard "${2:-}" "${3:-}" ;;
  *) exit 0 ;;
esac

exit 0
