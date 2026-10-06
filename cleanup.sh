#!/usr/bin/env bash
# Reclaim the disk that CI quietly eats on this Mac.
#
#   ./cleanup.sh            # dry run — prints what it WOULD delete, touches nothing
#   ./cleanup.sh --apply    # actually delete
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
#   - never touch a runner's _work. That is where the git checkouts and build
#     caches live; wiping it makes every job re-clone and recompile from cold.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
DERIVED_AGE_DAYS=7
DIAG_AGE_DAYS=14
PW_LOCK_AGE_HOURS=6

say() { printf '%s\n' "$*"; }
run() {
  if [ "$APPLY" = "1" ]; then "$@"; else say "    [dry-run] $*"; fi
}

# ---------------------------------------------------------------------------
# Refuse to run while a job is in flight. Deleting DerivedData out from under a
# live xcodebuild produces a failure that looks like a code problem and is not
# reproducible afterwards — the worst kind of CI flake to chase.
# ---------------------------------------------------------------------------
busy=""
for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  repo=$(python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1])" 2>/dev/null) || continue
  echo "$repo"
done | sort -u | while read -r repo; do
  gh api "repos/$repo/actions/runners" --jq '.runners[] | select(.busy) | .name' 2>/dev/null
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
[ -n "$(tr -d '[:space:]' < /tmp/.cleanup-busy)" ] && [ ! -s /tmp/.cleanup-building ] \
  && say "(runners held by admission are waiting, not building — not counted)"
busy="$(tr -d '[:space:]' < /tmp/.cleanup-building)"
if [ -n "$busy" ]; then
  say "a runner is BUSY:"
  sed 's/^/  /' /tmp/.cleanup-building
  if [ "$APPLY" = 1 ]; then
    say "refusing to clean while a job is running — try again when the fleet is idle"
    rm -f /tmp/.cleanup-busy /tmp/.cleanup-building
    exit 0
  fi
  # A dry run deletes nothing, so it always runs: during a disk-floor freeze
  # the preview is exactly what someone needs to see.
  say "(dry run continues; --apply would refuse until these finish)"
fi
rm -f /tmp/.cleanup-busy /tmp/.cleanup-building

before=$(df -g / | awk 'NR==2{print $4}')
say "==> free before: ${before} GB"

# ---------------------------------------------------------------------------
# DerivedData older than a week. Xcode rebuilds whatever it needs; the only cost
# of being wrong here is one slow build. Keyed on mtime, so a project being
# actively worked on is never a candidate.
# ---------------------------------------------------------------------------
say "==> DerivedData older than ${DERIVED_AGE_DAYS}d"
if [ -d "$DERIVED" ]; then
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
if [ "$APPLY" = "1" ]; then
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
if pgrep -f '[p]laywright.*install' >/dev/null 2>&1; then
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

after=$(df -g / | awk 'NR==2{print $4}')
say "==> free after:  ${after} GB  (reclaimed $((after - before)) GB)"
[ "$APPLY" = "1" ] || say "==> DRY RUN — nothing was deleted. Re-run with --apply."
