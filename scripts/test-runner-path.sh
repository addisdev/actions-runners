#!/usr/bin/env bash
# Tests for scripts/runner-path.sh: dry run changes nothing, --apply rewrites
# .path and .env's PATH on idle runners only, and a matching runner is left alone.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
WANT=/opt/homebrew/bin:/usr/bin:/bin
fail() { echo "FAIL: $*" >&2; exit 1; }
mk() {
  mkdir -p "$T/$1"; echo '{}' > "$T/$1/.runner"
  printf '#!/bin/sh\necho "$1" >> "%s/%s/svc.log"\n' "$T" "$1" > "$T/$1/svc.sh"; chmod +x "$T/$1/svc.sh"
  printf '%s\n' "$2" > "$T/$1/.path"; printf 'PATH=%s\nWB_SKIP=1\n' "$2" > "$T/$1/.env"
}
mk drifted /usr/bin:/bin
mk fine "$WANT"

out="$(FLEET_ROOT="$T" FLEET_RUNNER_PATH="$WANT" "$HERE/runner-path.sh")"
echo "$out" | grep -q "would drifted" || fail "dry run did not list the drifted runner: $out"
[ "$(cat "$T/drifted/.path")" = /usr/bin:/bin ] || fail "dry run changed .path"
[ ! -f "$T/drifted/svc.log" ] || fail "dry run restarted a runner"

FLEET_ROOT="$T" FLEET_RUNNER_PATH="$WANT" "$HERE/runner-path.sh" --apply >/dev/null
[ "$(cat "$T/drifted/.path")" = "$WANT" ] || fail ".path not rewritten"
grep -qx "PATH=$WANT" "$T/drifted/.env" || fail ".env PATH not rewritten"
grep -qx "WB_SKIP=1" "$T/drifted/.env" || fail "other .env lines lost"
[ "$(tr '\n' ' ' < "$T/drifted/svc.log")" = "stop start " ] || fail "runner not restarted"
[ ! -f "$T/fine/svc.log" ] || fail "a matching runner was restarted"
echo "ok runner-path"
