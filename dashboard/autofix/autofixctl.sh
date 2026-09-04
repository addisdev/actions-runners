#!/usr/bin/env bash
# Install, run and inspect the auto-remediation bridge.
#
#   ./autofixctl.sh install     # write the LaunchAgent and load it
#   ./autofixctl.sh status      # is it up, and what is it tracking
#   ./autofixctl.sh logs [n]    # tail the bridge log
#   ./autofixctl.sh restart
#   ./autofixctl.sh uninstall
#   ./autofixctl.sh run         # foreground, for debugging
#   ./autofixctl.sh dryrun      # foreground, decides but never acts
#   ./autofixctl.sh ping        # poke the bridge as if an alert had fired
#   ./autofixctl.sh wire        # point fleetd's alert webhook at the bridge
#
# The plist is generated rather than committed for the same reason fleetctl's
# is: the paths are user- and version-specific, and a hardcoded one fails
# silently a month later. node in particular lives under an nvm versioned
# directory, so its path changes the next time node is upgraded — which is why
# node_bin below resolves a version-independent path in preference to whatever
# nvm has activated in the installing shell.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(dirname "$HERE")"
ROOT="$(dirname "$DASH")"
# See fleetctl.sh: the label prefix is host-local because it names an already
# loaded LaunchAgent, and a mismatch makes a running daemon look absent.
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"
LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.fleet-autofix"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$DASH/logs/autofix.log"
PORT="${AUTOFIX_PORT:-7879}"
FLEET_PORT="${FLEET_PORT:-7878}"

need() {
  command -v "$1" 2>/dev/null && return 0
  for p in "/opt/homebrew/bin/$1" "/usr/local/bin/$1" "/usr/bin/$1"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  echo "no $1 found — install it or put it on PATH" >&2
  return 1
}

# node, resolved to a path that outlives a node upgrade.
#
# Deliberately NOT `need node`: that prefers whatever is on PATH, and anyone
# running this installer almost certainly has nvm active, whose node path
# embeds its version. Baking ~/.nvm/versions/node/vX.Y.Z/bin/node into the
# plist means this LaunchAgent stops loading the day that version is
# uninstalled — silently, and only discovered when an alert fires and nothing
# repairs it. The header comment above has warned about this since the file was
# written; preferring a stable path is the version that does not depend on
# someone remembering to reinstall after every `nvm install`.
node_bin() {
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  command -v node 2>/dev/null && return 0
  echo "no node found — install it or put it on PATH" >&2
  return 1
}

cmd_install() {
  local node
  node="$(node_bin)"

  # launchd hands a process a minimal PATH. The bridge itself needs only node;
  # fleet-action.sh needs curl and python3, both of which live in /usr/bin and
  # are covered by the fallback below.
  #
  # node's own directory is prepended only when it is not already in the list,
  # so the common case does not generate a PATH with /opt/homebrew/bin twice.
  local node_dir extra_path
  node_dir="$(dirname "$node")"
  extra_path=""
  if [ "$node_dir" != "/opt/homebrew/bin" ]; then extra_path="$node_dir:"; fi

  mkdir -p "$DASH/logs" "$HOME/Library/LaunchAgents"
  chmod +x "$HERE"/*.sh

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$HERE/bridge.js</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${extra_path}/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>AUTOFIX_PORT</key><string>$PORT</string>
    <key>FLEET_URL</key><string>http://127.0.0.1:$FLEET_PORT</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL"
  echo "node:   $node"
  sleep 2
  cmd_status
}

cmd_uninstall() { launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "removed $PLIST"; }
cmd_start()     { launchctl load "$PLIST"; }
cmd_stop()      { launchctl unload "$PLIST"; }
cmd_restart()   { launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; sleep 2; cmd_status; }
cmd_logs()      { tail -n "${1:-60}" "$LOG"; }
cmd_run()       { cd "$HERE" && exec "$(node_bin)" bridge.js; }
cmd_dryrun()    { cd "$HERE" && AUTOFIX_DRY_RUN=1 exec "$(node_bin)" bridge.js; }
cmd_ping()      { curl -sS -X POST "http://127.0.0.1:$PORT/alert" -d '{}' && echo "poked — ./autofixctl.sh logs"; }

cmd_status() {
  if out=$(launchctl list "$LABEL" 2>/dev/null); then
    echo "launchd: $(echo "$out" | awk -F'= ' '/"PID"/{print $2}' | tr -d ' ;') (last exit $(echo "$out" | awk -F'= ' '/"LastExitStatus"/{print $2}' | tr -d ' ;'))"
  else
    echo "launchd: not loaded"
  fi
  if s=$(curl -fsS --max-time 4 "http://127.0.0.1:$PORT/status" 2>/dev/null); then
    echo "http:    up on 127.0.0.1:$PORT"
    # The JSON arrives as argv rather than on stdin so the script can be a
    # quoted heredoc: this host has Python 3.9, where a backslash inside an
    # f-string expression is a SyntaxError, so the escaped-quote style used
    # elsewhere in this repo silently falls through to printing raw JSON.
    python3 -c "$(cat <<'PY'
import json, sys
d = json.loads(sys.argv[1])
t = d.get("tracked", {})
print("         dry-run: {}".format(d.get("dryRun")))
print("         tracking {} alert(s)".format(len(t)))
for k, v in t.items():
    bits = ["attempts={}".format(v.get("attempts", 0))]
    if v.get("exhausted"):
        bits.append("EXHAUSTED - needs a human")
    if v.get("lastOk") is False:
        bits.append("last attempt failed")
    print("           {}  ({})".format(k, ", ".join(bits)))
PY
)" "$s" 2>/dev/null || echo "$s"
  else
    echo "http:    not answering on 127.0.0.1:$PORT"
  fi
}

# Point fleetd's alert webhook at this bridge, preserving any other settings
# already in alerts.config.json.
cmd_wire() {
  local cfg="$DASH/alerts.config.json"
  python3 - "$cfg" "$PORT" <<'PY'
import json, os, sys
path, port = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        cfg = json.load(f)
cfg["webhook"] = {"url": f"http://127.0.0.1:{port}/alert"}
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"wired {path} -> http://127.0.0.1:{port}/alert")
PY
  echo "now restart the dashboard so it picks the config up:"
  echo "  $DASH/fleetctl.sh restart"
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
  dryrun)    cmd_dryrun ;;
  ping)      cmd_ping ;;
  wire)      cmd_wire ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
