#!/usr/bin/env bash
# Exercises shm-reap.sh with a fake ipcs/ipcrm. No real segment is touched.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/shm-hook-test/root"
BIN="$ROOT/bin"
TABLE="$ROOT/table"
REMOVED="$ROOT/removed"
LOG="$ROOT/dashboard/logs/shm.ndjson"
ME="$(id -un)"
PASS=0
FAIL=0
LIVE=""

cleanup() {
  [ -n "$LIVE" ] && kill "$LIVE" 2>/dev/null && wait "$LIVE" 2>/dev/null
  LIVE=""
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

# A PID that is certainly not running.
dead_pid() {
  local pid
  sh -c 'exit 0' &
  pid=$!
  wait "$pid" 2>/dev/null
  printf '%s' "$pid"
}

setup() {
  cleanup
  mkdir -p "$BIN" "$ROOT/dashboard/logs"
  : > "$ROOT/fleet.env"
  : > "$REMOVED"
  sleep 300 >/dev/null 2>&1 &
  LIVE=$!
  # The layout macOS prints for `ipcs -m -o -p`.
  {
    echo "IPC status from <running system> as of Mon Oct 12 23:04:47 EDT 2026"
    echo "T     ID     KEY        MODE       OWNER    GROUP NATTCH  CPID  LPID"
    echo "Shared Memory:"
  } > "$TABLE"
  cat > "$BIN/ipcs" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "-m -o -p" ] || exit 2
cat "$FAKE_SHM_TABLE"
EOF
  cat > "$BIN/ipcrm" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "-m" ] || exit 2
grep -q "^m  *$2 " "$FAKE_SHM_TABLE" || exit 1
echo "$2" >> "$FAKE_SHM_REMOVED"
awk -v id="$2" '!($1 == "m" && $2 == id)' "$FAKE_SHM_TABLE" > "$FAKE_SHM_TABLE.tmp"
mv "$FAKE_SHM_TABLE.tmp" "$FAKE_SHM_TABLE"
EOF
  chmod +x "$BIN/ipcs" "$BIN/ipcrm"
}

# segment <id> <owner> <nattch> <cpid>
segment() {
  printf 'm %6s 0x%08x --rw------- %8s    staff %6s %6s %6s\n' \
    "$1" "$1" "$2" "$3" "$4" "$4" >> "$TABLE"
}

reap() {
  FLEET_ROOT="$ROOT" FLEET_IPCS="$BIN/ipcs" FLEET_IPCRM="$BIN/ipcrm" \
    FLEET_SHM_LIMIT="${LIMIT:-32}" FAKE_SHM_TABLE="$TABLE" FAKE_SHM_REMOVED="$REMOVED" \
    RUNNER_NAME=host-repo GITHUB_REPOSITORY=acme/repo GITHUB_RUN_ID=7 \
    bash "$HOOKS/shm-reap.sh" "${1:-completed}"
}

removed() { tr '\n' ' ' < "$REMOVED" | sed 's/ $//'; }
log_lines() { if [ -f "$LOG" ]; then wc -l < "$LOG" | tr -d ' '; else echo 0; fi; }
log_field() {
  sed -n -e "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" -e "t" \
    -e "s/.*\"$1\":\([0-9-]*\).*/\1/p" "$LOG" | tail -1
}

echo "== only unattached segments of ours whose creator is gone are removed =="
setup
DEAD="$(dead_pid)"
segment 101 "$ME" 6 "$LIVE"    # the Homebrew postgres service: attached, alive
segment 102 "$ME" 0 "$DEAD"    # the orphan
segment 103 "$ME" 0 "$LIVE"    # a cluster between shmget and shmat
segment 104 "$ME" 2 "$DEAD"    # creator gone but still mapped by its children
segment 105 nobody 0 "$DEAD"   # another user's orphan is not ours to judge
segment 106 "$ME" 0 "$DEAD"
OUT="$(reap started)"
ok "exit status" "$?" "0"
ok "removed exactly the two orphans" "$(removed)" "102 106"
ok "the job log says so" \
  "$(printf '%s' "$OUT" | grep -c 'removed 2 orphaned')" "1"
ok "one log line" "$(log_lines)" "1"
ok "logged the count" "$(log_field reaped)" "2"
ok "logged the event" "$(log_field event)" "reaped"
ok "logged the phase" "$(log_field phase)" "started"
ok "logged the ids" "$(log_field ids)" "102,106"
ok "logged the table use after reaping" "$(log_field used)" "4"

echo "== a clean table is silent =="
setup
segment 101 "$ME" 6 "$LIVE"
OUT="$(reap)"
ok "nothing removed" "$(removed)" ""
ok "nothing logged" "$(log_lines)" "0"
ok "nothing printed" "$OUT" ""

echo "== a nearly full table is logged even when nothing can be removed =="
setup
LIMIT=4
segment 101 "$ME" 6 "$LIVE"
segment 102 "$ME" 1 "$LIVE"
segment 103 "$ME" 1 "$LIVE"
OUT="$(reap)"
LIMIT=""
ok "nothing removed" "$(removed)" ""
ok "logged as low" "$(log_field event)" "low"
ok "with the limit" "$(log_field limit)" "4"
ok "the job log warns" "$(printf '%s' "$OUT" | grep -c 'only 1 of 4')" "1"

echo "== an unreadable header removes nothing =="
setup
DEAD="$(dead_pid)"
segment 102 "$ME" 0 "$DEAD"
sed -i '' -e 's/NATTCH/ATTACH/' "$TABLE" 2>/dev/null || sed -i -e 's/NATTCH/ATTACH/' "$TABLE"
reap >/dev/null
ok "nothing removed" "$(removed)" ""

echo "== a failing ipcs or ipcrm never fails the hook =="
setup
DEAD="$(dead_pid)"
segment 102 "$ME" 0 "$DEAD"
printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/ipcrm"
reap >/dev/null
ok "ipcrm failure exits 0" "$?" "0"
ok "and logs nothing it did not do" "$(log_lines)" "0"
printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/ipcs"
reap >/dev/null
ok "ipcs failure exits 0" "$?" "0"

echo "== FLEET_SHM_REAP=0 turns it off =="
setup
DEAD="$(dead_pid)"
segment 102 "$ME" 0 "$DEAD"
echo "FLEET_SHM_REAP=0" > "$ROOT/fleet.env"
reap >/dev/null
ok "nothing removed" "$(removed)" ""

echo "== both job hooks run the sweep =="
for hook in job-started.sh job-completed.sh; do
  ok "$hook calls shm-reap.sh" \
    "$(grep -c 'shm-reap.sh' "$HOOKS/$hook")" "1"
done

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
