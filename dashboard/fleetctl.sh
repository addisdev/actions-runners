#!/usr/bin/env bash
# Install, run and inspect the fleet dashboard daemon.
#
#   ./fleetctl.sh install     # write the LaunchAgent and load it
#   ./fleetctl.sh status      # is it up, and what does it think
#   ./fleetctl.sh logs [n]    # tail the daemon log
#   ./fleetctl.sh restart
#   ./fleetctl.sh uninstall
#   ./fleetctl.sh run         # foreground, for debugging
#   ./fleetctl.sh token       # print the control token for the Control tab
#
# The plist is generated rather than committed because the two machines have
# different usernames, and a hardcoded /Users/<someone> is exactly the kind of
# thing that fails silently a month later.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# Machine-specific values live in an untracked fleet.env at the repo root, so
# this file stays the same on every host. The label prefix is in there because
# changing it renames the LaunchAgent: an already-loaded daemon keeps the label
# it was installed under, and a mismatched one here means status/restart quietly
# report "not loaded" for a daemon that is running perfectly well.
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"
LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.fleet-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HERE/logs"
PORT="${FLEET_PORT:-7878}"

node_bin() {
  # launchd gets a minimal PATH, so the node location is resolved once here and
  # written into the plist rather than looked up at launch time.
  command -v node 2>/dev/null && return 0
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  echo "no node found — install it or put it on PATH" >&2
  return 1
}

cmd_install() {
  local node; node="$(node_bin)"
  local gh_dir; gh_dir="$(dirname "$(command -v gh 2>/dev/null || echo /opt/homebrew/bin/gh)")"
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
    <string>$HERE/fleetd.js</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$gh_dir:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>FLEET_PORT</key><string>$PORT</string>
    <key>FLEET_ROOT</key><string>$ROOT</string>
    <key>FLEET_PROJECTS</key><string>${FLEET_PROJECTS:-}</string>
    <key>FLEET_GROUP_IGNORE</key><string>${FLEET_GROUP_IGNORE:-}</string>
    <key>FLEET_GROUP_MIN</key><string>${FLEET_GROUP_MIN:-2}</string>
    <key>FLEET_GROUPS</key><string>${FLEET_GROUPS:-on}</string>
    <key>FLEET_CEILING</key><string>${FLEET_CEILING:-3}</string>
  </dict>
  <!-- Unlike the runner plists, this one sets KeepAlive. health.sh exists
       precisely because theirs do not, and a monitoring daemon that dies
       quietly is worse than no monitoring daemon. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/fleetd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/fleetd.log</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL"
  echo "node:  $node"
  echo "gh:    $gh_dir/gh"
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
    echo "launchd: ${pid:-not running} (last exit ${exitcode:-?})"
  else
    echo "launchd: not loaded"
  fi
  if health=$(curl -fsS --max-time 4 "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
    echo "http:    up on 127.0.0.1:$PORT"
    # .format rather than an f-string: this host has Python 3.9, where a
    # backslash inside an f-string expression is a SyntaxError. The escaped
    # quotes needed to survive the shell's single quotes made this line fail
    # to parse, so status silently printed the raw JSON instead of the summary.
    echo "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("         {} runners, {} drift items".format(d["runners"], d["drift"]) + (", error: {}".format(d["lastError"]) if d.get("lastError") else ""))' 2>/dev/null || echo "$health"
  else
    echo "http:    not answering on 127.0.0.1:$PORT"
    echo "         ./fleetctl.sh logs"
  fi
}

cmd_logs() { tail -n "${1:-60}" "$LOG_DIR/fleetd.log"; }
cmd_run()  { cd "$HERE" && exec "$(node_bin)" fleetd.js; }

# The control token. Paste it into the dashboard's Control tab once; the browser
# keeps it in localStorage. It is deliberately not served to the page — read
# access and the right to restart runners are different things.
cmd_token() {
  if [ -f "$HERE/.fleet-token" ]; then
    cat "$HERE/.fleet-token"
  else
    echo "no token yet — start the daemon once and it will generate one" >&2
    return 1
  fi
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
  token)     cmd_token ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
