#!/usr/bin/env bash
# Does this machine have everything the fleet's workflows assume?
#
#   ./preflight.sh            # check only what the workflows actually need
#   ./preflight.sh --all      # check everything this script knows how to check
#   ./preflight.sh --explain   # show what was inferred, and stop
#
# Run it on a prospective runner host BEFORE registering anything. Every check
# below corresponds to something a workflow actually does — a missing one is not
# a warning, it is a red build later, usually with a diagnostic that points
# somewhere other than the real cause.
#
# WHICH checks apply is read from the workflows themselves, out of the
# dashboard's `workflow_files` table, which already holds their YAML at no API
# cost. A fleet with no iOS repo should not be told it is missing xcodegen, and
# the Postgres versions to look for are the ones the workflows actually name
# rather than the two that happened to be right when this was written.
#
# Only files that mention `self-hosted` are consulted. A job pinned to
# `ubuntu-latest` runs on GitHub's hardware and implies nothing about this Mac —
# checking for its dependencies here is how you end up installing Postgres for a
# job that was never going to run on you.
#
# With no database to read (a brand-new host, where the dashboard is still on
# the old one), it says so and checks everything.
#
# Reports and exits non-zero on any miss. Installs nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"

MODE=infer
for a in "$@"; do
  case "$a" in
    --all)     MODE=all ;;
    --explain) MODE=explain ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

rc=0
ok()   { printf "  \033[32mok\033[0m    %s\n" "$*"; }
miss() { printf "  \033[31mMISS\033[0m  %s\n" "$*"; rc=1; }
warn() { printf "  \033[33mwarn\033[0m  %s\n" "$*"; }
skip() { printf "  \033[90m-\033[0m     %s\n" "$*"; }

# ------------------------------------------------------------------- inference

DB="${FLEET_DB:-$HERE/dashboard/fleet.db}"

NEED_XCODE=1 NEED_XCODEGEN=1 NEED_WATCHOS=1 NEED_SIM=1
NEED_NODE=1 NEED_DOCKER=1 NEED_ANDROID=1 NEED_POSTGRES=1
PG_VERSIONS=""
INFERRED_FROM=""

if [ "$MODE" != all ] && [ -f "$DB" ]; then
  # Avoid eval. The Python script outputs KEY=value lines; validate each line
  # matches a known identifier with a safe value before sourcing so a tampered
  # or buggy script cannot run arbitrary code here.
  _INFER_TMP=$(mktemp /tmp/preflight-infer.XXXXXX)
  python3 "$HERE/scripts/infer-checks.py" "$DB" 2>/dev/null > "$_INFER_TMP" || true
  # Strip anything that is not a known key assignment with a simple value.
  _INFER_SAFE=$(mktemp /tmp/preflight-safe.XXXXXX)
  grep -E '^(NEED_XCODE|NEED_XCODEGEN|NEED_WATCHOS|NEED_SIM|NEED_NODE|NEED_DOCKER|NEED_ANDROID|NEED_POSTGRES|PG_VERSIONS|INFERRED_FROM)=[^;&|$()`]*$' \
    "$_INFER_TMP" > "$_INFER_SAFE" || true
  # shellcheck source=/dev/null
  . "$_INFER_SAFE"
  rm -f "$_INFER_TMP" "$_INFER_SAFE"
fi

if [ "$MODE" = all ]; then
  INFERRED_FROM="--all: every check, nothing inferred"
elif [ -z "$INFERRED_FROM" ]; then
  INFERRED_FROM="no readable workflow data at $DB — checking everything"
fi

if [ "$MODE" = explain ]; then
  echo "source: $INFERRED_FROM"
  echo "  xcode/swift      $NEED_XCODE"
  echo "  xcodegen         $NEED_XCODEGEN"
  echo "  watchOS SDK      $NEED_WATCHOS"
  echo "  iPhone simulator $NEED_SIM"
  echo "  node / npm       $NEED_NODE"
  echo "  docker           $NEED_DOCKER"
  echo "  android sdk      $NEED_ANDROID"
  echo "  postgres         $NEED_POSTGRES  versions: ${PG_VERSIONS:-<none named>}"
  exit 0
fi

echo "== host =="
echo "  $(sw_vers -productName) $(sw_vers -productVersion)  $(uname -m)"
echo "  $(sysctl -n hw.ncpu) cores, $(( $(sysctl -n hw.memsize) / 1073741824 )) GB RAM"
echo "  LocalHostName: $(scutil --get LocalHostName 2>/dev/null)  (runner names derive from this)"
echo "  free disk: $(df -g / | awk 'NR==2{print $4}') GB"
echo "  checks: $INFERRED_FROM"

echo "== core =="
if [ "$(uname -m)" = "arm64" ]; then
  ok "Apple Silicon (arm64)"
else
  miss "Intel Mac ($(uname -m)) — only arm64 is supported; the runner tarball is osx-arm64"
fi
[ -d /opt/homebrew ] && ok "Homebrew at /opt/homebrew" || miss "Homebrew at /opt/homebrew — the runner .env hardcodes this PATH"
command -v git  >/dev/null && ok "git"  || miss "git"
command -v python3 >/dev/null && ok "python3 ($(python3 -V 2>&1 | cut -d' ' -f2))" || miss "python3 — used by register/status/health/cleanup and by several workflows"

# The dashboard requires Node >= 22.5.0 for node:sqlite. This check is
# unconditional — the requirement is architectural, not workflow-derived.
echo "== dashboard (node:sqlite) =="
if _node_ver=$(node -e "process.exit(0)" 2>/dev/null && node -e "const [maj,min]=process.version.slice(1).split('.').map(Number);process.exit(maj>22||(maj===22&&min>=5)?0:1)" 2>/dev/null && node -v 2>/dev/null); then
  ok "node $_node_ver (>= 22.5.0 required)"
elif command -v node >/dev/null 2>&1; then
  _v=$(node -v 2>/dev/null || echo unknown)
  miss "node $_v is too old — dashboard requires >= 22.5.0 (uses node:sqlite). Fix: brew install node"
else
  miss "node not found — dashboard requires >= 22.5.0. Fix: brew install node"
fi

# gh must be not merely installed but authenticated: register.sh mints
# registration tokens with it, and status/health/cleanup all query the API.
if command -v gh >/dev/null; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh, authenticated as $(gh api user --jq .login 2>/dev/null)"
  else
    miss "gh is installed but NOT authenticated — run: gh auth login"
  fi
else
  miss "gh — register.sh cannot mint a registration token without it"
fi

if [ "$NEED_XCODE" = 1 ] || [ "$NEED_XCODEGEN" = 1 ] || [ "$NEED_SIM" = 1 ] || [ "$NEED_WATCHOS" = 1 ]; then
echo "== xcode =="
if [ "$NEED_XCODE" = 1 ]; then
  if xcodebuild -version >/dev/null 2>&1; then
    ok "$(xcodebuild -version | head -1)"
  else
    miss "xcodebuild — check xcode-select -p, and that the licence is accepted"
  fi
  command -v swift >/dev/null && ok "$(swift --version 2>&1 | head -1 | cut -c1-60)" || miss "swift"
fi
if [ "$NEED_XCODEGEN" = 1 ]; then
  command -v xcodegen >/dev/null && ok "xcodegen" || miss "xcodegen — needed by any workflow that generates its Xcode project rather than committing one"
else
  skip "xcodegen — no workflow generates its project"
fi

# An available iPhone simulator, not just "a simulator". Device models vary by
# installed runtime, so the workflows pick whatever iPhone exists rather than
# naming one — but there has to be at least one.
if [ "$NEED_SIM" = 1 ]; then
  sim=$(xcrun simctl list devices available -j 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin)['devices'];print(next((x['name'] for r in d.values() for x in r if x.get('isAvailable') and x['name'].startswith('iPhone')),''))" 2>/dev/null)
  [ -n "$sim" ] && ok "iPhone simulator available ($sim)" || miss "no available iPhone simulator — install an iOS runtime"
else
  skip "iPhone simulator — no workflow names one"
fi

# watchOS is a SEPARATE Xcode component, and detecting it is genuinely fiddly.
#
# Do NOT trust `xcodebuild -showsdks | grep watchos`: Xcode ships a stub
# WatchOS.platform, so that passes on a machine where the platform is not
# installed — found the hard way, by a watch build that failed on a host this
# check had already called green.
#
# Do NOT look in Profiles/Runtimes either. That directory is EMPTY on a healthy
# machine: downloaded runtimes are mounted as volumes under
# /Library/Developer/CoreSimulator/Volumes/. An earlier version of this check
# looked there and reported MISS on the very host that builds these targets
# green — a false alarm that would have sent someone reinstalling Xcode.
#
# What actually distinguishes a stub from a real install is whether the SDK the
# platform advertises exists on disk. The workflow builds
# `-destination generic/platform=watchOS`, a DEVICE build, so it is the SDK that
# matters, not the simulator runtime.
if [ "$NEED_WATCHOS" = 1 ]; then
  sdk=$(xcrun --sdk watchos --show-sdk-path 2>/dev/null)
  if [ -n "$sdk" ] && [ -d "$sdk" ]; then
    ok "watchOS SDK ($(basename "$sdk"))"
  else
    miss "watchOS platform is a stub or absent. Fix: xcodebuild -downloadPlatform watchOS"
  fi
else
  skip "watchOS SDK — no workflow builds watch targets"
fi
fi

if [ "$NEED_POSTGRES" = 1 ]; then
echo "== postgres =="
if [ -n "$PG_VERSIONS" ]; then
  # Exactly the versions the workflows name. The reusable workflow hard-checks
  # /opt/homebrew/opt/postgresql@N/bin/initdb, so that is the path to test.
  for v in $PG_VERSIONS; do
    if [ -x "/opt/homebrew/opt/postgresql@$v/bin/initdb" ]; then
      ok "postgresql@$v"
    else
      miss "postgresql@$v — a workflow hard-checks this exact path. Fix: brew install postgresql@$v"
    fi
  done
else
  # A workflow wants Postgres but never says which version, so any is better
  # than none and naming one here would just be this script's guess.
  found=$(ls -d /opt/homebrew/opt/postgresql@* 2>/dev/null | head -3 | tr '\n' ' ')
  if [ -n "$found" ]; then
    ok "postgres present ($(echo "$found" | sed 's|/opt/homebrew/opt/||g'))"
  else
    miss "no postgresql@N in /opt/homebrew/opt — a workflow uses Postgres but names no version. Fix: brew install postgresql@17"
  fi
fi
fi

if [ "$NEED_ANDROID" = 1 ]; then
echo "== android =="
# register.sh writes ANDROID_HOME into the runner's .env only if this directory
# exists at registration time, so a Gradle build on a host without it fails
# looking like a missing dependency rather than a missing SDK.
if [ -d "$HOME/Library/Android/sdk" ]; then
  ok "Android SDK at ~/Library/Android/sdk"
else
  miss "no Android SDK at ~/Library/Android/sdk — Gradle finds it via ANDROID_HOME, which register.sh only sets when this exists"
fi
if /usr/libexec/java_home >/dev/null 2>&1; then
  ok "JDK ($(/usr/libexec/java_home -V 2>&1 | sed -n '2s/^[[:space:]]*//p' | cut -c1-40))"
else
  miss "no JDK — Gradle will not start. Fix: brew install --cask temurin"
fi
fi

if [ "$NEED_NODE" = 1 ]; then
echo "== node / web =="
# Run them, do not merely locate them. `command -v node` succeeds for a Homebrew
# node whose linked icu4c has since been upgraded out from under it — the binary
# is present and dies with a dyld error the moment it is invoked. Found exactly
# that on a prospective host, where this check had happily printed "ok node".
if v=$(node -v 2>/dev/null) && [ -n "$v" ]; then
  ok "node $v"
else
  miss "node is missing or will not execute (try: node -v). A broken icu4c link shows up here. Fix: brew reinstall node"
fi
if v=$(npm -v 2>/dev/null) && [ -n "$v" ]; then
  ok "npm $v"
else
  miss "npm is missing or will not execute — web workflows run npm install and npx playwright install"
fi
fi

echo "== dns / network =="
# A runner host with two default routes and two resolvers resolves names by
# race. A VPN on utun4 holding the primary default route alongside en0, with a
# nameserver on each, made jobs fail at "Set up job" with
# `nodename nor servname provided (codeload.github.com:443)` while other jobs
# starting the same second succeeded.
#
# That failure names no cause, points at GitHub rather than at the network, and
# is intermittent, which is the worst combination to debug from a CI log. Check
# it here instead.
routes=$(netstat -rn 2>/dev/null | awk '$1=="default" && $0 !~ /fe80/ {print $NF}' | sort -u | tr '\n' ' ')
nrt=$(echo "$routes" | wc -w | tr -d ' ')
if [ "$nrt" -le 1 ]; then
  ok "single default route (${routes:-none})"
else
  miss "MULTIPLE default routes ($routes) — a VPN alongside the LAN makes DNS a race. Disconnect it, or give the tunnel split-DNS so public names resolve via the LAN."
fi

resolvers=$(scutil --dns 2>/dev/null | awk -F': ' '/nameserver\[0\]/{print $2}' | sort -u | tr '\n' ' ')
nres=$(echo "$resolvers" | wc -w | tr -d ' ')
if [ "$nres" -le 1 ]; then
  ok "single primary resolver (${resolvers:-none})"
else
  warn "multiple primary resolvers ($resolvers) — resolution may race; benign only while one route exists"
fi

# Resolve what the runner actually fetches on every single job. `actions/checkout`
# comes from codeload, not from api.github.com, and it is the first thing any job
# does — so this is the exact name whose flakiness stops every workflow.
fails=0
for _ in 1 2 3 4 5; do
  dscacheutil -q host -a name codeload.github.com 2>/dev/null | grep -q ip_address || fails=$((fails + 1))
done
if [ "$fails" = "0" ]; then
  ok "codeload.github.com resolves (5/5)"
else
  miss "codeload.github.com failed to resolve $fails/5 times — every job downloads actions/checkout from it"
fi

if [ "$NEED_DOCKER" = 1 ]; then
echo "== docker =="
if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then
    ok "docker daemon running ($(docker info --format '{{.ServerVersion}}' 2>/dev/null))"
  else
    # This is the documented failure mode in that workflow: the binary exists,
    # so nothing looks missing, but every compose step fails.
    miss "docker is installed but the DAEMON IS NOT RUNNING — start Docker Desktop and enable 'start at login'"
  fi
else
  miss "docker — needed by any workflow with a docker-build or compose step"
fi
fi

echo
if [ "$rc" = "0" ]; then
  echo "all checks passed — safe to register runners"
else
  echo "one or more prerequisites missing (above) — fix before registering, or those repos will fail their first build"
fi
exit "$rc"
