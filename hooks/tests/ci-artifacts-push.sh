#!/usr/bin/env bash
# Exercises ci-artifacts-push.sh with a local destination folder. No ssh, no
# real ~/ci-artifacts: everything lives under a temp folder.
set -uo pipefail
HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$(mktemp -d)"; trap 'rm -rf "$BASE"' EXIT
PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1)); else echo "  FAIL  $1 — expected '$3', got '$2'"; FAIL=$((FAIL + 1)); fi; }

export HOME="$BASE/home" FLEET_ROOT="$BASE/fleet"
export FLEET_CI_ARTIFACTS="$HOME/ci-artifacts" FLEET_CI_ARTIFACTS_PUSH_LOG="$BASE/push.log" FLEET_CI_ARTIFACTS_PUSH_RETRY_S=0
mkdir -p "$FLEET_ROOT" "$FLEET_CI_ARTIFACTS/app/77-2/shots" "$FLEET_CI_ARTIFACTS/app/77-1"
echo png > "$FLEET_CI_ARTIFACTS/app/77-2/shots/a.png"
echo old > "$FLEET_CI_ARTIFACTS/app/77-1/old.txt"
DEST="$BASE/coordinator/ci-artifacts"
push() { GITHUB_REPOSITORY="${REPO-owner/app}" GITHUB_RUN_ID="${RUN-77}" GITHUB_RUN_ATTEMPT="${ATT-2}" bash "$HOOKS/ci-artifacts-push.sh" "$@"; }

echo "== off unless FLEET_CI_ARTIFACTS_PUSH_TO is set =="
FLEET_CI_ARTIFACTS_PUSH_TO="" push; ok "exit 0" "$?" 0
ok "nothing copied" "$([ -e "$DEST" ] && echo yes || echo no)" no

echo "== a dry run copies nothing =="
out="$(FLEET_CI_ARTIFACTS_PUSH_TO="$DEST" push --dry-run)"
ok "says what it would copy" "$(printf '%s' "$out" | grep -c "app/77-2/")" 1
ok "nothing copied" "$([ -e "$DEST" ] && echo yes || echo no)" no

echo "== this run's attempt only, under <repo>/<run>-<attempt> =="
FLEET_CI_ARTIFACTS_PUSH_TO="$DEST" push; ok "exit 0" "$?" 0
ok "file copied" "$(cat "$DEST/app/77-2/shots/a.png" 2>/dev/null)" png
ok "other attempt not copied" "$([ -e "$DEST/app/77-1" ] && echo yes || echo no)" no
ok "logged" "$(grep -c 'app/77-2 pushed' "$BASE/push.log")" 1

echo "== a second job of the run adds to the folder =="
echo html > "$FLEET_CI_ARTIFACTS/app/77-2/report.html"
FLEET_CI_ARTIFACTS_PUSH_TO="$DEST" push
ok "new file arrives, old kept" "$(ls "$DEST/app/77-2" | tr '\n' ' ')" "report.html shots "

echo "== bad inputs never fail the job and copy nothing =="
before="$(find "$DEST" | wc -l | tr -d ' ')"
FLEET_CI_ARTIFACTS_PUSH_TO="$DEST" RUN="12x" push; ok "non-numeric run id: exit 0" "$?" 0
FLEET_CI_ARTIFACTS_PUSH_TO="$DEST" REPO="owner/.." push; ok "repo '..': exit 0" "$?" 0
FLEET_CI_ARTIFACTS_PUSH_TO="$DEST" RUN=999 push; ok "run with no folder: exit 0" "$?" 0
FLEET_CI_ARTIFACTS_PUSH_TO="relative/path" push; ok "relative destination: exit 0" "$?" 0
ok "nothing new copied" "$(find "$DEST" | wc -l | tr -d ' ')" "$before"
ok "relative destination refused in the log" "$(grep -c refused "$BASE/push.log")" 1

echo "== an unreachable destination is logged, not fatal =="
FLEET_CI_ARTIFACTS_PUSH_TO="/dev/null/nope" push; ok "exit 0" "$?" 0
ok "failure logged" "$(grep -c 'FAILED after 3 tries' "$BASE/push.log")" 1

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
