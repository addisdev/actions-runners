#!/usr/bin/env bash
# Install, run and inspect the fleet dashboard daemon.
#
#   ./fleetctl.sh install              # write the LaunchAgent and load it
#   ./fleetctl.sh status               # is it up, and what does it think
#   ./fleetctl.sh logs [n]             # tail the daemon log
#   ./fleetctl.sh restart
#   ./fleetctl.sh uninstall
#   ./fleetctl.sh run                  # foreground, for debugging
#   ./fleetctl.sh token                # print the control token for the Control tab
#   ./fleetctl.sh label                # print the launchd label
#   ./fleetctl.sh leader               # show this replica and the elected leader
#   ./fleetctl.sh backup               # consistent SQLite backup (safe while daemon runs)
#   ./fleetctl.sh restore <path>       # restore from backup (daemon must be stopped)
#   ./fleetctl.sh pair                 # generate a pairing code for a remote device
#   ./fleetctl.sh devices              # list paired devices
#   ./fleetctl.sh revoke <name-or-key> # revoke a device token
#   ./fleetctl.sh remote status        # show bind, LAN URLs, Tailscale state
#   ./fleetctl.sh remote lan on|off    # bind to 0.0.0.0 / revert to loopback
#   ./fleetctl.sh remote tailscale on|off  # configure Tailscale Serve (never Funnel)
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
DB="${FLEET_DB:-$HERE/fleet.db}"
BACKUP_DIR="${FLEET_BACKUP_DIR:-$HERE/backups}"

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

  # Resolve the agent token file path. A separate agent token keeps agent
  # credentials independent of the browser control token so they can be
  # rotated independently; if no separate file exists the daemon falls back
  # to the control token, which is fine for single-host deployments.
  local agent_token_file="${FLEET_AGENT_TOKEN_FILE:-$HERE/.fleet-agent-token}"
  local agent_tokens_file="${FLEET_AGENT_TOKENS_FILE:-$HERE/.fleet-agent-tokens.json}"
  local database_url_file="${FLEET_DATABASE_URL_FILE:-$HERE/.fleet-database-url}"

  if [ -s "$database_url_file" ]; then
    command -v npm >/dev/null 2>&1 || {
      echo "npm is required to install PostgreSQL HA support" >&2
      return 1
    }
    echo "Installing locked PostgreSQL HA dependency..."
    (cd "$HERE" && npm ci --omit=dev)
  fi

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
    <key>FLEET_DB</key><string>${FLEET_DB:-$HERE/fleet.db}</string>
    <key>FLEET_COLLECTOR_STALE_MS</key><string>${FLEET_COLLECTOR_STALE_MS:-240000}</string>
    <key>FLEET_AUTOFIX_STATUS_URL</key><string>${FLEET_AUTOFIX_STATUS_URL:-http://127.0.0.1:7879/status}</string>
    <key>FLEET_ADMISSION_LOG</key><string>${FLEET_ADMISSION_LOG:-$HERE/logs/admission.ndjson}</string>
    <key>FLEET_PROJECTS</key><string>${FLEET_PROJECTS:-}</string>
    <key>FLEET_GROUP_IGNORE</key><string>${FLEET_GROUP_IGNORE:-}</string>
    <key>FLEET_GROUP_MIN</key><string>${FLEET_GROUP_MIN:-2}</string>
    <key>FLEET_GROUPS</key><string>${FLEET_GROUPS:-on}</string>
    <key>FLEET_CEILING</key><string>${FLEET_CEILING:-3}</string>
    <!-- Federation: bind address, agent token, capability labels, read-only -->
    <key>FLEET_HOST</key><string>${FLEET_HOST:-127.0.0.1}</string>
    <key>FLEET_ALLOWED_HOSTS</key><string>${FLEET_ALLOWED_HOSTS:-}</string>
    <key>FLEET_DEVICE_TOKENS_FILE</key><string>${FLEET_DEVICE_TOKENS_FILE:-$HERE/.fleet-device-tokens.json}</string>
    <key>FLEET_AGENT_TOKEN_FILE</key><string>${agent_token_file}</string>
    <key>FLEET_AGENT_TOKENS_FILE</key><string>${agent_tokens_file}</string>
    <key>FLEET_DATABASE_URL_FILE</key><string>${database_url_file}</string>
    <key>FLEET_DATABASE_SSL</key><string>${FLEET_DATABASE_SSL:-1}</string>
    <key>FLEET_DATABASE_SSL_INSECURE</key><string>${FLEET_DATABASE_SSL_INSECURE:-0}</string>
    <key>FLEET_REPLICA_ID</key><string>${FLEET_REPLICA_ID:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}</string>
    <key>FLEET_HOST_NAME</key><string>${FLEET_HOST_NAME:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}</string>
    <key>FLEET_HOST_LABELS</key><string>${FLEET_HOST_LABELS:-}</string>
    <key>FLEET_READ_ONLY</key><string>${FLEET_READ_ONLY:-0}</string>
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
  echo "bind:  ${FLEET_HOST:-127.0.0.1}:$PORT"
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
    echo "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("         {} runners, {} drift items, role {} (leader {})".format(d["runners"], d["drift"], d.get("role","single"), d.get("leaderId") or d.get("replicaId","local")) + (", error: {}".format(d["lastError"]) if d.get("lastError") else ""))' 2>/dev/null || echo "$health"
  else
    echo "http:    not answering on 127.0.0.1:$PORT"
    echo "         ./fleetctl.sh logs"
  fi
}

cmd_logs() { tail -n "${1:-60}" "$LOG_DIR/fleetd.log"; }
cmd_run()  { cd "$HERE" && exec "$(node_bin)" fleetd.js; }
cmd_leader() { curl -fsS --max-time 4 "http://127.0.0.1:$PORT/api/leader"; echo; }

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

resolve_db_path() {
  # fleetd resolves a relative FLEET_DB against the dashboard directory.
  case "$DB" in
    /*) echo "$DB" ;;
    *)  echo "$HERE/$DB" ;;
  esac
}

daemon_running() {
  if out=$(launchctl list "$LABEL" 2>/dev/null); then
    local pid
    pid=$(echo "$out" | awk -F'= ' '/"PID"/{print $2}' | tr -d ' ;')
    if [ -n "$pid" ] && [ "$pid" != "-" ] && [ "$pid" != "0" ]; then
      return 0
    fi
  fi
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

cmd_backup() {
  local db; db="$(resolve_db_path)"
  if [ ! -f "$db" ]; then
    echo "no database at $db" >&2
    return 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3 is required for online backup" >&2
    return 1
  fi

  local ts dest
  ts="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  dest="$BACKUP_DIR/fleet-${ts}.db"

  # .backup takes a consistent snapshot even while fleetd holds the database open.
  sqlite3 "$db" ".backup '$dest'"
  chmod 600 "$dest"
  echo "backed up $db -> $dest"
}

cmd_restore() {
  local backup_path="${1:-}"
  if [ -z "$backup_path" ]; then
    echo "usage: $0 restore <backup-path>" >&2
    echo "       stop the daemon first: $0 stop" >&2
    return 1
  fi
  if [ ! -f "$backup_path" ]; then
    echo "backup not found: $backup_path" >&2
    return 1
  fi
  if daemon_running; then
    echo "refusing restore while the daemon is running — stop it first:" >&2
    echo "  $0 stop" >&2
    return 1
  fi

  local db rollback ts
  db="$(resolve_db_path)"
  ts="$(date +%Y%m%d-%H%M%S)"
  if [ -f "$db" ]; then
    rollback="${db}.rollback-${ts}"
    cp -p "$db" "$rollback"
    chmod 600 "$rollback"
    echo "preserved current database as $rollback"
  fi

  cp "$backup_path" "$db"
  chmod 600 "$db"
  echo "restored $backup_path -> $db"
  echo "start the daemon when ready: $0 start"
}

cmd_agent_token() {
  # Print (and create if missing) the token agents use to authenticate their
  # heartbeats. Separate from the control token so each can be rotated without
  # invalidating the other. Stored in a mode-0600 file so it is not readable
  # by other local users; written to both the default and the legacy location
  # for backwards compatibility with single-token deployments.
  if [ "${1:-}" = "--host" ]; then
    [ -n "${2:-}" ] || { echo "usage: $0 agent-token --host <host-id>" >&2; return 2; }
    FLEET_AGENT_TOKENS_FILE="${FLEET_AGENT_TOKENS_FILE:-$HERE/.fleet-agent-tokens.json}" \
      node "$HERE/host-token.mjs" "$2"
    return
  fi
  local token_file="${FLEET_AGENT_TOKEN_FILE:-$HERE/.fleet-agent-token}"
  if [ ! -f "$token_file" ]; then
    node -e "require('crypto').randomBytes(32).toString('hex').replace(/\n/,'')" > "$token_file"
    chmod 600 "$token_file"
    echo "generated $token_file"
  fi
  cat "$token_file"
}

# Generate a pairing code via the running daemon and display it (+ terminal QR
# if qrencode is installed). The code expires in 5 minutes and is single-use.
cmd_pair() {
  local token_file="$HERE/.fleet-token"
  if [ ! -f "$token_file" ]; then
    echo "no control token — start the daemon first" >&2
    return 1
  fi
  local token; token="$(cat "$token_file")"
  local result
  result="$(curl -fsS --max-time 5 -X POST \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$PORT/api/pair/start")" || {
    echo "daemon did not respond on port $PORT" >&2
    return 1
  }
  local code url
  code="$(echo "$result" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["code"])')"
  url="$(echo "$result" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["url"])')"
  echo ""
  echo "Pairing code: $code"
  echo "URL: $url"
  echo ""
  echo "On the remote device: visit the URL or open the dashboard and enter the code."
  echo "Expires in 5 minutes."
  if command -v qrencode >/dev/null 2>&1; then
    echo ""
    qrencode -t UTF8 "$url"
  fi
}

# List paired devices.
cmd_devices() {
  local token_file="$HERE/.fleet-token"
  if [ ! -f "$token_file" ]; then
    echo "no control token" >&2; return 1
  fi
  local token; token="$(cat "$token_file")"
  curl -fsS --max-time 5 \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$PORT/api/devices" | \
    python3 -c '
import json, sys, datetime
d = json.load(sys.stdin)
devs = d.get("devices", [])
if not devs:
    print("no devices paired")
    sys.exit(0)
for dev in devs:
    created = datetime.datetime.fromtimestamp(dev["createdAt"]/1000).strftime("%Y-%m-%d %H:%M")
    seen = datetime.datetime.fromtimestamp(dev["lastSeenAt"]/1000).strftime("%Y-%m-%d %H:%M") if dev.get("lastSeenAt") else "never"
    print(f"  {dev[\"key\"]}  {dev[\"name\"]:<30}  paired {created}  seen {seen}")
'
}

# Revoke a device by key or name.
cmd_revoke() {
  local target="${1:-}"
  [ -n "$target" ] || { echo "usage: $0 revoke <key-or-name>" >&2; return 1; }
  local token_file="$HERE/.fleet-token"
  if [ ! -f "$token_file" ]; then
    echo "no control token" >&2; return 1
  fi
  local token; token="$(cat "$token_file")"

  # Resolve name to key if not already a key
  local key="$target"
  if ! echo "$target" | grep -qE '^[0-9a-f]{16}$'; then
    key="$(curl -fsS --max-time 5 \
      -H "Authorization: Bearer $token" \
      "http://127.0.0.1:$PORT/api/devices" | \
      python3 -c "
import json, sys
d = json.load(sys.stdin)
name = sys.argv[1]
for dev in d.get('devices', []):
    if dev['name'] == name or dev['key'] == name:
        print(dev['key']); sys.exit(0)
sys.exit(1)
" "$target" 2>/dev/null)" || { echo "no device found: $target" >&2; return 1; }
  fi

  if curl -fsS --max-time 5 -X POST \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d "{\"key\":\"$key\"}" \
      "http://127.0.0.1:$PORT/api/devices/revoke"; then
    echo "revoked $target"
  else
    echo "revoke failed" >&2
    return 1
  fi
}

# Remote access management.
cmd_remote() {
  local sub="${1:-status}"
  case "$sub" in
    status)
      local host="${FLEET_HOST:-127.0.0.1}"
      echo "Bind:  $host:$PORT"
      if [ "$host" = "127.0.0.1" ]; then
        echo "LAN:   disabled (loopback only)"
      else
        echo "LAN:   enabled (listening on all interfaces)"
      fi
      echo ""
      echo "Reachable URLs:"
      curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/access" 2>/dev/null | \
        python3 -c '
import json, sys
d = json.load(sys.stdin)
for u in d.get("urls", []):
    print(f"  [{u[\"label\"]}] {u[\"url\"]}")
' || echo "  (daemon not running)"
      echo ""
      echo "Tailscale Serve:"
      if command -v tailscale >/dev/null 2>&1; then
        tailscale serve status 2>/dev/null || echo "  (not configured)"
      else
        echo "  tailscale not found"
      fi
      echo ""
      echo "macOS firewall:"
      if /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -q enabled; then
        echo "  Firewall is ON — ensure node is allowed:"
        echo "    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \$(which node)"
      else
        echo "  Firewall is OFF"
      fi
      ;;

    lan)
      local onoff="${2:-}"
      [ -n "$onoff" ] || { echo "usage: $0 remote lan on|off" >&2; return 1; }
      local env_file="$ROOT/fleet.env"
      touch "$env_file"
      if [ "$onoff" = "on" ]; then
        # Remove existing FLEET_HOST line and add the new one
        { grep -v '^FLEET_HOST=' "$env_file" 2>/dev/null || true; echo 'FLEET_HOST=0.0.0.0'; } > "$env_file.tmp" && mv "$env_file.tmp" "$env_file"
        echo "Set FLEET_HOST=0.0.0.0 in fleet.env"
        echo ""
        echo "If the macOS Application Firewall is on, allow node:"
        echo "  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \$(which node)"
        echo ""
        if daemon_running; then
          echo "Restarting daemon..."
          cmd_restart
        fi
      elif [ "$onoff" = "off" ]; then
        { grep -v '^FLEET_HOST=' "$env_file" 2>/dev/null || true; echo 'FLEET_HOST=127.0.0.1'; } > "$env_file.tmp" && mv "$env_file.tmp" "$env_file"
        echo "Set FLEET_HOST=127.0.0.1 in fleet.env (loopback only)"
        if daemon_running; then
          echo "Restarting daemon..."
          cmd_restart
        fi
      else
        echo "usage: $0 remote lan on|off" >&2; return 1
      fi
      ;;

    tailscale)
      local onoff="${2:-}"
      [ -n "$onoff" ] || { echo "usage: $0 remote tailscale on|off" >&2; return 1; }
      command -v tailscale >/dev/null 2>&1 || { echo "tailscale not found — install it first" >&2; return 1; }
      if [ "$onoff" = "on" ]; then
        # Only Serve, never Funnel. Funnel exposes to the public internet.
        tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
        echo ""
        echo "Tailscale Serve is ON. The dashboard is reachable on your tailnet only."
        echo "It is NOT public — Tailscale Funnel is deliberately not used here."
        echo ""
        echo "Pairing is recommended for control access from remote devices:"
        echo "  ./fleetctl.sh pair"
      elif [ "$onoff" = "off" ]; then
        tailscale serve reset || true
        echo "Tailscale Serve reset."
      else
        echo "usage: $0 remote tailscale on|off" >&2; return 1
      fi
      ;;

    *)
      echo "usage: $0 remote status|lan|tailscale" >&2; return 1 ;;
  esac
}

case "${1:-status}" in
  install)     cmd_install ;;
  uninstall)   cmd_uninstall ;;
  start)       cmd_start ;;
  stop)        cmd_stop ;;
  restart)     cmd_restart ;;
  status)      cmd_status ;;
  logs)        cmd_logs "${2:-60}" ;;
  run)         cmd_run ;;
  token)       cmd_token ;;
  label)       printf '%s\n' "$LABEL" ;;
  leader)      cmd_leader ;;
  agent-token) cmd_agent_token "${2:-}" "${3:-}" ;;
  backup)      cmd_backup ;;
  restore)     cmd_restore "${2:-}" ;;
  pair)        cmd_pair ;;
  devices)     cmd_devices ;;
  revoke)      cmd_revoke "${2:-}" ;;
  remote)      cmd_remote "${2:-status}" "${3:-}" ;;
  *) sed -n '2,22p' "$0"; exit 1 ;;
esac
