#!/bin/bash
# Tests for host-sentinel.sh: announce after N failures, once; announce the
# recovery once; retry a message that could not be delivered.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export SENTINEL_ENV="$T/none.env" SENTINEL_STATE="$T/state" SENTINEL_FAILS=3 SENTINEL_NAME=build-host
export SENTINEL_NOTIFY_CMD="head -1 >> $T/sent"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3] got [$2]"; fail=1; fi; }
run() { SENTINEL_PROBE_CMD="$1" bash "$HERE/host-sentinel.sh" >/dev/null; }
sent() { [ -f "$T/sent" ] && tr '\n' '|' < "$T/sent" || echo ""; }

run true;  check "healthy sends nothing" "$(sent)" ""
run false; run false; check "two misses are not an outage" "$(sent)" ""
run false; check "the third miss announces" "$(sent)" "build-host is down|"
run false; run false; check "still down: announced once" "$(sent)" "build-host is down|"
run true;  check "recovery announced" "$(sent)" "build-host is down|build-host is back|"
run true;  check "then quiet" "$(sent)" "build-host is down|build-host is back|"

rm -f "$T/state" "$T/sent"
export SENTINEL_NOTIFY_CMD="cat >/dev/null; exit 1"
run false; run false; run false
check "undelivered: state stays up so it retries" "$(sed -n 's/^status=//p' "$T/state")" "up"
export SENTINEL_NOTIFY_CMD="head -1 >> $T/sent"
run false; check "retried on the next probe" "$(sent)" "build-host is down|"
check "state file is private" "$(stat -f %Lp "$T/state")" "600"
exit $fail
