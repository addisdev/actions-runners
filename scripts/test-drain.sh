#!/usr/bin/env bash
# Shell tests for drain, resume, and unsafe-path handling.
#
#   scripts/test-drain.sh
#
# Builds a fake fleet in a temporary directory — real .runner files, a stub
# svc.sh that records what it was asked to do instead of talking to launchd —
# and drives the real scripts against it.
#
# WHY A STUB svc.sh RATHER THAN A MOCK LAYER
#
# The thing worth testing is that drain-runner.sh calls stop at the right moment
# and does not call it at the wrong one. A stub that appends to a log file
# answers that question exactly, and it does it against the real script rather
# than a copy of its logic, so the test cannot pass while the shipped script is
# broken.
#
# Nothing here touches the live fleet: FLEET_ROOT points at the temp directory
# and every runner in it is fake.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok — $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A fake runner directory: a valid .runner and a stub svc.sh that logs its argv.
make_runner() {
  local dir="$TMP/$1" repo="$2" agent="$3"
  mkdir -p "$dir"
  cat > "$dir/.runner" <<JSON
{"agentName":"$agent","gitHubUrl":"https://github.com/$repo","workFolder":"_work"}
JSON
  cat > "$dir/svc.sh" <<'SVC'
#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/svc.log"
exit 0
SVC
  chmod +x "$dir/svc.sh"
}

svc_log() { cat "$TMP/$1/svc.log" 2>/dev/null | tr '\n' ',' ; }

echo
echo "drain-runner.sh — an idle runner"
make_runner app-ios testowner/app-ios host-app-ios
FLEET_ROOT="$TMP" "$ROOT/scripts/drain-runner.sh" app-ios --drain >/dev/null 2>&1
check "writes a drain marker" "$([ -f "$TMP/app-ios/.drain" ] && echo yes || echo no)" "yes"
check "marks it drained, not draining" "$(head -1 "$TMP/app-ios/.drain")" "drained"
check "stops the service immediately" "$(svc_log app-ios)" "stop,"
check "writes no drain-stop flag" "$([ -f "$TMP/app-ios/.drain-stop" ] && echo yes || echo no)" "no"

echo
echo "drain-runner.sh — reporting state"
STATE="$(FLEET_ROOT="$TMP" "$ROOT/scripts/drain-runner.sh" app-ios 2>&1 | head -1)"
check "reports the drained state" "$STATE" "drained"

echo
echo "drain-runner.sh — resume"
FLEET_ROOT="$TMP" "$ROOT/scripts/drain-runner.sh" app-ios --resume >/dev/null 2>&1
check "removes the drain marker" "$([ -f "$TMP/app-ios/.drain" ] && echo yes || echo no)" "no"
check "starts the service" "$(svc_log app-ios)" "stop,start,"

echo
echo "drain-runner.sh — a runner with no drain marker"
make_runner app-web testowner/app-web host-app-web
OUT="$(FLEET_ROOT="$TMP" "$ROOT/scripts/drain-runner.sh" app-web 2>&1)"
case "$OUT" in *"not draining"*) ok "reports it is not draining" ;; *) bad "reports it is not draining (got: $OUT)" ;; esac
check "touches nothing" "$(svc_log app-web)" ""

echo
echo "drain-runner.sh — unsafe paths are refused"
for bad_arg in "../escape" "a/b" ".." "."; do
  if FLEET_ROOT="$TMP" "$ROOT/scripts/drain-runner.sh" "$bad_arg" --drain >/dev/null 2>&1; then
    bad "refuses '$bad_arg'"
  else
    ok "refuses '$bad_arg'"
  fi
done

echo
echo "drain-runner.sh — a directory that is not a runner"
mkdir -p "$TMP/not-a-runner"
if FLEET_ROOT="$TMP" "$ROOT/scripts/drain-runner.sh" not-a-runner --drain >/dev/null 2>&1; then
  bad "refuses a directory with no .runner"
else
  ok "refuses a directory with no .runner"
fi

echo
echo "drain-stop-when-idle.sh — a resume cancels an in-flight stop"
make_runner app-api testowner/app-api host-app-api
# No .drain-stop flag: the drain was cancelled before this ran.
"$ROOT/scripts/drain-stop-when-idle.sh" "$TMP/app-api" 4 >/dev/null 2>&1
check "does not stop a runner whose drain was cancelled" "$(svc_log app-api)" ""

echo
echo "drain-stop-when-idle.sh — stops an idle runner that is flagged"
make_runner app-cli testowner/app-cli host-app-cli
touch "$TMP/app-cli/.drain-stop"
"$ROOT/scripts/drain-stop-when-idle.sh" "$TMP/app-cli" 10 >/dev/null 2>&1
check "stops the service" "$(svc_log app-cli)" "stop,"
check "clears the drain-stop flag" "$([ -f "$TMP/app-cli/.drain-stop" ] && echo yes || echo no)" "no"
check "leaves a drained marker" "$(head -1 "$TMP/app-cli/.drain" 2>/dev/null)" "drained"

echo
echo "drain-stop-when-idle.sh — gives up rather than waiting forever"
make_runner app-busy testowner/app-busy host-app-busy
mkdir -p "$TMP/app-busy/bin"
touch "$TMP/app-busy/.drain-stop"
# A process whose command line contains the worker path, so the pgrep in the
# script sees the runner as busy for as long as it lives.
sleep 30 &
SLEEP_PID=$!
# The real check is the timeout: with a genuinely busy runner this must return
# without stopping the service. Bounded to 4s so the test is quick.
(
  exec -a "$TMP/app-busy/bin/Runner.Worker fake" sleep 20
) &
FAKE_PID=$!
sleep 0.5
timeout 20 "$ROOT/scripts/drain-stop-when-idle.sh" "$TMP/app-busy" 4 >/dev/null 2>&1
check "does not stop a busy runner" "$(svc_log app-busy)" ""
check "leaves the flag for the next attempt" "$([ -f "$TMP/app-busy/.drain-stop" ] && echo yes || echo no)" "yes"
kill "$FAKE_PID" "$SLEEP_PID" 2>/dev/null
wait "$FAKE_PID" "$SLEEP_PID" 2>/dev/null

echo
echo "health.sh — a drained runner is not a fault"
HEALTH_TMP="$(mktemp -d)"
make_health_runner() {
  local dir="$HEALTH_TMP/$1"
  mkdir -p "$dir"
  cat > "$dir/.runner" <<JSON
{"agentName":"$3","gitHubUrl":"https://github.com/$2","workFolder":"_work"}
JSON
  cat > "$dir/svc.sh" <<'SVC'
#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/svc.log"
exit 0
SVC
  chmod +x "$dir/svc.sh"
}
make_health_runner drained-one testowner/drained-one host-drained-one
printf 'drained\n' > "$HEALTH_TMP/drained-one/.drain"
# health.sh calls gh, which will fail in a temp fleet — that is fine, the
# assertion is about the drained runner being skipped before any of that.
OUT="$(FLEET_ROOT="$HEALTH_TMP" "$ROOT/health.sh" 2>&1)"
case "$OUT" in *"skipped — drained"*) ok "skips the drained runner" ;; *) bad "skips the drained runner (got: $OUT)" ;; esac
check "does not restart it" "$(cat "$HEALTH_TMP/drained-one/svc.log" 2>/dev/null | tr '\n' ',')" ""
OUT="$(FLEET_ROOT="$HEALTH_TMP" "$ROOT/health.sh" --repair 2>&1)"
check "--repair does not revive it either" "$(cat "$HEALTH_TMP/drained-one/svc.log" 2>/dev/null | tr '\n' ',')" ""
rm -rf "$HEALTH_TMP"

echo
echo "-----------------------------------------"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
