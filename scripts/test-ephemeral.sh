#!/usr/bin/env bash
# Shell tests for the ephemeral runner reaper.
#
#   scripts/test-ephemeral.sh
#
# The reaper deletes directories, so the tests that matter are the ones proving
# it REFUSES to. Everything here runs against a temporary FLEET_ROOT; nothing
# touches the real fleet.
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
mkdir -p "$TMP/.ephemeral"

# An abandoned directory: old enough to reap, nothing running in it, and no
# .runner so the reaper does not try to call gh.
make_old() {
  local d="$TMP/.ephemeral/$1"
  mkdir -p "$d/_work"
  echo "junk" > "$d/_work/file"
  # Backdated well past the default minimum age.
  touch -t "$(date -v-6H +%Y%m%d%H%M 2>/dev/null || date -d '6 hours ago' +%Y%m%d%H%M)" "$d"
}

make_new() {
  local d="$TMP/.ephemeral/$1"
  mkdir -p "$d/_work"
}

echo
echo "reap-ephemeral.sh — dry run does not delete"
make_old abandoned-1
FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" >/dev/null 2>&1
check "leaves the directory in place" "$([ -d "$TMP/.ephemeral/abandoned-1" ] && echo yes || echo no)" "yes"

echo
echo "reap-ephemeral.sh — names the candidate"
OUT="$(FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" 2>&1)"
case "$OUT" in *"abandoned-1: remove"*) ok "reports it would remove the directory" ;; *) bad "reports it would remove the directory (got: $OUT)" ;; esac
case "$OUT" in *"dry run"*) ok "says it was a dry run" ;; *) bad "says it was a dry run" ;; esac

echo
echo "reap-ephemeral.sh — --apply removes an abandoned directory"
FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" --apply >/dev/null 2>&1
check "removes it" "$([ -d "$TMP/.ephemeral/abandoned-1" ] && echo yes || echo no)" "no"

echo
echo "reap-ephemeral.sh — a young directory is left alone"
make_new fresh-1
FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" --apply >/dev/null 2>&1
check "keeps a directory younger than the minimum age" "$([ -d "$TMP/.ephemeral/fresh-1" ] && echo yes || echo no)" "yes"

echo
echo "reap-ephemeral.sh — a directory with a live process is left alone"
make_old busy-1
# A process whose command line contains the directory path, which is what the
# reaper's pgrep looks for. This is the check that makes the script safe to run
# on a timer during a 40-minute build.
(
  exec -a "$TMP/.ephemeral/busy-1/bin/Runner.Worker fake" sleep 25
) &
BUSY_PID=$!
sleep 0.5
OUT="$(FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" --apply 2>&1)"
check "keeps a directory with a running process" "$([ -d "$TMP/.ephemeral/busy-1" ] && echo yes || echo no)" "yes"
case "$OUT" in *"still running"*) ok "says why it was skipped" ;; *) bad "says why it was skipped (got: $OUT)" ;; esac
kill "$BUSY_PID" 2>/dev/null
wait "$BUSY_PID" 2>/dev/null

echo
echo "reap-ephemeral.sh — once the process is gone it becomes reapable"
sleep 0.5
FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" --apply >/dev/null 2>&1
check "removes it after the process exits" "$([ -d "$TMP/.ephemeral/busy-1" ] && echo yes || echo no)" "no"

echo
echo "reap-ephemeral.sh — --min-age-hours is honoured"
make_old aged-1
OUT="$(FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" --min-age-hours 99 2>&1)"
case "$OUT" in *"aged-1: SKIP"*) ok "a high minimum age protects an old directory" ;; *) bad "a high minimum age protects an old directory (got: $OUT)" ;; esac
check "and it is still there" "$([ -d "$TMP/.ephemeral/aged-1" ] && echo yes || echo no)" "yes"

echo
echo "reap-ephemeral.sh — rejects a bad --min-age-hours"
if FLEET_ROOT="$TMP" "$ROOT/scripts/reap-ephemeral.sh" --min-age-hours abc >/dev/null 2>&1; then
  bad "rejects a non-numeric age"
else
  ok "rejects a non-numeric age"
fi

echo
echo "reap-ephemeral.sh — an empty fleet is not an error"
EMPTY="$(mktemp -d)"
if FLEET_ROOT="$EMPTY" "$ROOT/scripts/reap-ephemeral.sh" >/dev/null 2>&1; then
  ok "exits cleanly with no .ephemeral directory"
else
  bad "exits cleanly with no .ephemeral directory"
fi
rm -rf "$EMPTY"

echo
echo "ephemeral-runner.sh — dry run by default"
OUT="$(FLEET_ROOT="$ROOT" "$ROOT/scripts/ephemeral-runner.sh" testowner/some-repo 2>&1)"
case "$OUT" in *"dry run"*) ok "does not create anything without --apply" ;; *) bad "does not create anything without --apply" ;; esac
check "created no .ephemeral directory" "$([ -d "$ROOT/.ephemeral" ] && echo yes || echo no)" "no"

echo
echo "ephemeral-runner.sh — rejects a malformed repo"
if FLEET_ROOT="$ROOT" "$ROOT/scripts/ephemeral-runner.sh" not-a-repo >/dev/null 2>&1; then
  bad "rejects a repo without owner/name"
else
  ok "rejects a repo without owner/name"
fi

echo
echo "-----------------------------------------"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
