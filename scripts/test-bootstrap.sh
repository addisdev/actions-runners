#!/usr/bin/env bash
# Tests for scripts/bootstrap-host.sh (the fleet-env step, the only one that
# needs no peer and no Homebrew) and scripts/host-manifest.sh --compare.
# Runs against a throwaway directory; never touches a real fleet.env or ssh.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILS=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

cat > "$T/peer.env" <<'P'
FLEET_LABEL_PREFIX=com.example
FLEET_OWNER=example-org
FLEET_HOST_ID=old-host
FLEET_HOST_LABELS=ci,ui-web,xcode-26
FLEET_XCODE_VERSION=27.2
FLEET_SIMULATOR_RUNNERS="*-ios *-ios-*"
FLEET_ADMIT_HEAVY_PATTERNS="*:test *:build"
FLEET_ADMIT_HEAVY_MAX_CONCURRENT=4
P
run_env() {
  FLEET_BOOTSTRAP_ROOT="$T/root" FLEET_BOOTSTRAP_PEER_ENV="$T/peer.env" FLEET_BOOTSTRAP_HOST_ID=box-1 \
    bash "$HERE/scripts/bootstrap-host.sh" --only fleet-env --coordinator http://coord:7878 "$@"
}
mkdir -p "$T/root"

# 1. Dry run writes nothing.
out="$(run_env)"
[ ! -e "$T/root/fleet.env" ] && pass "dry run writes no fleet.env" || fail "dry run wrote fleet.env"
printf '%s\n' "$out" | grep -q 'FLEET_HOST_ID=box-1' && pass "dry run previews the host id" || fail "no preview: $out"

# 2. --apply writes it, peer values copied verbatim, own identity and caps kept.
run_env --apply >/dev/null
f="$T/root/fleet.env"
[ -f "$f" ] && pass "--apply writes fleet.env" || fail "--apply wrote nothing"
grep -qx 'FLEET_HOST_ID=box-1' "$f" && pass "host id from this host, not the peer" || fail "host id wrong"
grep -qx 'FLEET_HOST_LABELS=ci,ui-web,xcode-26' "$f" && pass "labels copied from the peer" || fail "labels not copied"
grep -qx 'FLEET_XCODE_VERSION=27.2' "$f" && pass "Xcode version copied" || fail "Xcode version not copied"
grep -qx 'FLEET_SIMULATOR_RUNNERS="\*-ios \*-ios-\*"' "$f" && pass "quoted value copied verbatim" || fail "quoted value mangled"
grep -qx 'FLEET_ADMIT_HEAVY_MAX_CONCURRENT=4' "$f" && pass "first-day heavy cap from the template" || fail "heavy cap"
grep -qx 'FLEET_COORDINATOR=http://coord:7878' "$f" && pass "coordinator filled in" || fail "coordinator"
grep -qx 'FLEET_ADMIT_STATUS_URL=http://coord:7878/api/run-status' "$f" && pass "status URL points at the coordinator" || fail "status URL"
! grep -q '@[A-Z_]*@' "$f" && pass "no placeholder left" || fail "placeholder left"
[ "$(stat -f %Lp "$f")" = 600 ] && pass "mode 600" || fail "mode $(stat -f %Lp "$f")"
bash -n "$f" && pass "result is valid shell" || fail "result does not parse"

# 3. Never overwrites an existing fleet.env.
echo "FLEET_HOST_ID=hand-edited" > "$f"
run_env --apply >/dev/null
grep -qx 'FLEET_HOST_ID=hand-edited' "$f" && pass "existing fleet.env left alone" || fail "existing fleet.env overwritten"

# 4. A key the peer lacks is reported, not invented.
rm -f "$f"; grep -v '^FLEET_OWNER=' "$T/peer.env" > "$T/peer2.env"
out="$(FLEET_BOOTSTRAP_PEER_ENV="$T/peer2.env" FLEET_BOOTSTRAP_ROOT="$T/root" FLEET_BOOTSTRAP_HOST_ID=box-1 \
  bash "$HERE/scripts/bootstrap-host.sh" --only fleet-env --coordinator http://coord:7878 --apply)"
printf '%s\n' "$out" | grep -q 'left out: FLEET_OWNER' && pass "missing peer key reported" || fail "missing key not reported: $out"
grep -q '^FLEET_OWNER=' "$f" && fail "missing key invented" || pass "missing key not invented"

# 5. Unknown step and missing coordinator are refused.
bash "$HERE/scripts/bootstrap-host.sh" --only nope >/dev/null 2>&1; [ $? -eq 2 ] && pass "unknown step refused" || fail "unknown step accepted"
rm -f "$f"
FLEET_BOOTSTRAP_ROOT="$T/root" FLEET_BOOTSTRAP_PEER_ENV="$T/peer.env" bash "$HERE/scripts/bootstrap-host.sh" --only fleet-env --apply >/dev/null
[ $? -ne 0 ] && [ ! -e "$f" ] && pass "no --coordinator: refused, nothing written" || fail "wrote without a coordinator"

# 6. host-manifest.sh --compare: hardware lines may differ, nothing else may.
printf 'hw.cores 30\nhw.memory_gb 96\nxcode.Xcode Xcode 27.2 build 27B52\nbrew.jq 1.8.1\n' > "$T/a"
printf 'hw.cores 18\nhw.memory_gb 64\nxcode.Xcode Xcode 27.2 build 27B52\nbrew.jq 1.8.1\n' > "$T/b"
printf 'hw.cores 18\nhw.memory_gb 64\nxcode.Xcode Xcode 27.0 build 27A266a\nbrew.jq 1.8.1\n' > "$T/c"
bash "$HERE/scripts/host-manifest.sh" --compare "$T/a" "$T/b" >/dev/null && pass "hardware-only difference is parity" || fail "hardware difference counted"
out="$(bash "$HERE/scripts/host-manifest.sh" --compare "$T/a" "$T/c")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q '27A266a' && pass "an Xcode difference is a gap, and named" || fail "Xcode gap missed (rc $rc)"
bash "$HERE/scripts/host-manifest.sh" --compare "$T/a" "$T/missing" >/dev/null 2>&1; [ $? -eq 2 ] && pass "missing manifest is an error, not parity" || fail "missing manifest passed"

echo
[ "$FAILS" -eq 0 ] && echo "all bootstrap tests passed" || { echo "$FAILS failed"; exit 1; }
