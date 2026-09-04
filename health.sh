#!/usr/bin/env bash
# Is every runner service actually alive, and does GitHub agree?
#
#   ./health.sh           # report only
#   ./health.sh --repair  # also restart any service that is loaded but dead
#
# Why this exists: none of the 18 runner LaunchAgents sets KeepAlive. Each one
# runs runsvc.sh, which runs RunnerService.js, which supervises the listener — so
# a crashed *listener* is restarted for you. A crashed or OOM-killed
# RunnerService.js is not. launchd will not revive it, and the only symptom is
# that jobs for that one repo queue forever while every other repo looks fine.
#
# That is a silent failure with a slow tell, which is exactly what a health check
# is for. Being on a 16 GB machine that swaps under two concurrent Xcode builds
# makes an OOM kill a real possibility rather than a theoretical one.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"

REPAIR=0
[ "${1:-}" = "--repair" ] && REPAIR=1

rc=0
DRAINED=0
printf "%-42s %-10s %s\n" "SERVICE" "LAUNCHD" "GITHUB"

for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue

  name=$(python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['agentName'])" 2>/dev/null) || continue
  repo=$(python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1])" 2>/dev/null) || continue

  # A drained runner is stopped because somebody stopped it. Reporting that as a
  # fault would be wrong twice over: it sets a non-zero exit that reads as "the
  # fleet is unhealthy", and under --repair it would restart the very runner an
  # operator just took out of service. A repair that undoes a deliberate action
  # is worse than no repair at all.
  drain=""
  if [ -f "$d/.drain" ]; then
    drain=$(head -1 "$d/.drain" 2>/dev/null | tr -d '\r')
    DRAINED=$((DRAINED + 1))
    printf "%-42s %-10s %s\n" "$name" "${drain:-drained}" "(skipped — drained)"
    continue
  fi

  # The service label is derived the same way svc.sh derives it.
  label="actions.runner.$(echo "$repo" | tr '/' '-').$name"

  # `launchctl list <label>` exits non-zero when the job is not loaded at all.
  # When it is loaded, the first column is the PID or "-" if it is not running.
  if out=$(launchctl list "$label" 2>/dev/null); then
    pid=$(echo "$out" | awk -F'= ' '/"PID"/{print $2}' | tr -d ';' | tr -d ' ')
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      lstate="running"
    else
      lstate="DEAD"
      rc=1
    fi
  else
    lstate="NOT-LOADED"
    rc=1
  fi

  gstate=$(gh api "repos/$repo/actions/runners" \
    --jq ".runners[] | select(.name==\"$name\") | (if .busy then \"busy\" else .status end)" 2>/dev/null)
  [ -n "$gstate" ] || { gstate="unknown"; rc=1; }
  [ "$gstate" = "offline" ] && rc=1

  printf "%-42s %-10s %s\n" "$name" "$lstate" "$gstate"

  if [ "$REPAIR" = "1" ] && [ "$lstate" != "running" ]; then
    echo "    -> restarting $label"
    (cd "$d" && ./svc.sh stop >/dev/null 2>&1; ./svc.sh start >/dev/null 2>&1)
  fi
done

if [ "$DRAINED" != "0" ]; then
  echo
  echo "$DRAINED runner(s) are drained and were skipped. They are stopped on purpose;"
  echo "resume one with: scripts/drain-runner.sh <dir-name> --resume"
fi

if [ "$rc" != "0" ]; then
  echo
  echo "one or more runners are unhealthy — rerun with --repair to restart them"
fi
exit "$rc"
