#!/usr/bin/env bash
# Exercises hooks/job-started.sh and hooks/job-completed.sh against a throwaway
# fleet root, so no real runner or real fleet.env is involved.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${TMPDIR:-/tmp}/admit-test"
ROOT=""
LOG=""
BIN=""
RUN_STATUS=""
PASS=0
FAIL=0
CASE=0

finish_jobs() {
  local p
  for p in "${JOBPIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  for p in "${JOBPIDS[@]:-}"; do
    [ -n "$p" ] && wait "$p" 2>/dev/null || true
  done
  JOBPIDS=()
}

setup() {
  finish_jobs
  CASE=$((CASE + 1))
  ROOT="$BASE/case-$CASE"
  LOG="$ROOT/dashboard/logs/admission.ndjson"
  BIN="$ROOT/bin"
  RUN_STATUS="$ROOT/run-status"
  rm -rf "$ROOT"
  mkdir -p "$ROOT/dashboard/logs" "$BIN"
  {
    echo "FLEET_ADMIT_MODE=$1"
    echo "FLEET_ADMIT_MAX_CONCURRENT=${2:-2}"
    echo "FLEET_ADMIT_MAX_WAIT_S=${3:-6}"
    echo "FLEET_ADMIT_POLL_S=${4:-1}"
    echo "FLEET_ADMIT_MIN_FREE_DISK_GB=${5:-1}"
    echo "FLEET_ADMIT_STATUS_URL="
  } > "$ROOT/fleet.env"
  echo in_progress > "$RUN_STATUS"
  cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
cat "$FAKE_RUN_STATUS"
EOF
  chmod +x "$BIN/gh"
}

wait_for() {
  local expected="$1" cmd="$2" tries="${3:-30}" got=""
  while [ "$tries" -gt 0 ]; do
    got="$(eval "$cmd")"
    [ "$got" = "$expected" ] && return 0
    tries=$((tries - 1))
    sleep 1
  done
  return 1
}

# Runs the started hook as if a job on $1 were beginning.
start() {
  FLEET_ROOT="$ROOT" RUNNER_NAME="$1" GITHUB_REPOSITORY="acme/$1" \
    GITHUB_RUN_ID="${2:-100}" GITHUB_JOB="build" FAKE_RUN_STATUS="$RUN_STATUS" \
    PATH="$BIN:$PATH" \
    bash -e "$HOOKS/job-started.sh"
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
      bash -e "$HOOKS/job-started.sh"
    sleep 120
  ) >/dev/null 2>&1 &
  JOBPIDS+=("$!")
}

end_jobs() {
  finish_jobs
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

# A numeric field of the first $1 event, or empty when there is none.
event_num() {
  grep "\"event\":\"$1\"" "$LOG" 2>/dev/null | head -1 \
    | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p"
}

# "Promptly" for a waiter whose blocker has gone, against the 30 s wait bound
# those cases use. A wall-clock window around the whole hook failed on a
# GitHub-hosted macOS runner (run 38419823450: >3 s) because it also timed bash
# startup and a loaded host's scheduling. The failure these checks exist for is
# a waiter sitting out the bound, so a third of it still tells the two apart.
PROMPT_S=10

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
wait_for "1" "events admitted" 15
FIRST="$(grep '"event":"admitted"' "$LOG" | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p' | head -1)"
ok "oldest waiter admitted first" "$FIRST" "beta"
complete beta
wait_for "2" "events admitted" 15
SECOND="$(grep '"event":"admitted"' "$LOG" | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p' | tail -1)"
ok "second waiter admitted next" "$SECOND" "gamma"
end_jobs

echo "== a later waiter leaves the mutex to the oldest one =="
# Only the oldest waiter can be admitted. When every waiter polled through the
# mutex, 40 of them on a loaded host kept it permanently busy and the oldest
# almost never won it: nothing was admitted for a day with every slot empty.
# A mkdir shim records who asks for the mutex; once both have joined, the later
# waiter must stop asking while the older one is alive and ahead of it.
setup enforce 1 30 1
SHIM="$ROOT/bin-mutex-shim"
mkdir -p "$SHIM"
cat > "$SHIM/mkdir" <<'EOF2'
#!/usr/bin/env bash
case "${*: -1}" in
  */.admission/mutex) echo "${RUNNER_NAME:-?}" >> "$MUTEX_TRACE" ;;
esac
exec /bin/mkdir "$@"
EOF2
chmod +x "$SHIM/mkdir"
TRACE="$ROOT/mutex-trace"
: > "$TRACE"
LIVE=$(fake_slot occupied)
for r in beta gamma; do
  (
    FLEET_ROOT="$ROOT" RUNNER_NAME="$r" GITHUB_REPOSITORY="acme/$r" \
      GITHUB_RUN_ID=100 GITHUB_JOB=build FAKE_RUN_STATUS="$RUN_STATUS" \
      MUTEX_TRACE="$TRACE" PATH="$SHIM:$BIN:$PATH" \
      bash -e "$HOOKS/job-started.sh"
    sleep 120
  ) >/dev/null 2>&1 &
  JOBPIDS+=("$!")
  sleep 1
done
wait_for "2" "ls -1 '$ROOT/.admission/waiters' 2>/dev/null | wc -l | tr -d ' '" 10
sleep 1
GAMMA_BEFORE="$(grep -c '^gamma$' "$TRACE")"
BETA_BEFORE="$(grep -c '^beta$' "$TRACE")"
sleep 4
ok "the later waiter stopped asking for the mutex" \
  "$(( $(grep -c '^gamma$' "$TRACE") - GAMMA_BEFORE ))" "0"
ok "the oldest waiter kept asking" \
  "$([ "$(grep -c '^beta$' "$TRACE")" -gt "$BETA_BEFORE" ] && echo yes || echo no)" "yes"
kill "$LIVE" 2>/dev/null
wait_for "1" "events admitted" 15
FIRST="$(grep '"event":"admitted"' "$LOG" | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p' | head -1)"
ok "the oldest waiter was still admitted first" "$FIRST" "beta"
end_jobs

echo "== the lockless check defers to the locked one whenever unsure =="
setup enforce 1 30 1
echo 'FLEET_SIMULATOR_RUNNERS=*-ios' >> "$ROOT/fleet.env"
W="$ROOT/.admission/waiters"
mkdir -p "$W"
behind() {
  # $1 = this waiter's file name, $2 = FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT
  FLEET_ROOT="$ROOT" FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT="${2:-0}" bash -c '
    ROOT="$FLEET_ROOT"; set -a; . "$ROOT/fleet.env"; set +a
    . "'"$HOOKS"'/common.sh"
    ADMIT_WAITER="$ADMIT_WAITERS/'"$1"'"
    admit_waiting_behind_older && echo behind || echo decide
    trap - EXIT'
}
sleep 300 >/dev/null 2>&1 &
HEAD_PID=$!
printf 'pid=%s\nrunner=alpha\n' "$HEAD_PID" > "$W/00000000000000000001-0000000001-alpha"
printf 'pid=%s\nrunner=beta\n' "$$" > "$W/00000000000000000002-0000000002-beta"
ok "behind a live older waiter" "$(behind 00000000000000000002-0000000002-beta)" "behind"
ok "the oldest waiter decides" "$(behind 00000000000000000001-0000000001-alpha)" "decide"
ok "a job with no place in the queue decides" "$(behind 00000000000000000009-0000000009-zeta)" "decide"
printf 'pid=%s\nrunner=alpha-ios\n' "$HEAD_PID" > "$W/00000000000000000001-0000000001-alpha"
ok "a Simulator job at the head is left to the locked check" \
  "$(behind 00000000000000000002-0000000002-beta 1)" "decide"
ok "...unless the Simulator limit is off" "$(behind 00000000000000000002-0000000002-beta 0)" "behind"
kill "$HEAD_PID" 2>/dev/null
wait "$HEAD_PID" 2>/dev/null
ok "a dead head is left to the locked check, which reaps it" \
  "$(behind 00000000000000000002-0000000002-beta)" "decide"

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
wait_for "3" "events admitted" 15
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

# The runner runs the hook as `bash -e`, so the tests do too: a failed command
# there exits the hook, and its EXIT trap admits the job without a slot.
#
# Real df on the test host is far below this floor; the osascript stub plays
# macOS reporting that much usable once purgeable caches are counted.
usable_stub() {
  printf '#!/usr/bin/env bash\necho %s\n' "$1" > "$BIN/osascript"
  chmod +x "$BIN/osascript"
}

echo "== purgeable space counts toward the disk floor =="
# runner-host 2026-10-07: df 101 GB, macOS 163 GB available. A floor read from
# df held every job while macOS had 62 GB it would purge on demand.
setup enforce 8 3 1 400000
usable_stub 500000
start alpha
ok "admitted on what macOS will provide" "$(events admitted)" "1"
ok "not held" "$(events held)" "0"

echo "== FLEET_DISK_PROBE=df goes back to plain df =="
setup enforce 8 3 1 400000
usable_stub 500000
echo "FLEET_DISK_PROBE=df" >> "$ROOT/fleet.env"
start alpha
ok "held on plain df" "$(grep -c 'below the 400000 GB floor' "$LOG")" "2"

echo "== the plain hard floor still holds when purgeable is plentiful =="
setup enforce 8 3 1 1
usable_stub 500000
echo "FLEET_ADMIT_MIN_PLAIN_FREE_GB=999999" >> "$ROOT/fleet.env"
start alpha
ok "held on the hard floor" "$(grep -c 'plain disk free, below the 999999 GB hard floor' "$LOG")" "2"

echo "== an osascript that fails falls back to df =="
setup enforce 8 3 1 400000
printf '#!/usr/bin/env bash\necho "execution error: -2700" >&2\nexit 1\n' > "$BIN/osascript"
chmod +x "$BIN/osascript"
start alpha
ok "held on df rather than admitted on nothing" "$(grep -c 'below the 400000 GB floor' "$LOG")" "2"

echo "== a hooks directory without free-disk.sh still holds on df =="
setup enforce 8 3 1 400000
OLD="$ROOT/old-hooks"
mkdir -p "$OLD"
cp "$HOOKS/job-started.sh" "$HOOKS/common.sh" "$OLD/"
FLEET_ROOT="$ROOT" RUNNER_NAME=alpha GITHUB_REPOSITORY=acme/alpha GITHUB_RUN_ID=100 \
  GITHUB_JOB=build FAKE_RUN_STATUS="$RUN_STATUS" PATH="$BIN:$PATH" bash -e "$OLD/job-started.sh"
# Held on df, under bash -e: before the -f check, sourcing the missing file
# killed the hook there and its EXIT trap let the job straight in.
ok "held on df, not admitted by a failed source" "$(grep -c 'below the 400000 GB floor' "$LOG")" "2"

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
wait_for "2" "events admitted" 10
wait_for "3" "events held" 10
wait_for "3" "events timeout" 15
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
# A local invocation takes the fallback path. In GitHub-hosted CI the harness
# itself is legitimately below Runner.Worker, so either kind is correct; every
# claimed slot must still record which branch was used.
ok "owner kind recorded wherever there is an owner" \
  "$(grep -Ec '"owner_kind":"(worker|fallback)"' "$LOG")" "5"
if [ "$(events admitted)" != "2" ]; then
  echo "  --- log for the failing case ---"
  sed 's/^/  /' "$LOG"
fi
end_jobs

echo "== a waiter is admitted as soon as a live slot owner dies =="
setup enforce 1 30 1
LIVE=$(fake_slot alpha)
# Timed from the owner's death to the hook's own admitted line, not around the
# hook: how long bash takes to start on a busy runner is not what this tests.
# The time is taken before the kill, so admitted-before-death reads negative.
( sleep 2; date +%s > "$ROOT/owner-died"; kill "$LIVE" 2>/dev/null ) &
RELEASER=$!
start beta
wait "$RELEASER" 2>/dev/null
ok "beta admitted" "$(events admitted)" "1"
ok "beta admitted, not timed out" "$(events timeout)" "0"
ADMITTED_AT="$(event_num admitted ts)"
DIED_AT="$(cat "$ROOT/owner-died" 2>/dev/null)"
LAG=$(( ${ADMITTED_AT:-0} - ${DIED_AT:-0} ))
ok "beta held until the owner died" "$([ "$LAG" -ge 0 ] && echo after || echo before)" "after"
ok "beta got in promptly after it died" \
  "$([ "$LAG" -le "$PROMPT_S" ] && echo prompt || echo "slow (${LAG}s)")" "prompt"

echo "== cancellation works via curl when gh is absent =="
setup enforce 1 30 1
echo "FLEET_ADMIT_CANCEL_POLL_S=1" >> "$ROOT/fleet.env"
LIVE=$(fake_slot occupied)
( sleep 2; echo completed > "$RUN_STATUS" ) &
STATUS_WRITER=$!
CURL_BIN="$ROOT/bin-curl-only"
mkdir -p "$CURL_BIN"
cat > "$CURL_BIN/gh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "$CURL_BIN/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *actions/runs/* ]]; then
  printf '{"status":"%s"}' "$(cat "$FAKE_RUN_STATUS")"
  exit 0
fi
exit 1
EOF
chmod +x "$CURL_BIN/gh" "$CURL_BIN/curl"
BEFORE=$(date +%s)
# Keep coreutils and python3 on PATH; omit Homebrew so only the fake gh/curl run.
GITHUB_TOKEN=test-token \
  PATH="$CURL_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v python3)")" \
  FLEET_ROOT="$ROOT" RUNNER_NAME=curl-runner \
  GITHUB_REPOSITORY="acme/curl-runner" GITHUB_RUN_ID=200 GITHUB_JOB=build \
  FAKE_RUN_STATUS="$RUN_STATUS" \
  bash -e "$HOOKS/job-started.sh"
AFTER=$(date +%s)
wait "$STATUS_WRITER"
kill "$LIVE" 2>/dev/null
ok "curl cancellation event logged" "$(events cancelled)" "1"
ok "curl path claimed no slot" \
  "$([ -f "$ROOT/.admission/slots/curl-runner" ] && echo yes || echo no)" "no"
ok "curl path returned promptly" \
  "$([ $((AFTER - BEFORE)) -lt 10 ] && echo prompt || echo slow)" "prompt"

# The production shape since runners got SessionCreate: gh has no token and
# fails, and the dashboard daemon is the one that can answer.
fake_daemon_bin() {
  DAEMON_BIN="$ROOT/bin-daemon"
  mkdir -p "$DAEMON_BIN"
  cat > "$DAEMON_BIN/gh" <<EOF
#!/usr/bin/env bash
$1
EOF
  cat > "$DAEMON_BIN/curl" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *fleet.test/api/run-status* && "\$*" == *repo=acme/daemon-runner* && "\$*" == *run=400* ]]; then
  $2
fi
exit 7
EOF
  chmod +x "$DAEMON_BIN/gh" "$DAEMON_BIN/curl"
}
run_daemon_case() {
  setup enforce 1 30 1
  {
    echo "FLEET_ADMIT_CANCEL_POLL_S=1"
    echo "FLEET_ADMIT_STATUS_URL=http://fleet.test/api/run-status"
  } >> "$ROOT/fleet.env"
  LIVE=$(fake_slot occupied)
  ( sleep 2; echo completed > "$RUN_STATUS" ) &
  STATUS_WRITER=$!
  fake_daemon_bin "$1" "$2"
  BEFORE=$(date +%s)
  PATH="$DAEMON_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    FLEET_ROOT="$ROOT" RUNNER_NAME=daemon-runner \
    GITHUB_REPOSITORY="acme/daemon-runner" GITHUB_RUN_ID=400 GITHUB_JOB=build \
    FAKE_RUN_STATUS="$RUN_STATUS" \
    bash -e "$HOOKS/job-started.sh"
  AFTER=$(date +%s)
  wait "$STATUS_WRITER"
  kill "$LIVE" 2>/dev/null
}

echo "== cancellation works through the daemon when gh has no token =="
# shellcheck disable=SC2016
run_daemon_case 'echo "gh: HTTP 401: Bad credentials" >&2; exit 1' \
  'printf "{\"status\":\"%s\",\"conclusion\":null}" "$(cat "$FAKE_RUN_STATUS")"; exit 0'
ok "daemon cancellation event logged" "$(events cancelled)" "1"
ok "daemon path claimed no slot" \
  "$([ -f "$ROOT/.admission/slots/daemon-runner" ] && echo yes || echo no)" "no"
ok "daemon path returned promptly" \
  "$([ $((AFTER - BEFORE)) -lt 10 ] && echo prompt || echo slow)" "prompt"

echo "== an unreachable daemon falls back to gh =="
# shellcheck disable=SC2016
run_daemon_case 'cat "$FAKE_RUN_STATUS"' 'exit 7'
ok "gh fallback cancellation event logged" "$(events cancelled)" "1"
ok "gh fallback returned promptly" \
  "$([ $((AFTER - BEFORE)) -lt 10 ] && echo prompt || echo slow)" "prompt"

echo "== enforce mode does not fail open on mutex contention =="
setup enforce 1 30 1
echo "FLEET_ADMIT_MUTEX_TRIES=1" >> "$ROOT/fleet.env"
LIVE=$(fake_slot occupied)
start_bg blocked
wait_for "1" "events held" 10
ok "contended mutex keeps waiting" "$(events held)" "1"
MUTEX_BYPASS="$(grep -c 'mutex unavailable' "$LOG" 2>/dev/null)"
ok "mutex contention did not bypass the limit" "${MUTEX_BYPASS:-0}" "0"
ok "contended job did not claim a slot" \
  "$([ -f "$ROOT/.admission/slots/blocked" ] && echo yes || echo no)" "no"
kill "$LIVE" 2>/dev/null
end_jobs

# A stand-in Runner.Worker: a script whose command line says Runner.Worker, so
# admit_resolve_owner picks it as the owner exactly as it does in production.
# It starts the hook as its child and waits; killing it leaves the hook
# reparented, which is what a worker that dies mid-hold (a job timeout, a
# runner restart) does to the real one. A cancel does not kill the worker: it
# only writes to the worker's log (see the next case but one).
fake_worker() {
  cat > "$BIN/Runner.Worker" <<EOF
#!/usr/bin/env bash
FLEET_ROOT="$ROOT" RUNNER_NAME="\$1" GITHUB_REPOSITORY="acme/\$1" \\
  GITHUB_RUN_ID=300 GITHUB_JOB=build FAKE_RUN_STATUS="$RUN_STATUS" \\
  PATH="$BIN:\$PATH" bash -e "$HOOKS/job-started.sh" >/dev/null 2>&1 &
echo \$! > "$ROOT/hook-\$1.pid"
wait
EOF
  chmod +x "$BIN/Runner.Worker"
  bash "$BIN/Runner.Worker" "$1" >/dev/null 2>&1 &
  echo $!
}

# A waiter file for a job that is ahead in line, owned by $2 (a pid).
fake_waiter() {
  mkdir -p "$ROOT/.admission/waiters"
  printf 'pid=%s\nts=1\nrunner=%s\nrepo=acme/%s\nrun=1\njob=build\n' "$2" "$1" "$1" \
    > "$ROOT/.admission/waiters/00000000000000000001-0000000001-$1"
}

echo "== a waiter whose Runner.Worker is gone leaves the line =="
setup enforce 1 30 1
LIVE=$(fake_slot occupied)
WORKER=$(fake_worker orphan)
wait_for "1" "events held" 10
HOOK=$(cat "$ROOT/hook-orphan.pid")
kill -9 "$WORKER" 2>/dev/null
wait_for "1" "events orphaned" 10
ok "orphaned hook logged and left" "$(events orphaned)" "1"
ok "orphaned hook exited" "$(kill -0 "$HOOK" 2>/dev/null && echo alive || echo gone)" "gone"
ok "orphaned hook left no waiter" "$(ls -1 "$ROOT/.admission/waiters" 2>/dev/null | wc -l | tr -d ' ')" "0"
ok "orphaned hook claimed no slot" \
  "$([ -f "$ROOT/.admission/slots/orphan" ] && echo yes || echo no)" "no"
kill "$LIVE" 2>/dev/null

echo "== a cancel the worker logged releases the hook at once =="
# Measured 2026-10-07: GitHub keeps a cancelled run in_progress for minutes
# while its job is held here, and the worker never signals the hook. The
# worker's log is the only prompt sign, so the hook reads it every poll.
setup enforce 1 30 1
echo "FLEET_ADMIT_CANCEL_POLL_S=600" >> "$ROOT/fleet.env"
mkdir -p "$ROOT/_diag"
# Written before the hook starts, as the worker does: the job message (here a
# commit message quoting the cancel line) and even a real cancel line from
# earlier in the log. Neither may release the hook.
{
  echo '                      "v": "Cancellation/Shutdown message received. is what the worker logs"'
  echo "[2026-10-07 11:20:00Z INFO Worker] Cancellation/Shutdown message received."
  echo "[2026-10-07 11:25:33Z INFO Worker] Waiting for the job to complete or for a cancel message from the channel."
} > "$ROOT/_diag/Worker_20261007-112532-utc.log"
LIVE=$(fake_slot occupied)
WORKER=$(fake_worker cancelme)
wait_for "1" "events held" 10
HOOK=$(cat "$ROOT/hook-cancelme.pid")
sleep 2
ok "still held: nothing written before it started counts" "$(kill -0 "$HOOK" 2>/dev/null && echo alive || echo gone)" "alive"
echo '  "v": "a later quote: Cancellation/Shutdown message received."' \
  >> "$ROOT/_diag/Worker_20261007-112532-utc.log"
sleep 2
ok "still held: a quote of the line is not the line" "$(kill -0 "$HOOK" 2>/dev/null && echo alive || echo gone)" "alive"
echo "[2026-10-07 11:26:32Z INFO Worker] Cancellation/Shutdown message received." \
  >> "$ROOT/_diag/Worker_20261007-112532-utc.log"
BEFORE=$(date +%s)
wait_for "1" "events cancelled" 10
AFTER=$(date +%s)
ok "cancel logged" "$(events cancelled)" "1"
ok "reason names the worker" "$(grep -c 'the runner was told to cancel this job' "$LOG")" "1"
ok "released within a poll or two" "$([ $((AFTER - BEFORE)) -le 3 ] && echo prompt || echo slow)" "prompt"
ok "hook exited" "$(kill -0 "$HOOK" 2>/dev/null && echo alive || echo gone)" "gone"
ok "cancelled hook left no waiter" "$(ls -1 "$ROOT/.admission/waiters" 2>/dev/null | wc -l | tr -d ' ')" "0"
ok "cancelled hook claimed no slot" \
  "$([ -f "$ROOT/.admission/slots/cancelme" ] && echo yes || echo no)" "no"
kill "$WORKER" "$LIVE" 2>/dev/null

echo "== the worker's log is found under a versioned bin directory =="
# Production runners run <runner>/bin.<version>/Runner.Worker after a
# self-update; the log is in <runner>/_diag either way.
setup enforce 1 30 1
R="$ROOT/runner-x"
mkdir -p "$R/bin.2.337.0" "$R/_diag"
# A script, not a copy of /bin/sleep: macOS kills a renamed copy of a system
# binary on launch.
printf '#!/bin/bash\nsleep "$1"\n' > "$R/bin.2.337.0/Runner.Worker"
chmod +x "$R/bin.2.337.0/Runner.Worker"
"$R/bin.2.337.0/Runner.Worker" 300 >/dev/null 2>&1 &
WPID=$!
touch -t 202610070000 "$R/_diag/Worker_20261007-000000-utc.log"
touch "$R/_diag/Worker_20261007-112532-utc.log"
FOUND="$(FLEET_ROOT="$ROOT" bash -c '
  ROOT="$FLEET_ROOT"; . "'"$HOOKS"'/common.sh"
  ADMIT_WAIT_OWNER_KIND=worker ADMIT_WAIT_OWNER_PID='"$WPID"'
  admit_resolve_worker_log && echo "$ADMIT_WORKER_LOG"; trap - EXIT')"
ok "newest worker log of that runner" "$FOUND" "$R/_diag/Worker_20261007-112532-utc.log"
NONE="$(FLEET_ROOT="$ROOT" bash -c '
  ROOT="$FLEET_ROOT"; . "'"$HOOKS"'/common.sh"
  ADMIT_WAIT_OWNER_KIND=fallback ADMIT_WAIT_OWNER_PID='"$WPID"'
  admit_resolve_worker_log && echo found || echo none; trap - EXIT')"
ok "no worker, no log" "$NONE" "none"
kill "$WPID" 2>/dev/null

echo "== a dead head of the line does not stall the jobs behind it =="
setup enforce 1 30 1
sleep 300 >/dev/null 2>&1 &
GONE=$!
kill "$GONE" 2>/dev/null
wait "$GONE" 2>/dev/null
fake_waiter ghost "$GONE"
start alive
ok "job behind a dead head admitted" "$(events admitted)" "1"
# The hook's own count of time spent in the wait loop, so startup is excluded.
WAITED_S="$(event_num admitted waited_s)"
ok "job behind a dead head got in promptly" \
  "$([ "${WAITED_S:-999}" -le "$PROMPT_S" ] && echo prompt || echo "slow (${WAITED_S:-none}s)")" "prompt"

echo "== a job behind a live head does not take the mutex every poll =="
setup enforce 1 30 1
LIVE=$(fake_slot occupied)
sleep 300 >/dev/null 2>&1 &
HEAD=$!
fake_waiter head "$HEAD"
# Counts every attempt to create the mutex directory; bash has no builtin mkdir.
cat > "$BIN/mkdir" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do [ "\${a##*/}" = mutex ] && echo x >> "$ROOT/mutex-attempts"; done
exec /bin/mkdir "\$@"
EOF
chmod +x "$BIN/mkdir"
start_bg behind
wait_for "1" "events held" 10
: > "$ROOT/mutex-attempts"
sleep 5
ok "waiter behind a live head skipped the mutex" \
  "$(wc -l < "$ROOT/mutex-attempts" | tr -d ' ')" "0"
kill "$HEAD" 2>/dev/null
wait "$HEAD" 2>/dev/null
kill "$LIVE" 2>/dev/null
wait_for "1" "events admitted" 10
ok "it is admitted once the head is gone and a slot frees" "$(events admitted)" "1"
end_jobs

# ---------------------------------------------------------------------------
# Lanes (FLEET_ADMIT_LANES). Runners named h-* run heavy jobs and l-* light
# ones, by pattern, unless a case says otherwise.
# ---------------------------------------------------------------------------
lanes_setup() {
  # $1 = FLEET_ADMIT_LANES, $2 = total (FLEET_ADMIT_MAX_CONCURRENT),
  # $3 = heavy limit, $4 = light limit
  setup enforce "$2" 30 1
  {
    echo "FLEET_ADMIT_LANES=$1"
    echo "FLEET_ADMIT_HEAVY_MAX_CONCURRENT=$3"
    echo "FLEET_ADMIT_LIGHT_MAX_CONCURRENT=$4"
    echo 'FLEET_ADMIT_HEAVY_PATTERNS="acme/h-*:*"'
    echo 'FLEET_ADMIT_LIGHT_PATTERNS="l-*:build"'
  } >> "$ROOT/fleet.env"
}
# The newest log line for a runner and event.
row() { grep "\"event\":\"$2\"" "$LOG" | grep "\"runner\":\"$1\"" | tail -1; }
# Matching lines in a file that may not exist (grep -c then prints nothing).
count_in() {
  local n
  n="$(grep -c "$1" "$2" 2>/dev/null)"
  printf '%s' "${n:-0}"
}
# A field of one log line: a string's text, or a bare number/true/false/null.
field() {
  case "$1" in
    *"\"$2\":\""*) printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" ;;
    *) printf '%s' "$1" | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" ;;
  esac
}

# Classifies the job of runner $1 with the case's fleet.env plus extra
# assignments in $2, and prints lane/source.
classify() {
  FLEET_ROOT="$ROOT" RUNNER_NAME="$1" GITHUB_REPOSITORY="acme/$1" GITHUB_JOB="${3:-build}" \
    PATH="$BIN:$PATH" FAKE_CURL_LOG="$ROOT/curl-calls" bash -c '
    ROOT="$FLEET_ROOT"; '"${2:-:}"'
    . "'"$HOOKS"'/common.sh"
    admit_classify; echo "$ADMIT_LANE/$ADMIT_LANE_SOURCE"; trap - EXIT'
}

echo "== lanes off: no lane logic, the log line is unchanged =="
setup enforce 2 4 1
cat > "$BIN/curl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$ROOT/curl-calls"
exit 7
EOF
chmod +x "$BIN/curl"
echo 'FLEET_ADMIT_HEAVY_PATTERNS="*:*"' >> "$ROOT/fleet.env"
start alpha
ok "admitted" "$(events admitted)" "1"
ok "no lane fields" "$(grep -c '"lane"' "$LOG")" "0"
ok "nobody asked the daemon for a class" "$(count_in job-class "$ROOT/curl-calls")" "0"
ok "nothing is classified" "$(classify alpha)" "/"

echo "== classification: Simulator runner, patterns, history, fallback =="
setup enforce 4 4 1
{
  echo 'FLEET_ADMIT_LANES=enforce'
  echo 'FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT=1'
  echo 'FLEET_SIMULATOR_RUNNERS=*-ios'
  echo 'FLEET_ADMIT_HEAVY_PATTERNS="acme/h-*:* *:e2e"'
  echo 'FLEET_ADMIT_LIGHT_PATTERNS="l-one:build,acme/h-x:lint"'
  echo 'FLEET_ADMIT_CLASS_URL=http://fleet.test/api/job-class'
} >> "$ROOT/fleet.env"
# The daemon: words is light, test is heavy, new has too few runs to say.
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_CURL_LOG"
case "$*" in
  *fleet.test/api/job-class*job=words*) printf '{"class":"light","p50Ms":12000,"n":40}' ;;
  *fleet.test/api/job-class*job=test*) printf '{"class":"heavy","p50Ms":533000,"n":59}' ;;
  *fleet.test/api/job-class*job=new*) printf '{"class":"unknown","p50Ms":null,"n":2}' ;;
  *) exit 7 ;;
esac
EOF
chmod +x "$BIN/curl"
ok "a Simulator runner is the simulator lane" "$(classify app-ios)" "simulator/runner"
ok "a heavy pattern with the owner" "$(classify h-api)" "heavy/pattern"
ok "a heavy pattern on the job alone" "$(classify web '' e2e)" "heavy/pattern"
ok "a light pattern without the owner" "$(classify l-one)" "light/pattern"
ok "heavy patterns win over light ones" "$(classify h-x '' lint)" "heavy/pattern"
ok "the daemon's history says light" "$(classify docs-site '' words)" "light/history"
ok "the daemon's history says heavy" "$(classify mobile '' test)" "heavy/history"
ok "too few runs to say is heavy" "$(classify fresh '' new)" "heavy/unknown"
ok "an unreachable daemon is heavy" "$(classify other '' gone)" "heavy/fallback"
: > "$ROOT/curl-calls"
ok "the answer is cached" "$(classify docs-site '' words)" "light/history"
ok "...so the daemon was not asked again" "$(grep -c 'job=words' "$ROOT/curl-calls")" "0"

echo "== an empty FLEET_ADMIT_STATUS_URL means no daemon to ask for a class =="
setup enforce 4 4 1
echo 'FLEET_ADMIT_LANES=enforce' >> "$ROOT/fleet.env"
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_CURL_LOG"
printf '{"class":"light","p50Ms":1000,"n":40}'
EOF
chmod +x "$BIN/curl"
ok "heavy, as a fallback" "$(classify docs-site '' words)" "heavy/fallback"
ok "curl was not called" "$(count_in job-class "$ROOT/curl-calls")" "0"

echo "== lanes enforce: the heavy limit holds a heavy job and names the lane =="
lanes_setup enforce 10 2 5
start_bg h-1
start_bg h-2
wait_for "2" "events admitted" 10
start_bg h-3
wait_for "1" "events held" 10
ok "third heavy job held" "$(events held)" "1"
ok "the reason names the heavy lane" \
  "$(field "$(row h-3 held)" reason)" "2 heavy job(s) already running, at the heavy limit of 2"
ok "the held row carries its lane" "$(field "$(row h-3 held)" lane)" "heavy"
ok "...and the lane counts" "$(field "$(row h-3 held)" heavy_busy)" "2"
ok "the decided limit is the total" "$(field "$(row h-3 held)" limit)" "10"

echo "== lanes enforce: a light job passes an older heavy waiter =="
BEFORE=$(date +%s)
start l-1
AFTER=$(date +%s)
ok "light job admitted" "$(field "$(row l-1 admitted)" lane)" "light"
ok "...at once" "$([ $((AFTER - BEFORE)) -le 3 ] && echo prompt || echo slow)" "prompt"
ok "the heavy waiter still waits" "$(events admitted)" "3"
complete h-1
wait_for "4" "events admitted" 15
ok "the heavy waiter took the freed heavy slot" "$(field "$(row h-3 admitted)" lane)" "heavy"
ok "a release carries the lane it freed" "$(field "$(row h-1 released)" lane)" "heavy"
end_jobs

echo "== lanes enforce: the light limit, and FIFO within a lane =="
lanes_setup enforce 10 2 1
start_bg l-1
wait_for "1" "events admitted" 10
start_bg l-2
sleep 1
start_bg l-3
wait_for "2" "events held" 10
ok "light limit reason" "$(field "$(row l-2 held)" reason)" "1 light job(s) already running, at the light limit of 1"
start h-1
ok "a heavy job is not held by the light line" "$(field "$(row h-1 admitted)" lane)" "heavy"
complete l-1
wait_for "3" "events admitted" 15
ok "the oldest light waiter went first" \
  "$(grep '"event":"admitted"' "$LOG" | grep '"lane":"light"' | tail -1 | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p')" "l-2"
end_jobs

echo "== lanes enforce: the total cap still applies =="
lanes_setup enforce 2 5 5
start_bg h-1
start_bg l-1
wait_for "2" "events admitted" 10
start_bg l-2
wait_for "1" "events held" 10
ok "held at the total, in the old words" "$(field "$(row l-2 held)" reason)" "2 job(s) already running, at the limit of 2"
end_jobs

echo "== lanes enforce: a Simulator job counts as heavy =="
lanes_setup enforce 10 1 5
{
  echo 'FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT=2'
  echo 'FLEET_SIMULATOR_RUNNERS=*-ios'
} >> "$ROOT/fleet.env"
start_bg a-ios
wait_for "1" "events admitted" 10
ok "the Simulator job's lane" "$(field "$(row a-ios admitted)" lane)" "simulator"
start_bg h-1
wait_for "1" "events held" 10
ok "a heavy job waits for the Simulator job's heavy slot" \
  "$(field "$(row h-1 held)" reason)" "1 heavy job(s) already running, at the heavy limit of 1"
end_jobs

echo "== lanes enforce: unknown jobs fall back to heavy =="
lanes_setup enforce 10 1 5
echo 'FLEET_ADMIT_HEAVY_PATTERNS=' >> "$ROOT/fleet.env"
start_bg x-1
wait_for "1" "events admitted" 10
start_bg x-2
wait_for "1" "events held" 10
ok "an unclassified job is heavy" "$(field "$(row x-2 held)" lane)" "heavy"
ok "...and says why" "$(field "$(row x-2 held)" lane_source)" "fallback"
end_jobs

echo "== legacy alias: FLEET_ADMIT_SHORT_MAX_CONCURRENT is the light limit =="
setup enforce 10 30 1
{
  echo 'FLEET_ADMIT_LANES=enforce'
  echo 'FLEET_ADMIT_SHORT_MAX_CONCURRENT=1'
  echo 'FLEET_ADMIT_LIGHT_PATTERNS="*:*"'
} >> "$ROOT/fleet.env"
start_bg l-1
wait_for "1" "events admitted" 10
start_bg l-2
wait_for "1" "events held" 10
ok "short max reads as the light limit" "$(field "$(row l-2 held)" light_limit)" "1"
ok "...and holds" "$(field "$(row l-2 held)" reason)" "1 light job(s) already running, at the light limit of 1"
echo 'FLEET_ADMIT_LIGHT_MAX_CONCURRENT=3' >> "$ROOT/fleet.env"
start l-3
ok "the new name wins over the alias" "$(field "$(row l-3 admitted)" light_limit)" "3"
end_jobs

echo "== lanes observe: the single lane decides, the lanes are recorded =="
# Single lane: 1 at a time. Lanes: 1 heavy, 3 light, 5 in all.
setup enforce 1 30 1
{
  echo 'FLEET_ADMIT_LANES=observe'
  echo 'FLEET_ADMIT_TOTAL_MAX_CONCURRENT=5'
  echo 'FLEET_ADMIT_HEAVY_MAX_CONCURRENT=1'
  echo 'FLEET_ADMIT_LIGHT_MAX_CONCURRENT=3'
  echo 'FLEET_ADMIT_HEAVY_PATTERNS="h-*:*"'
  echo 'FLEET_ADMIT_LIGHT_PATTERNS="l-*:*"'
} >> "$ROOT/fleet.env"
start_bg h-1
wait_for "1" "events admitted" 10
ok "the lanes would have admitted it too" "$(field "$(row h-1 admitted)" lane_would_hold)" "false"
start_bg l-1
wait_for "1" "events held" 10
ok "the single lane held the light job" "$(field "$(row l-1 held)" reason)" "1 job(s) already running, at the limit of 1"
ok "...where the lanes would not have" "$(field "$(row l-1 held)" lane_would_hold)" "false"
ok "...from the start of the wait" "$(field "$(row l-1 held)" lane_wait_s)" "0"
ok "the row says which policy decided" "$(field "$(row l-1 held)" lanes)" "observe"
ok "the single lane's limit is the one reported" "$(field "$(row l-1 held)" limit)" "1"
start_bg h-2
wait_for "2" "events held" 10
ok "the lanes would have held a second heavy job" "$(field "$(row h-2 held)" lane_would_hold)" "true"
ok "...for the heavy limit" "$(field "$(row h-2 held)" lane_reason)" "1 heavy job(s) already running, at the heavy limit of 1"
complete h-1
wait_for "2" "events admitted" 15
ok "the single lane admitted its oldest waiter" \
  "$(grep '"event":"admitted"' "$LOG" | tail -1 | sed -n 's/.*"runner":"\([^"]*\)".*/\1/p')" "l-1"
ok "it waited under the single lane" \
  "$([ "$(field "$(row l-1 admitted)" waited_s)" -ge 1 ] && echo waited || echo instant)" "waited"
ok "the lanes would have let it in at once" "$(field "$(row l-1 admitted)" lane_wait_s)" "0"
end_jobs

echo "== lanes observe with admission observe: would-hold carries the lane view =="
setup observe 5
{
  echo 'FLEET_ADMIT_LANES=enforce'
  echo 'FLEET_ADMIT_HEAVY_MAX_CONCURRENT=1'
  echo 'FLEET_ADMIT_HEAVY_PATTERNS="*:*"'
} >> "$ROOT/fleet.env"
start alpha; start beta
ok "the lanes' heavy limit is what would have held" \
  "$(field "$(row beta would-hold)" reason)" "1 heavy job(s) already running, at the heavy limit of 1"

echo "== the lockless check, per lane =="
setup enforce 1 30 1
echo 'FLEET_ADMIT_LANES=enforce' >> "$ROOT/fleet.env"
W="$ROOT/.admission/waiters"
mkdir -p "$W"
behind_lane() {
  # $1 = this waiter's file name, $2 = its lane
  FLEET_ROOT="$ROOT" bash -c '
    ROOT="$FLEET_ROOT"; set -a; . "$ROOT/fleet.env"; set +a
    . "'"$HOOKS"'/common.sh"
    ADMIT_LANE='"$2"'
    ADMIT_WAITER="$ADMIT_WAITERS/'"$1"'"
    admit_waiting_behind_older_in_lane && echo behind || echo decide
    trap - EXIT'
}
sleep 300 >/dev/null 2>&1 &
HEAD_PID=$!
printf 'pid=%s\nrunner=h-1\nlane=heavy\n' "$HEAD_PID" > "$W/00000000000000000001-0000000001-heavy-h-1"
printf 'pid=%s\nrunner=l-1\nlane=light\n' "$$" > "$W/00000000000000000002-0000000002-light-l-1"
printf 'pid=%s\nrunner=h-2\nlane=heavy\n' "$$" > "$W/00000000000000000003-0000000003-heavy-h-2"
printf 'pid=%s\nrunner=l-2\nlane=light\n' "$$" > "$W/00000000000000000004-0000000004-light-l-2"
ok "a light waiter is not behind an older heavy one" \
  "$(behind_lane 00000000000000000002-0000000002-light-l-1 light)" "decide"
ok "a heavy waiter is behind the older heavy one" \
  "$(behind_lane 00000000000000000003-0000000003-heavy-h-2 heavy)" "behind"
ok "a light waiter is behind the older light one" \
  "$(behind_lane 00000000000000000004-0000000004-light-l-2 light)" "behind"
printf 'pid=%s\nrunner=old\n' "$HEAD_PID" > "$W/00000000000000000000-0000000000-old-runner"
ok "a waiter from before lanes counts as heavy" \
  "$(behind_lane 00000000000000000002-0000000002-light-l-1 light)" "decide"
ok "...and is ahead of the heavy ones" \
  "$(behind_lane 00000000000000000001-0000000001-heavy-h-1 heavy)" "behind"
kill "$HEAD_PID" 2>/dev/null
wait "$HEAD_PID" 2>/dev/null

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
