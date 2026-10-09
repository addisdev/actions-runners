#!/usr/bin/env bash
# Join this Mac to an existing fleet as a runner host, in one command.
#
#   scripts/join-host.sh                       # check everything, change nothing
#   scripts/join-host.sh --apply               # install the agent, mirror runners, health timer
#   scripts/join-host.sh --apply --only peertest,radiator     # pilot a few repos first
#   scripts/join-host.sh --apply --install-tools              # also brew-install what is missing
#   ... | scripts/join-host.sh --apply --tokens-from -        # registration tokens minted elsewhere
#
# What it does, each step safe to repeat:
#   1. Preflight: macOS, Node, a git clone, fleet.env with the agent settings,
#      the coordinator answering, and the toolchains jobs use (Xcode, Java,
#      Android SDK, gh, and the plain CLI tools in scripts/cli-tools.txt such
#      as shellcheck). Missing toolchains are reported with how to install
#      them; only Xcode changes the plan (Simulator runners are skipped without it).
#   2. --install-tools: `brew install` the formulae that are missing.
#   3. The agent (dashboard/agentctl.sh install): heartbeats out to the
#      coordinator, never listens.
#   4. Runners (scripts/mirror-runners.sh): one per label set the coordinator's
#      runners carry, minus what this host cannot run. register.sh writes the
#      admission hooks, ANDROID_HOME, WB_SKIP and the Spotlight marker.
#   5. The health-repair timer (healthctl.sh install).
#
# Admission limits for this host come from fleet.env (FLEET_ADMIT_*); start
# from examples/fleet.env.ultra. Everything is dry run without --apply.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$HERE/fleet.env"
# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

APPLY=0; INSTALL_TOOLS=0; PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --install-tools) INSTALL_TOOLS=1 ;;
    --only|--tokens-from|--coordinator) PASS+=("$1" "${2:?$1 needs a value}"); shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

ok()   { printf '    ✓ %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*"; }
bad()  { printf '    ✗ %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
header() { printf '\n==> %s\n' "$*"; }
PROBLEMS=0
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

header "Preflight"
[ "$(uname)" = Darwin ] && ok "macOS $(sw_vers -productVersion)" || bad "macOS required"
[ -d "$HERE/.git" ] && ok "git clone at $HERE ($(git -C "$HERE" rev-parse --short HEAD))" || bad "not a git clone"
if command -v node >/dev/null; then ok "node $(node --version)"; else bad "node missing (brew install node)"; fi
[ -f "$ENV_FILE" ] && ok "fleet.env present" || bad "no fleet.env — copy examples/fleet.env.ultra and edit it"

COORD="${FLEET_COORDINATOR:-${FLEET_COORDINATORS%%,*}}"
for i in "${!PASS[@]}"; do [ "${PASS[$i]}" = "--coordinator" ] && COORD="${PASS[$((i + 1))]}"; done
[ -n "${FLEET_HOST_ID:-}" ] && ok "FLEET_HOST_ID=$FLEET_HOST_ID" || bad "FLEET_HOST_ID not set (stable; scopes the agent token)"
[ -n "${FLEET_HOST_NAME:-}" ] || bad "FLEET_HOST_NAME not set"
if [ -n "${FLEET_AGENT_TOKEN:-}" ] || { [ -n "${FLEET_AGENT_TOKEN_FILE:-}" ] && [ -s "$FLEET_AGENT_TOKEN_FILE" ]; }; then
  ok "agent token present"
else
  bad "no agent token: on the coordinator run ./dashboard/fleetctl.sh agent-token --host ${FLEET_HOST_ID:-<id>} and save it to FLEET_AGENT_TOKEN_FILE (mode 600)"
fi
if [ -z "$COORD" ]; then
  bad "FLEET_COORDINATOR not set"
elif health="$(curl -fsS --max-time 8 "$COORD/api/health" 2>&1)"; then
  ok "coordinator $COORD answers: $(printf '%s' "$health" | sed -n 's/.*"runners":\([0-9]*\).*/\1 runners/p')"
else
  bad "coordinator $COORD does not answer /api/health: ${health:0:160}"
  warn "if it says 'not a recognised address', add this host's name for it to FLEET_ALLOWED_HOSTS there"
fi

header "Toolchains jobs use"
HAS_XCODE=0
if xcodebuild -version >/dev/null 2>&1; then
  HAS_XCODE=1; ok "$(xcodebuild -version | head -1) — Simulator runners will be mirrored"
else
  warn "no Xcode (xcode-select points at $(xcode-select -p 2>/dev/null || echo nothing)) — Simulator runners will be skipped"
fi
if [ "$HAS_XCODE" -eq 1 ]; then
  # -version answers before the license is accepted; swiftc then exits 69 in
  # the first job. Accepting needs sudo, so this can only report it.
  if xcodebuild -license check >/dev/null 2>&1; then
    ok "Xcode license accepted"
  else
    bad "Xcode license not accepted: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"
  fi
  # Both hosts must build with the SAME Xcode, or a job's SDK depends on which
  # host GitHub picked: code using the newer SDK fails on the older host only,
  # and it reads as a flaky build. Set the fleet's version in fleet.env.
  XCODE_HERE="$(xcodebuild -version | sed -n 's/^Xcode //p' | head -1)"
  if [ -n "${FLEET_XCODE_VERSION:-}" ]; then
    case "$XCODE_HERE" in
      "$FLEET_XCODE_VERSION"|"$FLEET_XCODE_VERSION".*) ok "Xcode $XCODE_HERE matches FLEET_XCODE_VERSION=$FLEET_XCODE_VERSION" ;;
      *) bad "Xcode $XCODE_HERE here, but the fleet builds with $FLEET_XCODE_VERSION (FLEET_XCODE_VERSION): install that one, or Simulator jobs will build against a different SDK depending on the host" ;;
    esac
  else
    warn "FLEET_XCODE_VERSION not set: nothing checks that this Xcode ($XCODE_HERE) is the one the other hosts build with"
  fi
fi
case ",${FLEET_HOST_LABELS:-}," in
  *,xcode-*) [ "$HAS_XCODE" -eq 1 ] || bad "FLEET_HOST_LABELS advertises an xcode label but xcodebuild does not run" ;;
esac

# Runners whose job PATH (.path) is not the fleet's: they find a different
# python3, node or git than their twins on other hosts. scripts/runner-path.sh.
drift="$("$HERE/scripts/runner-path.sh" 2>/dev/null | sed -n 's/.* \([0-9][0-9]*\) would change.*/\1/p')"
if [ -n "$drift" ] && [ "$drift" != 0 ]; then
  warn "$drift runner(s) here have a job PATH other than the fleet's: scripts/runner-path.sh --apply"
fi

# Python modules jobs import without installing them. Checked with both
# interpreters a job can reach: the runners' PATH puts Homebrew's python3 first
# where it exists, and scripts that name /usr/bin/python3 get Xcode's.
for py in "$(PATH="${FLEET_RUNNER_PATH:-/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin}" command -v python3)" /usr/bin/python3; do
  [ -x "$py" ] || continue
  if "$py" -c 'import yaml' >/dev/null 2>&1; then
    ok "PyYAML importable by $py"
  else
    warn "no PyYAML for $py (kit-ci imports it): $py -m pip install --user pyyaml, or brew install pyyaml for Homebrew's python"
  fi
done
if /usr/libexec/java_home >/dev/null 2>&1 || [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
  ok "Java present"
else
  warn "no Java (brew install openjdk@21); Android jobs that use actions/setup-java bring their own"
fi
[ -d "$HOME/Library/Android/sdk" ] && ok "Android SDK at ~/Library/Android/sdk" || warn "no Android SDK — Android jobs will fail here; list those repos in FLEET_MIRROR_SKIP_REPOS"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  ok "gh logged in (register.sh can mint registration tokens)"
else
  warn "gh cannot mint tokens here (not logged in, or over SSH): pass --tokens-from"
fi

MISSING_FORMULAE=()
for f in gh jq node; do command -v "$f" >/dev/null || MISSING_FORMULAE+=("$f"); done

# Every tool in cli-tools.txt, not just the inferred ones: the workflow history
# lives in the coordinator's database, and this host will take the same jobs.
# Looked up on the runners' PATH, which is what a job sees.
ALL_TOOLS="$("$HERE/scripts/check-tools.sh" --list all)"
while IFS=$'\t' read -r state tool formula why; do
  if [ "$state" = ok ]; then
    ok "$tool"
  elif [ "$formula" = - ]; then
    warn "no $tool on the runners' PATH — $why"
  else
    warn "no $tool on the runners' PATH ($why): brew install $formula, or --install-tools"
    case " ${MISSING_FORMULAE[*]:-} " in *" $formula "*) ;; *) MISSING_FORMULAE+=("$formula") ;; esac
  fi
done < <("$HERE/scripts/check-tools.sh" $ALL_TOOLS)
[ -x /opt/homebrew/opt/openjdk@21/bin/java ] || /usr/libexec/java_home >/dev/null 2>&1 || MISSING_FORMULAE+=("openjdk@21")

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n%s problem(s) above; fix them and re-run.\n' "$PROBLEMS"
  exit 1
fi

if [ "$INSTALL_TOOLS" -eq 1 ] && [ "${#MISSING_FORMULAE[@]}" -gt 0 ]; then
  header "Homebrew: ${MISSING_FORMULAE[*]}"
  if [ "$APPLY" -eq 1 ]; then brew install "${MISSING_FORMULAE[@]}"; else echo "    (dry run) brew install ${MISSING_FORMULAE[*]}"; fi
fi

header "Agent"
if [ "$APPLY" -eq 1 ]; then
  "$HERE/dashboard/agentctl.sh" install
else
  echo "    (dry run) dashboard/agentctl.sh install — reports to $COORD as ${FLEET_HOST_ID:-?}"
fi

header "Runners"
MIRROR=("$HERE/scripts/mirror-runners.sh" --coordinator "$COORD")
for i in "${!PASS[@]}"; do
  case "${PASS[$i]}" in --only|--tokens-from) MIRROR+=("${PASS[$i]}" "${PASS[$((i + 1))]}") ;; esac
done
[ "$APPLY" -eq 1 ] && MIRROR+=(--apply)
"${MIRROR[@]}"

header "Health repair"
if [ "$APPLY" -eq 1 ]; then
  "$HERE/healthctl.sh" install
else
  echo "    (dry run) healthctl.sh install — restarts runners that die silently"
fi

header "Done"
if [ "$APPLY" -eq 1 ]; then
  echo "    Hosts tab on $COORD should list ${FLEET_HOST_NAME:-this host} within 30 s."
  echo "    Admission here: ${FLEET_ADMIT_MODE:-off}, ${FLEET_ADMIT_MAX_CONCURRENT:-3} jobs, ${FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT:-0} Simulator"
else
  echo "    Dry run. Re-run with --apply."
fi
