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
#   - never touch a runner's checkouts or build caches in _work; wiping them
#     makes every job re-clone and recompile from cold. The one exception is
#     the Playwright tool cache, and only under disk pressure.
#   - never touch a simulator that is not a runner's own ci- device.
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

# --auto runs every 15 minutes, so its no-op has to cost two cheap reads and
# nothing else: the host it guards is usually saturated when the disk is short.
FREE_NOW="$(free_gb)"
PLAIN_NOW="$(fleet_plain_free_gb)"
PRESSURE=0
[ -n "$FREE_NOW" ] && [ "$FREE_NOW" -lt "$PRESSURE_GB" ] && PRESSURE=1
[ -n "$PLAIN_NOW" ] && [ "$PLAIN_NOW" -lt $((PLAIN_HARD_GB + 10)) ] && PRESSURE=1
if [ "$AUTO" = "1" ] && [ "$PRESSURE" = "0" ]; then
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
say "==> $(date '+%F %T')  free ${FREE_NOW} GB (${PLAIN_NOW} GB without purgeable), pressure line ${PRESSURE_GB} GB$([ "$PRESSURE" = 1 ] && echo '  — UNDER PRESSURE')"

# ---------------------------------------------------------------------------
# Jobs in flight. Deleting DerivedData out from under a live xcodebuild produces
# a failure that looks like a code problem and is not reproducible afterwards —
# the worst kind of CI flake to chase. So the host-wide steps wait for an idle
# fleet, and the per-runner steps (its simulator, its Playwright browsers) skip
# only the runners that are building. Refusing everything while any job ran
# meant this never ran on a busy day, which is when the disk runs out.
# ---------------------------------------------------------------------------
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
while read -r name; do
  [ -n "$name" ] || continue
  case " $held " in *" $name "*) continue ;; esac
  echo "$name" >> /tmp/.cleanup-building
done < /tmp/.cleanup-busy
# An admitted job holds a slot file with a live owner. That is local and does
# not depend on `gh` working from this session, so it counts too.
for f in "$ROOT"/.admission/slots/*; do
  [ -f "$f" ] || continue
  pid="$(sed -n 's/^pid=//p' "$f" | head -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
  sed -n 's/^runner=//p' "$f" | head -1 >> /tmp/.cleanup-building
done
sort -u -o /tmp/.cleanup-building /tmp/.cleanup-building
[ -n "$(tr -d '[:space:]' < /tmp/.cleanup-busy)" ] && [ ! -s /tmp/.cleanup-building ] \
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
# A runner directory's GitHub name, which is what GitHub and the slots use.
runner_name() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8-sig'))['agentName'])" \
    "$1/.runner" 2>/dev/null
}

before=$(free_gb)
say "==> free before: ${before} GB"

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
# ---------------------------------------------------------------------------
sim_limit="$SIM_MAX_GB"; [ "$PRESSURE" = 1 ] && sim_limit="$SIM_PRESSURE_GB"
say "==> CI simulators over ${sim_limit} GB"
known=" "
for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  known="$known$(runner_name "$d" | tr -c 'A-Za-z0-9._\n-' '_') "
done
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
        m = re.match(r"ci-(\S+) (iOS|tvOS|watchOS|visionOS|xrOS) [0-9.]+$", d.get("name", ""))
        if m:
            print("|".join([d["udid"], d.get("state", ""), str(d.get("dataPathSize", 0)), m.group(1)]))
')
say "    ${n} devices"

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
