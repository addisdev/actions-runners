#!/usr/bin/env bash
# Build a new CI runner host to the same toolchain as a peer that already runs
# the fleet's jobs: the user-level half. The root half (Xcode licence, sleep,
# Spotlight, Rosetta, tailscaled) is scripts/bootstrap-host-root.sh, run by the
# host's owner with sudo.
#
#   scripts/bootstrap-host.sh --peer <ssh-host>                 # what it would do
#   scripts/bootstrap-host.sh --peer <ssh-host> --apply         # do all of it
#   scripts/bootstrap-host.sh --peer <ssh-host> --apply --only xcode,android
#   scripts/bootstrap-host.sh --peer <ssh-host> --coordinator http://host:7878 --apply --only fleet-env
#
# Steps, in order, each safe to repeat (a step whose result is already there
# says so and does nothing):
#   brew        brew bundle --file examples/Brewfile.ci
#   xcode       copy every /Applications/Xcode*.app the peer has, unless the same
#               build is already here (tar over ssh into a temp dir, then a rename,
#               so a cut copy never sits at the real path). No Apple ID needed.
#   metal       the Metal toolchain for each Xcode (-downloadComponent)
#   runtimes    every simulator runtime the peer has (-downloadPlatform)
#   android     copy ~/Library/Android/sdk from the peer when it is not here
#   gradle      org.gradle.workers.max=4 and daemon.idletimeout=600000 in
#               ~/.gradle/gradle.properties (idle daemons held 40 GB on a 96 GB host)
#   playwright  copy the peer's warm ~/Library/Caches/ms-playwright (a cold cache
#               failed Firefox jobs while it filled)
#   pyyaml      PyYAML (pip --user) for Homebrew's python3 and /usr/bin/python3
#   toolcache   ~/hostedtoolcache, where setup-* actions expect a tool cache
#   colima      a small build-only Docker VM (4 CPU, 6 GB), started at login
#   fleet-env   fleet.env from examples/fleet.env.build-box, the peer's labels,
#               lanes and Xcode version copied in. Never overwrites one.
#
# Then: scripts/host-manifest.sh --diff <peer> must show hardware lines only,
# and after the first runners register, scripts/install-ps-shim.sh --apply.
#
# Reads the peer, never writes to it. Everything is a dry run without --apply.
set -uo pipefail   # not -e: each step reports its own failure and the rest still run
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${FLEET_BOOTSTRAP_ROOT:-$HERE}"
BREWFILE="$HERE/examples/Brewfile.ci"
TEMPLATE="$HERE/examples/fleet.env.build-box"
APPS="${FLEET_BOOTSTRAP_APPS:-/Applications}"
ALL_STEPS="brew xcode metal runtimes android gradle playwright pyyaml toolcache colima fleet-env"

PEER=""; APPLY=0; ONLY=""; COORD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --peer) PEER="${2:?--peer needs an ssh host}"; shift ;;
    --apply) APPLY=1 ;;
    --only) ONLY="${2:?--only needs a step list}"; shift ;;
    --coordinator) COORD="${2:?--coordinator needs a URL}"; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

ok()   { printf '    ✓ %s\n' "$*"; }
todo() { if [ "$APPLY" -eq 1 ]; then printf '    → %s\n' "$*"; else printf '    · would %s\n' "$*"; fi; }
warn() { printf '    ! %s\n' "$*"; }
bad()  { printf '    ✗ %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
header() { printf '\n==> %s\n' "$*"; }
PROBLEMS=0

want() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}
for s in ${ONLY//,/ }; do
  case " $ALL_STEPS " in *" $s "*) ;; *) echo "unknown step: $s (steps: $ALL_STEPS)" >&2; exit 2 ;; esac
done

need_peer() {
  [ -n "$PEER" ] && return 0
  bad "this step copies from a peer: pass --peer <ssh-host>"
  return 1
}
peer() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$PEER" "$@"; }

# The peer's fleet.env, read as text and never sourced. FLEET_BOOTSTRAP_PEER_ENV
# (a local file) stands in for it in tests.
peer_env() {
  if [ -n "${FLEET_BOOTSTRAP_PEER_ENV:-}" ]; then cat "$FLEET_BOOTSTRAP_PEER_ENV"; return; fi
  peer 'cat ~/actions-runners/fleet.env'
}

xcode_build() { DEVELOPER_DIR="$1/Contents/Developer" xcodebuild -version 2>/dev/null | sed -n 's/^Build version //p'; }

step_brew() {
  header "Homebrew formulae (examples/Brewfile.ci)"
  if ! command -v brew >/dev/null; then
    bad "no Homebrew: the owner's day-0 script installs it (it needs the account password)"
    return
  fi
  if brew bundle check --file "$BREWFILE" --no-upgrade >/dev/null 2>&1; then
    ok "every formula and cask in the Brewfile is installed"
  else
    todo "brew bundle --file examples/Brewfile.ci --no-upgrade"
    [ "$APPLY" -eq 1 ] && { brew bundle --file "$BREWFILE" --no-upgrade || bad "brew bundle failed"; }
  fi
}

step_xcode() {
  header "Xcode, copied from $PEER"
  need_peer || return 0
  local apps app theirs ours tmp
  apps="$(peer 'for a in /Applications/Xcode*.app; do [ -d "$a" ] && basename "$a"; done')" || { bad "cannot list the peer's Xcode"; return; }
  for app in $apps; do
    theirs="$(peer "DEVELOPER_DIR=/Applications/$app/Contents/Developer xcodebuild -version 2>/dev/null | sed -n 's/^Build version //p'")"
    ours=""
    [ -d "$APPS/$app" ] && ours="$(xcode_build "$APPS/$app")"
    if [ -n "$ours" ] && [ "$ours" = "$theirs" ]; then
      ok "$app build $ours, same as the peer"
      continue
    fi
    [ -n "$ours" ] && warn "$app here is build $ours, the peer's is $theirs: it is replaced"
    todo "copy $PEER:/Applications/$app (build $theirs) to $APPS/$app"
    [ "$APPLY" -eq 1 ] || continue
    tmp="$(mktemp -d "$APPS/.bootstrap-xcode.XXXXXX")"
    if peer "tar -C /Applications -cf - '$app'" | tar -C "$tmp" -xpf -; then
      [ -d "$APPS/$app" ] && mv "$APPS/$app" "$tmp/old-$app"
      mv "$tmp/$app" "$APPS/$app"
      rm -rf "$tmp"
      ours="$(xcode_build "$APPS/$app")"
      [ "$ours" = "$theirs" ] && ok "$app build $ours" || bad "$app copied but reads build '${ours:-nothing}', not $theirs"
    else
      rm -rf "$tmp"; bad "copy of $app failed; nothing replaced"
    fi
  done
  warn "the licence and first launch need root: scripts/bootstrap-host-root.sh (the owner, with sudo)"
}

step_metal() {
  header "Metal toolchain for each Xcode"
  local x status
  for x in "$APPS"/Xcode*.app; do
    [ -d "$x" ] || continue
    status="$(DEVELOPER_DIR="$x/Contents/Developer" xcodebuild -showComponent MetalToolchain 2>/dev/null | sed -n 's/^Status: //p')"
    if [ "$status" = installed ]; then
      ok "$(basename "$x"): installed"
    else
      todo "DEVELOPER_DIR=$x/Contents/Developer xcodebuild -downloadComponent MetalToolchain"
      [ "$APPLY" -eq 1 ] && { DEVELOPER_DIR="$x/Contents/Developer" xcodebuild -downloadComponent MetalToolchain || bad "Metal toolchain download failed for $(basename "$x")"; }
    fi
  done
}

runtimes_of() {
  sed -nE 's/^(iOS|tvOS|watchOS|visionOS|xrOS) ([0-9.]+) \(([^)]*)\).*\(Ready\)$/\1 \2 \3/p'
}

step_runtimes() {
  header "Simulator runtimes the peer has"
  need_peer || return 0
  local theirs ours plat ver build
  theirs="$(peer 'xcrun simctl runtime list 2>/dev/null' | runtimes_of)" || { bad "cannot list the peer's runtimes"; return; }
  ours="$(xcrun simctl runtime list 2>/dev/null | runtimes_of || true)"
  while read -r plat ver build; do
    [ -n "$plat" ] || continue
    if printf '%s\n' "$ours" | grep -q "^$plat $ver $build$"; then
      ok "$plat $ver ($build)"
    else
      todo "xcodebuild -downloadPlatform $plat -buildVersion $build   # $plat $ver"
      [ "$APPLY" -eq 1 ] && { xcodebuild -downloadPlatform "$plat" -buildVersion "$build" || bad "$plat $ver ($build) did not download"; }
    fi
  done <<< "$theirs"
}

copy_tree() {  # copy_tree <peer path under ~> <local path>
  local src="$1" dst="$2" parent tmp
  parent="$(dirname "$dst")"; mkdir -p "$parent"
  tmp="$(mktemp -d "$parent/.bootstrap.XXXXXX")"
  if peer "tar -C \"\$HOME/$(dirname "$src")\" -cf - '$(basename "$src")'" | tar -C "$tmp" -xpf -; then
    [ -e "$dst" ] && mv "$dst" "$tmp/old"
    mv "$tmp/$(basename "$src")" "$dst"
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"; return 1
}

step_android() {
  header "Android SDK"
  local sdk="$HOME/Library/Android/sdk"
  if [ -d "$sdk/platforms" ] && [ -d "$sdk/build-tools" ]; then
    ok "present at $sdk (host-manifest.sh --diff says whether it matches)"
    return
  fi
  need_peer || return 0
  todo "copy $PEER:~/Library/Android/sdk to $sdk"
  [ "$APPLY" -eq 1 ] && { copy_tree Library/Android/sdk "$sdk" && ok "copied" || bad "SDK copy failed"; }
}

step_gradle() {
  header "Gradle properties (~/.gradle/gradle.properties)"
  local f="$HOME/.gradle/gradle.properties" key val
  for kv in org.gradle.workers.max=4 org.gradle.daemon.idletimeout=600000; do
    key="${kv%%=*}"; val="${kv#*=}"
    if [ -f "$f" ] && grep -q "^$key=$val$" "$f"; then
      ok "$key=$val"
    else
      todo "set $key=$val"
      if [ "$APPLY" -eq 1 ]; then
        mkdir -p "$(dirname "$f")"; touch "$f"
        grep -v "^$key=" "$f" > "$f.tmp" || true
        printf '%s=%s\n' "$key" "$val" >> "$f.tmp"; mv "$f.tmp" "$f"
      fi
    fi
  done
}

step_playwright() {
  header "Playwright browser cache"
  need_peer || return 0
  local cache="$HOME/Library/Caches/ms-playwright" theirs missing=""
  theirs="$(peer 'ls ~/Library/Caches/ms-playwright 2>/dev/null')" || true
  for b in $theirs; do [ -d "$cache/$b" ] || missing="$missing $b"; done
  if [ -z "$missing" ]; then ok "every browser build the peer has is here"; return; fi
  todo "copy from $PEER:$missing"
  if [ "$APPLY" -eq 1 ]; then
    mkdir -p "$cache"
    # shellcheck disable=SC2086
    peer "cd ~/Library/Caches/ms-playwright && tar -cf - $missing" | tar -C "$cache" -xpf - \
      && ok "copied" || bad "Playwright cache copy failed"
  fi
}

step_pyyaml() {
  header "PyYAML for both pythons (kit lint steps import it without installing it)"
  # --user for both, as on the current host: Homebrew's python is PEP 668
  # managed, so its install needs --break-system-packages, which touches only
  # ~/Library/Python/<version>, never Homebrew's own site-packages.
  local py extra
  for py in /opt/homebrew/bin/python3 /usr/bin/python3; do
    [ -x "$py" ] || { warn "no $py"; continue; }
    if "$py" -c 'import yaml' >/dev/null 2>&1; then ok "$py imports yaml"; continue; fi
    extra=""; [ "$py" = /opt/homebrew/bin/python3 ] && extra="--break-system-packages"
    todo "$py -m pip install --user $extra pyyaml"
    # shellcheck disable=SC2086
    [ "$APPLY" -eq 1 ] && { "$py" -m pip install --user --quiet $extra pyyaml || bad "pip install pyyaml failed for $py"; }
  done
}

step_toolcache() {
  header "Tool cache"
  if [ -d "$HOME/hostedtoolcache" ]; then ok "$HOME/hostedtoolcache"; else
    todo "mkdir $HOME/hostedtoolcache"
    [ "$APPLY" -eq 1 ] && mkdir -p "$HOME/hostedtoolcache"
  fi
  [ "$HOME" = /Users/runner ] || warn "home is $HOME, not /Users/runner: setup-* actions that hardcode /Users/runner/hostedtoolcache need a sudo symlink"
}

step_colima() {
  header "Docker (Colima build VM)"
  if ! command -v colima >/dev/null; then bad "no colima: run the brew step first"; return; fi
  if colima status >/dev/null 2>&1; then
    ok "colima is running ($(colima list 2>/dev/null | awk 'NR==2 {print $4" CPU, "$5" memory"}'))"
  else
    todo "colima start --cpu 4 --memory 6 --disk 60 --runtime docker; brew services start colima"
    if [ "$APPLY" -eq 1 ]; then
      colima start --cpu 4 --memory 6 --disk 60 --runtime docker || bad "colima start failed"
      brew services start colima >/dev/null || warn "brew services start colima failed: it will not start at login"
    fi
  fi
}

step_fleet_env() {
  header "fleet.env from examples/fleet.env.build-box"
  local out="$ROOT/fleet.env" host_id penv line key value body
  if [ -f "$out" ]; then ok "$out exists; left as it is"; return; fi
  if [ -z "${FLEET_BOOTSTRAP_PEER_ENV:-}" ]; then need_peer || return 0; fi
  [ -n "$COORD" ] || { bad "--coordinator <url> is needed (the coordinator as this host reaches it)"; return; }
  host_id="${FLEET_BOOTSTRAP_HOST_ID:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}"
  penv="$(peer_env)" || { bad "cannot read the peer's fleet.env"; return; }
  body="$(sed -e "s|@HOST_ID@|$host_id|g" -e "s|@COORDINATOR@|$COORD|g" -e "s|@ROOT@|$ROOT|g" "$TEMPLATE")"
  local missing=""
  while IFS= read -r line; do
    case "$line" in
      *=@COPIED@)
        key="${line%%=*}"
        value="$(printf '%s\n' "$penv" | grep "^$key=" | tail -1 || true)"
        if [ -n "$value" ]; then
          printf '%s\n' "$value"
        else
          missing="$missing $key"
          printf '# %s: not set on the peer\n' "$key"
        fi
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <<< "$body" > "${out}.new"
  [ -n "$missing" ] && warn "not set on the peer, left out:$missing"
  if grep -q '@[A-Z_]*@' "${out}.new"; then
    bad "placeholders left in the result: $(grep -o '@[A-Z_]*@' "${out}.new" | sort -u | tr '\n' ' ')"
    rm -f "${out}.new"; return
  fi
  if [ "$APPLY" -eq 1 ]; then
    mv "${out}.new" "$out"; chmod 600 "$out"; ok "wrote $out (host id $host_id)"
  else
    todo "write $out (host id $host_id); preview:"
    grep -E '^FLEET_(HOST_ID|HOST_LABELS|XCODE_VERSION|COORDINATOR|ADMIT_HEAVY_MAX)' "${out}.new" | sed 's/^/        /'
    rm -f "${out}.new"
  fi
}

printf 'bootstrap-host: %s%s\n' "$([ "$APPLY" -eq 1 ] && echo applying || echo 'dry run')" "${PEER:+, peer $PEER}"
for s in $ALL_STEPS; do
  want "$s" || continue
  case "$s" in
    fleet-env) step_fleet_env ;;
    *) "step_$s" ;;
  esac
done

header "Next"
echo "    scripts/host-manifest.sh --diff ${PEER:-<peer>}   # must show hardware lines only"
echo "    scripts/join-host.sh                         # dry run; then --apply --only <pilot repos>"
echo "    scripts/install-ps-shim.sh --apply           # once the first runners exist"
[ "$PROBLEMS" -eq 0 ] || { printf '\n%s problem(s) above.\n' "$PROBLEMS"; exit 1; }
