#!/usr/bin/env bash
# Shell tests for the plain-CLI-tool checks: scripts/check-tools.sh, the tool
# inference in scripts/infer-checks.py, and what preflight.sh --explain picks.
#
#   scripts/test-preflight-tools.sh
#
# WHY THIS EXISTS
#
# On 2026-10-09 a repo's `make lint` failed on a new runner host with
# `make: shellcheck: No such file or directory`. preflight.sh had checked Xcode,
# Postgres, Java, node and gh, and nothing a Makefile calls. Inference reads the
# workflow YAML, which says `make lint` and never `shellcheck`, so tools reached
# that way are checked always; tools the YAML runs itself are inferred.
#
# Uses a stub bin directory as the runners' PATH and a temporary workflow
# database. Nothing here touches the live fleet.
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
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/sh\nexit 0\n' > "$BIN/shellcheck"
chmod +x "$BIN/shellcheck"

echo "== check-tools.sh =="
check "--list always" "$("$HERE/check-tools.sh" --list always | tr '\n' ' ')" "shellcheck jq make "
case " $("$HERE/check-tools.sh" --list all | tr '\n' ' ') " in
  *" shellcheck "*" deno "*) ok "--list all includes the inferred tools" ;;
  *) bad "--list all includes the inferred tools" ;;
esac

out="$(CHECK_TOOLS_PATH="$BIN" "$HERE/check-tools.sh" shellcheck)"; rc=$?
check "present tool exits 0" "$rc" "0"
check "present tool line" "$out" "$(printf 'ok\tshellcheck\t%s' "$BIN/shellcheck")"

out="$(CHECK_TOOLS_PATH="$BIN" "$HERE/check-tools.sh" shellcheck jq)"; rc=$?
check "a missing tool exits 1" "$rc" "1"
check "missing tool names its formula" "$(printf '%s\n' "$out" | awk -F'\t' '$2 == "jq" {print $1, $3}')" "miss jq"

out="$(CHECK_TOOLS_PATH="$BIN" "$HERE/check-tools.sh" make)"
check "macOS-shipped tool has no formula" "$(printf '%s' "$out" | cut -f3)" "-"
case "$(printf '%s' "$out" | cut -f4)" in
  *xcode-select*) ok "and says what does install it" ;;
  *) bad "and says what does install it (got '$out')" ;;
esac

out="$(CHECK_TOOLS_PATH="$BIN" "$HERE/check-tools.sh" no-such-tool)"
check "unlisted tool is still checked" "$(printf '%s' "$out" | cut -f1,3)" "$(printf 'miss\t-')"

# The caller's PATH does not count: only the runners' does.
out="$(PATH="$BIN:$PATH" CHECK_TOOLS_PATH="$TMP/empty" "$HERE/check-tools.sh" shellcheck)"
check "found only on the caller's PATH is missing" "$(printf '%s' "$out" | cut -f1)" "miss"

echo "== infer-checks.py =="
DB="$TMP/fleet.db"
python3 - "$DB" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE workflow_files (repo TEXT, path TEXT, ref TEXT, name TEXT, sha TEXT, content TEXT, fetched_at INTEGER, is_default INTEGER)")
rows = [
    # Self-hosted: runs deno; ruby and jq appear only in comments.
    ("a/backend", "ci.yml", "jobs:\n  t:\n    runs-on: [self-hosted, ci]\n    steps:\n      # ruby is not used here\n      # shellcheck disable=SC2016\n      - run: deno test --allow-env functions/\n      - run: make lint\n"),
    # GitHub-hosted: its ruby implies nothing about this Mac.
    ("a/ios", "asc.yml", "jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ruby tools/asc.rb\n"),
]
db.executemany("INSERT INTO workflow_files (repo, path, content) VALUES (?, ?, ?)", rows)
db.commit()
PY
out="$(python3 "$ROOT/scripts/infer-checks.py" "$DB")"
check "infers the tool a self-hosted job runs, not comments or hosted jobs" \
  "$(printf '%s\n' "$out" | sed -n 's/^NEED_TOOLS=//p')" '"deno"'

echo "== preflight.sh --explain =="
out="$(FLEET_DB="$DB" "$ROOT/preflight.sh" --explain | sed -n 's/^  cli tools *//p')"
check "always tools plus inferred ones" "$out" "shellcheck jq make deno"
out="$(FLEET_DB="$TMP/none.db" "$ROOT/preflight.sh" --explain | sed -n 's/^  cli tools *//p')"
check "no workflow data: every listed tool" "$out" "$("$HERE/check-tools.sh" --list all | tr '\n' ' ')"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
