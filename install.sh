#!/usr/bin/env bash
# One-command setup for a coordinator or agent host.
#
#   ./install.sh coordinator   — install the dashboard daemon on this machine
#   ./install.sh agent         — install the fleet agent on this machine
#
# Both roles expect configuration in fleet.env at the repo root:
#
#   Coordinator — copy from fleet.env.example:
#     FLEET_PORT, FLEET_ROOT, FLEET_HOST (set 0.0.0.0 to accept agents)
#     FLEET_HOST_LABELS  (optional: comma-separated capability labels)
#
#   Agent — copy from examples/fleet.env.federated-agent:
#     FLEET_COORDINATOR  (http://coordinator-host:7878)
#     FLEET_AGENT_TOKEN  (from: coordinator$ ./dashboard/fleetctl.sh agent-token)
#     FLEET_HOST_NAME    (display name shown in the Hosts tab)
#     FLEET_HOST_LABELS  (optional: comma-separated capability labels)
#
# Preflight checks:
#   - macOS 13+ on Apple Silicon (arm64)
#   - Node.js 20+
#   - git (to confirm this is a repo clone)
#   - gh (coordinator only, for GitHub API access)
#
# The installer does NOT create runners. To register runners after installing
# the coordinator, run: ./register.sh owner/repo
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD="$HERE/dashboard"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"

role="${1:-}"

header() { echo ""; echo "==> $*"; }
ok()     { echo "    ✓ $*"; }
fail()   { echo "    ✗ $*" >&2; }

# ---- preflight ---------------------------------------------------------------

check_macos() {
  if [[ "$(uname)" != "Darwin" ]]; then
    fail "macOS required (found: $(uname))"
    exit 1
  fi
  local maj; maj="$(sw_vers -productVersion | cut -d. -f1)"
  if [[ "$maj" -lt 14 ]]; then
    fail "macOS 14 (Sonoma) or later required (found: $(sw_vers -productVersion))"
    exit 1
  fi
  ok "macOS $(sw_vers -productVersion)"
}

check_arch() {
  if [[ "$(uname -m)" != "arm64" ]]; then
    echo "  ⚠  expected arm64 (Apple Silicon) — found $(uname -m)"
    echo "     x64 may work but is untested. Continuing."
  else
    ok "Apple Silicon (arm64)"
  fi
}

check_node() {
  if ! command -v node &>/dev/null; then
    fail "node not found — install via Homebrew: brew install node"
    exit 1
  fi
  local version; version="$(node --version)"
  local normalized="${version#v}"
  local major="${normalized%%.*}"
  local rest="${normalized#*.}"
  local minor="${rest%%.*}"
  if [[ "$major" -lt 22 || ( "$major" -eq 22 && "$minor" -lt 5 ) ]]; then
    fail "Node.js 22.5+ required (found: $version)"
    exit 1
  fi
  ok "Node.js $version at $(command -v node)"
}

check_git() {
  if [[ ! -d "$HERE/.git" ]]; then
    fail "not a git clone — clone the repo first"
    exit 1
  fi
  ok "git clone at $HERE"
}

check_gh() {
  if ! command -v gh &>/dev/null; then
    fail "gh not found — install via Homebrew: brew install gh"
    fail "The coordinator uses gh to poll GitHub for runner and run state."
    exit 1
  fi
  ok "gh at $(command -v gh)"
  if ! gh auth status &>/dev/null; then
    echo ""
    echo "  ⚠  gh is installed but not authenticated."
    echo "     Run: gh auth login"
    echo "     Then re-run this installer, or use GH_TOKEN=... in fleet.env."
  fi
}

check_fleet_env() {
  if [[ ! -f "$HERE/fleet.env" ]]; then
    echo "  ⚠  no fleet.env found at $HERE/fleet.env"
    if [[ "$role" == "coordinator" ]]; then
      echo "     Copying fleet.env.example — edit it before the daemon starts."
      cp "$HERE/fleet.env.example" "$HERE/fleet.env"
    else
      echo "     Copying examples/fleet.env.federated-agent — edit it before installing."
      cp "$HERE/examples/fleet.env.federated-agent" "$HERE/fleet.env"
      echo ""
      echo "  Required: FLEET_COORDINATOR or FLEET_COORDINATORS, plus FLEET_AGENT_TOKEN and FLEET_HOST_NAME"
      echo "  Then re-run: ./install.sh agent"
      exit 1
    fi
  else
    ok "fleet.env present"
  fi
}

check_required_agent() {
  local missing=0
  [[ -z "${FLEET_COORDINATOR:-}" && -z "${FLEET_COORDINATORS:-}" ]] \
    && { fail "FLEET_COORDINATOR or FLEET_COORDINATORS not set in fleet.env"; missing=1; }
  [[ -z "${FLEET_AGENT_TOKEN:-}" ]] && { fail "FLEET_AGENT_TOKEN not set in fleet.env"; missing=1; }
  [[ -z "${FLEET_HOST_NAME:-}" ]]  && { fail "FLEET_HOST_NAME not set in fleet.env"; missing=1; }
  if [[ "$missing" -ne 0 ]]; then
    echo ""
    echo "  Set the missing variables in $HERE/fleet.env and re-run."
    exit 1
  fi
  ok "coordinator(s)=${FLEET_COORDINATORS:-${FLEET_COORDINATOR}}"
  ok "FLEET_HOST_NAME=${FLEET_HOST_NAME}"
}

# ---- roles -------------------------------------------------------------------

do_coordinator() {
  header "Preflight checks"
  check_macos
  check_arch
  check_node
  check_git
  check_gh
  check_fleet_env

  header "Installing coordinator daemon"
  "$DASHBOARD/fleetctl.sh" install

  header "Done"
  echo ""
  echo "  Dashboard:  http://localhost:${FLEET_PORT:-7878}"
  echo "  Logs:       $DASHBOARD/fleetctl.sh logs"
  echo "  Status:     $DASHBOARD/fleetctl.sh status"
  echo ""
  echo "  To add agents on other Macs:"
  echo "    1. On THIS machine:  ./dashboard/fleetctl.sh agent-token"
  echo "    2. On the agent Mac: clone the repo, set fleet.env, run ./install.sh agent"
  echo ""
  echo "  To register runners:  ./register.sh owner/repo"
}

do_agent() {
  header "Preflight checks"
  check_macos
  check_arch
  check_node
  check_git
  check_fleet_env
  check_required_agent

  header "Installing agent daemon"
  "$DASHBOARD/agentctl.sh" install

  header "Done"
  echo ""
  echo "  This host (${FLEET_HOST_NAME:-?}) will now report to ${FLEET_COORDINATOR:-?}"
  echo "  Logs:    $DASHBOARD/agentctl.sh logs"
  echo "  Status:  $DASHBOARD/agentctl.sh status"
  echo ""
  if [[ "${FLEET_AGENT_ALLOW_REGISTER:-0}" != "1" ]]; then
    echo "  Remote provisioning is disabled. To allow the coordinator to register"
    echo "  runners here, add FLEET_AGENT_ALLOW_REGISTER=1 to fleet.env and run:"
    echo "    ./dashboard/agentctl.sh restart"
  else
    echo "  Remote provisioning ENABLED — the coordinator can register runners here."
  fi
}

# ---- main --------------------------------------------------------------------

case "$role" in
  coordinator) do_coordinator ;;
  agent)       do_agent ;;
  *)
    echo "usage: $0 {coordinator|agent}"
    echo ""
    echo "  coordinator — install the dashboard daemon (GitHub polling, autoscaling, control plane)"
    echo "  agent       — install the fleet agent (heartbeat reporting, optional remote commands)"
    echo ""
    echo "See README.md or docs/federation.md for setup instructions."
    exit 1
    ;;
esac
