#!/usr/bin/env bash
# Print every version a CI job on this Mac can see, one sorted `key value` line
# each, so two runner hosts can be compared with a plain diff.
#
#   scripts/host-manifest.sh                    # this host's manifest
#   scripts/host-manifest.sh --peer <ssh-host>  # the same, run on a peer over ssh
#   scripts/host-manifest.sh --diff <ssh-host>  # this host against a peer: exit 1 on a difference
#   scripts/host-manifest.sh --compare a b      # two saved manifests: exit 1 on a difference
#
# Why: a job's toolchain must not depend on which host GitHub handed it to. A
# runner registered on a host with a different Xcode, simulator runtime, Metal
# toolchain, JDK or Android SDK does not fail at registration; it takes a job
# and fails in the middle of it, and the failure reads as a flaky build. So a
# new host is compared with the one it joins BEFORE its first runner registers,
# and the diff must show hardware lines only.
#
# Lines under `hw.` (cores, memory, disk, model) are expected to differ and are
# left out of --diff and --compare. Everything else is a parity gap: fix the
# bootstrap (scripts/bootstrap-host.sh), not the box by hand.
#
# Formulae are the ones examples/Brewfile.ci names (FLEET_MANIFEST_BREWFILE
# overrides): a host may carry other tools of its own, and those are not the
# CI's business. Read-only; nothing here changes the host.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/.." 2>/dev/null && pwd)"
ROOT="${FLEET_ROOT:-$HERE}"
BREWFILE="${FLEET_MANIFEST_BREWFILE:-$HERE/examples/Brewfile.ci}"
# Run over ssh by --peer: the Brewfile arrives in the environment.
if [ -n "${FLEET_MANIFEST_BREWFILE_B64:-}" ]; then
  BREWFILE="$(mktemp -t brewfile)"
  trap 'rm -f "$BREWFILE"' EXIT
  printf '%s' "$FLEET_MANIFEST_BREWFILE_B64" | base64 -D > "$BREWFILE" 2>/dev/null \
    || printf '%s' "$FLEET_MANIFEST_BREWFILE_B64" | base64 -d > "$BREWFILE"
fi

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Lines that may differ between two hosts and still count as parity.
strip_hw() { grep -v '^hw\.' "$1" | grep -v '^#'; }

compare() {
  local a="$1" b="$2" out
  [ -s "$a" ] || { echo "empty or missing manifest: $a" >&2; return 2; }
  [ -s "$b" ] || { echo "empty or missing manifest: $b" >&2; return 2; }
  if out="$(diff <(strip_hw "$a") <(strip_hw "$b"))"; then
    echo "parity: no difference outside hw.* ($(strip_hw "$a" | wc -l | tr -d ' ') lines compared)"
    return 0
  fi
  echo "parity gaps (< ${3:-first}, > ${4:-second}):"
  printf '%s\n' "$out" | grep '^[<>]'
  return 1
}

manifest() {
  export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"
  local x dev name ver build
  # ---- hardware: expected to differ ----------------------------------------
  echo "hw.model $(sysctl -n hw.model 2>/dev/null)"
  echo "hw.cores $(sysctl -n hw.ncpu 2>/dev/null)"
  echo "hw.memory_gb $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))"
  echo "hw.disk_free_gb $(df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
  echo "hw.hostname $(scutil --get LocalHostName 2>/dev/null || hostname -s)"
  # ---- operating system -----------------------------------------------------
  echo "os.macos $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
  echo "os.arch $(uname -m)"
  echo "os.home $HOME"
  # ---- Xcode: every copy in /Applications, and the selected one -------------
  for x in /Applications/Xcode*.app; do
    [ -d "$x" ] || continue
    dev="$x/Contents/Developer"
    name="$(basename "$x" .app)"
    ver="$(DEVELOPER_DIR="$dev" xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/Build version/build/; s/ *$//')"
    echo "xcode.$name ${ver:-unreadable}"
    # The Metal toolchain is a separate download per Xcode; without it any
    # target with a .metal file fails to build (B2 trap, 10-09).
    build="$(DEVELOPER_DIR="$dev" xcodebuild -showComponent MetalToolchain 2>/dev/null \
      | awk -F': ' '/^Build Version/ {b=$2} /^Status/ {s=$2} END {print b" "s}')"
    echo "metal.$name ${build:-none}"
  done
  echo "xcode.selected $(xcode-select -p 2>/dev/null || echo none)"
  # Runtimes are system-wide: iOS 27.0 (24A434) and so on. UUIDs differ per host.
  if command -v xcrun >/dev/null 2>&1; then
    xcrun simctl runtime list 2>/dev/null \
      | sed -nE 's/^(iOS|tvOS|watchOS|visionOS|xrOS) ([0-9.]+) \(([^)]*)\).*\(([A-Za-z]+)\)$/runtime.\1-\2 \3 \4/p'
  fi
  # ---- languages ------------------------------------------------------------
  for x in node python3 uv deno kotlin gh jq shellcheck xcodegen gtar colima docker git make ruby; do
    if command -v "$x" >/dev/null 2>&1; then
      case "$x" in
        python3|node|uv|deno|gh|jq|xcodegen|colima|docker|git|make|ruby)
          ver="$("$x" --version 2>&1 | head -1)" ;;
        shellcheck) ver="$(shellcheck --version 2>/dev/null | sed -n 's/^version: //p')" ;;
        kotlin) ver="$(kotlin -version 2>&1 | head -1)" ;;
        gtar) ver="$(gtar --version 2>/dev/null | head -1)" ;;
      esac
      echo "tool.$x ${ver:-present} @ $(command -v "$x")"
    else
      echo "tool.$x missing"
    fi
  done
  echo "tool.python3-system $(/usr/bin/python3 --version 2>&1 | head -1)"
  # PyYAML is imported by kit-ci without installing it, from both pythons.
  for x in "$(command -v python3)" /usr/bin/python3; do
    [ -x "$x" ] || continue
    if "$x" -c 'import yaml' >/dev/null 2>&1; then echo "pyyaml.$x yes"; else echo "pyyaml.$x no"; fi
  done
  if [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
    echo "tool.java21 $(/opt/homebrew/opt/openjdk@21/bin/java -version 2>&1 | head -1)"
  else
    echo "tool.java21 missing"
  fi
  # ---- Homebrew: the CI's formulae only ------------------------------------
  if command -v brew >/dev/null 2>&1 && [ -f "$BREWFILE" ]; then
    local formula cask installed
    installed="$(brew list --versions 2>/dev/null)"
    while IFS= read -r formula; do
      ver="$(printf '%s\n' "$installed" | awk -v f="$formula" '$1==f {print $NF}')"
      echo "brew.$formula ${ver:-missing}"
    done < <(sed -n 's/^brew "\([^"]*\)".*/\1/p' "$BREWFILE")
    while IFS= read -r cask; do
      if brew list --cask "$cask" >/dev/null 2>&1; then echo "cask.$cask present"; else echo "cask.$cask missing"; fi
    done < <(sed -n 's/^cask "\([^"]*\)".*/\1/p' "$BREWFILE")
  else
    echo "brew missing"
  fi
  # ---- Android SDK -----------------------------------------------------------
  local sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}" p
  if [ -d "$sdk" ]; then
    for p in "$sdk"/platforms/* "$sdk"/build-tools/* "$sdk"/ndk/* "$sdk"/emulator "$sdk"/platform-tools "$sdk"/cmdline-tools/*; do
      [ -d "$p" ] || continue
      ver="$(sed -n 's/^Pkg.Revision=//p' "$p/source.properties" 2>/dev/null | head -1)"
      echo "android.${p#"$sdk"/} ${ver:-present}"
    done
    for p in "$sdk"/system-images/*/*/*; do
      [ -d "$p" ] && echo "android.${p#"$sdk"/} present"
    done
  else
    echo "android.sdk missing"
  fi
  # ---- CI settings and caches ---------------------------------------------------
  for x in org.gradle.workers.max org.gradle.daemon.idletimeout; do
    echo "gradle.$x $(sed -n "s/^$x=//p" "$HOME/.gradle/gradle.properties" 2>/dev/null | tail -1)"
  done
  for p in "$HOME"/Library/Caches/ms-playwright/*; do
    [ -d "$p" ] && echo "playwright.$(basename "$p") present"
  done
  # The runner keeps itself updated; every runner on a host runs the same build.
  local listener
  for p in "$ROOT"/*/bin/Runner.Listener; do
    [ -x "$p" ] && { listener="$p"; break; }
  done
  if [ -n "${listener:-}" ]; then
    echo "runner.version $("$listener" --version 2>/dev/null)"
  else
    echo "runner.version none-registered"
  fi
  echo "fleet.xcode_version ${FLEET_XCODE_VERSION:-$(sed -n 's/^FLEET_XCODE_VERSION=//p' "$ROOT/fleet.env" 2>/dev/null)}"
}

case "${1:-}" in
  ""|--local) manifest | sort ;;
  --peer)
    peer="${2:?--peer needs an ssh host}"
    # The peer runs this same file from stdin, so its own checkout may be older
    # than this one. The Brewfile travels with it, base64 in the environment.
    # shellcheck disable=SC2029
    ssh -o BatchMode=yes "$peer" \
      "FLEET_MANIFEST_BREWFILE_B64='$(base64 < "$BREWFILE" | tr -d '\n')' FLEET_ROOT=\${FLEET_ROOT:-\$HOME/actions-runners} bash -s -- --local" \
      < "$0"
    ;;
  --diff)
    peer="${2:?--diff needs an ssh host}"
    here_m="$(mktemp -t manifest-here)"; peer_m="$(mktemp -t manifest-peer)"
    trap 'rm -f "$here_m" "$peer_m"' EXIT
    "$0" > "$here_m"
    "$0" --peer "$peer" > "$peer_m"
    compare "$peer_m" "$here_m" "$peer" "$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
    ;;
  --compare) compare "${2:?--compare needs two files}" "${3:?--compare needs two files}" "$2" "$3" ;;
  -h|--help) usage ;;
  *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac
