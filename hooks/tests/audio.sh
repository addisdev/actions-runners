#!/usr/bin/env bash
# Exercises audio-control.sh with a fake osascript, so no test changes the
# machine running it.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/audio-hook-test/root"
BIN="$ROOT/bin"
MOCK_STATE="$ROOT/mock-muted"
PASS=0
FAIL=0
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    fi
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
  printf 'FLEET_MUTE_RUNNERS="sample-tvos sample-tvos-2"\n' > "$ROOT/fleet.env"
  printf 'false\n' > "$MOCK_STATE"
  cat > "$BIN/osascript" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"output muted of"*) cat "$FAKE_AUDIO_STATE" ;;
  *"with output muted"*) printf 'true\n' > "$FAKE_AUDIO_STATE" ;;
  *"without output muted"*) printf 'false\n' > "$FAKE_AUDIO_STATE" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$BIN/osascript"
}

worker() {
  sleep "${1:-60}" >/dev/null 2>&1 &
  PIDS+=("$!")
  WORKER_PID="$!"
}

audio() {
  local runner="$1"
  shift
  FLEET_ROOT="$ROOT" RUNNER_NAME="$runner" FAKE_AUDIO_STATE="$MOCK_STATE" \
    PATH="$BIN:/usr/bin:/bin" bash "$HOOKS/audio-control.sh" "$@"
}

hook() {
  FLEET_ROOT="$ROOT" RUNNER_NAME=sample-tvos FAKE_AUDIO_STATE="$MOCK_STATE" \
    PATH="$BIN:/usr/bin:/bin" bash "$HOOKS/$1"
}

echo "== job hooks mute even when admission is off =="
setup
hook job-started.sh
ok "started hook muted output" "$(cat "$MOCK_STATE")" "true"
hook job-completed.sh
ok "completed hook restored output" "$(cat "$MOCK_STATE")" "false"

echo "== selected runner is muted and restored =="
setup
worker
OWNER="$WORKER_PID"
audio sample-tvos start "$OWNER"
ok "output muted" "$(cat "$MOCK_STATE")" "true"
ok "lease created" "$([ -f "$ROOT/.audio-mute/jobs/sample-tvos" ] && echo yes || echo no)" "yes"
audio sample-tvos complete
ok "output restored" "$(cat "$MOCK_STATE")" "false"
ok "lease removed" "$([ -f "$ROOT/.audio-mute/jobs/sample-tvos" ] && echo yes || echo no)" "no"

echo "== unselected runner does not touch audio =="
setup
worker
OWNER="$WORKER_PID"
audio sample-firetv start "$OWNER"
ok "output unchanged" "$(cat "$MOCK_STATE")" "false"
ok "no state directory" "$([ -d "$ROOT/.audio-mute" ] && echo yes || echo no)" "no"

echo "== an initially muted host stays muted =="
setup
printf 'true\n' > "$MOCK_STATE"
worker
OWNER="$WORKER_PID"
audio sample-tvos start "$OWNER"
audio sample-tvos complete
ok "mute state preserved" "$(cat "$MOCK_STATE")" "true"

echo "== overlapping selected jobs hold separate leases =="
setup
worker
OWNER1="$WORKER_PID"
worker
OWNER2="$WORKER_PID"
audio sample-tvos start "$OWNER1"
audio sample-tvos-2 start "$OWNER2"
audio sample-tvos complete
ok "first completion keeps mute" "$(cat "$MOCK_STATE")" "true"
audio sample-tvos-2 complete
ok "last completion restores" "$(cat "$MOCK_STATE")" "false"

echo "== stale guardian cannot release a replacement lease =="
setup
worker
OWNER1="$WORKER_PID"
audio sample-tvos start "$OWNER1"
worker
OWNER2="$WORKER_PID"
audio sample-tvos start "$OWNER2"
kill "$OWNER1" 2>/dev/null
wait "$OWNER1" 2>/dev/null
sleep 3
ok "replacement stays muted" "$(cat "$MOCK_STATE")" "true"
ok "replacement lease survives" \
  "$(sed -n 's/^pid=//p' "$ROOT/.audio-mute/jobs/sample-tvos")" "$OWNER2"
audio sample-tvos complete

echo "== guardian restores after a worker dies =="
setup
worker 1
OWNER="$WORKER_PID"
audio sample-tvos start "$OWNER"
wait "$OWNER" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8; do
  [ "$(cat "$MOCK_STATE")" = "false" ] && break
  sleep 1
done
ok "guardian restored output" "$(cat "$MOCK_STATE")" "false"
ok "guardian removed lease" "$([ -f "$ROOT/.audio-mute/jobs/sample-tvos" ] && echo yes || echo no)" "no"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
