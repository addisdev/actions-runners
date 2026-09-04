#!/usr/bin/env bash
# Install, run and inspect the fleet watchdog.
#
#   ./watchctl.sh install     # write the LaunchAgent and load it
#   ./watchctl.sh status      # is it up, and what did it last see
#   ./watchctl.sh logs [n]    # tail the watch log
#   ./watchctl.sh problems    # only the transitions, newest last
#   ./watchctl.sh restart
#   ./watchctl.sh uninstall
#   ./watchctl.sh run         # foreground, for debugging
#
# The plist is generated rather than committed, for the same reason fleetctl.sh
# generates its own: a hardcoded /Users/<someone> fails silently a month later.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(dirname "$HERE")"
ROOT="$(dirname "$DASH")"
# See fleetctl.sh: the label prefix is host-local because it names an already
# loaded LaunchAgent, and a mismatch makes a running daemon look absent.
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"
LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.fleet-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$DASH/logs"
LOG="$LOG_DIR/fleet-watch.log"
PORT="${FLEET_PORT:-7878}"

# launchd gets a minimal PATH, so the node location is resolved once here and
# written into the plist rather than looked up at launch time.
#
# The package-manager paths are tried BEFORE `command -v`, which is the opposite
# of what fleetctl.sh does, and deliberate: whoever runs this probably has nvm
# active, and nvm's node path contains its version. Baking
# ~/.nvm/versions/node/v22.20.0/bin/node into a plist means the watchdog stops
# surviving reboots the day that version is uninstalled — silently, months
# later, which is the failure mode a watchdog least wants. Homebrew's path is
# stable across upgrades.
node_bin() {
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  command -v node 2>/dev/null && return 0
  echo "no node found — install it or put it on PATH" >&2
  return 1
}

cmd_install() {
  local node; node="$(node_bin)"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$HERE/fleet-watch.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>FLEET_PORT</key><string>$PORT</string>
  </dict>
  <!-- KeepAlive for the same reason the dashboard sets it: a watchdog that dies
       quietly is worse than no watchdog. ThrottleInterval is 30 rather than 10
       because if this cannot start, retrying twice a minute only fills the log
       faster than anyone will read it. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL"
  echo "node:  $node"
  echo "log:   $LOG"
  sleep 3
  cmd_status
}

cmd_uninstall() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "unloaded and removed $PLIST"
}

cmd_start()   { launchctl load "$PLIST"; }
cmd_stop()    { launchctl unload "$PLIST"; }
cmd_restart() { launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; sleep 3; cmd_status; }

cmd_status() {
  if out=$(launchctl list "$LABEL" 2>/dev/null); then
    pid=$(echo "$out" | awk -F'= ' '/"PID"/{print $2}' | tr -d ' ;')
    exitcode=$(echo "$out" | awk -F'= ' '/"LastExitStatus"/{print $2}' | tr -d ' ;')
    echo "launchd: ${pid:-not running} (last exit ${exitcode:-?})"
  else
    echo "launchd: not loaded"
  fi
  if [ -f "$LOG" ]; then
    echo "last:    $(tail -n 1 "$LOG")"
    local n; n=$(grep -c 'FLEET_PROBLEM\|FLEET_UNREACHABLE' "$LOG" 2>/dev/null || true)
    echo "faults:  ${n:-0} reported since the log began"
  else
    echo "log:     nothing written yet — $LOG"
  fi
}

cmd_logs()     { tail -n "${1:-60}" "$LOG"; }
cmd_problems() { grep -E 'FLEET_PROBLEM|FLEET_UNREACHABLE|FLEET_RECOVERED' "$LOG" || echo "no transitions logged — the fleet has been healthy"; }
cmd_run()      { cd "$HERE" && exec "$(node_bin)" fleet-watch.mjs; }

case "${1:-status}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-60}" ;;
  problems)  cmd_problems ;;
  run)       cmd_run ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
