#!/usr/bin/env bash
# The only way the auto-remediation bridge can act on the fleet.
#
#   ./fleet-action.sh <action-id> ['{"json":"args"}']
#
# The bridge decides WHEN to act; this decides WHAT may ever be acted on. Those
# are separate files on purpose: the complete set of things an unattended
# process can do to sixteen runners should be one short list you can read in a
# few seconds, not something you have to reconstruct by following control flow
# through a daemon.
#
# It also keeps the control token out of the daemon that listens on a socket.
# The bridge knows the name of a script; it does not hold the credential, so a
# bug in its HTTP handling is not a bug that can tear down the fleet.
#
# The allowlist is deliberately wider than the bridge uses — it only ever calls
# fleet.healthRepair — so this doubles as the operator's safe manual entry
# point when poking at the fleet by hand.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(dirname "$HERE")"
FLEET_URL="${FLEET_URL:-http://127.0.0.1:7878}"
TOKEN_FILE="${FLEET_TOKEN_FILE:-$DASH/.fleet-token}"

# Deliberately a subset of /api/actions, not all of it. Each of these is either
# read-only or idempotent-and-reversible; none of them can destroy a runner or
# delete a cache. The ones that can — fleet.cleanupApply, runner.register,
# runner.deregister — are absent on purpose and adding one here is a decision to
# be made deliberately, not a config tweak.
#
# Notably absent for a subtler reason: run.cancel. Cancelling looks harmless,
# but the fleet's own analytics treat a cancelled run as unmeasurable (see the
# README's "what the analytics deliberately exclude"), so anything cancelling
# automatically would quietly corrupt the duration percentiles it is judged by.
ALLOWED=(
  fleet.health
  fleet.healthRepair
  fleet.status
  fleet.preflight
  fleet.cleanupPreview
  runner.restart
  run.rerun
)

usage() {
  echo "usage: $(basename "$0") <action-id> ['{\"json\":\"args\"}']" >&2
  printf 'allowed: %s\n' "${ALLOWED[*]}" >&2
  exit 64
}

[ $# -ge 1 ] || usage
ACTION="$1"
ARGS="${2:-{\}}"

# Exact match against the allowlist. No globbing, no prefix matching — a prefix
# rule that accepted "fleet.cleanup" would accept "fleet.cleanupApply".
ok=false
for a in "${ALLOWED[@]}"; do [ "$a" = "$ACTION" ] && ok=true && break; done
if [ "$ok" != true ]; then
  echo "refused: '$ACTION' is not an auto-remediation action." >&2
  printf 'allowed: %s\n' "${ALLOWED[*]}" >&2
  echo "If this alert genuinely needs one of the destructive actions, stop and" >&2
  echo "report that to the operator instead of working around it." >&2
  exit 77
fi

[ -f "$TOKEN_FILE" ] || { echo "no control token at $TOKEN_FILE — is fleetd running?" >&2; exit 69; }

# Build the request body here rather than accepting one, so the caller supplies
# only the arguments and can never override the action field it just passed the
# allowlist check with. `--argjson` fails closed if $ARGS is not valid JSON.
BODY="$(python3 -c '
import json, sys
action, raw = sys.argv[1], sys.argv[2]
try:
    args = json.loads(raw)
except ValueError as e:
    sys.exit(f"args is not valid JSON: {e}")
if not isinstance(args, dict):
    sys.exit("args must be a JSON object")
print(json.dumps({"action": action, "args": args}))
' "$ACTION" "$ARGS")" || { echo "refused: bad args for $ACTION" >&2; exit 65; }

# --fail-with-body so a 403 still prints the daemon's reason. The Origin header
# is omitted entirely: auth.js only enforces the origin allowlist when one is
# present, and this is not a browser.
exec curl -sS --fail-with-body --max-time 330 \
  -X POST "$FLEET_URL/api/action" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H 'content-type: application/json' \
  -d "$BODY"
