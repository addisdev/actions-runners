#!/usr/bin/env bash
# Exercises ci-artifacts-prune.sh against a throwaway ~/ci-artifacts. Ages are
# set with touch; nothing outside the temp folder is read or removed.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${TMPDIR:-/tmp}/ci-artifacts-test"
PASS=0
FAIL=0

cleanup() { rm -rf "$BASE"; }
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

# touch -t wants [[CC]YY]MMDDhhmm; BSD and GNU date spell "N minutes ago" differently.
ago() {
  local s=$(( $(date +%s) - $1 * 60 ))
  date -r "$s" +%Y%m%d%H%M 2>/dev/null || date -d "@$s" +%Y%m%d%H%M
}

setup() {
  rm -rf "$BASE"
  A="$BASE/home/ci-artifacts"
  mkdir -p "$A/homelake/100-1/agent-shots" "$A/homelake/200-1/agent-shots" "$A/homelake/300-2/report" \
    "$A/jerv/400-1" "$BASE/outside"
  echo png > "$A/homelake/100-1/agent-shots/a.png"
  echo png > "$A/homelake/200-1/agent-shots/a.png"
  echo html > "$A/homelake/300-2/report/index.html"
  echo log > "$A/jerv/400-1/build.log"
  echo stray > "$A/jerv/notes.txt"
  echo keep > "$BASE/outside/precious.txt"
  ln -s "$BASE/outside" "$A/jerv/500-1"
  # 100-1: two days old all through. 200-1: old folder, but a file inside
  # written 10 minutes ago. 300-2: written an hour ago. 400-1 and the stray
  # file: two days. 500-1: an old link to a folder outside the root.
  local old new
  old="$(ago 2880)"
  new="$(ago 10)"
  touch -t "$old" "$A/homelake/100-1/agent-shots/a.png" "$A/homelake/100-1/agent-shots" "$A/homelake/100-1" \
    "$A/homelake/200-1/agent-shots" "$A/homelake/200-1" "$A/jerv/400-1/build.log" "$A/jerv/400-1" "$A/jerv/notes.txt"
  touch -t "$new" "$A/homelake/200-1/agent-shots/a.png"
  touch -t "$(ago 60)" "$A/homelake/300-2/report/index.html" "$A/homelake/300-2/report" "$A/homelake/300-2"
  touch -h -t "$old" "$A/jerv/500-1" 2>/dev/null || true
  export FLEET_CI_ARTIFACTS="$A"
  export FLEET_CI_ARTIFACTS_STAMP="$BASE/stamp.last"
  export HOME="$BASE/home"
}

echo "== a dry run removes nothing =="
setup
out="$(bash "$HOOKS/ci-artifacts-prune.sh")"
ok "the old run is still there" "$(there "$A/homelake/100-1")" "kept"
ok "it says what it would remove" "$(printf '%s\n' "$out" | grep -c '^\[dry-run\].*homelake/100-1$')" "1"

echo "== --apply removes what is older than a day =="
setup
out="$(bash "$HOOKS/ci-artifacts-prune.sh" --apply)"
ok "a two-day-old run" "$(there "$A/homelake/100-1")" "removed"
ok "another repo's old run" "$(there "$A/jerv/400-1")" "removed"
ok "a stray old file beside the runs" "$(there "$A/jerv/notes.txt")" "removed"
ok "an old folder written into ten minutes ago" "$(there "$A/homelake/200-1")" "kept"
ok "a run from an hour ago" "$(there "$A/homelake/300-2")" "kept"
ok "the repo folders themselves" "$(there "$A/homelake")" "kept"
ok "an old symlink goes, as a link" "$(there "$A/jerv/500-1")" "removed"
ok "what the link pointed at stays" "$(there "$BASE/outside/precious.txt")" "kept"
ok "the total line counts them" "$(printf '%s\n' "$out" | tail -1 | cut -d' ' -f1)" "4"
ok "it says why it kept the busy one" "$(printf '%s\n' "$out" | grep -c 'kept homelake/200-1')" "1"

echo "== FLEET_CI_ARTIFACTS_KEEP_MIN =="
setup
FLEET_CI_ARTIFACTS_KEEP_MIN=30 FLEET_CI_ARTIFACTS_FRESH_MIN=5 bash "$HOOKS/ci-artifacts-prune.sh" --apply >/dev/null
ok "with a 30-minute keep the hour-old run goes" "$(there "$A/homelake/300-2")" "removed"
ok "and with a 5-minute fresh window so does the one written ten minutes ago" "$(there "$A/homelake/200-1")" "removed"

echo "== --if-due runs at most once per window =="
setup
bash "$HOOKS/ci-artifacts-prune.sh" --apply --if-due >/dev/null
ok "the first run prunes" "$(there "$A/homelake/100-1")" "removed"
mkdir -p "$A/homelake/600-1"; touch -t "$(ago 2880)" "$A/homelake/600-1"
bash "$HOOKS/ci-artifacts-prune.sh" --apply --if-due >/dev/null
ok "a second run inside the window does nothing" "$(there "$A/homelake/600-1")" "kept"
FLEET_CI_ARTIFACTS_EVERY_S=0 bash "$HOOKS/ci-artifacts-prune.sh" --apply --if-due >/dev/null
ok "once the window has passed it prunes again" "$(there "$A/homelake/600-1")" "removed"

echo "== a held lock means another prune is running =="
setup
mkdir "${FLEET_CI_ARTIFACTS_STAMP%.last}.lock"
bash "$HOOKS/ci-artifacts-prune.sh" --apply >/dev/null
ok "nothing removed while locked" "$(there "$A/homelake/100-1")" "kept"
rmdir "${FLEET_CI_ARTIFACTS_STAMP%.last}.lock"

echo "== it refuses a root that is not a folder of its own =="
setup
for bad in "/" "$HOME" "relative/path" "$BASE/missing"; do
  out="$(FLEET_CI_ARTIFACTS="$bad" bash "$HOOKS/ci-artifacts-prune.sh" --apply)"
  ok "root '$bad' is refused" "$(printf '%s\n' "$out" | grep -c '^(no ')" "1"
done
ok "and nothing in HOME was touched" "$(there "$A/homelake/100-1")" "kept"

echo "== the job-completed hook runs it, detached =="
ok "job-completed.sh calls ci-artifacts-prune.sh --apply --if-due" \
  "$(grep -c 'ci-artifacts-prune.sh" --apply --if-due' "$HOOKS/job-completed.sh")" "1"
setup
mkdir -p "$BASE/root/hooks"
cp "$HOOKS/job-completed.sh" "$HOOKS/ci-artifacts-prune.sh" "$BASE/root/hooks/"
FLEET_ROOT="$BASE/root" bash "$BASE/root/hooks/job-completed.sh"
ok "the hook exits 0" "$?" "0"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$A/homelake/100-1" ] || break; sleep 0.3; done
ok "and the old run is gone" "$(there "$A/homelake/100-1")" "removed"
FLEET_CI_ARTIFACTS_PRUNE=0 FLEET_ROOT="$BASE/root" bash "$BASE/root/hooks/job-completed.sh"
mkdir -p "$A/homelake/700-1"; touch -t "$(ago 2880)" "$A/homelake/700-1"
rm -f "$FLEET_CI_ARTIFACTS_STAMP"
FLEET_CI_ARTIFACTS_PRUNE=0 FLEET_ROOT="$BASE/root" bash "$BASE/root/hooks/job-completed.sh"
sleep 1
ok "FLEET_CI_ARTIFACTS_PRUNE=0 turns it off" "$(there "$A/homelake/700-1")" "kept"

echo "== cleanup.sh reports and prunes it =="
setup
mkdir -p "$BASE/c/hooks"
cp "$HOOKS/../cleanup.sh" "$BASE/c/"
cp "$HOOKS/ci-artifacts-prune.sh" "$HOOKS/free-disk.sh" "$BASE/c/hooks/"
out="$(FLEET_ROOT="$BASE/c" FLEET_DISK_PROBE=df PATH="/usr/bin:/bin:/usr/sbin:/sbin" bash "$BASE/c/cleanup.sh" 2>/dev/null)"
ok "the dry run lists the section" "$(printf '%s\n' "$out" | grep -c '^==> CI artifacts')" "1"
ok "and reports what is kept" "$(printf '%s\n' "$out" | grep -c 'MB kept in ')" "1"
ok "and deletes nothing" "$(there "$A/homelake/100-1")" "kept"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
