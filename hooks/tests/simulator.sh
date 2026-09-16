#!/usr/bin/env bash
# Exercises simulator-control.sh with a fake simctl. No real simulator changes.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/simulator-hook-test/root"
BIN="$ROOT/bin"
SIM_STATE="$ROOT/booted"
SIM_LOG="$ROOT/shutdowns"
PASS=0
FAIL=0
PIDS=()

MANUAL=11111111-1111-1111-1111-111111111111
CI_ONE=22222222-2222-2222-2222-222222222222
CI_TWO=33333333-3333-3333-3333-333333333333

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
    [ -n "$pid" ] && wait "$pid" 2>/dev/null
  done
  PIDS=()
  rm -rf "$ROOT"
}
trap cleanup EXIT

ok() {
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 ($2)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 — expected '$3', got '$2'"
    FAIL=$((FAIL + 1))
  fi
}

setup() {
  cleanup
  mkdir -p "$BIN"
  cat > "$ROOT/fleet.env" <<'EOF'
FLEET_SIMULATOR_CLEANUP=1
FLEET_SIMULATOR_RUNNERS="*-ios *-ios-*"
EOF
  : > "$SIM_STATE"
  : > "$SIM_LOG"
  cat > "$BIN/simctl" <<'EOF'
#!/usr/bin/env bash
case "$1 $2 $3" in
  "list devices booted")
    while read -r uuid; do
      [ -n "$uuid" ] && echo "    iPhone CI ($uuid) (Booted)"
    done < "$FAKE_SIM_STATE"
    ;;
  *)
    if [ "$1" = "shutdown" ] && [ -n "${2:-}" ]; then
      echo "$2" >> "$FAKE_SIM_LOG"
      awk -v uuid="$2" '$0 != uuid' "$FAKE_SIM_STATE" > "$FAKE_SIM_STATE.tmp"
      mv "$FAKE_SIM_STATE.tmp" "$FAKE_SIM_STATE"
    fi
    ;;
esac
EOF
  chmod +x "$BIN/simctl"
}

worker() {
  sleep "${1:-60}" >/dev/null 2>&1 &
  PIDS+=("$!")
  WORKER_PID="$!"
}

sim() {
  local runner="$1"
  shift
  FLEET_ROOT="$ROOT" RUNNER_NAME="$runner" FLEET_SIMCTL="$BIN/simctl" \
    FAKE_SIM_STATE="$SIM_STATE" FAKE_SIM_LOG="$SIM_LOG" \
    bash "$HOOKS/simulator-control.sh" "$@"
}

hook() {
  FLEET_ROOT="$ROOT" RUNNER_NAME=test-ios FLEET_SIMCTL="$BIN/simctl" \
    FAKE_SIM_STATE="$SIM_STATE" FAKE_SIM_LOG="$SIM_LOG" \
    bash "$HOOKS/$1"
}

echo "== selected job preserves pre-existing devices =="
setup
echo "$MANUAL" > "$SIM_STATE"
worker
sim test-ios start "$WORKER_PID"
echo "$CI_ONE" >> "$SIM_STATE"
sim test-ios complete
ok "manual simulator remains booted" "$(grep -c "$MANUAL" "$SIM_STATE")" "1"
ok "CI simulator was shut down" "$(grep -c "$CI_ONE" "$SIM_STATE")" "0"
ok "only CI device was targeted" "$(cat "$SIM_LOG")" "$CI_ONE"

echo "== overlapping jobs clean only after the last completion =="
setup
echo "$MANUAL" > "$SIM_STATE"
worker
OWNER_ONE="$WORKER_PID"
worker
OWNER_TWO="$WORKER_PID"
sim test-ios start "$OWNER_ONE"
sim test-ios-2 start "$OWNER_TWO"
printf '%s\n%s\n' "$CI_ONE" "$CI_TWO" >> "$SIM_STATE"
sim test-ios complete
ok "first completion does not interrupt peer" "$(wc -l < "$SIM_LOG" | tr -d ' ')" "0"
sim test-ios-2 complete
ok "last completion shuts both CI devices" "$(wc -l < "$SIM_LOG" | tr -d ' ')" "2"
ok "manual device still survives overlap" "$(cat "$SIM_STATE")" "$MANUAL"

echo "== guardian cleans after an abruptly ended worker =="
setup
echo "$MANUAL" > "$SIM_STATE"
worker 1
OWNER="$WORKER_PID"
sim test-ios start "$OWNER"
echo "$CI_ONE" >> "$SIM_STATE"
wait "$OWNER" 2>/dev/null
for _ in 1 2 3 4 5 6; do
  grep -q "$CI_ONE" "$SIM_STATE" || break
  sleep 1
done
ok "guardian shut down CI device" "$(grep -c "$CI_ONE" "$SIM_STATE")" "0"
ok "guardian preserved manual device" "$(cat "$SIM_STATE")" "$MANUAL"

echo "== unselected runners do nothing =="
setup
echo "$MANUAL" > "$SIM_STATE"
worker
sim test-web start "$WORKER_PID"
echo "$CI_ONE" >> "$SIM_STATE"
sim test-web complete
ok "no shutdown for web job" "$(wc -l < "$SIM_LOG" | tr -d ' ')" "0"
ok "no lease created for web job" "$([ -d "$ROOT/.simulator-cleanup" ] && echo yes || echo no)" "no"

echo "== job hooks invoke simulator lifecycle with admission off =="
setup
echo "$MANUAL" > "$SIM_STATE"
hook job-started.sh
echo "$CI_ONE" >> "$SIM_STATE"
hook job-completed.sh
ok "hook completion shuts CI device" "$(grep -c "$CI_ONE" "$SIM_STATE")" "0"
ok "hook completion preserves manual device" "$(cat "$SIM_STATE")" "$MANUAL"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
