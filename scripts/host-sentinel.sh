#!/bin/bash
# host-sentinel.sh — from ANOTHER machine, notice the runner host going away.
#
#   scripts/host-sentinel.sh             # one probe; run it every minute from launchd
#   scripts/host-sentinel.sh --install   # write and load the LaunchAgent
#   scripts/host-sentinel.sh --uninstall
#   scripts/host-sentinel.sh --test-notify
#
# The one failure mode nothing on the runner host can report is the host itself
# being gone: asleep, off, or rebooted with nobody logged in (runner
# LaunchAgents start at login, so a reboot while nobody is home strands every
# one of them). The dashboard, its watchdog and its phone push all go down with
# it. This runs somewhere else — a Mac mini in the same house — and sends one
# message when the host stops answering and one when it comes back.
#
# Configuration lives in ~/.config/fleet-sentinel.env (mode 0600), sourced here:
#
#   SENTINEL_NAME=runner-host              # what the messages call the host
#   SENTINEL_TARGET=runner                 # tailnet name or IP to probe
#   SENTINEL_PROBE=tailscale               # tailscale (ping over the tailnet) | tcp (nc -z host 22)
#   SENTINEL_TAILSCALE=/opt/homebrew/opt/tailscale/bin/tailscale
#   SENTINEL_TS_SOCKET=                    # --socket for a userspace tailscaled, if any
#   SENTINEL_NTFY=https://ntfy.sh/<topic>  # where to send; the topic is the secret
#   SENTINEL_FAILS=3                       # consecutive failed probes before announcing
#
# Messages carry the host's name and nothing else about the fleet.
#
# Deliberately bash 3.2 (the stock macOS shell), no arrays of arrays, no
# associative arrays, and every external command given an explicit path.
set -u

ENV_FILE="${SENTINEL_ENV:-$HOME/.config/fleet-sentinel.env}"
# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

NAME="${SENTINEL_NAME:-runner-host}"
TARGET="${SENTINEL_TARGET:-runner}"
PROBE="${SENTINEL_PROBE:-tailscale}"
TS_BIN="${SENTINEL_TAILSCALE:-/opt/homebrew/opt/tailscale/bin/tailscale}"
TS_SOCKET="${SENTINEL_TS_SOCKET:-}"
NTFY="${SENTINEL_NTFY:-}"
FAILS_NEEDED="${SENTINEL_FAILS:-3}"
STATE="${SENTINEL_STATE:-$HOME/.fleet-sentinel.state}"
LABEL="${SENTINEL_LABEL:-com.runner-fleet.host-sentinel}"
LOG="${SENTINEL_LOG:-$HOME/Library/Logs/fleet-host-sentinel.log}"
# Test seams: replace the probe or the delivery with a command.
PROBE_CMD="${SENTINEL_PROBE_CMD:-}"
NOTIFY_CMD="${SENTINEL_NOTIFY_CMD:-}"

now() { /bin/date +%s; }
say() { echo "$(/bin/date '+%Y-%m-%d %H:%M:%S') $*"; }

duration() {
  local s="$1"
  if [ "$s" -lt 120 ]; then echo "${s}s"
  elif [ "$s" -lt 7200 ]; then echo "$((s / 60)) min"
  else echo "$((s / 3600)) h $(((s % 3600) / 60)) min"; fi
}

probe() {
  if [ -n "$PROBE_CMD" ]; then /bin/sh -c "$PROBE_CMD" >/dev/null 2>&1; return $?; fi
  case "$PROBE" in
    tailscale)
      if [ -n "$TS_SOCKET" ]; then
        "$TS_BIN" --socket="$TS_SOCKET" ping -c 1 --timeout 8s "$TARGET" >/dev/null 2>&1
      else
        "$TS_BIN" ping -c 1 --timeout 8s "$TARGET" >/dev/null 2>&1
      fi ;;
    tcp) /usr/bin/nc -z -G 5 "$TARGET" 22 >/dev/null 2>&1 ;;
    *) say "unknown SENTINEL_PROBE=$PROBE"; return 2 ;;
  esac
}

notify() {
  local title="$1" body="$2" priority="$3" tags="$4"
  if [ -n "$NOTIFY_CMD" ]; then
    printf '%s\n%s\n%s\n' "$title" "$body" "$priority" | /bin/sh -c "$NOTIFY_CMD"
    return $?
  fi
  if [ -z "$NTFY" ]; then say "no SENTINEL_NTFY set — would have sent: $title"; return 0; fi
  /usr/bin/curl -fsS -m 15 -H "Title: $title" -H "Priority: $priority" -H "Tags: $tags" -d "$body" "$NTFY" >/dev/null
}

install_agent() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist" self
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$self</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>SENTINEL_ENV</key><string>$ENV_FILE</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
  /bin/launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  /bin/launchctl bootstrap "gui/$(id -u)" "$plist" && say "installed $LABEL (every 60 s), log: $LOG"
}

case "${1:-}" in
  --install) install_agent; exit $? ;;
  --uninstall)
    /bin/launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$STATE"
    say "removed $LABEL"; exit 0 ;;
  --test-notify)
    notify "Fleet sentinel test" "The sentinel on $(/bin/hostname -s) can reach you. It watches $NAME." default "white_check_mark"
    exit $? ;;
esac

# ---- one probe ---------------------------------------------------------------
status=up fails=0 since="$(now)"
# shellcheck source=/dev/null
[ -f "$STATE" ] && . "$STATE"

if probe; then
  if [ "$status" = down ]; then
    lasted="$(duration $(($(now) - since)))"
    notify "$NAME is back" "$NAME answers again after $lasted. Check the fleet: queued jobs start on their own, dead services may need a repair." default "white_check_mark" \
      && say "recovered after $lasted"
  fi
  status=up fails=0 since="$(now)"
else
  fails=$((fails + 1))
  say "$NAME did not answer ($fails/$FAILS_NEEDED)"
  if [ "$status" = up ] && [ "$fails" -ge "$FAILS_NEEDED" ]; then
    if notify "$NAME is down" "$NAME has not answered for $fails minutes. Asleep, off, or rebooted with nobody logged in — runners start at login. Only someone there can wake it." urgent "rotating_light"; then
      status=down since="$(now)"
      say "announced down"
    else
      say "could not deliver the down message; will retry next probe"
    fi
  fi
fi

umask 077
printf 'status=%s\nfails=%s\nsince=%s\n' "$status" "$fails" "$since" > "$STATE"
