#!/usr/bin/env bash
# The root half of building a CI runner host: the settings only an
# administrator can change. Run by the host's owner, at the box, with sudo:
#
#   sudo scripts/bootstrap-host-root.sh            # what it would change
#   sudo scripts/bootstrap-host-root.sh --apply    # change it
#
# What it sets, each safe to repeat:
#   - Xcode: licence accepted and first launch run for every /Applications/Xcode*.app
#     (skipped, with a note, for an Xcode not copied yet: run it again after
#     scripts/bootstrap-host.sh --only xcode), and /Applications/Xcode.app selected.
#   - Power: never sleep, restart after a power cut (pmset sleep 0, disksleep 0,
#     autorestart 1, womp 1). A sleeping box takes no jobs.
#   - Spotlight off on every volume (mdutil -i off -a, then -E). A CI-only box has
#     nothing to search, and indexing runner work trees starved a host until jobs
#     lost contact mid-step (2026-09-12); its file-event daemon later grew to 76 GB.
#   - Rosetta, for the x86_64 tools some Android and Java builds still start.
#   - tailscaled as a system daemon, so the box is reachable from away after a
#     reboot with nobody logged in. Signing in (tailscale up) stays the owner's.
#
# What it never does: FileVault, auto-login, sharing, accounts or passwords.
# Those are System Settings, by hand, by the owner.
set -uo pipefail
APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0 ${1:-}" >&2
  exit 1
fi
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ok()   { printf '    ✓ %s\n' "$*"; }
todo() { if [ "$APPLY" -eq 1 ]; then printf '    → %s\n' "$*"; else printf '    · would %s\n' "$*"; fi; }
warn() { printf '    ! %s\n' "$*"; }
bad()  { printf '    ✗ %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
header() { printf '\n==> %s\n' "$*"; }
run()  { [ "$APPLY" -eq 1 ] || return 0; "$@" || bad "failed: $*"; }
PROBLEMS=0

header "Xcode"
found=0
for x in /Applications/Xcode*.app; do
  [ -d "$x" ] || continue
  found=1
  dev="$x/Contents/Developer"
  if DEVELOPER_DIR="$dev" xcodebuild -license check >/dev/null 2>&1; then
    ok "$(basename "$x"): licence accepted"
  else
    todo "accept the licence and run first launch for $(basename "$x")"
    run env DEVELOPER_DIR="$dev" xcodebuild -license accept
    run env DEVELOPER_DIR="$dev" xcodebuild -runFirstLaunch
  fi
done
[ "$found" -eq 1 ] || warn "no Xcode in /Applications yet: run this again after it is copied"
if [ -d /Applications/Xcode.app ]; then
  if [ "$(xcode-select -p 2>/dev/null)" = /Applications/Xcode.app/Contents/Developer ]; then
    ok "xcode-select: /Applications/Xcode.app"
  else
    todo "xcode-select -s /Applications/Xcode.app"
    run xcode-select -s /Applications/Xcode.app
  fi
fi

header "Power"
for kv in sleep=0 disksleep=0 autorestart=1 womp=1; do
  key="${kv%%=*}"; want="${kv#*=}"
  have="$(pmset -g | awk -v k="$key" '$1==k {print $2; exit}')"
  if [ "$have" = "$want" ]; then ok "$key $want"; else
    todo "pmset -a $key $want (now ${have:-unset})"
    run pmset -a "$key" "$want"
  fi
done

header "Spotlight"
if mdutil -s -a 2>/dev/null | grep -q 'Indexing enabled'; then
  todo "mdutil -i off -a && mdutil -E -a"
  run mdutil -i off -a
  run mdutil -E -a
else
  ok "indexing off on every volume"
fi

header "Rosetta"
if /usr/bin/pgrep -q oahd || arch -x86_64 /usr/bin/true 2>/dev/null; then
  ok "installed"
else
  todo "softwareupdate --install-rosetta --agree-to-license"
  run softwareupdate --install-rosetta --agree-to-license
fi

header "Tailscale"
if [ -f /Library/LaunchDaemons/com.tailscale.tailscaled.plist ]; then
  ok "tailscaled is a system daemon"
elif command -v tailscaled >/dev/null; then
  todo "tailscaled install-system-daemon"
  run tailscaled install-system-daemon
else
  warn "no tailscaled: brew install tailscale first (examples/Brewfile.ci)"
fi
echo "    then, as the owner: sudo tailscale up   (approve the sign-in in the browser)"

[ "$PROBLEMS" -eq 0 ] || { printf '\n%s problem(s) above.\n' "$PROBLEMS"; exit 1; }
