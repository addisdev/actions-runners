#!/usr/bin/env bash
# Exercises cleanup.sh against a throwaway fleet root with df, xcrun and gh
# stubbed, so no real simulator, disk or GitHub call is involved.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${TMPDIR:-/tmp}/cleanup-test"
PASS=0
FAIL=0

ok() {
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 ($2)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 — expected '$3', got '$2'"
    FAIL=$((FAIL + 1))
  fi
}

# A fleet root with three runners, a copy of cleanup.sh, stub tools, and a
# simulator list: web's device is big, android's is small, ios's is booted,
# gone's runner does not exist, and "iPhone 17" belongs to nobody in CI.
setup() {
  T="$BASE/case-$1"
  rm -rf "$T"
  mkdir -p "$T/bin" "$T/home/Library/Developer/Xcode/DerivedData"
  mkdir -p "$T/hooks"
  cp "$HERE/cleanup.sh" "$T/"
  cp "$HERE/hooks/free-disk.sh" "$T/hooks/"
  for r in web android ios; do
    mkdir -p "$T/$r/_work/_tool/ms-playwright/chromium" "$T/$r/_diag"
    printf '{"agentName":"RL-%s","gitHubUrl":"https://github.com/acme/%s"}' "$r" "$r" > "$T/$r/.runner"
  done
  echo 60 > "$T/free"
  # Usable space (purgeable counted) follows the same file unless a case sets
  # $T/usable: osascript is what macOS answers, df is plain free.
  cat > "$T/bin/osascript" <<EOF
#!/usr/bin/env bash
if [ -f "$T/usable" ]; then cat "$T/usable"; else cat "$T/free"; fi
EOF
  : > "$T/busy"
  : > "$T/calls"
  cat > "$T/sims.json" <<'EOF'
{"devices": {
  "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
    {"name": "ci-RL-web iOS 27.0", "udid": "U-WEB", "state": "Shutdown", "dataPathSize": 5368709120},
    {"name": "ci-RL-android iOS 27.0", "udid": "U-ANDROID", "state": "Shutdown", "dataPathSize": 1610612736},
    {"name": "ci-RL-ios iOS 27.0", "udid": "U-IOS", "state": "Booted", "dataPathSize": 6442450944},
    {"name": "ci-RL-gone iOS 27.0", "udid": "U-GONE", "state": "Shutdown", "dataPathSize": 1048576},
    {"name": "iPhone 17", "udid": "U-PERSON", "state": "Shutdown", "dataPathSize": 12884901888}
  ]}}
EOF
  # Honours -k (KB) and -g (GB) like the real df: free-disk.sh asks in KB.
  cat > "$T/bin/df" <<EOF
#!/usr/bin/env bash
f=\$(cat "$T/free")
case "\$*" in *-k*) f=\$((f * 1048576)) ;; esac
echo "Filesystem blocks Used Available Capacity Mounted"
echo "/dev/disk3s1s1 926 12 \$f 16% /"
EOF
  cat > "$T/bin/xcrun" <<EOF
#!/usr/bin/env bash
case "\$*" in
  "simctl list devices -j") cat "$T/sims.json" ;;
  simctl\ list*) echo "" ;;
  *) echo "xcrun \$*" >> "$T/calls" ;;
esac
EOF
  cat > "$T/bin/gh" <<EOF
#!/usr/bin/env bash
cat "$T/busy"
EOF
  chmod +x "$T/bin/"*
}

clean() {
  HOME="$T/home" FLEET_ROOT="$T" PATH="$T/bin:$PATH" bash "$T/cleanup.sh" "$@" 2>&1
}
calls() { grep -c "$1" "$T/calls" 2>/dev/null; }
gone() { [ -e "$1" ] && echo kept || echo removed; }

echo "== --auto does nothing with room to spare and a recent full run =="
setup 1
echo 120 > "$T/free"
date +%s > "$T/.cleanup-last-full"
OUT="$(clean --apply --auto)"
ok "printed nothing" "$OUT" ""
ok "touched no simulator" "$(calls simctl)" "0"

echo "== --auto runs the full pass once a day =="
setup 2
echo 120 > "$T/free"
echo 1 > "$T/.cleanup-last-full"
clean --apply --auto > "$T/out"
ok "erased the idle CI device over 3 GB" "$(calls 'simctl erase U-WEB')" "1"
ok "left a CI device under 3 GB" "$(calls 'simctl erase U-ANDROID')" "0"
ok "left a booted device" "$(calls 'U-IOS')" "0"
ok "deleted the device of a runner that no longer exists" "$(calls 'simctl delete U-GONE')" "1"
ok "never touched a device outside CI" "$(calls 'U-PERSON')" "0"
ok "kept Playwright browsers with room to spare" "$(gone "$T/web/_work/_tool/ms-playwright")" "kept"
ok "recorded the full run" "$([ "$(cat "$T/.cleanup-last-full")" -gt 1 ] && echo yes || echo no)" "yes"

echo "== under pressure it takes more, but never from a building runner =="
setup 3
echo 45 > "$T/free"
date +%s > "$T/.cleanup-last-full"
echo "RL-web" > "$T/busy"
# android's job holds an admission slot; gh does not know it is busy.
mkdir -p "$T/.admission/slots"
sleep 300 >/dev/null 2>&1 &
SLOT=$!
printf 'pid=%s\nrunner=RL-android\n' "$SLOT" > "$T/.admission/slots/RL-android"
old="$T/home/Library/Developer/Xcode/DerivedData/Old-abc"
mkdir -p "$old"; touch -t 202601010000 "$old"
clean --apply --auto > "$T/out"
ok "ran although the last full run was recent" "$(grep -c 'UNDER PRESSURE' "$T/out")" "1"
ok "left the device of a runner GitHub says is busy" "$(calls 'U-WEB')" "0"
ok "left the device of a runner holding a slot" "$(calls 'U-ANDROID')" "0"
ok "removed an idle runner's Playwright browsers" "$(gone "$T/ios/_work/_tool/ms-playwright")" "removed"
ok "kept a busy runner's Playwright browsers" "$(gone "$T/web/_work/_tool/ms-playwright")" "kept"
ok "kept a slot-holding runner's Playwright browsers" "$(gone "$T/android/_work/_tool/ms-playwright")" "kept"
ok "host-wide steps waited for an idle fleet" "$(gone "$old")" "kept"
ok "a partial run is not recorded as full" \
  "$([ "$(cat "$T/.cleanup-last-full")" -gt 1 ] && [ -n "$(find "$T/.cleanup-last-full" -newer "$T/out" 2>/dev/null)" ] && echo recorded || echo not)" "not"
{ kill "$SLOT"; wait "$SLOT"; } 2>/dev/null

echo "== under pressure on an idle fleet, small CI devices go too =="
setup 4
echo 45 > "$T/free"
clean --apply > "$T/out"
ok "erased a CI device over 1 GB" "$(calls 'simctl erase U-ANDROID')" "1"
ok "removed old DerivedData" "$(old="$T/home/Library/Developer/Xcode/DerivedData"; mkdir -p "$old/x"; touch -t 202601010000 "$old/x"; clean --apply >/dev/null; gone "$old/x")" "removed"

echo "== a dry run deletes nothing =="
setup 5
echo 45 > "$T/free"
clean > "$T/out"
ok "no simulator call" "$(calls simctl)" "0"
ok "Playwright browsers kept" "$(gone "$T/ios/_work/_tool/ms-playwright")" "kept"
ok "said so" "$(grep -c 'DRY RUN' "$T/out")" "1"

echo "== two runs never overlap =="
setup 6
echo 45 > "$T/free"
mkdir "$T/.cleanup-lock"
OUT="$(clean --apply)"
ok "second run stepped aside" "$OUT" "another cleanup is running"
ok "and touched nothing" "$(calls simctl)" "0"
touch -t 202601010000 "$T/.cleanup-lock"
clean --apply > "$T/out"
ok "a lock left by a killed run is taken over" "$(calls 'simctl erase U-WEB')" "1"
ok "the lock is released afterwards" "$(gone "$T/.cleanup-lock")" "removed"

echo "== a failed GitHub check is not read as runner names =="
setup 7
echo 45 > "$T/free"
# What gh does over SSH with no token: the error body on stdout, exit 1.
printf '#!/usr/bin/env bash\nprintf %s\nexit 1\n' "'{\n  \"message\": \"Requires authentication\",\n  \"status\": \"401\"\n}\n'" > "$T/bin/gh"
chmod +x "$T/bin/gh"
echo "FLEET_ADMIT_MODE=enforce" > "$T/fleet.env"
mkdir -p "$T/.admission/slots"
sleep 300 >/dev/null 2>&1 &
SLOT=$!
printf 'pid=%s\nrunner=RL-android\n' "$SLOT" > "$T/.admission/slots/RL-android"
clean --apply > "$T/out"
ok "the stub really prints an error body" "$("$T/bin/gh" | grep -c 'Requires authentication')" "1"
ok "no error text listed as a busy runner" "$(grep -c -E '"status"|"message"|^ *[{}]' "$T/out")" "0"
ok "said it went by the slots" "$(grep -c 'going by the admission slots' "$T/out")" "1"
ok "the slot-holding runner kept its device" "$(calls 'U-ANDROID')" "0"
ok "an idle runner's device was still erased" "$(calls 'simctl erase U-WEB')" "1"
{ kill "$SLOT"; wait "$SLOT"; } 2>/dev/null

echo "== with admission off, a failed GitHub check deletes nothing =="
setup 8
echo 45 > "$T/free"
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/bin/gh"
chmod +x "$T/bin/gh"
clean --apply > "$T/out"
ok "said every runner counts as building" "$(grep -c 'every runner counts as building' "$T/out")" "1"
ok "erased no device" "$(calls 'simctl erase')" "0"
ok "kept every runner's browsers" "$(gone "$T/ios/_work/_tool/ms-playwright")" "kept"

echo "== purgeable space keeps --auto quiet, a low plain free does not =="
setup 9
echo 50 > "$T/free"
echo 160 > "$T/usable"
date +%s > "$T/.cleanup-last-full"
OUT="$(clean --apply --auto)"
ok "50 GB plain but 160 usable: nothing to do" "$OUT" ""
echo 20 > "$T/free"
clean --apply --auto > "$T/out"
ok "plain free near the hard floor is pressure" "$(grep -c 'UNDER PRESSURE' "$T/out")" "1"
ok "the log shows both numbers" "$(grep -c 'free 160 GB (20 GB without purgeable)' "$T/out")" "1"

echo "== without free-disk.sh it still reads df =="
setup 10
rm "$T/hooks/free-disk.sh"
echo 45 > "$T/free"
echo 160 > "$T/usable"
clean --apply > "$T/out"
ok "no missing-file noise" "$(grep -c -E 'No such file|command not found' "$T/out")" "0"
ok "went by df, so under pressure" "$(grep -c 'UNDER PRESSURE' "$T/out")" "1"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
