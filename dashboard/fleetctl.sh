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
#   ./fleetctl.sh pair [--scopes read,act]  # pairing code for a device or a chat tool's sign-in
#   ./fleetctl.sh devices              # list paired devices and API tokens
#   ./fleetctl.sh revoke <name-or-key> # revoke a device or API token
#   ./fleetctl.sh api-token <name> [--scopes read,act]  # a scoped /api/v1 token for an agent
#   ./fleetctl.sh remote status        # show bind, LAN URLs, Tailscale state
#   ./fleetctl.sh remote lan on|off    # bind to 0.0.0.0 / revert to loopback
#   ./fleetctl.sh remote tailscale on|off  # configure Tailscale Serve (tailnet only)
#   ./fleetctl.sh remote funnel on|off     # publish only /mcp to the internet with Tailscale Funnel
#   ./fleetctl.sh remote cloudflare on <hostname>|off  # the same through a Cloudflare Tunnel
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
    <key>FLEET_ADMISSION_LOG</key><string>${FLEET_ADMISSION_LOG:-$HERE/logs/admission.ndjson}</string>
    <key>FLEET_SHM_LOG</key><string>${FLEET_SHM_LOG:-$HERE/logs/shm.ndjson}</string>
    <key>FLEET_SHM_LOW_FREE</key><string>${FLEET_SHM_LOW_FREE:-4}</string>
    <key>FLEET_PROJECTS</key><string>${FLEET_PROJECTS:-}</string>
    <key>FLEET_GROUP_IGNORE</key><string>${FLEET_GROUP_IGNORE:-}</string>
    <key>FLEET_GROUP_MIN</key><string>${FLEET_GROUP_MIN:-2}</string>
    <key>FLEET_GROUPS</key><string>${FLEET_GROUPS:-on}</string>
    <key>FLEET_CEILING</key><string>${FLEET_CEILING:-3}</string>
    <!-- The hooks' admission settings, so the verdict and alerts judge holds
         against the limits the hooks actually enforce. -->
    <key>FLEET_LABEL_PREFIX</key><string>${FLEET_LABEL_PREFIX:-com.runner-fleet}</string>
    <key>FLEET_ADMIT_MODE</key><string>${FLEET_ADMIT_MODE:-off}</string>
    <key>FLEET_ADMIT_MAX_WAIT_S</key><string>${FLEET_ADMIT_MAX_WAIT_S:-600}</string>
    <key>FLEET_ADMIT_MIN_FREE_DISK_GB</key><string>${FLEET_ADMIT_MIN_FREE_DISK_GB:-40}</string>
    <key>FLEET_ADMIT_MAX_CONCURRENT</key><string>${FLEET_ADMIT_MAX_CONCURRENT:-}</string>
    <key>FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT</key><string>${FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT:-}</string>
    <key>FLEET_SIMULATOR_RUNNERS</key><string>${FLEET_SIMULATOR_RUNNERS:-}</string>
    <!-- Standby tiers (lib/tiers.js, docs/design/tiers.md). -->
    <key>FLEET_TIERS_MODE</key><string>${FLEET_TIERS_MODE:-off}</string>
    <key>FLEET_TIERS_PRIMARY_HOST</key><string>${FLEET_TIERS_PRIMARY_HOST:-}</string>
    <key>FLEET_TIERS_STANDBY_HOSTS</key><string>${FLEET_TIERS_STANDBY_HOSTS:-}</string>
    <key>FLEET_TIERS_FLOOR_REPOS</key><string>${FLEET_TIERS_FLOOR_REPOS:-}</string>
    <key>FLEET_TIERS_PRIMARY_ONLY_REPOS</key><string>${FLEET_TIERS_PRIMARY_ONLY_REPOS:-}</string>
    <key>FLEET_TIERS_RESUME_AFTER_S</key><string>${FLEET_TIERS_RESUME_AFTER_S:-}</string>
    <key>FLEET_TIERS_QUEUE_AGE_S</key><string>${FLEET_TIERS_QUEUE_AGE_S:-}</string>
    <key>FLEET_TIERS_DRAIN_AFTER_S</key><string>${FLEET_TIERS_DRAIN_AFTER_S:-}</string>
    <key>FLEET_TIERS_PRIMARY_STALE_S</key><string>${FLEET_TIERS_PRIMARY_STALE_S:-}</string>
    <key>FLEET_TIERS_SELF_DRAIN</key><string>${FLEET_TIERS_SELF_DRAIN:-1}</string>
    <key>FLEET_TIERS_SELF_DRAIN_AFTER_S</key><string>${FLEET_TIERS_SELF_DRAIN_AFTER_S:-}</string>
    <key>FLEET_TIERS_SELF_RESUME_AFTER_S</key><string>${FLEET_TIERS_SELF_RESUME_AFTER_S:-}</string>
    <key>FLEET_TIERS_SELF_MIN_HOLD_S</key><string>${FLEET_TIERS_SELF_MIN_HOLD_S:-}</string>
    <key>FLEET_TIERS_SELF_MIN_OPEN_S</key><string>${FLEET_TIERS_SELF_MIN_OPEN_S:-}</string>
    <key>FLEET_TIERS_BUILD_CAP</key><string>${FLEET_TIERS_BUILD_CAP:-}</string>
    <key>FLEET_TIERS_SIMULATOR_CAP</key><string>${FLEET_TIERS_SIMULATOR_CAP:-}</string>
    <!-- Federation: bind address, agent token, capability labels, read-only -->
    <key>FLEET_HOST</key><string>${FLEET_HOST:-127.0.0.1}</string>
    <key>FLEET_ALLOWED_HOSTS</key><string>${FLEET_ALLOWED_HOSTS:-}</string>
    <key>FLEET_DEVICE_TOKENS_FILE</key><string>${FLEET_DEVICE_TOKENS_FILE:-$HERE/.fleet-device-tokens.json}</string>
    <!-- Public MCP listener for chat tools (remote funnel / remote cloudflare). -->
    <key>FLEET_PUBLIC_PORT</key><string>${FLEET_PUBLIC_PORT:-}</string>
    <key>FLEET_PUBLIC_URL</key><string>${FLEET_PUBLIC_URL:-}</string>
    <key>FLEET_OAUTH_CLIENTS_FILE</key><string>${FLEET_OAUTH_CLIENTS_FILE:-$HERE/.fleet-oauth-clients.json}</string>
    <key>FLEET_TAILSCALE</key><string>${FLEET_TAILSCALE:-auto}</string>
    <key>FLEET_TAILSCALE_BIN</key><string>${FLEET_TAILSCALE_BIN:-}</string>
    <key>FLEET_AGENT_TOKEN_FILE</key><string>${agent_token_file}</string>
    <key>FLEET_AGENT_TOKENS_FILE</key><string>${agent_tokens_file}</string>
    <key>FLEET_DATABASE_URL_FILE</key><string>${database_url_file}</string>
    <key>FLEET_DATABASE_SSL</key><string>${FLEET_DATABASE_SSL:-1}</string>
    <key>FLEET_DATABASE_SSL_INSECURE</key><string>${FLEET_DATABASE_SSL_INSECURE:-0}</string>
    <key>FLEET_REPLICA_ID</key><string>${FLEET_REPLICA_ID:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}</string>
    <key>FLEET_HOST_NAME</key><string>${FLEET_HOST_NAME:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}</string>
    <key>FLEET_HOST_LABELS</key><string>${FLEET_HOST_LABELS:-}</string>
    <key>FLEET_READ_ONLY</key><string>${FLEET_READ_ONLY:-0}</string>
    <key>FLEET_HOLD_DRAINS</key><string>${FLEET_HOLD_DRAINS:-1}</string>
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

# JSON is read with node rather than python3: node is already a hard
# requirement, and python3's version varies by host (3.9 here rejects the
# f-string escaping this used to need).
#   json_get <dotted.path>   print one field from JSON on stdin (objects as JSON)
json_get() {
  "$(node_bin)" -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let v;
      try { v = process.argv[1].split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(s)); }
      catch { process.exit(2); }
      if (v == null) process.exit(1);
      console.log(typeof v === "object" ? JSON.stringify(v) : String(v));
    });' "$1"
}

control_token() {
  [ -f "$HERE/.fleet-token" ] || { echo "no control token yet — start the daemon once and it will generate one" >&2; return 1; }
  cat "$HERE/.fleet-token"
}

# curl the local daemon with the control token. Prints the body; fails with the
# daemon's own error message rather than curl's bare "HTTP 403".
api() {
  local method="$1" path="$2" body="${3:-}" token out status
  token="$(control_token)" || return 1
  out="$(curl -sS --max-time 8 -X "$method" -w '\n%{http_code}' \
    -H "Authorization: Bearer $token" \
    ${body:+-H "Content-Type: application/json" -d "$body"} \
    "http://127.0.0.1:$PORT$path" 2>&1)" || { echo "daemon not answering on 127.0.0.1:$PORT — ./fleetctl.sh status" >&2; return 1; }
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [ "${status:0:1}" != "2" ]; then
    echo "daemon refused $path (HTTP $status): $(echo "$out" | json_get error.message 2>/dev/null || echo "$out" | json_get error 2>/dev/null || echo "$out")" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# Generate a pairing code via the running daemon and display it (+ terminal QR
# if qrencode is installed). The code is single-use and expires in 5 minutes.
cmd_pair() {
  local result code url warning alts scopes="" body=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --scopes) scopes="${2:-}"; shift 2 ;;
      *) echo "usage: $0 pair [--scopes read,act]" >&2; return 1 ;;
    esac
  done
  [ -n "$scopes" ] && body="$("$(node_bin)" -e 'console.log(JSON.stringify({ scopes: process.argv[1] }))' "$scopes")"
  result="$(api POST /api/pair/start "$body")" || return 1
  code="$(echo "$result" | json_get code)"
  url="$(echo "$result" | json_get url)"
  warning="$(echo "$result" | json_get warning 2>/dev/null || true)"
  alts="$(echo "$result" | "$(node_bin)" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const u of JSON.parse(s).alternatives??[])console.log("  "+u)})' 2>/dev/null || true)"
  echo ""
  echo "Pairing code: ${code:0:3} ${code:3:3}"
  echo "Open on the phone: $url"
  [ -n "$alts" ] && { echo "Other addresses:"; echo "$alts"; }
  [ -n "$warning" ] && { echo ""; echo "Note: $warning"; }
  echo ""
  echo "Scan the QR, open the link, or choose \"Enter pairing code\" in the"
  echo "dashboard's Control tab on the other device. Signing in a chat tool's"
  echo "connector? Type the code on its sign-in page. Single use; expires in 5 minutes."
  if command -v qrencode >/dev/null 2>&1; then
    echo ""
    qrencode -t UTF8 "$url"
  else
    echo "(brew install qrencode to print a QR code here)"
  fi
}

# A named token holding only the scopes given, for an agent or a script that
# talks to /api/v1 (docs/api.md). Printed once on stdout, so it can be piped
# into a keychain; the daemon keeps only its hash.
cmd_api_token() {
  local name="${1:-}" scopes="read" body result
  [ $# -gt 0 ] && shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --scopes) scopes="${2:-}"; shift 2 ;;
      *) name="" ; break ;;
    esac
  done
  [ -n "$name" ] || { echo "usage: $0 api-token <name> [--scopes read,act,act:danger]" >&2; return 1; }
  body="$("$(node_bin)" -e 'console.log(JSON.stringify({ name: process.argv[1], scopes: process.argv[2] }))' "$name" "$scopes")"
  result="$(api POST /api/v1/tokens "$body")" || return 1
  echo "$result" | json_get token
  echo "scopes $(echo "$result" | json_get scopes); revoke with: $0 revoke $(echo "$result" | json_get key)" >&2
}

cmd_devices() {
  api GET /api/devices | "$(node_bin)" -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const devs = JSON.parse(s).devices ?? [];
      if (!devs.length) return console.log("no devices paired");
      const at = (ms) => (ms ? new Date(ms).toLocaleString() : "never");
      for (const d of devs) {
        const scopes = (d.scopes ?? ["all scopes"]).join(",");
        console.log(`  ${d.key}  ${String(d.name).padEnd(30)}  ${String(d.kind ?? "device").padEnd(6)}  ${scopes.padEnd(20)}  paired ${at(d.createdAt)}  seen ${at(d.lastSeenAt)}`);
      }
    });'
}

# Revoke a device by key or exact name.
cmd_revoke() {
  local target="${1:-}"
  [ -n "$target" ] || { echo "usage: $0 revoke <key-or-name>" >&2; return 1; }
  local key
  key="$(api GET /api/devices | "$(node_bin)" -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const t = process.argv[1];
      const hits = (JSON.parse(s).devices ?? []).filter((d) => d.key === t || d.name === t);
      if (hits.length === 1) return console.log(hits[0].key);
      console.error(hits.length ? `"${t}" matches ${hits.length} devices — revoke by key (./fleetctl.sh devices)` : `no device found: ${t}`);
      process.exit(1);
    });' "$target")" || return 1
  api POST /api/devices/revoke "{\"key\":\"$key\"}" >/dev/null || return 1
  echo "revoked $target ($key)"
}

tailscale_bin() {
  if [ -n "${FLEET_TAILSCALE_BIN:-}" ]; then echo "$FLEET_TAILSCALE_BIN"; return 0; fi
  command -v tailscale 2>/dev/null && return 0
  # The Mac App Store build ships its CLI inside the app bundle, off PATH.
  for p in /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

# Set KEY=value in fleet.env, replacing any existing KEY= or export KEY= line
# (and only that key — FLEET_HOST must not clobber FLEET_HOST_NAME).
set_env_var() {
  local key="$1" value="$2" env_file="$ROOT/fleet.env"
  touch "$env_file"
  { grep -Ev "^[[:space:]]*(export[[:space:]]+)?${key}=" "$env_file" || true; echo "${key}=${value}"; } > "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
}

# The bind address is written into the LaunchAgent at install time, so changing
# it means regenerating the plist — a plain restart would reload the old value.
apply_env_change() {
  if [ -f "$PLIST" ]; then
    echo "Regenerating the LaunchAgent so the change takes effect..."
    cmd_install
  else
    echo "Not installed as a LaunchAgent; run ./fleetctl.sh install (or restart ./fleetctl.sh run)."
  fi
}

cmd_remote() {
  local sub="${1:-status}"
  case "$sub" in
    status)
      local access
      if access="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/access" 2>/dev/null)"; then
        local bind; bind="$(echo "$access" | json_get host 2>/dev/null || echo "?")"
        echo "Bind:  $bind:$PORT (running daemon)"
        case "$bind" in
          127.0.0.1|localhost|::1) echo "LAN:   off — loopback only (./fleetctl.sh remote lan on)" ;;
          0.0.0.0|::)              echo "LAN:   on — listening on all interfaces" ;;
          *)                       echo "LAN:   bound to $bind only" ;;
        esac
        [ "${FLEET_HOST:-127.0.0.1}" != "$bind" ] && \
          echo "       fleet.env says FLEET_HOST=${FLEET_HOST:-127.0.0.1} — run ./fleetctl.sh install to apply it"
        echo ""
        echo "Reachable at:"
        echo "$access" | "$(node_bin)" -e '
          let s = "";
          process.stdin.on("data", (c) => (s += c)).on("end", () => {
            const urls = JSON.parse(s).urls ?? [];
            if (!urls.length) console.log("  (this machine only)");
            for (const u of urls) console.log(`  ${u.label.padEnd(22)} ${u.url}`);
          });'
        echo ""
        echo "Public MCP: $(echo "$access" | json_get publicUrl 2>/dev/null || echo "off (./fleetctl.sh remote funnel on, or remote cloudflare on <hostname>)")"
      else
        echo "Bind:  ${FLEET_HOST:-127.0.0.1}:$PORT (from fleet.env — daemon not answering)"
      fi
      echo ""
      echo "Tailscale Serve:"
      local ts
      if ts="$(tailscale_bin)"; then
        "$ts" serve status 2>/dev/null || echo "  (not configured)"
      else
        echo "  tailscale CLI not found"
      fi
      echo ""
      echo "macOS firewall:"
      if /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -q enabled; then
        echo "  ON — for LAN access, allow node:"
        echo "    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(node_bin) --unblockapp $(node_bin)"
      else
        echo "  off"
      fi
      ;;

    lan)
      case "${2:-}" in
        on)
          set_env_var FLEET_HOST 0.0.0.0
          export FLEET_HOST=0.0.0.0
          echo "Set FLEET_HOST=0.0.0.0 in fleet.env"
          echo "Anyone on this network can view the dashboard; controls still need a token or pairing."
          if /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -q enabled; then
            echo ""
            echo "The macOS firewall is on. If phones cannot connect, allow node:"
            echo "  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(node_bin) --unblockapp $(node_bin)"
          fi
          echo ""
          apply_env_change
          ;;
        off)
          set_env_var FLEET_HOST 127.0.0.1
          export FLEET_HOST=127.0.0.1
          echo "Set FLEET_HOST=127.0.0.1 in fleet.env (loopback only; Tailscale Serve keeps working)"
          echo ""
          apply_env_change
          ;;
        *) echo "usage: $0 remote lan on|off" >&2; return 1 ;;
      esac
      ;;

    tailscale)
      local ts
      ts="$(tailscale_bin)" || { echo "tailscale CLI not found — install Tailscale, or set FLEET_TAILSCALE_BIN" >&2; return 1; }
      case "${2:-}" in
        on)
          "$ts" status >/dev/null 2>&1 || { echo "Tailscale is not connected — run: $ts up" >&2; return 1; }
          # Serve only, never Funnel: Serve is reachable from your tailnet,
          # Funnel from the whole internet.
          "$ts" serve --bg --https=443 "http://127.0.0.1:$PORT" || {
            echo "tailscale serve failed — if it printed a link, Serve must first be enabled for your tailnet there." >&2
            return 1
          }
          local dns
          dns="$("$ts" status --json 2>/dev/null | json_get Self.DNSName 2>/dev/null | sed 's/\.$//' || true)"
          echo ""
          echo "Tailscale Serve is on. Reachable from your tailnet only (Funnel is never used)."
          [ -n "$dns" ] && echo "  https://$dns/"
          echo ""
          echo "To use controls from a remote device: ./fleetctl.sh pair"
          ;;
        off)
          # Only our listener: 'serve reset' would also remove anything else
          # this machine serves on the tailnet.
          "$ts" serve --https=443 off 2>/dev/null || "$ts" serve --https=443 "http://127.0.0.1:$PORT" off 2>/dev/null || {
            echo "could not remove the Serve config; inspect with: $ts serve status" >&2
            return 1
          }
          echo "Tailscale Serve for the dashboard is off."
          ;;
        *) echo "usage: $0 remote tailscale on|off" >&2; return 1 ;;
      esac
      ;;

    funnel)
      local ts
      ts="$(tailscale_bin)" || { echo "tailscale CLI not found — install Tailscale, or set FLEET_TAILSCALE_BIN" >&2; return 1; }
      case "${2:-}" in
        on)
          "$ts" status >/dev/null 2>&1 || { echo "Tailscale is not connected — run: $ts up" >&2; return 1; }
          local dns
          dns="$("$ts" status --json 2>/dev/null | json_get Self.DNSName 2>/dev/null | sed 's/\.$//' || true)"
          [ -n "$dns" ] || { echo "could not read this machine's tailnet name from: $ts status --json" >&2; return 1; }
          # The Funnel port carries only the public listener. 443 is left to
          # Serve, whose dashboard must never become public.
          "$ts" funnel --bg --https="$FUNNEL_PORT" "http://127.0.0.1:$PUBLIC_PORT" || {
            echo "tailscale funnel failed — if it printed a link, Funnel must first be enabled for this machine in the tailnet policy there." >&2
            return 1
          }
          set_public "https://$dns:$FUNNEL_PORT"
          ;;
        off)
          "$ts" funnel --https="$FUNNEL_PORT" off 2>/dev/null || {
            echo "could not remove the Funnel config; inspect with: $ts funnel status" >&2
            return 1
          }
          echo "Tailscale Funnel on port $FUNNEL_PORT is off."
          set_public ""
          ;;
        *) echo "usage: $0 remote funnel on|off" >&2; return 1 ;;
      esac
      ;;

    cloudflare)
      case "${2:-}" in
        on)
          local hostname="${3:-}"
          [ -n "$hostname" ] || { echo "usage: $0 remote cloudflare on <hostname, e.g. fleet-mcp.example.com>" >&2; return 1; }
          cmd_cloudflare_on "$hostname"
          ;;
        off)
          local tunnel_plist="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"
          launchctl unload "$tunnel_plist" 2>/dev/null || true
          rm -f "$tunnel_plist"
          echo "Stopped the tunnel. The tunnel and its DNS record are kept; remove them with:"
          echo "  cloudflared tunnel delete $CF_TUNNEL"
          set_public ""
          ;;
        *) echo "usage: $0 remote cloudflare on <hostname>|off" >&2; return 1 ;;
      esac
      ;;

    *)
      echo "usage: $0 remote status|lan on|off|tailscale on|off|funnel on|off|cloudflare on <hostname>|off" >&2; return 1 ;;
  esac
}

FUNNEL_PORT="${FLEET_FUNNEL_PORT:-8443}"
PUBLIC_PORT="${FLEET_PUBLIC_PORT:-7879}"
CF_TUNNEL="${FLEET_CLOUDFLARE_TUNNEL:-fleet-mcp}"
TUNNEL_LABEL="${FLEET_LABEL_PREFIX:-com.runner-fleet}.fleet-tunnel"

# Turns the public listener on at <url> (or off, given ""). One public URL at
# a time: it is the OAuth issuer, and a connector signed in through one
# tunnel would not recognise the other.
set_public() {
  local url="$1"
  if [ -n "$url" ]; then
    [ -n "${FLEET_PUBLIC_URL:-}" ] && [ "$FLEET_PUBLIC_URL" != "$url" ] && \
      echo "Replacing the public URL $FLEET_PUBLIC_URL; connectors signed in through it must sign in again."
    set_env_var FLEET_PUBLIC_PORT "$PUBLIC_PORT"
    set_env_var FLEET_PUBLIC_URL "$url"
    export FLEET_PUBLIC_PORT="$PUBLIC_PORT" FLEET_PUBLIC_URL="$url"
    echo ""
    echo "Public MCP server: $url/mcp"
    echo "Only /mcp and its OAuth sign-in are published; the dashboard is not."
    echo "Add that URL as a custom connector in the chat tool, then sign in with"
    echo "a code from: $0 pair --scopes read,act"
  else
    set_env_var FLEET_PUBLIC_PORT ""
    set_env_var FLEET_PUBLIC_URL ""
    export FLEET_PUBLIC_PORT="" FLEET_PUBLIC_URL=""
    echo "Public MCP listener off."
  fi
  echo ""
  apply_env_change
}

cloudflared_bin() {
  command -v cloudflared 2>/dev/null && return 0
  for p in /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

cmd_cloudflare_on() {
  local hostname="$1" cf id config
  cf="$(cloudflared_bin)" || { echo "cloudflared not found — brew install cloudflared" >&2; return 1; }
  [ -f "$HOME/.cloudflared/cert.pem" ] || {
    echo "cloudflared is not logged in. Run this, and pick the zone that holds $hostname:" >&2
    echo "  $cf tunnel login" >&2
    return 1
  }
  id="$("$cf" tunnel list --output json 2>/dev/null | "$(node_bin)" -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const t = (JSON.parse(s || "[]") ?? []).find((x) => x.name === process.argv[1] && !x.deleted_at);
      if (t) console.log(t.id);
    });' "$CF_TUNNEL" || true)"
  if [ -z "$id" ]; then
    "$cf" tunnel create "$CF_TUNNEL" || return 1
    id="$("$cf" tunnel list --output json | "$(node_bin)" -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        const t = JSON.parse(s).find((x) => x.name === process.argv[1] && !x.deleted_at);
        if (t) console.log(t.id);
      });' "$CF_TUNNEL")"
    [ -n "$id" ] || { echo "created tunnel $CF_TUNNEL but could not find its id" >&2; return 1; }
  fi
  # An existing record for this name is fine; anything else is not.
  local route
  if ! route="$("$cf" tunnel route dns "$CF_TUNNEL" "$hostname" 2>&1)"; then
    echo "$route" | grep -qi "already exists" || { echo "$route" >&2; return 1; }
    echo "DNS record for $hostname already exists; make sure it points at tunnel $CF_TUNNEL."
  fi

  # Cloudflare passes on only the paths the listener serves, so the tunnel is
  # narrow even before the listener's own 404s.
  config="$HOME/.cloudflared/$CF_TUNNEL.yml"
  cat > "$config" <<CF_EOF
tunnel: $id
credentials-file: $HOME/.cloudflared/$id.json
ingress:
  - hostname: $hostname
    path: '^/(mcp|oauth/.*|\.well-known/oauth-.*)$'
    service: http://127.0.0.1:$PUBLIC_PORT
  - service: http_status:404
CF_EOF
  "$cf" tunnel --config "$config" ingress validate >/dev/null || return 1

  local tunnel_plist="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
  cat > "$tunnel_plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$cf</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>$config</string>
    <string>run</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/tunnel.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$tunnel_plist" 2>/dev/null || true
  launchctl load "$tunnel_plist"
  echo "Cloudflare Tunnel $CF_TUNNEL is running as $TUNNEL_LABEL (log: $LOG_DIR/tunnel.log)."
  set_public "https://$hostname"
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
  pair)        shift; cmd_pair "$@" ;;
  api-token)   shift; cmd_api_token "$@" ;;
  devices)     cmd_devices ;;
  revoke)      cmd_revoke "${2:-}" ;;
  remote)      cmd_remote "${2:-status}" "${3:-}" "${4:-}" ;;
  *) sed -n '2,24p' "$0"; exit 1 ;;
esac
