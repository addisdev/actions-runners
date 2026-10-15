#!/usr/bin/env bash
# Install, run and inspect the disk-cleanup LaunchAgent.
#
#   ./cleanupctl.sh install     # write the LaunchAgent and load it
#   ./cleanupctl.sh status      # is it loaded, and what did the last run say
#   ./cleanupctl.sh logs [n]    # tail the cleanup log
#   ./cleanupctl.sh restart
#   ./cleanupctl.sh uninstall
#   ./cleanupctl.sh run         # one `cleanup.sh --apply --auto` in the foreground
#
# Runs `cleanup.sh --apply --auto` every FLEET_CLEANUP_INTERVAL seconds (900).
# Most ticks cost one disk read and exit; the script does real work under the
# pressure line (FLEET_ADMIT_MIN_FREE_DISK_GB + 20 by default) or once a day.
# What it may delete, and what it never touches, is in cleanup.sh's header.
# This installs its own plist only; it never touches the runner LaunchAgents.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"
LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.runner-cleanup"
INTERVAL="${FLEET_CLEANUP_INTERVAL:-900}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="${FLEET_CLEANUP_LOG:-$HOME/Library/Logs/runner-cleanup.log}"
SCRIPT="$HERE/cleanup.sh"
DOMAIN="gui/$(id -u)"
# The same job PATH the runners get (register.sh), so cleanup's gh, python3
# and xcrun are the ones the jobs use.
JOB_PATH="${FLEET_RUNNER_PATH:-/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin}"

# bootstrap into the login session's gui domain: `launchctl load` from an SSH
# shell lands in a background domain that goes away with the session.
load_agent() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
}

cmd_install() {
  [ -x "$SCRIPT" ] || chmod +x "$SCRIPT"
  mkdir -p "$(dirname "$LOG")" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT</string>
    <string>--apply</string>
    <string>--auto</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$JOB_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>FLEET_ROOT</key><string>$ROOT</string>
  </dict>
  <!-- A timer, not a resident daemon. No RunAtLoad: after a login every
       runner starts at once, and the first tick 15 minutes later is soon
       enough. cleanup.sh holds its own lock, so ticks never overlap. -->
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
  plutil -lint "$PLIST" >/dev/null
  load_agent
  echo "loaded $LABEL"
  echo "script:   $SCRIPT --apply --auto"
  echo "interval: ${INTERVAL}s"
  echo "log:      $LOG"
  cmd_status
}

cmd_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "unloaded and removed $PLIST"
}

cmd_start()   { launchctl bootstrap "$DOMAIN" "$PLIST"; }
cmd_stop()    { launchctl bootout "$DOMAIN/$LABEL"; }
cmd_restart() { load_agent; cmd_status; }

cmd_status() {
  local out runs exitcode
  if out="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"; then
    runs="$(printf '%s\n' "$out" | awk -F'= ' '/^\truns =/{print $2}')"
    exitcode="$(printf '%s\n' "$out" | awk -F'= ' '/last exit code =/{print $2; exit}')"
    echo "launchd: loaded in $DOMAIN (runs ${runs:-0}, last exit ${exitcode:-none yet})"
  else
    echo "launchd: not loaded"
  fi
  echo "plist:   $PLIST"
  echo "every:   ${INTERVAL}s (reinstall after changing FLEET_CLEANUP_INTERVAL)"
  local floor="${FLEET_ADMIT_MIN_FREE_DISK_GB:-40}"
  echo "acts:    under ${FLEET_CLEANUP_PRESSURE_GB:-$((floor + 20))} GB usable (admission floor ${floor} GB), else once per ${FLEET_CLEANUP_FULL_EVERY_S:-86400}s"
  if [ -f "$LOG" ]; then
    echo "last:    $(grep '^==> 20' "$LOG" | tail -n 1)"
    echo "         $(grep '^==> free after' "$LOG" | tail -n 1)"
  else
    echo "log:     nothing written yet — $LOG"
  fi
}

cmd_logs() { tail -n "${1:-60}" "$LOG"; }

cmd_run() {
  export FLEET_ROOT="$ROOT" PATH="$JOB_PATH"
  exec /bin/bash "$SCRIPT" --apply --auto
}

case "${1:-status}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-60}" ;;
  run)       cmd_run ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
