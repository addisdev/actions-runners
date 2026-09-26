#!/usr/bin/env bash
# Install, run and inspect the fleet agent daemon (agent.js).
#
#   ./agentctl.sh install   # write the LaunchAgent plist and load it
#   ./agentctl.sh status    # is it running, and is it reaching the coordinator
#   ./agentctl.sh logs [n]  # tail the agent log
#   ./agentctl.sh restart
#   ./agentctl.sh uninstall
#   ./agentctl.sh run       # foreground, for debugging
#
# Before installing, set the three required variables in fleet.env at the
# repo root (copy from examples/fleet.env.federated-agent):
#
#   FLEET_COORDINATOR=http://coordinator-mac:7878
#   FLEET_AGENT_TOKEN=<token from coordinator: ./fleetctl.sh agent-token --host mac-studio>
#   FLEET_HOST_ID=mac-studio
#   FLEET_HOST_NAME=mac-studio
#
# Optional variables read from fleet.env:
#   FLEET_HOST_LABELS          — comma-separated capability labels, e.g. xcode-16,macos-15
#   FLEET_AGENT_ALLOW_COMMANDS — set to 1 to allow remote drain/resume/health
#   FLEET_AGENT_ALLOW_REGISTER — set to 1 to allow remote runner provisioning
#   FLEET_MAX_TOTAL_RUNNERS    — cap on runners this host may hold (default 8)
#   FLEET_CEILING              — do not add while this many jobs are running (default 3)
#   FLEET_LOAD_PER_CORE        — load/core threshold (default 2)
#   FLEET_MIN_FREE_DISK_GB     — minimum free disk space in GB (default 50)
#   FLEET_HEARTBEAT_MS         — heartbeat interval in ms (default 30000)
#   FLEET_LABEL_PREFIX         — LaunchAgent label prefix (default com.runner-fleet)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.fleet-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HERE/logs"

node_bin() {
  command -v node 2>/dev/null && return 0
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  echo "no node found — install it or put it on PATH" >&2
  return 1
}

check_required() {
  local missing=0
  if [ -z "${FLEET_COORDINATOR:-}" ] && [ -z "${FLEET_COORDINATORS:-}" ]; then
    echo "FLEET_COORDINATOR or FLEET_COORDINATORS is not set — add it to fleet.env" >&2; missing=1
  fi
  if [ -z "${FLEET_AGENT_TOKEN:-}" ]; then
    echo "FLEET_AGENT_TOKEN is not set — run ./fleetctl.sh agent-token --host <FLEET_HOST_ID> on the coordinator" >&2; missing=1
  fi
  if [ -z "${FLEET_HOST_NAME:-}" ]; then
    echo "FLEET_HOST_NAME is not set — add it to fleet.env (shown in the Hosts tab)" >&2; missing=1
  fi
  [ "$missing" -eq 0 ] || { echo "Set the missing variables in $ROOT/fleet.env and re-run." >&2; exit 1; }
}

cmd_install() {
  check_required
  local node; node="$(node_bin)"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

  # Write the token to a mode-0600 file so it does not appear in the plist.
  # LaunchAgent env dicts are readable by any local user, and a token in plain
  # text there is one `defaults read` away from being harvested.
  local token_file="$HERE/.fleet-agent-token-local"
  printf '%s\n' "$FLEET_AGENT_TOKEN" > "$token_file"
  chmod 600 "$token_file"

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$HERE/agent.js</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>FLEET_COORDINATOR</key><string>${FLEET_COORDINATOR:-}</string>
    <key>FLEET_COORDINATORS</key><string>${FLEET_COORDINATORS:-}</string>
    <key>FLEET_AGENT_TOKEN_FILE</key><string>${token_file}</string>
    <key>FLEET_HOST_NAME</key><string>${FLEET_HOST_NAME}</string>
    <key>FLEET_HOST_ID</key><string>${FLEET_HOST_ID:-${FLEET_HOST_NAME}}</string>
    <key>FLEET_ROOT</key><string>${ROOT}</string>
    <key>FLEET_HOST_LABELS</key><string>${FLEET_HOST_LABELS:-}</string>
    <key>FLEET_AGENT_ALLOW_COMMANDS</key><string>${FLEET_AGENT_ALLOW_COMMANDS:-0}</string>
    <key>FLEET_AGENT_ALLOW_REGISTER</key><string>${FLEET_AGENT_ALLOW_REGISTER:-0}</string>
    <key>FLEET_AGENT_ALLOW_DEREGISTER</key><string>${FLEET_AGENT_ALLOW_DEREGISTER:-0}</string>
    <key>FLEET_MAX_TOTAL_RUNNERS</key><string>${FLEET_MAX_TOTAL_RUNNERS:-8}</string>
    <key>FLEET_CEILING</key><string>${FLEET_CEILING:-3}</string>
    <key>FLEET_LOAD_PER_CORE</key><string>${FLEET_LOAD_PER_CORE:-2}</string>
    <key>FLEET_MIN_FREE_DISK_GB</key><string>${FLEET_MIN_FREE_DISK_GB:-50}</string>
    <key>FLEET_MAX_INSTANCES_PER_REPO</key><string>${FLEET_MAX_INSTANCES_PER_REPO:-4}</string>
    <key>FLEET_HEARTBEAT_MS</key><string>${FLEET_HEARTBEAT_MS:-30000}</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/agent.log</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL"
  echo "node:  $node"
  echo "host:  $FLEET_HOST_NAME"
  echo "id:    ${FLEET_HOST_ID:-${FLEET_HOST_NAME}}"
  echo "coordinator(s): ${FLEET_COORDINATORS:-${FLEET_COORDINATOR:-}}"
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
  local endpoints="${FLEET_COORDINATORS:-${FLEET_COORDINATOR:-}}"
  local endpoint
  if [ -n "$endpoints" ]; then
    local -a coordinator_list
    IFS=',' read -r -a coordinator_list <<< "$endpoints"
    for endpoint in "${coordinator_list[@]}"; do
      [ -n "$endpoint" ] || continue
      if curl -fsS --max-time 4 "${endpoint%/}/api/health" >/dev/null 2>&1; then
        echo "coordinator: reachable at $endpoint"
      else
        echo "coordinator: NOT reachable at $endpoint"
      fi
    done
  else
    echo "coordinator: not configured"
  fi
}

cmd_logs() { tail -n "${1:-60}" "$LOG_DIR/agent.log" 2>/dev/null || echo "no log yet — has the agent started?" ; }
cmd_run()  {
  check_required
  cd "$HERE" && exec "$(node_bin)" agent.js
}

case "${1:-help}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-60}" ;;
  run)       cmd_run ;;
  *)
    echo "usage: $0 {install|uninstall|start|stop|restart|status|logs|run}"
    echo ""
    echo "  install   — write the LaunchAgent plist and load it"
    echo "  uninstall — unload and remove the LaunchAgent plist"
    echo "  start     — load the existing plist"
    echo "  stop      — unload the plist"
    echo "  restart   — unload, reload, show status"
    echo "  status    — is the agent running, can it reach the coordinator"
    echo "  logs [n]  — tail the last n lines of the agent log (default 60)"
    echo "  run       — run in the foreground (for debugging)"
    echo ""
    echo "Set FLEET_COORDINATOR, FLEET_AGENT_TOKEN, and FLEET_HOST_NAME in"
    echo "$ROOT/fleet.env before running install."
    ;;
esac
