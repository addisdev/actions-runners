#!/usr/bin/env bash
# Reclaim the disk that CI quietly eats on this Mac.
#
#   ./cleanup.sh                  # dry run — prints what it WOULD delete, touches nothing
#   ./cleanup.sh --apply          # actually delete
#   ./cleanup.sh --apply --auto   # what the LaunchAgent runs every 15 minutes:
#                                 # nothing unless disk is under the pressure line
#                                 # or a day has passed since the last full run
#
# Dry run is the default on purpose. This machine is a person's laptop as well as
# the build fleet, and everything below is shared with their interactive Xcode —
# DerivedData in particular. A cleanup that runs unattended should be one you have
# already watched run once.
#
# What it does NOT do, deliberately:
#   - never `simctl shutdown all`, never kill CoreSimulatorService. Those close
#     simulators the user is working in. `delete unavailable` only removes devices
#     whose runtime is already gone, which nothing can be using.
#   - never touch a runner's checkouts in _work, and never a warm build cache
#     a job used this week: wiping them makes every job re-clone and recompile
#     from cold. Warm caches (_work/<repo>/DerivedData-*, spm-*,
#     .build-cache-*) go after FLEET_CLEANUP_RUNNER_CACHE_DAYS without use, or
#     all of an idle runner's under disk pressure, as do its Playwright
#     browsers.
#   - never touch a simulator or Android AVD that is not a runner's own
#     ci- (or shots-) device.
#   - never throw away a runner's quick-boot snapshot AVD (the kit's
#     emulator_snapshot) while its runner exists and used it in the last
#     FLEET_CLEANUP_AVD_KEEP_DAYS, except to stay under
#     FLEET_CLEANUP_AVD_KEEP_GB or, below the admission floor, first of all.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"

APPLY=0
AUTO=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --auto) AUTO=1 ;;
  esac
done

DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
DERIVED_AGE_DAYS=7
# Per-runner warm build caches the kit keeps beside each checkout. A week
# without a build reading them means the next one rebuilds anyway.
RUNNER_CACHE_DAYS="${FLEET_CLEANUP_RUNNER_CACHE_DAYS:-7}"
case "$RUNNER_CACHE_DAYS" in '' | *[!0-9]*) RUNNER_CACHE_DAYS=7 ;; esac
DIAG_AGE_DAYS=14
PW_LOCK_AGE_HOURS=6

# Below this much free disk the cleanup also takes what costs the next job time
# (Playwright browsers, CI simulators over a smaller size). 20 GB over the
# admission floor: the floor holds every job, and once it does the fleet has
# already stopped. On runner-host the disk swung by 20-40 GB within a day while
# the weekly run reclaimed 1-2 GB, and it reached the floor on 09-29, 10-04 and
# 10-05.
PRESSURE_GB="${FLEET_CLEANUP_PRESSURE_GB:-$(( ${FLEET_ADMIT_MIN_FREE_DISK_GB:-40} + 20 ))}"
FULL_EVERY_S="${FLEET_CLEANUP_FULL_EVERY_S:-86400}"
SIM_MAX_GB="${FLEET_CLEANUP_SIM_MAX_GB:-3}"
SIM_PRESSURE_GB="${FLEET_CLEANUP_SIM_PRESSURE_GB:-1}"
STAMP="$ROOT/.cleanup-last-full"
LOCK="$ROOT/.cleanup-lock"

say() { printf '%s\n' "$*"; }
run() {
  if [ "$APPLY" = "1" ]; then "$@"; else say "    [dry-run] $*"; fi
}
# Usable free disk, counting what macOS can purge, as the admission floor does
# (hooks/free-disk.sh): df alone read 62 GB of purgeable caches as used.
if [ -f "$HERE/hooks/free-disk.sh" ]; then
  # shellcheck source=hooks/free-disk.sh
  . "$HERE/hooks/free-disk.sh"
else
  fleet_plain_free_gb() { df -g / | awk 'NR==2{print $4}'; }
  fleet_usable_free_gb() { fleet_plain_free_gb; }
fi
free_gb() { fleet_usable_free_gb; }
PLAIN_HARD_GB="${FLEET_ADMIT_MIN_PLAIN_FREE_GB:-15}"
# The admission floor itself: below it every job is held, so the snapshots go
# first (see the AVD step).
FLOOR_GB="${FLEET_ADMIT_MIN_FREE_DISK_GB:-40}"

# A runner's name as the kit spells it in AVD and simulator names.
runner_name() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8-sig'))['agentName'])" \
    "$1/.runner" 2>/dev/null
}

AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
AVD_PREFIXES="${FLEET_CLEANUP_AVD_PREFIXES:-ci shots}"
AVD_KEEP_DAYS="${FLEET_CLEANUP_AVD_KEEP_DAYS:-14}"
case "$AVD_KEEP_DAYS" in '' | *[!0-9]*) AVD_KEEP_DAYS=14 ;; esac
AVD_KEEP_GB="${FLEET_CLEANUP_AVD_KEEP_GB:-30}"
case "$AVD_KEEP_GB" in '' | *[!0-9]*) AVD_KEEP_GB=30 ;; esac
EMU_ORPHAN_MIN_S="${FLEET_CLEANUP_EMU_ORPHAN_MIN_S:-300}"
case "$EMU_ORPHAN_MIN_S" in '' | *[!0-9]*) EMU_ORPHAN_MIN_S=300 ;; esac
# emu_list, emu_avd_owner, emu_stop: the job-completed hook's emulator helpers.
if [ -f "$HERE/hooks/emulator-control.sh" ]; then
  # shellcheck source=hooks/emulator-control.sh
  . "$HERE/hooks/emulator-control.sh"
fi
EMU_PREFIXES="$AVD_PREFIXES"
EMU_AVD_HOME="$AVD_HOME"

# The kit's snapshot AVDs ("<prefix>-<runner>-a<api>-<target>-<profile>"), in
# KB. A few du calls on a handful of directories: cheap enough for every tick.
avd_snapshot_kb() {
  local t=0 kb d p
  for p in $AVD_PREFIXES; do
    for d in "$AVD_HOME/$p"-*-a[0-9]*-*.avd; do
      [ -d "$d" ] || continue
      kb="$(du -sk "$d" 2>/dev/null | cut -f1)"
      case "$kb" in '' | *[!0-9]*) kb=0 ;; esac
      t=$((t + kb))
    done
  done
  printf '%s' "$t"
}

# ---------------------------------------------------------------------------
# Orphaned CI emulators, on every tick (it costs one ps when there are none).
# android-emulator-runner starts the emulator detached, so it belongs to launchd
# even while its job runs, and a job cancelled or timed out mid-step leaves it
# running: on ultra (2026-10-23) two greenfolio emulators ran 9 h that way,
# each holding 4 GB of RAM and its runner's AVD. One goes when its parent is
# launchd, it is older than FLEET_CLEANUP_EMU_ORPHAN_MIN_S, and its runner is
# running no job (no Runner.Worker under the runner's directory) or no longer
# exists. It is stopped the snapshot-safe way (hooks/emulator-control.sh).
# ---------------------------------------------------------------------------
reap_orphan_emulators() {
  command -v emu_list >/dev/null 2>&1 || return 0
  local procs map names workers d name pid secs avd port save owner runner where dir
  procs="$(emu_list | awk -v min="$EMU_ORPHAN_MIN_S" '$2 == 1 && $3 >= min')"
  [ -n "$procs" ] || return 0
  map=""
  for d in "$ROOT"/*/; do
    [ -f "$d/.runner" ] || continue
    name="$(runner_name "$d" | tr -c 'A-Za-z0-9._\n-' '_')"
    [ -n "$name" ] && map="$map$name ${d%/}
"
  done
  names="$(printf '%s' "$map" | awk '{print $1}' | tr '\n' ' ')"
  workers="$("${FLEET_PS:-/bin/ps}" -axo command= 2>/dev/null | grep 'Runner\.Worker')"
  say "==> orphaned CI emulators (parent launchd, runner running no job)"
  while read -r pid _ secs avd port save; do
    [ -n "$pid" ] || continue
    owner="$(emu_avd_owner "$avd" "$names")" || continue
    runner="${owner%% *}"
    where="${owner##* }"
    if [ "$where" = here ]; then
      dir="$(printf '%s' "$map" | awk -v n="$runner" '$1 == n { sub(/^[^ ]+ /, ""); print; exit }')"
      if [ -n "$dir" ] && printf '%s\n' "$workers" \
        | awk -v d="$dir/bin" 'index($0, d) == 1 { f = 1 } END { exit !f }'; then
        continue
      fi
    fi
    if [ "$APPLY" = "1" ]; then
      say "    $avd (pid $pid, port $port, up ${secs}s, runner $runner $where): $(emu_stop "$pid" "$port" "$avd" "$save")"
    else
      say "    [dry-run] stop $avd (pid $pid, port $port, up ${secs}s, runner $runner $where)"
    fi
  done <<< "$procs"
}
reap_orphan_emulators

# --auto runs every 15 minutes, so its no-op has to cost two cheap reads and
# nothing else: the host it guards is usually saturated when the disk is short.
FREE_NOW="$(free_gb)"
PLAIN_NOW="$(fleet_plain_free_gb)"
PRESSURE=0
[ -n "$FREE_NOW" ] && [ "$FREE_NOW" -lt "$PRESSURE_GB" ] && PRESSURE=1
[ -n "$PLAIN_NOW" ] && [ "$PLAIN_NOW" -lt $((PLAIN_HARD_GB + 10)) ] && PRESSURE=1
FLOOR=0
[ -n "$FREE_NOW" ] && [ "$FREE_NOW" -lt "$FLOOR_GB" ] && FLOOR=1
[ -n "$PLAIN_NOW" ] && [ "$PLAIN_NOW" -lt "$PLAIN_HARD_GB" ] && FLOOR=1
AVD_SNAP_KB="$(avd_snapshot_kb)"
AVD_OVER=0
[ "$AVD_SNAP_KB" -gt $((AVD_KEEP_GB * 1048576)) ] && AVD_OVER=1
if [ "$AUTO" = "1" ] && [ "$PRESSURE" = "0" ] && [ "$AVD_OVER" = "0" ]; then
  last="$(cat "$STAMP" 2>/dev/null)"
  case "$last" in '' | *[!0-9]*) last=0 ;; esac
  if [ $(( $(date +%s) - last )) -lt "$FULL_EVERY_S" ]; then
    exit 0
  fi
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  # A run killed mid-way leaves the lock; none takes anywhere near two hours.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    say "another cleanup is running"; exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT
say "==> $(date '+%F %T')  free ${FREE_NOW} GB (${PLAIN_NOW} GB without purgeable), pressure line ${PRESSURE_GB} GB$([ "$PRESSURE" = 1 ] && echo '  — UNDER PRESSURE')$([ "$FLOOR" = 1 ] && echo ', BELOW THE FLOOR')$([ "$AVD_OVER" = 1 ] && echo "  — snapshot AVDs over ${AVD_KEEP_GB} GB")"

# ---------------------------------------------------------------------------
# Jobs in flight. Deleting DerivedData out from under a live xcodebuild produces
# a failure that looks like a code problem and is not reproducible afterwards —
# the worst kind of CI flake to chase. So the host-wide steps wait for an idle
# fleet, and the per-runner steps (its simulator, its Playwright browsers) skip
# only the runners that are building. Refusing everything while any job ran
# meant this never ran on a busy day, which is when the disk runs out.
# ---------------------------------------------------------------------------
# The runners on THIS host. GitHub lists every runner of a repository, so with
# the same repo mirrored on two hosts (runner-host and ultra, 2026-10-09) the
# other host's busy runners came back too, and each host's host-wide steps
# waited on the other's jobs and almost never ran.
LOCAL=" "
for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  LOCAL="$LOCAL$(runner_name "$d") "
done
rm -f /tmp/.cleanup-gh-failed
for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  repo=$(python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1])" 2>/dev/null) || continue
  echo "$repo"
done | sort -u | while read -r repo; do
  # On failure gh prints GitHub's error body to stdout ({"message": "Requires
  # authentication", ...} over SSH, where it has no keychain token), which used
  # to land in this list as runner names. Only a successful call counts, and
  # only lines shaped like a runner name.
  if out="$(gh api "repos/$repo/actions/runners" --jq '.runners[] | select(.busy) | .name' 2>/dev/null)"; then
    printf '%s\n' "$out" | grep -E '^[A-Za-z0-9._-]+$'
  else
    : > /tmp/.cleanup-gh-failed
  fi
done > /tmp/.cleanup-busy 2>/dev/null
# A runner held by the admission hook is "busy" to GitHub but is running
# nothing: its job is parked before its first step, waiting for a slot or for
# disk. Counting those as busy deadlocked the fleet on 2026-09-30 — the disk
# floor held four jobs, the held jobs made this script refuse, and this script
# is what frees the disk. Waiters with a live hook PID are left out.
held=""
for w in "$ROOT"/.admission/waiters/*; do
  [ -f "$w" ] || continue
  pid="$(sed -n 's/^pid=//p' "$w" | head -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
  held="$held $(sed -n 's/^runner=//p' "$w" | head -1)"
done
: > /tmp/.cleanup-building
elsewhere=0
waiting=0
while read -r name; do
  [ -n "$name" ] || continue
  case "$LOCAL" in *" $name "*) ;; *) elsewhere=$((elsewhere + 1)); continue ;; esac
  case " $held " in *" $name "*) waiting=$((waiting + 1)); continue ;; esac
  echo "$name" >> /tmp/.cleanup-building
done < /tmp/.cleanup-busy
[ "$elsewhere" -gt 0 ] && say "(${elsewhere} busy runner(s) of the same repos are on other hosts — not counted)"
# An admitted job holds a slot file with a live owner. That is local and does
# not depend on `gh` working from this session, so it counts too.
for f in "$ROOT"/.admission/slots/*; do
  [ -f "$f" ] || continue
  pid="$(sed -n 's/^pid=//p' "$f" | head -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
  sed -n 's/^runner=//p' "$f" | head -1 >> /tmp/.cleanup-building
done
sort -u -o /tmp/.cleanup-building /tmp/.cleanup-building
[ "$waiting" -gt 0 ] && [ ! -s /tmp/.cleanup-building ] \
  && say "(runners held by admission are waiting, not building — not counted)"
BUILDING=" $(tr '\n' ' ' < /tmp/.cleanup-building) "
HOST_IDLE=1
ALL_BUSY=0
# Without GitHub's answer the admission slots still know every admitted job,
# but only where the hook runs. With admission off nothing local does, so
# every runner counts as building and nothing is deleted.
if [ -f /tmp/.cleanup-gh-failed ]; then
  case "${FLEET_ADMIT_MODE:-off}" in
    enforce | observe) say "(GitHub's busy check failed; going by the admission slots)" ;;
    *)
      say "GitHub's busy check failed and admission is off: every runner counts as building"
      ALL_BUSY=1
      HOST_IDLE=0
      ;;
  esac
  rm -f /tmp/.cleanup-gh-failed
fi
if [ -n "$(tr -d '[:space:]' < /tmp/.cleanup-building)" ]; then
  HOST_IDLE=0
  say "a runner is BUSY:"
  sed 's/^/  /' /tmp/.cleanup-building
  say "(host-wide steps wait for an idle fleet; per-runner steps skip these runners)"
fi
rm -f /tmp/.cleanup-busy /tmp/.cleanup-building
building() {
  [ "$ALL_BUSY" = 1 ] && return 0
  case "$BUILDING" in *" $1 "*) return 0 ;; esac
  return 1
}
host_idle() {
  [ "$HOST_IDLE" = 1 ] && return 0
  say "    (skipped: a job is running)"
  return 1
}
before=$(free_gb)
say "==> free before: ${before} GB"

# This host's runners, spelled as the kit spells them in device and AVD names.
known=" "
for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  known="$known$(runner_name "$d" | tr -c 'A-Za-z0-9._\n-' '_') "
done

# ---------------------------------------------------------------------------
# Runners' own Android emulators (AVDs). First, because below the admission
# floor their snapshots are what goes before anything else.
#
# Plain "ci-<runner>" (Jerv's screenshots: "shots-<runner>"): android-emulator-
# runner creates it again at the start of every job (force-avd-creation), so
# between jobs it is 1-1.5 GB the next job overwrites anyway; on ultra
# (2026-10-22) 17 of them held 20 GB. One goes once its runner is idle and it is
# 30 minutes untouched.
#
# Snapshot "ci-<runner>-a<api>-<target>-<profile>" (the kit's android-ci with
# emulator_snapshot, taylab-launch-kit v1.38.0): the AVD and its quick-boot
# snapshot (~6 GB; the guest's 4 GB of RAM is most of it) are what the runner's
# next job boots from in seconds instead of cold. Deleting one makes that job
# boot three times (initialise, save, test) instead of once, so it is KEPT
# while its runner exists, until FLEET_CLEANUP_AVD_KEEP_DAYS without a boot.
# Two limits on the kept ones, both met by dropping snapshots/ (the AVD stays,
# so the next job only saves a new snapshot), least recently used first, never
# a building runner's, an open one, or one written in the last 30 minutes:
#   - FLEET_CLEANUP_AVD_KEEP_GB: the snapshot AVDs in all;
#   - below the admission floor (FLEET_ADMIT_MIN_FREE_DISK_GB, usable): every
#     idle snapshot, before any other step, since the floor holds every job.
# A snapshot AVD whose runner no longer exists goes like a plain one. Other
# AVDs (night QA's fleet-explore-*, a person's) are never touched.
# ---------------------------------------------------------------------------
avd_open() {
  local dir="$1" pid
  pid="$(cat "$dir/hardware-qemu.ini.lock" 2>/dev/null | tr -dc '0-9')"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
  pgrep -f -- "-avd $2( |\$)" >/dev/null 2>&1
}
avd_last_use() {
  find "$1" -maxdepth 1 -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1
}
du_kb() {
  local kb
  kb="$(du -sk "$1" 2>/dev/null | cut -f1)"
  case "$kb" in '' | *[!0-9]*) kb=0 ;; esac
  printf '%s' "$kb"
}
say "==> runners' Android emulators (snapshot AVDs: kept ${AVD_KEEP_DAYS}d unused, ${AVD_KEEP_GB} GB in all)$([ "$FLOOR" = 1 ] && echo ' — below the floor: idle snapshots go first')"
AVD_KEPT="$(mktemp -t cleanup-avd 2>/dev/null || echo "/tmp/.cleanup-avd-$$")"
: > "$AVD_KEPT"
snap_total="$AVD_SNAP_KB"
n=0
s=0
for dir in "$AVD_HOME"/*.avd; do
  [ -d "$dir" ] || continue
  avd="$(basename "$dir" .avd)"
  owner="$(emu_avd_owner "$avd" "$known" 2>/dev/null)" || continue
  runner="${owner%% *}"
  rest="${owner#* }"
  kind="${rest%% *}"
  where="${rest##* }"
  building "$runner" && continue
  avd_open "$dir" "$avd" && continue
  recent=0
  [ -n "$(find "$dir" -maxdepth 1 -mmin -30 2>/dev/null | head -1)" ] && recent=1
  if [ "$kind" = snapshot ] && [ "$where" = here ]; then
    if [ -z "$(find "$dir" -maxdepth 1 -mtime -"$AVD_KEEP_DAYS" -print -quit 2>/dev/null)" ]; then
      kb="$(du_kb "$dir")"
      say "    $(du -sh "$dir" 2>/dev/null | cut -f1)  $avd: no boot in ${AVD_KEEP_DAYS}d"
      run rm -rf "$dir" "$AVD_HOME/$avd.ini"
      snap_total=$((snap_total - kb))
      n=$((n + 1))
      continue
    fi
    [ "$recent" = 1 ] && continue
    [ -d "$dir/snapshots" ] || continue
    if [ "$FLOOR" = 1 ]; then
      kb="$(du_kb "$dir/snapshots")"
      say "    $(du -sh "$dir/snapshots" 2>/dev/null | cut -f1)  $avd/snapshots: below the floor"
      run rm -rf "$dir/snapshots" "$dir/ci-snapshot.key"
      snap_total=$((snap_total - kb))
      s=$((s + 1))
      continue
    fi
    echo "$(avd_last_use "$dir") $(du_kb "$dir/snapshots") $dir" >> "$AVD_KEPT"
    continue
  fi
  [ "$recent" = 1 ] && continue
  why=""
  [ "$where" = gone ] && why=": no such runner here"
  [ "$kind" = snapshot ] && snap_total=$((snap_total - $(du_kb "$dir")))
  say "    $(du -sh "$dir" 2>/dev/null | cut -f1)  $avd$why"
  run rm -rf "$dir" "$AVD_HOME/$avd.ini"
  n=$((n + 1))
done
cap_kb=$((AVD_KEEP_GB * 1048576))
while read -r _ kb dir; do
  [ -n "$dir" ] || continue
  [ "$snap_total" -gt "$cap_kb" ] || break
  say "    $(du -sh "$dir/snapshots" 2>/dev/null | cut -f1)  $(basename "$dir" .avd)/snapshots: least recently used over ${AVD_KEEP_GB} GB"
  run rm -rf "$dir/snapshots" "$dir/ci-snapshot.key"
  snap_total=$((snap_total - kb))
  s=$((s + 1))
done < <(sort -n "$AVD_KEPT")
rm -f "$AVD_KEPT"
say "    ${n} AVDs, ${s} snapshots; snapshot AVDs now $((snap_total / 1048576)) GB"

# ---------------------------------------------------------------------------
# DerivedData older than a week. Xcode rebuilds whatever it needs; the only cost
# of being wrong here is one slow build. Keyed on mtime, so a project being
# actively worked on is never a candidate.
# ---------------------------------------------------------------------------
say "==> DerivedData older than ${DERIVED_AGE_DAYS}d"
if [ -d "$DERIVED" ] && host_idle; then
  n=0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    sz=$(du -sh "$dir" 2>/dev/null | cut -f1)
    say "    $sz  $(basename "$dir")"
    run rm -rf "$dir"
    n=$((n + 1))
  done < <(find "$DERIVED" -maxdepth 1 -mindepth 1 -type d -mtime +${DERIVED_AGE_DAYS} 2>/dev/null)
  say "    ${n} directories"
fi

# ---------------------------------------------------------------------------
# Simulators whose runtime is no longer installed. These accumulate silently
# across Xcode upgrades and are pure waste — nothing can boot them.
# ---------------------------------------------------------------------------
say "==> unavailable simulators"
if ! host_idle; then
  :
elif [ "$APPLY" = "1" ]; then
  xcrun simctl delete unavailable 2>&1 | sed 's/^/    /'
else
  cnt=$(xcrun simctl list devices 2>/dev/null | grep -c "unavailable" || true)
  say "    [dry-run] xcrun simctl delete unavailable  (${cnt} unavailable entries listed)"
fi

# ---------------------------------------------------------------------------
# Runner diagnostic logs. The runner never rotates these itself.
# ---------------------------------------------------------------------------
say "==> runner _diag logs older than ${DIAG_AGE_DAYS}d"
n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  run rm -f "$f"
  n=$((n + 1))
done < <(find "$ROOT"/*/_diag -type f -mtime +${DIAG_AGE_DAYS} 2>/dev/null)
say "    ${n} files"

# ---------------------------------------------------------------------------
# Superseded runner versions. The runner self-updates into bin.<version> and
# externals.<version> beside the old pair and only repoints the bin/externals
# links, so every runner keeps a dead copy of the version before. At 59 runners
# that was 25 GB, and it was what held the disk floor shut on 2026-10-05. Only
# versions OLDER than the linked one go: a newer unlinked pair is an update in
# progress.
# ---------------------------------------------------------------------------
version_older() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, "."); n = na > nb ? na : nb
    for (i = 1; i <= n; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 }
    exit 1 }'
}
say "==> superseded runner versions"
n=0
for d in "$ROOT"/*/; do
  d="${d%/}"
  [ -f "$d/.runner" ] && [ -L "$d/bin" ] && [ -L "$d/externals" ] || continue
  current="$(basename "$(readlink "$d/bin")")"
  current="${current#bin.}"
  [ -d "$d/bin.$current" ] && [ "$(basename "$(readlink "$d/externals")")" = "externals.$current" ] \
    || continue
  for old in "$d"/bin.* "$d"/externals.*; do
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    v="${old##*/}"; v="${v#*.}"
    version_older "$v" "$current" || continue
    pgrep -f "$old/" >/dev/null 2>&1 && continue
    say "    $(du -sh "$old" 2>/dev/null | cut -f1)  $(basename "$d")/$(basename "$old")"
    run rm -rf "$old"
    n=$((n + 1))
  done
done
say "    ${n} directories"

# ---------------------------------------------------------------------------
# Each runner's own CI simulator. The kit's ios-ci gives every runner one device
# named "ci-<runner> <platform> <version>" and creates it again if it is gone.
# Nothing ever reset them: each kept every build installed into it, its app
# data and its logs, and the 41 devices on runner-host grew from 48 to 62 GB in
# three days (2026-10-04 to 10-07), the largest thing on the disk this script
# could take. A device is erased only while it is shut down and its runner is
# not building; a ci- device whose runner no longer exists is deleted. Other
# devices (the person's, or a shared "iPhone 17") are never touched.
# A repo that picks its own device can name it "ci-<runner> <app> <platform>
# <version>" (Jerv's ci/sim.py: "ci-ultra-jerv-2 jerv iOS 27.0"). Matching only
# the kit's shape missed those: on ultra (2026-10-22) nine of them held 19 GB
# and none had ever been erased.
# ---------------------------------------------------------------------------
sim_limit="$SIM_MAX_GB"; [ "$PRESSURE" = 1 ] && sim_limit="$SIM_PRESSURE_GB"
say "==> CI simulators over ${sim_limit} GB"
n=0
while IFS='|' read -r udid state bytes runner; do
  [ -n "$udid" ] || continue
  if [ "$state" != "Shutdown" ]; then continue; fi
  if building "$runner"; then continue; fi
  gb=$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1073741824}')
  case "$known" in
    *" $runner "*)
      awk -v b="$bytes" -v l="$sim_limit" 'BEGIN{exit !(b >= l*1073741824)}' || continue
      say "    ${gb} GB  erase ci-${runner} ($udid)"
      run xcrun simctl erase "$udid" ;;
    *)
      say "    ${gb} GB  delete ci-${runner} ($udid): no such runner here"
      run xcrun simctl delete "$udid" ;;
  esac
  n=$((n + 1))
done < <(xcrun simctl list devices -j 2>/dev/null | python3 -c '
import json, re, sys
try:
    devices = json.load(sys.stdin)["devices"]
except Exception:
    sys.exit(0)
for devs in devices.values():
    for d in devs:
        m = re.match(r"ci-(\S+) (?:\S+ )?(iOS|tvOS|watchOS|visionOS|xrOS) [0-9.]+$", d.get("name", ""))
        if m:
            print("|".join([d["udid"], d.get("state", ""), str(d.get("dataPathSize", 0)), m.group(1)]))
')
say "    ${n} devices"

# ---------------------------------------------------------------------------
# A runner's leftover self-update. The runner unpacks a new version into
# _work/_update, copies it into bin.<version>/externals.<version> and is meant
# to remove the staging copy; nine runners on ultra kept theirs (0.45 GB each,
# 2026-10-22). Only a copy older than six hours on an idle runner that no
# process is running from goes: an update in progress takes minutes.
# ---------------------------------------------------------------------------
say "==> leftover runner self-updates"
n=0
for d in "$ROOT"/*/; do
  d="${d%/}"
  up="$d/_work/_update"
  [ -f "$d/.runner" ] && [ -d "$up" ] || continue
  [ -n "$(find "$up" -maxdepth 0 -mmin +360 2>/dev/null)" ] || continue
  building "$(runner_name "$d")" && continue
  pgrep -f "$up/" >/dev/null 2>&1 && continue
  say "    $(du -sh "$up" 2>/dev/null | cut -f1)  $(basename "$d")/_work/_update"
  run rm -rf "$up"
  n=$((n + 1))
done
say "    ${n} directories"

# ---------------------------------------------------------------------------
# Warm build caches in each runner's _work/<repo>/: DerivedData-<scheme>,
# spm-* (SwiftPM checkouts) and .build-cache-*, which the kit's iOS and
# SwiftPM jobs keep per runner so a build is incremental (CI plan Phase 1.4).
# Each one is a few GB and per runner, so across 80 runners they are the disk.
# One whose newest file (two levels down, where xcodebuild and SwiftPM write on
# every build) is older than RUNNER_CACHE_DAYS goes; under pressure, all of an
# idle runner's go. Never a building runner's, never under _work/_*/ (the
# runner's own _temp, _tool, _actions), and never a directory that is a git
# checkout (a repo that happens to be named spm-something).
# ---------------------------------------------------------------------------
say "==> runner build caches unused for ${RUNNER_CACHE_DAYS}d$([ "$PRESSURE" = 1 ] && echo ' (under pressure: all of them, on idle runners)')"
n=0
for d in "$ROOT"/*/; do
  d="${d%/}"
  [ -f "$d/.runner" ] && [ -d "$d/_work" ] || continue
  building "$(runner_name "$d")" && continue
  for cache in "$d"/_work/*/DerivedData* "$d"/_work/*/spm* "$d"/_work/*/.build-cache*; do
    [ -d "$cache" ] || continue
    case "$cache" in "$d"/_work/_*) continue ;; esac
    [ -e "$cache/.git" ] && continue
    if [ "$PRESSURE" != 1 ] \
      && [ -n "$(find "$cache" -maxdepth 2 -mtime -"$RUNNER_CACHE_DAYS" -print -quit 2>/dev/null)" ]; then
      continue
    fi
    say "    $(du -sh "$cache" 2>/dev/null | cut -f1)  ${cache#"$ROOT"/}"
    run rm -rf "$cache"
    n=$((n + 1))
  done
done
say "    ${n} directories"

# ---------------------------------------------------------------------------
# Spotlight stays out of every runner's build tree. register.sh writes the
# marker for a new runner; this catches one created any other way (copied,
# restored, registered by hand). Cheap and idempotent: one test per runner.
# ---------------------------------------------------------------------------
n=0
for d in "$ROOT"/*/; do
  d="${d%/}"
  [ -f "$d/.runner" ] && [ -d "$d/_work" ] || continue
  [ -e "$d/_work/.metadata_never_index" ] && continue
  if [ "$APPLY" = "1" ]; then touch "$d/_work/.metadata_never_index" 2>/dev/null || continue; fi
  n=$((n + 1))
done
[ "$n" -gt 0 ] && say "==> Spotlight exclusion written for ${n} runner work tree(s)$([ "$APPLY" = 1 ] || echo ' [dry-run]')"

# ---------------------------------------------------------------------------
# Under pressure only: each idle runner's Playwright browsers. They are 0.5-1.1 GB
# per web runner (13 GB on runner-host) and the next job that needs them
# downloads them again, which is cheaper than a fleet held at the floor.
# ---------------------------------------------------------------------------
if [ "$PRESSURE" = 1 ]; then
  say "==> under pressure: idle runners' Playwright browsers"
  n=0
  for d in "$ROOT"/*/; do
    tc="${d}_work/_tool/ms-playwright"
    [ -d "$tc" ] && [ -f "$d/.runner" ] || continue
    building "$(runner_name "$d")" && continue
    say "    $(du -sh "$tc" 2>/dev/null | cut -f1)  $tc"
    run rm -rf "$tc"
    n=$((n + 1))
  done
  say "    ${n} directories"
fi

# ---------------------------------------------------------------------------
# Playwright browser caches and stale install locks. Browsers are large and the
# default cache is shared unless workflows set PLAYWRIGHT_BROWSERS_PATH to each
# runner's tool cache. A crashed install leaves __dirlock behind; the next job
# hangs waiting on it. Only remove locks older than PW_LOCK_AGE_HOURS, and skip
# entirely while an install is in flight.
# ---------------------------------------------------------------------------
say "==> playwright browser caches"
_pw_paths=()
[ -d "$HOME/Library/Caches/ms-playwright" ] && _pw_paths+=("$HOME/Library/Caches/ms-playwright")
for d in "$ROOT"/*/; do
  tc="$d/_work/_tool/ms-playwright"
  [ -d "$tc" ] && _pw_paths+=("$tc")
done
if [ ${#_pw_paths[@]} -eq 0 ]; then
  say "    (none found)"
else
  for p in "${_pw_paths[@]}"; do
    say "    $(du -sh "$p" 2>/dev/null | cut -f1)  $p"
  done
fi

say "==> stale playwright __dirlock (older than ${PW_LOCK_AGE_HOURS}h)"
if ! host_idle; then
  :
elif pgrep -f '[p]laywright.*install' >/dev/null 2>&1; then
  say "    playwright install in progress — skipping lock cleanup"
else
  n=0
  while IFS= read -r lock; do
    [ -n "$lock" ] || continue
    say "    $(basename "$(dirname "$lock")")/ __dirlock"
    run rm -rf "$lock"
    n=$((n + 1))
  done < <(find "$HOME/Library/Caches/ms-playwright" "$ROOT"/*/_work/_tool/ms-playwright \
    -name __dirlock \( -type f -o -type d \) -mmin +$((PW_LOCK_AGE_HOURS * 60)) 2>/dev/null)
  say "    ${n} lock files"
fi

after=$(free_gb)
say "==> free after:  ${after} GB  (reclaimed $((after - before)) GB)"
if [ "$APPLY" = "1" ]; then
  # A run that skipped the host-wide steps is not a full run: --auto tries again
  # on its next tick instead of waiting a day.
  [ "$HOST_IDLE" = 1 ] && date +%s > "$STAMP"
else
  say "==> DRY RUN — nothing was deleted. Re-run with --apply."
fi
# A partial run is a normal outcome, not a failure. Without this the stamp
# test above was the exit status, so every tick on a busy host exited 1 and
# the Homelab Map read the LaunchAgent as failing (launchd.exit-nonzero).
exit 0
