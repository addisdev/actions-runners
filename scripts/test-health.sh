#!/usr/bin/env bash
# Shell tests for health.sh: what counts as an unhealthy runner.
#
#   scripts/test-health.sh
#
# Builds a fake fleet in a temporary directory and puts stub `gh`, `launchctl`
# and `plutil` first on PATH, then runs the real health.sh against it. The stubs
# answer from files the test writes, so each case says exactly what GitHub and
# launchd would have said.
#
# WHY THIS EXISTS
#
# On 2026-10-08 the health job had been red on and off for days with every
# runner online. GitHub's runner API had failed to answer for a moment, and
# health.sh read "no answer" as "this runner is unhealthy" — 60 runners at once.
# Not being able to ask is not a fault in the runner; a runner GitHub no longer
# lists is.
#
# Nothing here touches the live fleet: FLEET_ROOT points at the temp directory.
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
FLEET="$TMP/fleet"
STUB="$TMP/stub"
BIN="$TMP/bin"
mkdir -p "$FLEET" "$STUB" "$BIN"

# plutil -extract <key> raw -o - <file>: read a key from the runner's JSON.
cat > "$BIN/plutil" <<'PY'
#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
key, path = a[a.index("-extract") + 1], a[-1]
try:
    d = json.loads(open(path, encoding="utf-8-sig").read())
    print(d[key], end="")
except Exception:
    sys.exit(1)
PY
# launchctl list <label>: loaded and running unless the test says otherwise.
cat > "$BIN/launchctl" <<SH
#!/usr/bin/env bash
[ "\$1" = list ] || exit 0
[ -f "$STUB/notloaded-\$2" ] && exit 113
[ -f "$STUB/dead-\$2" ] && { echo '{ "Label" = "'"\$2"'"; };'; exit 0; }
echo '{ "Label" = "'"\$2"'"; "PID" = 4242; };'
SH
# gh api repos/<owner>/<repo>/actions/runners --jq <expr>: answer from
# stub/runners-<owner>-<repo> ("name state" lines), or fail when stub/down exists.
cat > "$BIN/gh" <<PY
#!/usr/bin/env python3
import os, re, sys
stub = "$STUB"
if os.path.exists(os.path.join(stub, "down")):
    sys.stderr.write("HTTP 502\n"); sys.exit(1)
path = sys.argv[2]
repo = path.split("/")[1] + "-" + path.split("/")[2]
want = re.search(r'select\(\.name=="([^"]+)"\)', sys.argv[sys.argv.index("--jq") + 1]).group(1)
f = os.path.join(stub, "runners-" + repo)
for line in (open(f).read().splitlines() if os.path.exists(f) else []):
    name, state = line.split()
    if name == want:
        print(state)
PY
chmod +x "$BIN"/*

make_runner() { # make_runner <dir> <owner/repo> <agent name>
  mkdir -p "$FLEET/$1"
  printf '{"agentName":"%s","gitHubUrl":"https://github.com/%s"}' "$3" "$2" > "$FLEET/$1/.runner"
  cat > "$FLEET/$1/svc.sh" <<'SVC'
#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/svc.log"
SVC
  chmod +x "$FLEET/$1/svc.sh"
}
run_health() { PATH="$BIN:$PATH" FLEET_ROOT="$FLEET" bash "$ROOT/health.sh" "$@" > "$TMP/out" 2>&1; echo $?; }

make_runner app-ios me/app-ios host-app-ios
make_runner app-web me/app-web host-app-web
printf 'host-app-ios online\n' > "$STUB/runners-me-app-ios"
printf 'host-app-web busy\n' > "$STUB/runners-me-app-web"

echo
echo "health.sh — every runner online or busy"
check "exits 0" "$(run_health)" "0"
check "shows GitHub's state" "$(grep -c 'host-app-web.*busy' "$TMP/out")" "1"

echo
echo "health.sh — GitHub does not answer"
touch "$STUB/down"
check "exits 0: not being able to ask is not a fault" "$(run_health)" "0"
check "says GitHub did not answer" "$(grep -c 'GitHub did not answer for 2 runner' "$TMP/out")" "1"
check "under --repair restarts nothing" "$(run_health --repair >/dev/null; cat "$FLEET"/*/svc.log 2>/dev/null | wc -l | tr -d ' ')" "0"
rm "$STUB/down"

echo
echo "health.sh — GitHub answers without the runner"
printf 'someone-else online\n' > "$STUB/runners-me-app-web"
check "exits 1: the registration is gone" "$(run_health)" "1"
check "names it not-registered" "$(grep -c 'host-app-web.*not-registered' "$TMP/out")" "1"
printf 'host-app-web online\n' > "$STUB/runners-me-app-web"

echo
echo "health.sh — GitHub says offline"
printf 'host-app-ios offline\n' > "$STUB/runners-me-app-ios"
check "exits 1" "$(run_health)" "1"
check "--repair restarts it" "$(run_health --repair >/dev/null; tr '\n' ',' < "$FLEET/app-ios/svc.log")" "stop,start,"
rm -f "$FLEET/app-ios/svc.log"
printf 'host-app-ios online\n' > "$STUB/runners-me-app-ios"

echo
echo "health.sh — launchd job dead while GitHub cannot be asked"
touch "$STUB/down" "$STUB/dead-actions.runner.me-app-ios.host-app-ios"
check "exits 1: launchd is still judged" "$(run_health)" "1"
check "reports it DEAD" "$(grep -c 'host-app-ios *DEAD' "$TMP/out")" "1"
rm -f "$STUB/down" "$STUB/dead-actions.runner.me-app-ios.host-app-ios"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
