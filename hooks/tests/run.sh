#!/usr/bin/env bash
# Exercises hooks/job-started.sh and hooks/job-completed.sh against a throwaway
# fleet root, so no real runner or real fleet.env is involved.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/admit-test/root"
LOG="$ROOT/dashboard/logs/admission.ndjson"
BIN="$ROOT/bin"
RUN_STATUS="$ROOT/run-status"
PASS=0
FAIL=0

setup() {
  rm -rf "$ROOT"
  mkdir -p "$ROOT/dashboard/logs" "$BIN"
  {
    echo "FLEET_ADMIT_MODE=$1"
    echo "FLEET_ADMIT_MAX_CONCURRENT=${2:-2}"
    echo "FLEET_ADMIT_MAX_WAIT_S=${3:-6}"
    echo "FLEET_ADMIT_POLL_S=${4:-1}"
    echo "FLEET_ADMIT_MIN_FREE_DISK_GB=${5:-1}"
  } > "$ROOT/fleet.env"
  echo in_progress > "$RUN_STATUS"
  cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
cat "$FAKE_RUN_STATUS"
EOF
  chmod +x "$BIN/gh"
}

# Runs the started hook as if a job on $1 were beginning.
start() {
  FLEET_ROOT="$ROOT" RUNNER_NAME="$1" GITHUB_REPOSITORY="acme/$1" \
    GITHUB_RUN_ID="${2:-100}" GITHUB_JOB="build" FAKE_RUN_STATUS="$RUN_STATUS" \
    PATH="$BIN:$PATH" \
    bash "$HOOKS/job-started.sh"
}

# Starts a hook whose PARENT outlives it, which is the production shape: the
# hook's owner is Runner.Worker, and that process lives for the whole job. A
# plain `start &` gives the hook a parent that exits immediately, so its slot is
# reaped the moment it is written and the concurrency count never rises.
#
# The pid of the stand-in parent is recorded so a test can end the "job".
declare -a JOBPIDS=()
start_bg() {
  (
    FLEET_ROOT="$ROOT" RUNNER_NAME="$1" GITHUB_REPOSITORY="acme/$1" \
      GITHUB_RUN_ID="${2:-100}" GITHUB_JOB="build" \
      FAKE_RUN_STATUS="$RUN_STATUS" PATH="$BIN:$PATH" \
      bash "$HOOKS/job-started.sh"
    sleep 120
  ) >/dev/null 2>&1 &
  JOBPIDS+=("$!")
}

end_jobs() {
  local p
  for p in "${JOBPIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  JOBPIDS=()
}

complete() {
  FLEET_ROOT="$ROOT" RUNNER_NAME="$1" GITHUB_REPOSITORY="acme/$1" \
    GITHUB_RUN_ID="${2:-100}" GITHUB_JOB="build" FAKE_RUN_STATUS="$RUN_STATUS" \
    PATH="$BIN:$PATH" \
    bash "$HOOKS/job-completed.sh"
}

slots() { ls -1 "$ROOT/.admission/slots" 2>/dev/null | wc -l | tr -d ' '; }
# grep -c already prints 0 when nothing matches; a `|| echo 0` on top of that
# emits a second line and every comparison against it fails.
events() {
  local n
  n="$(grep -c "\"event\":\"$1\"" "$LOG" 2>/dev/null)"
  printf '%s' "${n:-0}"
}

ok() {
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 ($2)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 — expected '$3', got '$2'"
    FAIL=$((FAIL + 1))
  fi
}

# Places a slot file owned by a live process, standing in for a running job.
#
# The sleep's stdout goes to /dev/null deliberately: called via $(...) it would
# otherwise inherit the command-substitution pipe and hold it open, so the
# substitution would block for the sleep's full duration instead of returning.
fake_slot() {
  mkdir -p "$ROOT/.admission/slots"
  sleep 300 >/dev/null 2>&1 &
  printf 'pid=%s\nts=%s\nrepo=acme/%s\n' "$!" "$(date +%s)" "$1" \
    > "$ROOT/.admission/slots/$1"
  echo $!
}

echo "== mode=off does nothing =="
setup off
start alpha
ok "no slots taken" "$(slots)" "0"
ok "no log written" "$([ -f "$LOG" ] && echo yes || echo no)" "no"

echo "== mode=observe never delays, still counts =="
setup observe 2
BEFORE=$(date +%s)
start alpha; start beta; start gamma
AFTER=$(date +%s)
ok "all three took slots" "$(slots)" "3"
ok "returned immediately" "$([ $((AFTER - BEFORE)) -le 2 ] && echo fast || echo slow)" "fast"
ok "two observed under limit" "$(events observed)" "2"
ok "third would have been held" "$(events would-hold)" "1"

echo "== mode=enforce admits up to the limit =="
setup enforce 2 4 1
start alpha; start beta
ok "two admitted" "$(events admitted)" "2"
ok "two slots held" "$(slots)" "2"

echo "== mode=enforce holds past the limit, then times out =="
BEFORE=$(date +%s)
start gamma
AFTER=$(date +%s)
ok "held before admitting" "$(events held)" "1"
ok "admitted on timeout" "$(events timeout)" "1"
ok "waited the bounded time" "$([ $((AFTER - BEFORE)) -ge 4 ] && echo waited || echo instant)" "waited"

echo "== strict timeout keeps holding until capacity returns =="
setup enforce 1 2 1
echo "FLEET_ADMIT_TIMEOUT_ACTION=hold" >> "$ROOT/fleet.env"
LIVE=$(fake_slot occupied)
( sleep 4; kill "$LIVE" 2>/dev/null ) &
RELEASER=$!
BEFORE=$(date +%s)
start alpha
AFTER=$(date +%s)
wait "$RELEASER" 2>/dev/null
ok "strict mode did not fail open" "$(events timeout)" "0"
ok "continued hold was logged" "$(events continued-hold)" "1"
ok "admitted only after capacity returned" "$([ $((AFTER - BEFORE)) -ge 4 ] && echo waited || echo early)" "waited"

echo "== a cancelled run releases its waiting runner =="
setup enforce 1 30 1
echo "FLEET_ADMIT_CANCEL_POLL_S=5" >> "$ROOT/fleet.env"
LIVE=$(fake_slot occupied)
( sleep 2; echo completed > "$RUN_STATUS" ) &
STATUS_WRITER=$!
BEFORE=$(date +%s)
start cancelled
AFTER=$(date +%s)
wait "$STATUS_WRITER"
kill "$LIVE" 2>/dev/null
ok "cancellation event logged" "$(events cancelled)" "1"
ok "cancelled job claimed no slot" \
  "$([ -f "$ROOT/.admission/slots/cancelled" ] && echo yes || echo no)" "no"
ok "returned before admission timeout" "$([ $((AFTER - BEFORE)) -lt 10 ] && echo prompt || echo slow)" "prompt"

echo "== waiters are admitted in arrival order =="
setup enforce 1 30 1
LIVE=$(fake_slot occupied)
start_bg beta
sleep 1
start_bg gamma
sleep 1
ok "both jobs joined the waiter queue" \
  "$(ls -1 "$ROOT/.admission/waiters" 2>/dev/null | wc -l | tr -d ' ')" "2"
kill "$LIVE" 2>/dev/null
for _ in 1 2 3 4 5; do
  [ "$(events admitted)" = "1" ] && break
  sleep 1
done
FIRST="$(grep '"event":"admitted"' "$LOG" | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p' | head -1)"
ok "oldest waiter admitted first" "$FIRST" "beta"
complete beta
for _ in 1 2 3 4 5; do
  [ "$(events admitted)" = "2" ] && break
  sleep 1
done
SECOND="$(grep '"event":"admitted"' "$LOG" | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p' | tail -1)"
ok "second waiter admitted next" "$SECOND" "gamma"
end_jobs

echo "== Simulator limit does not serialize unrelated jobs =="
setup enforce 3 30 1
{
  echo 'FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT=1'
  echo 'FLEET_SIMULATOR_RUNNERS=*-ios'
} >> "$ROOT/fleet.env"
start_bg alpha-ios
sleep 1
start_bg beta-ios
sleep 1
ok "second Simulator job held" "$(events held)" "1"
start backend
ok "backend bypassed Simulator-only waiter" "$(events admitted)" "2"
ok "one Simulator plus backend occupied two slots" "$(slots)" "2"
complete alpha-ios
for _ in 1 2 3 4 5; do
  [ "$(events admitted)" = "3" ] && break
  sleep 1
done
ok "second Simulator admitted after first released" "$(events admitted)" "3"
end_jobs

echo "== Simulator limit stays strict after fail-open timeout =="
setup enforce 2 2 1
{
  echo 'FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT=1'
  echo 'FLEET_SIMULATOR_RUNNERS=*-ios'
} >> "$ROOT/fleet.env"
LIVE=$(fake_slot alpha-ios)
( sleep 4; kill "$LIVE" 2>/dev/null ) &
RELEASER=$!
BEFORE=$(date +%s)
start beta-ios
AFTER=$(date +%s)
wait "$RELEASER" 2>/dev/null
ok "Simulator wait did not fail open" "$(events timeout)" "0"
ok "strict Simulator hold was logged" "$(events continued-hold)" "1"
ok "Simulator admitted only after release" \
  "$([ $((AFTER - BEFORE)) -ge 4 ] && echo waited || echo early)" "waited"

echo "== completing a job frees the slot for a waiter =="
setup enforce 2 20 1
start alpha; start beta
( sleep 2; complete alpha ) &
FREER=$!
BEFORE=$(date +%s)
start gamma
AFTER=$(date +%s)
wait $FREER
ok "gamma admitted, not timed out" "$(events timeout)" "0"
ok "gamma was held first" "$(events held)" "1"
ok "admitted after the release" "$([ $((AFTER - BEFORE)) -ge 2 ] && echo waited || echo instant)" "waited"
ok "release logged" "$(events released)" "1"
# A release reports how long it OCCUPIED the slot, as ran_s. It must not report
# that as waited_s: nothing waited, and the wait totals are summed from that
# field, so an occupancy landing there would inflate them by whole job durations.
ok "release reports occupancy as ran_s" \
  "$(grep '"event":"released"' "$LOG" | grep -c '"ran_s":[1-9]')" "1"
ok "release claims no wait" \
  "$(grep '"event":"released"' "$LOG" | grep -c '"waited_s":0')" "1"

echo "== a slot whose process died is reaped =="
setup enforce 1 3 1
mkdir -p "$ROOT/.admission/slots"
printf 'pid=999999\nts=%s\n' "$(date +%s)" > "$ROOT/.admission/slots/ghost"
start alpha
ok "admitted despite the ghost slot" "$(events admitted)" "1"
ok "ghost reaped" "$([ -f "$ROOT/.admission/slots/ghost" ] && echo present || echo gone)" "gone"

echo "== a slot older than its TTL is reaped =="
setup enforce 1 3 1
mkdir -p "$ROOT/.admission/slots"
LIVE=$(fake_slot stale)
# Backdate past the 6h default TTL while keeping the pid live.
printf 'pid=%s\nts=%s\n' "$LIVE" "$(( $(date +%s) - 30000 ))" \
  > "$ROOT/.admission/slots/stale"
start alpha
ok "admitted despite the stale slot" "$(events admitted)" "1"
ok "stale slot reaped" "$([ -f "$ROOT/.admission/slots/stale" ] && echo present || echo gone)" "gone"
kill "$LIVE" 2>/dev/null

echo "== the disk floor blocks admission =="
setup enforce 8 3 1 999999
start alpha
ok "held on the disk floor" "$(events held)" "1"
ok "disk reason recorded" "$(grep -c 'below the 999999 GB floor' "$LOG")" "2"

echo "== a garbage config falls back instead of spinning =="
setup enforce
{
  echo "FLEET_ADMIT_MODE=enforce"
  echo "FLEET_ADMIT_MAX_CONCURRENT=banana"
  echo "FLEET_ADMIT_POLL_S=0"
  echo "FLEET_ADMIT_MAX_WAIT_S=nonsense"
  echo "FLEET_ADMIT_MIN_FREE_DISK_GB=1"
} > "$ROOT/fleet.env"
start alpha
ok "admitted using the default limit" "$(events admitted)" "1"
ok "limit fell back to 3" "$(grep -c '\"limit\":3' "$LOG")" "1"

echo "== an unrecognised mode reads as off =="
setup enfroce
start alpha
ok "no slots taken" "$(slots)" "0"

echo "== a broken common.sh still lets the job run =="
setup enforce
BROKEN=/tmp/admit-test/broken
mkdir -p "$BROKEN"
cp "$HOOKS/job-started.sh" "$BROKEN/"
echo 'this is not shell (' > "$BROKEN/common.sh"
FLEET_ROOT="$ROOT" RUNNER_NAME=alpha bash "$BROKEN/job-started.sh"
ok "exited zero anyway" "$?" "0"

echo "== concurrent starts never exceed the limit =="
setup enforce 2 3 1
for r in a b c d e; do start_bg "$r"; done
# The stand-in parents sleep, so `wait` would block on them. Two jobs are
# admitted at once and three hold for the 3s bound.
sleep 7
ok "exactly the limit admitted without waiting" "$(events admitted)" "2"
ok "the rest were held" "$(events held)" "3"
ok "the held ones hit the bound" "$(events timeout)" "3"
# An owner exists only once a slot has been claimed, and `held` is logged before
# that — so the 5 events that took a slot (2 admitted + 3 timeout) carry one and
# the 3 holds do not. Asserted rather than assumed because the owner is what the
# slot is keyed on, and a decision recording no owner would be unreapable.
ok "owner pid on every event that took a slot" "$(grep -c '"owner_pid":"[0-9][0-9]*"' "$LOG")" "5"
ok "no owner on a hold, which claims nothing" \
  "$(grep '"event":"held"' "$LOG" | grep -c '"owner_pid":""')" "3"
# This harness has no Runner.Worker in the tree, so every owner resolves through
# the fallback path. That the fallback is exercised at all is the point: it is
# the branch that keeps admission working on an unexpected process shape.
ok "owner kind recorded wherever there is an owner" "$(grep -c '"owner_kind":"fallback"' "$LOG")" "5"
if [ "$(events admitted)" != "2" ]; then
  echo "  --- log for the failing case ---"
  sed 's/^/  /' "$LOG"
fi
end_jobs

echo "== a waiter is admitted as soon as a real job ends =="
setup enforce 1 30 1
start_bg alpha
sleep 1
ok "alpha admitted" "$(events admitted)" "1"
# End alpha's stand-in worker without running the completed hook, which is the
# SIGKILL case: the slot is reclaimed only by the PID check.
end_jobs
BEFORE=$(date +%s)
start beta
AFTER=$(date +%s)
ok "beta admitted, not timed out" "$(events timeout)" "0"
ok "beta got in promptly" "$([ $((AFTER - BEFORE)) -le 3 ] && echo prompt || echo slow)" "prompt"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
