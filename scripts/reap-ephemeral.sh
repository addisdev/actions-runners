#!/usr/bin/env bash
# Remove ephemeral runner directories that nothing owns any more.
#
#   scripts/reap-ephemeral.sh                # show what would be removed
#   scripts/reap-ephemeral.sh --apply
#   scripts/reap-ephemeral.sh --apply --min-age-hours 1
#
# WHY THIS EXISTS EVEN THOUGH ephemeral-runner.sh CLEANS UP AFTER ITSELF
#
# Its cleanup runs from a trap, and a trap cannot run if the process was SIGKILLed,
# if the machine lost power, or if it was killed by the OOM reaper — which on a
# 16 GB machine running Xcode is a real event rather than a theoretical one. Each
# of those leaves a directory holding an unpacked runner and a full checkout,
# and nothing else will ever remove it.
#
# So this is the backstop, and it is written to be safe to run from a timer: it
# refuses to touch a directory with a live process in it, and it refuses anything
# younger than the minimum age, because a running ephemeral job looks exactly like
# an abandoned one apart from those two checks.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"
EPH="$ROOT/.ephemeral"

APPLY=0
# Two hours by default. Long enough that a slow Xcode build in progress is never
# a candidate, short enough that leftovers do not accumulate for a whole day.
MIN_AGE_HOURS=2
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --min-age-hours) shift; MIN_AGE_HOURS="${1:?--min-age-hours needs a value}" ;;
    -h | --help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

case "$MIN_AGE_HOURS" in
  '' | *[!0-9]*) echo "--min-age-hours must be a whole number of hours" >&2; exit 1 ;;
esac

if [ ! -d "$EPH" ]; then
  echo "no $EPH directory — nothing has run an ephemeral runner on this host"
  exit 0
fi

CANDIDATES=0
SKIPPED=0
FREED_KB=0

for dir in "$EPH"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"

  # A live process inside the directory means a job is running. This is the check
  # that makes the script safe to run on a timer: without it, a sweep during a
  # 40-minute build would delete the build.
  if pgrep -f "$dir" >/dev/null 2>&1; then
    echo "  $name: SKIP — a process is still running in it"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Age from the directory's own mtime. A younger directory is left alone even
  # with no process in it, because registration takes a while and there is a
  # window where the directory exists and run.sh has not started.
  age_seconds=$(( $(date +%s) - $(stat -f %m "$dir" 2>/dev/null || echo 0) ))
  age_hours=$(( age_seconds / 3600 ))
  if [ "$age_hours" -lt "$MIN_AGE_HOURS" ]; then
    echo "  $name: SKIP — only ${age_hours}h old (minimum ${MIN_AGE_HOURS}h)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  size_kb="$(du -sk "$dir" 2>/dev/null | cut -f1)"
  size_kb="${size_kb:-0}"
  echo "  $name: remove — ${age_hours}h old, $((size_kb / 1024)) MB"
  CANDIDATES=$((CANDIDATES + 1))
  FREED_KB=$((FREED_KB + size_kb))

  [ "$APPLY" -eq 1 ] || continue

  # Still registered means the trap never ran. Removing it from GitHub first
  # stops it lingering there as a permanently offline runner that somebody has to
  # clean up by hand.
  if [ -f "$dir/.runner" ]; then
    repo="$(python3 -c "import json;print(json.load(open('$dir/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1])" 2>/dev/null || true)"
    if [ -n "$repo" ]; then
      echo "    removing its registration from $repo"
      token="$(gh api -X POST "repos/$repo/actions/runners/remove-token" --jq .token 2>/dev/null || true)"
      if [ -n "$token" ]; then
        (cd "$dir" && ./config.sh remove --token "$token" >/dev/null 2>&1) || true
      else
        echo "    warn: could not mint a removal token — it may linger on GitHub as offline"
      fi
    fi
  fi

  # Guarded for the same reason as in ephemeral-runner.sh: an rm -rf driven by a
  # variable is worth checking twice, however it was built.
  case "$dir" in
    "$EPH/"*) rm -rf "$dir" ;;
    *) echo "    refusing to delete an unexpected path: $dir" >&2 ;;
  esac
done

echo
if [ "$CANDIDATES" -eq 0 ]; then
  echo "nothing to reap${SKIPPED:+ ($SKIPPED still in use or too new)}"
  exit 0
fi

echo "$CANDIDATES directory(ies), $((FREED_KB / 1024)) MB${SKIPPED:+; $SKIPPED skipped}"
if [ "$APPLY" -eq 0 ]; then
  echo
  echo "dry run — nothing was removed. Re-run with --apply."
fi
