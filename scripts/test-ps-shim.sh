#!/usr/bin/env bash
# Tests for shims/ps and scripts/install-ps-shim.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM="$HERE/shims/ps"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. The runner's exact orphan-scan call: exit 1, nothing printed, and no /bin/ps.
out="$("$SHIM" e -p $$ -o command 2>&1)" && fail "the runner's call exited 0"
[ -z "$out" ] || fail "the runner's call printed: $out"

# 2. Everything else is /bin/ps, byte for byte.
[ "$("$SHIM" -p $$ -o pid=)" = "$(/bin/ps -p $$ -o pid=)" ] || fail "ps -p -o pid= differs from /bin/ps"
[ "$("$SHIM" e -p $$ -o pid=)" = "$(/bin/ps e -p $$ -o pid=)" ] || fail "a near miss (-o pid=) was not passed through"
a=0; "$SHIM" e -p notapid -o command >/dev/null 2>&1 || a=$?; b=0; /bin/ps e -p notapid -o command >/dev/null 2>&1 || b=$?
[ "$a" = "$b" ] || fail "a non-numeric pid was not passed through ($a vs $b)"

# 3. FLEET_PS_SHIM=off restores the runner's own scan.
FLEET_PS_SHIM=off "$SHIM" e -p $$ -o command >/dev/null || fail "FLEET_PS_SHIM=off did not pass through"

# 4. It is cheap: 200 runner calls (one job's worth on a busy host) well under 5 s.
s=$(date +%s); for _ in $(seq 200); do "$SHIM" e -p 1 -o command || true; done; e=$(date +%s)
[ $((e - s)) -lt 5 ] || fail "200 calls took $((e - s)) s"

# 5. Installer: dry run changes nothing; --apply links into the runners' first PATH dir; idempotent; --remove.
mkdir -p "$T/bin" "$T/r1" "$T/r2"
printf '%s:/usr/bin:/bin\n' "$T/bin" > "$T/r1/.path"; printf '%s:/usr/bin:/bin\n' "$T/bin" > "$T/r2/.path"
FLEET_ROOT="$T" "$HERE/scripts/install-ps-shim.sh" | grep -q "would link" || fail "dry run did not say what it would do"
[ ! -e "$T/bin/ps" ] || fail "dry run linked"
FLEET_ROOT="$T" "$HERE/scripts/install-ps-shim.sh" --apply >/dev/null
[ "$(readlink "$T/bin/ps")" = "$SHIM" ] || fail "--apply did not link the shim"
FLEET_ROOT="$T" "$HERE/scripts/install-ps-shim.sh" --apply | grep -q "already linked" || fail "second --apply was not idempotent"
FLEET_ROOT="$T" "$HERE/scripts/install-ps-shim.sh" --remove --apply >/dev/null
[ ! -e "$T/bin/ps" ] || fail "--remove did not unlink"

# 6. Refuses a real ps it does not own, and runners that disagree on PATH.
printf '#!/bin/sh\n' > "$T/bin/ps"; chmod +x "$T/bin/ps"
FLEET_ROOT="$T" "$HERE/scripts/install-ps-shim.sh" --apply >/dev/null 2>&1 && fail "overwrote a real ps"
rm "$T/bin/ps"; printf '/usr/bin:/bin\n' > "$T/r2/.path"
FLEET_ROOT="$T" "$HERE/scripts/install-ps-shim.sh" --apply >/dev/null 2>&1 && fail "linked although runners disagree on PATH"
echo "ps shim: all checks passed"
