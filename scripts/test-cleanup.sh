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
  cp "$HERE/hooks/free-disk.sh" "$HERE/hooks/emulator-control.sh" "$T/hooks/"
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
  # Only this case's processes (stand-in emulators and workers), never a real
  # emulator on the machine running the tests.
  cat > "$T/bin/fakeps" <<EOF
#!/usr/bin/env bash
/bin/ps "\$@" | grep -F "$T/"
EOF
  # adb's \`emu kill\` stops the stand-in on that port, when it listens.
  cat > "$T/bin/adb" <<EOF
#!/usr/bin/env bash
echo "adb \$*" >> "$T/calls"
port="\${2#emulator-}"
pkill -TERM -f -- "-port \$port -avd" 2>/dev/null
exit 0
EOF
  chmod +x "$T/bin/"*
}

clean() {
  HOME="$T/home" FLEET_ROOT="$T" PATH="$T/bin:$PATH" ANDROID_AVD_HOME="" \
    FLEET_PS="$T/bin/fakeps" FLEET_ADB="$T/bin/adb" bash "$T/cleanup.sh" "$@" 2>&1
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
ok "a partial run exits 0, not as a failure" "$?" "0"
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

echo "== another host's busy runners do not hold this host =="
setup 11
echo 45 > "$T/free"
# The same repos are mirrored on a second host: GitHub lists its runners too.
printf 'OTHER-web\nOTHER-ios\n' > "$T/busy"
old="$T/home/Library/Developer/Xcode/DerivedData/Old-abc"
mkdir -p "$old"; touch -t 202601010000 "$old"
clean --apply > "$T/out"
ok "said they are elsewhere" "$(grep -c 'on other hosts' "$T/out")" "1"
ok "did not list them as busy here" "$(grep -c 'a runner is BUSY' "$T/out")" "0"
ok "host-wide steps ran" "$(gone "$old")" "removed"
ok "this host's idle device was erased" "$(calls 'simctl erase U-WEB')" "1"
echo "OTHER-web" > "$T/busy"; echo "RL-android" >> "$T/busy"
mkdir -p "$old"; touch -t 202601010000 "$old"
: > "$T/calls"
clean --apply > "$T/out"
ok "a local busy runner still holds the host-wide steps" "$(gone "$old")" "kept"
ok "and keeps its own device" "$(calls 'U-ANDROID')" "0"

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

echo "== a repo's own ci-<runner> <app> devices count as CI devices =="
setup 12
echo 120 > "$T/free"
echo 1 > "$T/.cleanup-last-full"
echo "RL-web" > "$T/busy"
cat > "$T/sims.json" <<'EOF'
{"devices": {
  "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
    {"name": "ci-RL-ios jerv iOS 27.0", "udid": "U-JERV", "state": "Shutdown", "dataPathSize": 5368709120},
    {"name": "ci-RL-web jerv iOS 27.0", "udid": "U-JWEB", "state": "Shutdown", "dataPathSize": 5368709120},
    {"name": "iPhone 17 Pro", "udid": "U-PERSON", "state": "Shutdown", "dataPathSize": 12884901888}
  ],
  "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [
    {"name": "ci-RL-gone jerv watchOS 27.0", "udid": "U-JGONE", "state": "Shutdown", "dataPathSize": 1048576}
  ]}}
EOF
clean --apply > "$T/out"
ok "erased an idle runner's app device over 3 GB" "$(calls 'simctl erase U-JERV')" "1"
ok "left a busy runner's app device" "$(calls 'U-JWEB')" "0"
ok "deleted an app device whose runner is gone" "$(calls 'simctl delete U-JGONE')" "1"
ok "never touched a device outside CI" "$(calls 'U-PERSON')" "0"

echo "== idle runners' AVDs and leftover self-updates go, nothing else =="
setup 13
echo 120 > "$T/free"
echo 1 > "$T/.cleanup-last-full"
echo "RL-web" > "$T/busy"
A="$T/home/.android/avd"
mkdir -p "$A"
avd() {
  mkdir -p "$A/$1.avd"; : > "$A/$1.avd/userdata-qemu.img.qcow2"; echo "path=$A/$1.avd" > "$A/$1.ini"
  [ "${2:-old}" = old ] && touch -t 202601010000 "$A/$1.avd/userdata-qemu.img.qcow2" "$A/$1.avd"
}
avd ci-RL-ios; avd shots-RL-android; avd ci-RL-web; avd ci-RL-gone; avd fleet-explore-1
avd ci-RL-android new
avd shots-RL-ios
sleep 300 >/dev/null 2>&1 &
EMU=$!
echo "$EMU" > "$A/shots-RL-ios.avd/hardware-qemu.ini.lock"
touch -t 202601010000 "$A/shots-RL-ios.avd/hardware-qemu.ini.lock" "$A/shots-RL-ios.avd"
for r in ios web android; do mkdir -p "$T/$r/_work/_update/bin"; done
touch -t 202601010000 "$T/ios/_work/_update" "$T/web/_work/_update"
clean > "$T/out"
ok "a dry run keeps every AVD" "$(gone "$A/ci-RL-ios.avd")" "kept"
ok "a dry run keeps the leftover update" "$(gone "$T/ios/_work/_update")" "kept"
clean --apply > "$T/out"
ok "removed an idle runner's AVD" "$(gone "$A/ci-RL-ios.avd")" "removed"
ok "and its .ini" "$(gone "$A/ci-RL-ios.ini")" "removed"
ok "removed an idle runner's screenshot AVD" "$(gone "$A/shots-RL-android.avd")" "removed"
ok "removed the AVD of a runner that no longer exists" "$(gone "$A/ci-RL-gone.avd")" "removed"
ok "kept a busy runner's AVD" "$(gone "$A/ci-RL-web.avd")" "kept"
ok "kept an AVD written in the last 30 minutes" "$(gone "$A/ci-RL-android.avd")" "kept"
ok "kept an AVD an emulator has open" "$(gone "$A/shots-RL-ios.avd")" "kept"
ok "never touched an AVD outside CI" "$(gone "$A/fleet-explore-1.avd")" "kept"
ok "removed an idle runner's old self-update" "$(gone "$T/ios/_work/_update")" "removed"
ok "kept a busy runner's self-update" "$(gone "$T/web/_work/_update")" "kept"
ok "kept a self-update under six hours old" "$(gone "$T/android/_work/_update")" "kept"
{ kill "$EMU"; wait "$EMU"; } 2>/dev/null

echo "== warm build caches: a week unused goes, all of an idle runner's under pressure =="
setup 30
echo 120 > "$T/free"
echo "RL-web" > "$T/busy"
for r in ios web android; do
  mkdir -p "$T/$r/_work/$r/DerivedData-App/Build" "$T/$r/_work/$r/spm-App" \
    "$T/$r/_work/$r/.build-cache-x" "$T/$r/_work/$r/$r/.git"
done
# ios: everything stale. android: DerivedData used yesterday. web: building.
for c in "$T"/*/_work/*/DerivedData-App "$T"/*/_work/*/spm-App "$T"/*/_work/*/.build-cache-x; do
  touch -t 202601010000 "$c/state"
  touch -t 202601010000 "$c"
done
touch -t 202601010000 "$T"/*/_work/*/DerivedData-App/Build
touch "$T/android/_work/android/DerivedData-App/Build"
# A checkout named like a cache, and a cache under the runner's own _temp.
mkdir -p "$T/ios/_work/spm-tools/spm-tools/.git" "$T/ios/_work/_temp/DerivedData"
touch -t 202601010000 "$T/ios/_work/spm-tools/spm-tools" "$T/ios/_work/_temp/DerivedData"
rm -f "$T/web/_work/.metadata_never_index"
clean > "$T/out"
ok "a dry run keeps the caches" "$(gone "$T/ios/_work/ios/DerivedData-App")" "kept"
ok "a dry run writes no Spotlight marker" "$(gone "$T/web/_work/.metadata_never_index")" "removed"
clean --apply > "$T/out"
ok "removed a week-old DerivedData" "$(gone "$T/ios/_work/ios/DerivedData-App")" "removed"
ok "removed a week-old SwiftPM cache" "$(gone "$T/ios/_work/ios/spm-App")" "removed"
ok "removed a week-old build cache" "$(gone "$T/ios/_work/ios/.build-cache-x")" "removed"
ok "kept a DerivedData built in this week" "$(gone "$T/android/_work/android/DerivedData-App")" "kept"
ok "but removed that runner's stale SwiftPM cache" "$(gone "$T/android/_work/android/spm-App")" "removed"
ok "kept a building runner's caches" "$(gone "$T/web/_work/web/DerivedData-App")" "kept"
ok "never touched a checkout" "$(gone "$T/ios/_work/ios/ios")" "kept"
ok "never touched a git checkout named like a cache" "$(gone "$T/ios/_work/spm-tools/spm-tools")" "kept"
ok "never touched the runner's own _temp" "$(gone "$T/ios/_work/_temp/DerivedData")" "kept"
ok "wrote the missing Spotlight marker" "$(gone "$T/web/_work/.metadata_never_index")" "kept"
echo 45 > "$T/free"
clean --apply > "$T/out"
ok "under pressure, an idle runner's recent cache goes too" "$(gone "$T/android/_work/android/DerivedData-App")" "removed"
ok "...but never a building runner's" "$(gone "$T/web/_work/web/DerivedData-App")" "kept"

echo "== snapshot AVDs: kept for a runner here, gone when stale or orphaned =="
setup 40
echo 120 > "$T/free"
echo 1 > "$T/.cleanup-last-full"
echo "RL-web" > "$T/busy"
A="$T/home/.android/avd"
mkdir -p "$A"
# snap <name> <age: old|days N|new> [with-snapshot]
snap() {
  mkdir -p "$A/$1.avd"; : > "$A/$1.avd/userdata-qemu.img.qcow2"; echo "path=$A/$1.avd" > "$A/$1.ini"
  [ "${4:-}" = with-snapshot ] && { mkdir -p "$A/$1.avd/snapshots/default_boot"; : > "$A/$1.avd/snapshots/default_boot/ram.bin"; echo key > "$A/$1.avd/ci-snapshot.key"; }
  case "$2" in
    old) stamp=202601010000 ;;
    days) stamp="$(date -v-"$3"d +%Y%m%d%H%M)" ;;
    *) return 0 ;;
  esac
  find "$A/$1.avd" -exec touch -t "$stamp" {} +
}
snap ci-RL-ios-a34-google_apis-pixel_6 days 2 with-snapshot
snap ci-RL-ios-a34-android-tv-tv_1080p days 3 with-snapshot
snap ci-RL-android-a34-google_apis-pixel_6 days 20 with-snapshot
snap ci-RL-web-a34-google_apis-pixel_6 old with-snapshot
snap ci-RL-gone-a34-android-tv-tv_1080p days 2 with-snapshot
snap ci-RL-ios-2-a34-google_apis-pixel_6 days 2 with-snapshot
snap ci-RL-android x x
touch -t 202601010000 "$A/ci-RL-android.avd/userdata-qemu.img.qcow2" "$A/ci-RL-android.avd"
clean --apply > "$T/out"
ok "kept an idle runner's snapshot AVD used this week" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd/snapshots/default_boot")" "kept"
ok "kept the same runner's TV snapshot AVD" "$(gone "$A/ci-RL-ios-a34-android-tv-tv_1080p.avd/snapshots")" "kept"
ok "removed a snapshot AVD with no boot in 14 days" "$(gone "$A/ci-RL-android-a34-google_apis-pixel_6.avd")" "removed"
ok "and its .ini" "$(gone "$A/ci-RL-android-a34-google_apis-pixel_6.ini")" "removed"
ok "kept a building runner's snapshot AVD, however old" "$(gone "$A/ci-RL-web-a34-google_apis-pixel_6.avd")" "kept"
ok "removed the snapshot AVD of a runner that no longer exists" "$(gone "$A/ci-RL-gone-a34-android-tv-tv_1080p.avd")" "removed"
ok "RL-ios-2's AVD is not RL-ios's (no such runner: removed)" "$(gone "$A/ci-RL-ios-2-a34-google_apis-pixel_6.avd")" "removed"
ok "still removed an idle runner's plain AVD" "$(gone "$A/ci-RL-android.avd")" "removed"

echo "== below the admission floor, idle runners' snapshots go first =="
setup 41
echo 30 > "$T/free"
date +%s > "$T/.cleanup-last-full"
echo "RL-web" > "$T/busy"
A="$T/home/.android/avd"
mkdir -p "$A"
snap ci-RL-ios-a34-google_apis-pixel_6 days 2 with-snapshot
snap ci-RL-web-a34-google_apis-pixel_6 days 2 with-snapshot
snap ci-RL-android-a34-google_apis-pixel_6 new x with-snapshot
clean --apply --auto > "$T/out"
ok "said it is below the floor" "$(grep -c 'BELOW THE FLOOR' "$T/out")" "1"
ok "dropped an idle runner's snapshot" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd/snapshots")" "removed"
ok "and its snapshot key" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd/ci-snapshot.key")" "removed"
ok "but kept the AVD itself" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd/userdata-qemu.img.qcow2")" "kept"
ok "kept a building runner's snapshot" "$(gone "$A/ci-RL-web-a34-google_apis-pixel_6.avd/snapshots")" "kept"
ok "kept a snapshot written in the last 30 minutes" "$(gone "$A/ci-RL-android-a34-google_apis-pixel_6.avd/snapshots")" "kept"
ok "the snapshots went before any other step" \
  "$(awk '/Android emulators/ {a = NR} /DerivedData older/ {d = NR} END {print (a && d && a < d) ? "first" : "not first"}' "$T/out")" "first"

echo "== over FLEET_CLEANUP_AVD_KEEP_GB, the least recently used snapshots go, even on a quiet --auto tick =="
setup 42
echo 120 > "$T/free"
date +%s > "$T/.cleanup-last-full"
A="$T/home/.android/avd"
mkdir -p "$A"
snap ci-RL-ios-a34-google_apis-pixel_6 x x with-snapshot
snap ci-RL-android-a34-google_apis-pixel_6 x x with-snapshot
dd if=/dev/zero of="$A/ci-RL-ios-a34-google_apis-pixel_6.avd/snapshots/default_boot/ram.bin" bs=1048576 count=700 2>/dev/null
dd if=/dev/zero of="$A/ci-RL-android-a34-google_apis-pixel_6.avd/snapshots/default_boot/ram.bin" bs=1048576 count=700 2>/dev/null
find "$A/ci-RL-ios-a34-google_apis-pixel_6.avd" -exec touch -t "$(date -v-3d +%Y%m%d%H%M)" {} +
find "$A/ci-RL-android-a34-google_apis-pixel_6.avd" -exec touch -t "$(date -v-1d +%Y%m%d%H%M)" {} +
OUT="$(FLEET_CLEANUP_AVD_KEEP_GB=2 clean --apply --auto)"
ok "under the limit, a quiet tick stays quiet" "$OUT" ""
FLEET_CLEANUP_AVD_KEEP_GB=1 clean --apply --auto > "$T/out"
ok "over the limit, a quiet tick runs" "$(grep -c 'snapshot AVDs over 1 GB' "$T/out")" "1"
ok "dropped the least recently used snapshot" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd/snapshots")" "removed"
ok "kept its AVD" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd")" "kept"
ok "and stopped once under the limit" "$(gone "$A/ci-RL-android-a34-google_apis-pixel_6.avd/snapshots/default_boot/ram.bin")" "kept"
rm -rf "$A"

echo "== orphaned CI emulators are stopped the snapshot-safe way =="
setup 43
echo 120 > "$T/free"
date +%s > "$T/.cleanup-last-full"
A="$T/home/.android/avd"
mkdir -p "$A" "$T/emu" "$T/web/bin"
snap ci-RL-ios-a34-google_apis-pixel_6 days 1 with-snapshot
cat > "$T/emu/qemu-system-aarch64-headless" <<'EOF'
#!/usr/bin/env bash
case " $* " in *" -stubborn "*) trap '' TERM ;; *) trap 'exit 0' TERM ;; esac
while :; do sleep 1; done
EOF
chmod +x "$T/emu/qemu-system-aarch64-headless"
# Detached, so launchd is the parent, as android-emulator-runner leaves it.
emu() { ( "$T/emu/qemu-system-aarch64-headless" "$@" >/dev/null 2>&1 & ); }
emu -port 5554 -avd ci-RL-android-a34-google_apis-pixel_6 -no-snapshot-save
emu -port 5556 -avd ci-RL-web-a34-google_apis-pixel_6 -no-snapshot-save
emu -port 5558 -avd ci-RL-ios-a34-google_apis-pixel_6 -stubborn
emu -port 5560 -avd fleet-explore-1
emu -port 5562 -avd ci-RL-gone -no-snapshot
# RL-web is running a job: a Runner.Worker under its directory.
ln -s /bin/sleep "$T/web/bin/Runner.Worker"
( "$T/web/bin/Runner.Worker" 300 >/dev/null 2>&1 & )
sleep 1
alive() { pgrep -f -- "-avd $1" >/dev/null 2>&1 && echo running || echo stopped; }
FLEET_CLEANUP_EMU_ORPHAN_MIN_S=0 clean --auto > "$T/out"
ok "a dry run stops nothing" "$(alive ci-RL-android-a34)" "running"
ok "a dry run says what it would stop" "$(grep -c '\[dry-run\] stop ci-RL-android-a34' "$T/out")" "1"
FLEET_CLEANUP_EMU_ORPHAN_MIN_S=3600 clean --apply --auto > "$T/out"
ok "a young emulator is not an orphan yet" "$(alive ci-RL-android-a34)" "running"
FLEET_CLEANUP_EMU_ORPHAN_MIN_S=0 FLEET_EMU_KILL_WAIT_S=2 FLEET_EMU_TERM_WAIT_S=1 clean --apply --auto > "$T/out"
ok "stopped an idle runner's emulator" "$(alive ci-RL-android-a34)" "stopped"
ok "with the console's emu kill" "$(grep -c 'adb -s emulator-5554 emu kill' "$T/calls")" "1"
ok "and said so" "$(grep -c 'ci-RL-android-a34.*stopped (emu kill)' "$T/out")" "1"
ok "left the emulator of a runner running a job" "$(alive ci-RL-web-a34)" "running"
ok "never touched night QA's emulator" "$(alive fleet-explore-1)" "running"
ok "stopped the emulator of a runner that no longer exists" "$(alive 'ci-RL-gone ')" "stopped"
ok "SIGKILLed one that ignored emu kill and SIGTERM" "$(alive ci-RL-ios-a34)" "stopped"
ok "and, since it could have been saving, dropped its snapshot" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd/snapshots/default_boot")" "removed"
ok "but kept the AVD" "$(gone "$A/ci-RL-ios-a34-google_apis-pixel_6.avd")" "kept"
pkill -f -- "$T/" 2>/dev/null

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
