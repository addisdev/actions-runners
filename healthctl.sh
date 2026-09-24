#!/usr/bin/env bash
# Install, run and inspect the periodic health-repair LaunchAgent.
#
#   ./healthctl.sh install     # write the LaunchAgent and load it
#   ./healthctl.sh status      # is it loaded, and what did the last sweep say
#   ./healthctl.sh logs [n]    # tail the repair log
#   ./healthctl.sh restart
#   ./healthctl.sh uninstall
#   ./healthctl.sh run         # foreground once, for debugging
#
# Runs health.sh --repair on a StartInterval (default 60s) with RunAtLoad.
# Drain-respecting behaviour lives in health.sh — drained runners are skipped
# even under --repair. The wrapper script serialises runs so a slow sweep cannot
# overlap the next tick. This installs its own plist only; it never touches the
# GitHub runner LaunchAgents that register.sh creates.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"
LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.fleet-health"
INTERVAL="${FLEET_HEALTH_INTERVAL:-60}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/logs"
LOG="${FLEET_HEALTH_LOG:-$LOG_DIR/fleet-health-repair.log}"
WRAPPER="$ROOT/scripts/health-repair-launchd.sh"

gh_dir() {
  local d
  d="$(dirname "$(command -v gh 2>/dev/null || echo /opt/homebrew/bin/gh)")"
  echo "$d"
}

cmd_install() {
  local gh_path
  gh_path="$(gh_dir)"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
  chmod +x "$WRAPPER"

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAPPER</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$gh_path:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>FLEET_ROOT</key><string>$ROOT</string>
  </dict>
  <!-- StartInterval + RunAtLoad: periodic repair, not a resident daemon.
       Unlike runner plists, no KeepAlive — a dead RunnerService.js is what
       we are here to notice. -->
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL"
  echo "root:     $ROOT"
  echo "wrapper:  $WRAPPER"
  echo "interval: ${INTERVAL}s"
  echo "log:      $LOG"
  sleep 2
  cmd_status
}

cmd_uninstall() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "unloaded and removed $PLIST"
}

cmd_start()   { launchctl load "$PLIST"; }
cmd_stop()    { launchctl unload "$PLIST"; }
cmd_restart() { launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; sleep 2; cmd_status; }

cmd_status() {
  if out=$(launchctl list "$LABEL" 2>/dev/null); then
    pid=$(echo "$out" | awk -F'= ' '/"PID"/{print $2}' | tr -d ' ;')
    exitcode=$(echo "$out" | awk -F'= ' '/"LastExitStatus"/{print $2}' | tr -d ' ;')
    echo "launchd: loaded (pid ${pid:-—}, last exit ${exitcode:-?})"
  else
    echo "launchd: not loaded"
  fi
  echo "plist:   $PLIST"
  echo "every:   ${INTERVAL}s (reinstall after changing FLEET_HEALTH_INTERVAL)"
  if [ -f "$LOG" ]; then
    echo "last:    $(tail -n 1 "$LOG")"
    local n
    n=$(grep -c ' start health.sh --repair$' "$LOG" 2>/dev/null || true)
    echo "sweeps:  ${n:-0} logged since the file began"
  else
    echo "log:     nothing written yet — $LOG"
  fi
}

cmd_logs() { tail -n "${1:-60}" "$LOG"; }

cmd_run() {
  export FLEET_ROOT="$ROOT"
  export FLEET_HEALTH_LOG="$LOG"
  exec /bin/bash "$WRAPPER"
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
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
