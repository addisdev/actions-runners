#!/usr/bin/env bash
# Exercises emulator-control.sh with stand-in emulators and a fake adb. No real
# emulator or AVD is touched: ps is filtered to this test's own processes.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/emulator-hook-test/root"
PASS=0
FAIL=0

ok() {
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 ($2)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 — expected '$3', got '$2'"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  pkill -f -- "$ROOT/" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT

setup() {
  cleanup
  mkdir -p "$ROOT/bin" "$ROOT/home/.android/avd"
  : > "$ROOT/calls"
  cat > "$ROOT/bin/fakeps" <<EOF
#!/usr/bin/env bash
/bin/ps "\$@" | grep -F "$ROOT/"
EOF
  cat > "$ROOT/bin/adb" <<EOF
#!/usr/bin/env bash
echo "adb \$*" >> "$ROOT/calls"
pkill -TERM -f -- "-port \${2#emulator-} -avd" 2>/dev/null
exit 0
EOF
  cat > "$ROOT/bin/qemu-system-aarch64-headless" <<'EOF'
#!/usr/bin/env bash
trap 'exit 0' TERM
while :; do sleep 1; done
EOF
  chmod +x "$ROOT/bin/"*
}

emu() { ( "$ROOT/bin/qemu-system-aarch64-headless" "$@" >/dev/null 2>&1 & ); }
alive() { pgrep -f -- "-avd $1" >/dev/null 2>&1 && echo running || echo stopped; }
complete() {
  HOME="$ROOT/home" FLEET_ROOT="$ROOT" ANDROID_AVD_HOME="" FLEET_PS="$ROOT/bin/fakeps" \
    FLEET_ADB="$ROOT/bin/adb" FLEET_EMU_KILL_WAIT_S=3 FLEET_EMU_TERM_WAIT_S=1 "$@" \
    bash "$HOOKS/emulator-control.sh" complete 2>&1
}

echo "== whose AVD is it =="
# shellcheck source=hooks/emulator-control.sh
. "$HOOKS/emulator-control.sh"
K="ultra-jerv ultra-jerv-2 ultra-greenfolio-android ultra-dozehound-firetv"
ok "a plain AVD" "$(emu_avd_owner ci-ultra-jerv "$K")" "ultra-jerv plain here"
ok "the longest runner wins" "$(emu_avd_owner ci-ultra-jerv-2 "$K")" "ultra-jerv-2 plain here"
ok "a phone snapshot AVD" "$(emu_avd_owner ci-ultra-greenfolio-android-a34-google_apis-pixel_6 "$K")" \
  "ultra-greenfolio-android snapshot here"
ok "a TV snapshot AVD" "$(emu_avd_owner ci-ultra-dozehound-firetv-a34-android-tv-tv_1080p "$K")" \
  "ultra-dozehound-firetv snapshot here"
ok "ultra-jerv-2's snapshot AVD is not ultra-jerv's" \
  "$(emu_avd_owner ci-ultra-jerv-2-a34-google_apis-pixel_6 "$K")" "ultra-jerv-2 snapshot here"
ok "a snapshot AVD of a runner that is gone" \
  "$(emu_avd_owner ci-ultra-jerv-9-a34-google_apis-pixel_6 "$K")" "ultra-jerv-9 snapshot gone"
ok "a screenshot AVD" "$(emu_avd_owner shots-ultra-jerv "$K")" "ultra-jerv plain here"
ok "not a runner's AVD" "$(emu_avd_owner fleet-explore-1 "$K" || echo none)" "none"

echo "== job end: this runner's emulator is stopped with emu kill, nobody else's =="
setup
emu -port 5554 -avd ci-RL-a-a34-google_apis-pixel_6 -no-snapshot-save
emu -port 5556 -avd ci-RL-a-2-a34-google_apis-pixel_6 -no-snapshot-save
emu -port 5558 -avd fleet-explore-1
sleep 1
OUT="$(complete env RUNNER_NAME=RL-a)"
ok "stopped this runner's emulator" "$(alive ci-RL-a-a34)" "stopped"
ok "through the console" "$(grep -c 'adb -s emulator-5554 emu kill' "$ROOT/calls")" "1"
ok "and said so in the job log" "$(printf '%s\n' "$OUT" | grep -c 'ci-RL-a-a34.*stopped (emu kill)')" "1"
ok "left RL-a-2's emulator" "$(alive ci-RL-a-2-a34)" "running"
ok "left night QA's emulator" "$(alive fleet-explore-1)" "running"

echo "== job end with nothing running is silent =="
OUT="$(complete env RUNNER_NAME=RL-b)"
ok "printed nothing" "$OUT" ""

echo "== FLEET_EMULATOR_CLEANUP=0 turns it off =="
emu -port 5560 -avd ci-RL-c -no-snapshot
sleep 1
complete env RUNNER_NAME=RL-c FLEET_EMULATOR_CLEANUP=0 >/dev/null
ok "left the emulator running" "$(alive ci-RL-c)" "running"
complete env RUNNER_NAME=RL-c >/dev/null
ok "and stops it when on" "$(alive ci-RL-c)" "stopped"

echo "== it never fails the hook =="
complete env RUNNER_NAME= FLEET_PS=/nonexistent >/dev/null
ok "exit 0 without a runner name or ps" "$?" "0"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
