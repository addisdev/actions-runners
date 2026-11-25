#!/usr/bin/env bash
# Tests for scripts/xcode-label.sh (the rule for xcode-* runner labels) and
# for register.sh's refusal of a label that names the wrong Xcode. A stand-in
# xcodebuild answers for whatever DEVELOPER_DIR it is given, so this runs on a
# host with no Xcode (CI is Linux).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LIB="$HERE/xcode-label.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }

# Stand-ins. xcodebuild prints "Xcode <v>" where <v> comes from
# $T/xcode/<DEVELOPER_DIR with / as _>, falling back to $T/xcode/selected;
# no file means "no Xcode here" (exit 1, like a missing xcodebuild).
mkdir -p "$T/bin" "$T/xcode"
cat > "$T/bin/xcodebuild" <<SH
#!/usr/bin/env bash
key=selected
[ -n "\${DEVELOPER_DIR:-}" ] && key="\$(printf '%s' "\$DEVELOPER_DIR" | tr / _)"
f="$T/xcode/\$key"
[ -f "\$f" ] || { echo "xcode-select: error: tool 'xcodebuild' requires Xcode" >&2; exit 1; }
printf 'Xcode %s\nBuild version 27B52\n' "\$(cat "\$f")"
SH
printf '#!/bin/sh\necho /Applications/Xcode.app/Contents/Developer\n' > "$T/bin/xcode-select"
chmod +x "$T/bin/xcodebuild" "$T/bin/xcode-select"
export XCODE_LABEL_XCODEBUILD="$T/bin/xcodebuild" XCODE_LABEL_XCODE_SELECT="$T/bin/xcode-select"
selected() { if [ "$1" = - ]; then rm -f "$T/xcode/selected"; else printf '%s' "$1" > "$T/xcode/selected"; fi; }
other() { printf '%s' "$2" > "$T/xcode/$(printf '%s' "$1" | tr / _)"; }

# shellcheck source=xcode-label.sh
. "$LIB"

# --- the case table, shared with dashboard/test/xcode-label.test.js ----------
n=0
while IFS=$'\t' read -r label version expect; do
  case "$label" in ''|\#*) continue ;; esac
  [ "$version" = - ] && version=""
  xcode_label_matches "$label" "$version"
  case $? in 0) got=match ;; 2) got=ignored ;; *) got=mismatch ;; esac
  [ "$got" = "$expect" ] || fail "matches $label against '${version:-none}': $got, want $expect"
  n=$((n + 1))
done < "$HERE/xcode-label-cases.tsv"
[ "$n" -ge 15 ] || fail "only $n cases read from the table"

# --- version: selected, DEVELOPER_DIR, and xcodebuild missing ----------------
selected 27.2
[ "$(xcode_label_version "")" = 27.2 ] || fail "selected version"
other /Applications/Xcode-26.6.app/Contents/Developer 26.6
[ "$(xcode_label_version /Applications/Xcode-26.6.app/Contents/Developer)" = 26.6 ] || fail "DEVELOPER_DIR version"
[ "$(DEVELOPER_DIR=/Applications/Xcode-26.6.app/Contents/Developer xcode_label_version "")" = 27.2 ] \
  || fail "the caller's DEVELOPER_DIR leaked into the selected version (the runner does not inherit it)"
selected -
xcode_label_version "" >/dev/null && fail "a version with xcodebuild missing"

# --- check: match, mismatch, minor label, no xcode labels, xcodebuild missing -
selected 27.2
out="$("$LIB" check ci,xcode-27 release)"; rc=$?
[ "$rc" = 0 ] && [ -z "$out" ] || fail "match: rc=$rc out=$out"
out="$("$LIB" check ci,healer,hmap,homelake,xcode-26)"; rc=$?
[ "$rc" = 1 ] || fail "mismatch rc=$rc"
echo "$out" | grep -q '^xcode-26 names an Xcode jobs here do not get: Xcode 27.2' || fail "mismatch message: $out"
out="$("$LIB" check xcode-27.2)"; rc=$?
[ "$rc" = 0 ] || fail "minor label that matches: rc=$rc $out"
out="$("$LIB" check xcode-27.1)"; rc=$?
[ "$rc" = 1 ] || fail "minor label that does not match: rc=$rc"
out="$("$LIB" check ci ui-web release)"; rc=$?
[ "$rc" = 0 ] && [ -z "$out" ] || fail "no xcode labels: rc=$rc out=$out"
out="$("$LIB" check --developer-dir /Applications/Xcode-26.6.app/Contents/Developer xcode-26.6)"; rc=$?
[ "$rc" = 0 ] || fail "a non-selected Xcode named by DEVELOPER_DIR: rc=$rc $out"
selected -
out="$("$LIB" check ci xcode-27)"; rc=$?
[ "$rc" = 1 ] || fail "xcodebuild missing: rc=$rc"
echo "$out" | grep -q 'xcodebuild does not answer' || fail "xcodebuild missing message: $out"
out="$("$LIB" check ci release)"; rc=$?
[ "$rc" = 0 ] || fail "xcodebuild missing, no xcode labels: rc=$rc"
"$LIB" check >/dev/null 2>&1; [ $? = 2 ] || fail "check with no labels is a usage error"

# --- facts: selected line, and runners whose .env sets DEVELOPER_DIR ---------
selected 27.2
F="$T/fleet"
mkdir -p "$F/plain" "$F/old-xcode" "$F/not-a-runner"
echo '{}' > "$F/plain/.runner"; printf 'PATH=/usr/bin\n' > "$F/plain/.env"
echo '{}' > "$F/old-xcode/.runner"
printf 'PATH=/usr/bin\nDEVELOPER_DIR=/Applications/Xcode-26.6.app/Contents/Developer\n' > "$F/old-xcode/.env"
printf 'DEVELOPER_DIR=/nowhere\n' > "$F/not-a-runner/.env"
facts="$("$LIB" facts --root "$F")"
want="$(printf 'selected\t/Applications/Xcode.app/Contents/Developer\t27.2\nrunner\told-xcode\t/Applications/Xcode-26.6.app/Contents/Developer\t26.6')"
[ "$facts" = "$want" ] || fail "facts: got [$facts]"
selected -
facts="$("$LIB" facts --root "$F")"
printf '%s\n' "$facts" | head -1 | grep -q "$(printf '^selected\t/Applications/Xcode.app/Contents/Developer\t$')" \
  || fail "facts with xcodebuild missing: [$facts]"

# --- register.sh refuses before it downloads or creates anything -------------
# A copy of the scripts it needs, with curl and scutil stand-ins so the path
# past the check stops at the download instead of reaching the network.
R="$T/repo"; mkdir -p "$R/scripts" "$T/runners"
cp "$ROOT/register.sh" "$R/"; cp "$LIB" "$R/scripts/"
printf '#!/bin/sh\necho test-host\n' > "$T/bin/scutil"
printf '#!/bin/sh\necho "curl stand-in: no network" >&2; exit 7\n' > "$T/bin/curl"
chmod +x "$T/bin/scutil" "$T/bin/curl"
reg() { PATH="$T/bin:$PATH" FLEET_ROOT="$T/runners" RUNNER_TOKEN=unused "$R/register.sh" "$@" 2>&1; }

selected 27.2
out="$(reg owner/app ci xcode-26)"; rc=$?
[ "$rc" = 1 ] || fail "register.sh with xcode-26 on 27.2: rc=$rc"
echo "$out" | grep -q 'refusing to register owner/app' || fail "refusal message: $out"
echo "$out" | grep -q 'xcode-26 names an Xcode' || fail "refusal names the label: $out"
echo "$out" | grep -q 'xcode-27' || fail "refusal names the right label: $out"
[ ! -e "$T/runners/app" ] || fail "a refused registration created its directory"

out="$(reg owner/app 'ci,xcode-26.6')"; rc=$?
[ "$rc" = 1 ] || fail "comma-separated xcode-26.6 on 27.2 was not refused: rc=$rc"

out="$(reg owner/app ci xcode-27)"; rc=$?
echo "$out" | grep -q 'refusing' && fail "xcode-27 on 27.2 was refused: $out"
echo "$out" | grep -q 'downloading runner' || fail "a matching label did not reach the download: $out"
rm -rf "$T/runners/app"

out="$(reg owner/app ci)"; rc=$?
echo "$out" | grep -q 'downloading runner' || fail "no xcode label did not reach the download: $out"
rm -rf "$T/runners/app"

out="$(FLEET_RUNNER_DEVELOPER_DIR=/Applications/Xcode-26.6.app/Contents/Developer reg owner/app xcode-26.6)"; rc=$?
echo "$out" | grep -q 'refusing' && fail "xcode-26.6 with its own DEVELOPER_DIR was refused: $out"
rm -rf "$T/runners/app"

out="$(FLEET_RUNNER_DEVELOPER_DIR=/Applications/Nope.app/Contents/Developer reg owner/app ci)"; rc=$?
[ "$rc" = 1 ] || fail "a DEVELOPER_DIR where xcodebuild does not answer was not refused: rc=$rc"

out="$(reg owner/app xcode-26 --force-xcode-label)"; rc=$?
echo "$out" | grep -q 'warning (--force-xcode-label)' || fail "--force-xcode-label did not warn: $out"
echo "$out" | grep -q 'downloading runner' || fail "--force-xcode-label did not go on: $out"
rm -rf "$T/runners/app"

selected -
out="$(reg owner/app xcode-27)"; rc=$?
[ "$rc" = 1 ] || fail "xcode-27 with no Xcode was not refused: rc=$rc"

rm -f "$R/scripts/xcode-label.sh"; selected 27.2
out="$(reg owner/app xcode-27)"; rc=$?
[ "$rc" = 1 ] && echo "$out" | grep -q 'is missing' || fail "xcode label with the rule missing was not refused: rc=$rc $out"
out="$(reg owner/app ci)"; rc=$?
echo "$out" | grep -q 'downloading runner' || fail "the missing rule blocked a runner with no xcode label: $out"

[ "$FAILS" -eq 0 ] || { echo "$FAILS failure(s)" >&2; exit 1; }
echo "ok xcode-label ($n cases)"
