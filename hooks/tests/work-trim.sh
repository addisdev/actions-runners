#!/usr/bin/env bash
# Exercises hooks/work-trim.sh, as the job-completed hook runs it, against a
# throwaway fleet root with a real git checkout. Disk pressure is set with
# FLEET_CLEANUP_PRESSURE_GB (0: never under it, huge: always); nothing outside
# the temp folder is read or removed.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${TMPDIR:-/tmp}/work-trim-test"
PASS=0
FAIL=0

cleanup() { chmod -R u+w "$BASE" 2>/dev/null; rm -rf "$BASE"; }
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

there() { if [ -e "$1" ] || [ -L "$1" ]; then echo kept; else echo removed; fi; }

ago() {
  local s=$(( $(date +%s) - $1 * 60 ))
  date -r "$s" +%Y%m%d%H%M 2>/dev/null || date -d "@$s" +%Y%m%d%H%M
}

# A fleet root with the hooks, one runner (homelake-3) whose workspace looks
# like ultra's after an iOS job: a checkout with ignored output, and beside it
# DerivedData, venvs and a native build tree.
setup() {
  cleanup
  R="$BASE/root"
  mkdir -p "$R/hooks" "$R/homelake-3" "$BASE/outside"
  cp "$HOOKS/job-completed.sh" "$HOOKS/work-trim.sh" "$HOOKS/free-disk.sh" "$R/hooks/"
  echo 'FLEET_ADMIT_MODE=off' > "$R/fleet.env"
  echo '{"agentName":"ultra-homelake-3"}' > "$R/homelake-3/.runner"
  WS="$R/homelake-3/_work/homelake"
  CO="$WS/homelake"
  mkdir -p "$CO" "$R/homelake-3/_work/_temp/keep" "$R/homelake-3/_work/_tool/node"
  git -C "$CO" init -q
  printf 'build/\nnode_modules/\ntest-results/\n' > "$CO/.gitignore"
  echo src > "$CO/main.swift"
  git -C "$CO" add -A && git -C "$CO" -c user.email=t@t -c user.name=t commit -qm init
  mkdir -p "$CO/homelake-android/app/build/intermediates" "$CO/node_modules/left-pad" "$CO/test-results"
  echo o > "$CO/homelake-android/app/build/intermediates/a.dex"
  echo js > "$CO/node_modules/left-pad/index.js"
  mkdir -p "$WS/DerivedData-HomelakeCompanion-iOS/Build" "$WS/venvs/ci" "$WS/duckdb-native-work/build-android"
  echo x > "$WS/DerivedData-HomelakeCompanion-iOS/Build/obj"
  echo x > "$WS/venvs/ci/python"
  echo x > "$WS/duckdb-native-work/build-android/libduckdb.a"
  # The native tree was last built nine days ago.
  touch -t "$(ago 12960)" "$WS/duckdb-native-work/build-android/libduckdb.a" \
    "$WS/duckdb-native-work/build-android" "$WS/duckdb-native-work"
  # A fixture repo checked out beside the main one (taylab-launch-kit's
  # fixture-contract) is a checkout, not a cache.
  mkdir -p "$WS/fixture-repo/.git"
  touch -t "$(ago 12960)" "$WS/fixture-repo"
  echo keep > "$BASE/outside/precious.txt"
  ln -s "$BASE/outside" "$WS/link-out"
  touch -h -t "$(ago 12960)" "$WS/link-out" 2>/dev/null || true
  export FLEET_ROOT="$R"
  export RUNNER_WORKSPACE="$WS"
  export GITHUB_WORKSPACE="$CO"
  export RUNNER_NAME="ultra-homelake-3"
  export FLEET_DISK_PROBE=df
}

hook() { bash "$R/hooks/job-completed.sh"; }

wait_trash() {
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -n "$(find "$R/.work-trash" -mindepth 1 -maxdepth 1 -name 'run.*' 2>/dev/null)" ] || return 0
    sleep 0.3
  done
}

echo "== with room on the disk: the checkout's output goes, warm caches stay =="
setup
out="$(FLEET_CLEANUP_PRESSURE_GB=0 hook)"
ok "the hook exits 0" "$?" "0"
ok "the Android build output in the checkout" "$(there "$CO/homelake-android/app/build")" "removed"
ok "node_modules in the checkout" "$(there "$CO/node_modules")" "removed"
ok "tracked files stay" "$(there "$CO/main.swift")" "kept"
ok ".git stays" "$(there "$CO/.git")" "kept"
ok "DerivedData built this job stays" "$(there "$WS/DerivedData-HomelakeCompanion-iOS")" "kept"
ok "the venvs stay" "$(there "$WS/venvs")" "kept"
ok "a native build tree unused for nine days goes" "$(there "$WS/duckdb-native-work")" "removed"
ok "a fixture checkout beside it stays" "$(there "$WS/fixture-repo")" "kept"
ok "an old link goes, as a link" "$(there "$WS/link-out")" "removed"
ok "what it pointed at stays" "$(there "$BASE/outside/precious.txt")" "kept"
ok "the runner's _temp stays" "$(there "$R/homelake-3/_work/_temp/keep")" "kept"
ok "the runner's _tool stays" "$(there "$R/homelake-3/_work/_tool/node")" "kept"
ok "it says what it gave back in the job log" "$(printf '%s\n' "$out" | grep -c '^work-trim: homelake-3/_work/homelake gave back')" "1"
ok "and logs each entry" "$(grep -c 'duckdb-native-work (unused 7d)' "$R/logs/work-trim.log")" "1"
wait_trash
ok "the detached emptier deletes the trash" "$(find "$R/.work-trash" -mindepth 1 -maxdepth 1 -name 'run.*' | wc -l | tr -d ' ')" "0"

echo "== under the pressure line: the warm caches go too =="
setup
FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "DerivedData" "$(there "$WS/DerivedData-HomelakeCompanion-iOS")" "removed"
ok "venvs" "$(there "$WS/venvs")" "removed"
ok "the checkout is back to its tracked files" "$(cd "$CO" && find . -path ./.git -prune -o -type f -print | sort | tr '\n' ' ')" "./.gitignore ./main.swift "
ok "the fixture checkout still stays" "$(there "$WS/fixture-repo")" "kept"
FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "a second job with nothing to give back logs nothing new" "$(grep -c 'gave back' "$R/logs/work-trim.log")" "1"

echo "== FLEET_WORK_TRIM_KEEP spares a cache from the pressure rule =="
setup
FLEET_WORK_TRIM_KEEP="venvs DerivedData-*" FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "venvs kept" "$(there "$WS/venvs")" "kept"
ok "DerivedData kept" "$(there "$WS/DerivedData-HomelakeCompanion-iOS")" "kept"
ok "but not from the unused rule" "$(there "$WS/duckdb-native-work")" "removed"

echo "== the Playwright ingest still reads test-results/ before it goes =="
setup
echo '{"suites":[{"file":"a.spec.ts","specs":[{"title":"t","tests":[{"projectName":"chromium","results":[{"status":"passed","duration":5}]}]}]}]}' \
  > "$CO/test-results/results.json"
sed -i.bak 's/^FLEET_ADMIT_MODE=off$/FLEET_ADMIT_MODE=observe/' "$R/fleet.env"
mkdir -p "$R/dashboard/logs"
cp "$HOOKS/common.sh" "$R/hooks/"
GITHUB_REPOSITORY=acme/web FLEET_CLEANUP_PRESSURE_GB=0 hook >/dev/null
ok "the outcome was ingested" "$(grep -c '"title":"t"' "$R/.playwright-outcomes.ndjson" 2>/dev/null)" "1"
ok "then the report went with the rest" "$(there "$CO/test-results")" "removed"

echo "== read-only trees are emptied too =="
setup
mkdir -p "$CO/build/go/pkg/mod/x@v1"
echo m > "$CO/build/go/pkg/mod/x@v1/go.mod"
chmod -R a-w "$CO/build/go"
FLEET_CLEANUP_PRESSURE_GB=0 hook >/dev/null
ok "moved out of the checkout" "$(there "$CO/build")" "removed"
wait_trash
ok "and deleted from the trash" "$(find "$R/.work-trash" -mindepth 1 -maxdepth 1 -name 'run.*' | wc -l | tr -d ' ')" "0"

echo "== it acts only on the job's own workspace under this fleet root =="
setup
RUNNER_WORKSPACE="$BASE/outside" FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "a workspace outside the root" "$(there "$BASE/outside/precious.txt")" "kept"
RUNNER_WORKSPACE="$R/homelake-3/_work/_temp" FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "the runner's own _temp is not a workspace" "$(there "$R/homelake-3/_work/_temp/keep")" "kept"
RUNNER_WORKSPACE="homelake-3/_work/homelake" FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "a relative path" "$(there "$WS/venvs")" "kept"
mv "$R/homelake-3/.runner" "$R/homelake-3/.runner.off"
FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "a folder that is not a runner" "$(there "$WS/venvs")" "kept"
mv "$R/homelake-3/.runner.off" "$R/homelake-3/.runner"
FLEET_WORK_TRIM=0 FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "FLEET_WORK_TRIM=0 turns it off" "$(there "$CO/node_modules")" "kept"
unset RUNNER_WORKSPACE
FLEET_CLEANUP_PRESSURE_GB=999999 hook >/dev/null
ok "without RUNNER_WORKSPACE it does nothing" "$(there "$WS/venvs")" "kept"
ok "and still exits 0" "$?" "0"

echo "== without work-trim.sh the hook still exits 0 =="
setup
rm -f "$R/hooks/work-trim.sh"
hook >/dev/null
ok "exit 0" "$?" "0"
ok "nothing removed" "$(there "$CO/node_modules")" "kept"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
