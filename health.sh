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
UNANSWERED=0
DIRECT=0

# GitHub's view of the runners, without spending GitHub's allowance on it.
#
# This used to ask GitHub once per runner on every sweep: 68 runners at 37 sweeps
# an hour was 2,500 calls an hour, half the account's 5,000, measured from this
# job's own log on 2026-11-02. That budget is shared with every agent and session
# on the login, and the account ran dry 15 minutes before each reset. The
# dashboard already holds this answer: it lists every repo's runners on its fast
# loop with ETags, so a quiet repo costs nothing. Ask it first, and ask GitHub
# only when it has no answer or the answer would call a runner faulty.
#
# Empty when the dashboard is not running, is not this host's, or stopped
# collecting; health.sh must keep working then, because it is what notices.
DASHBOARD_URL="${FLEET_HEALTH_STATE_URL-http://127.0.0.1:${FLEET_PORT:-7878}/api/state}"
DASHBOARD_MAX_AGE_S="${FLEET_HEALTH_STATE_MAX_AGE_S:-180}"
DASHBOARD_STATES=""
if [ -n "$DASHBOARD_URL" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  DASHBOARD_STATES="$(curl -fsS --max-time 5 "$DASHBOARD_URL" 2>/dev/null | jq -r --argjson max "$DASHBOARD_MAX_AGE_S" '
    select(((now * 1000) - (.collector.lastFast // 0)) < ($max * 1000))
    | .runners[]
    | [.name, (if .ghUnknown then "unknown"
               elif (.registered | not) then "not-registered"
               elif .ghBusy then "busy"
               else (.ghStatus // "unknown") end)]
    | @tsv' 2>/dev/null)" || DASHBOARD_STATES=""
fi

# Without the dashboard, one cached call per repo rather than one per runner. A
# repo's runners share the answer, and ten minutes between looks costs ~30 repos
# 180 calls an hour instead of 2,500.
GH_CACHE="${FLEET_HEALTH_GH_CACHE:-600s}"
github_state() { # github_state <repo> <name> [--cache <ttl>]
  local repo="$1" name="$2"
  shift 2
  gh api "repos/$repo/actions/runners?per_page=100" "$@" \
    --jq ".runners[] | select(.name==\"$name\") | (if .busy then \"busy\" else .status end)" 2>/dev/null
}

printf "%-42s %-10s %s\n" "SERVICE" "LAUNCHD" "GITHUB"

for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue

  # plutil is built into macOS and reads the runner's BOM-prefixed JSON without
  # depending on /usr/bin/python3, which Xcode can block behind a license prompt.
  if ! name=$(plutil -extract agentName raw -o - "$d/.runner" 2>/dev/null); then
    printf "%-42s %-10s %s\n" "$(basename "$d")" "UNKNOWN" "invalid .runner"
    rc=1
    continue
  fi
  if url=$(plutil -extract gitHubUrl raw -o - "$d/.runner" 2>/dev/null); then
    repo="${url#https://github.com/}"
  else
    printf "%-42s %-10s %s\n" "$name" "UNKNOWN" "invalid .runner"
    rc=1
    continue
  fi

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

  # Two different "no answer"s. GitHub not answering (rate limit, network, an
  # expired token) says nothing about this runner: report it, but do not call the
  # fleet unhealthy, or every API blip turns the health job red across 60
  # runners at once. GitHub answering without this runner means its
  # registration is gone, which is a real fault.
  #
  # A secondhand or cached answer never convicts a runner. Restarting a listener
  # on a ten-minute-old "offline" would repeat every sweep after it had already
  # recovered, so anything but online or busy is asked again, fresh. That is at
  # most one call per faulty runner per sweep, and a dashboard that is waiting out
  # a rate limit says "unknown", which spends nothing.
  gstate=""
  answered=1
  if [ -n "$DASHBOARD_STATES" ]; then
    gstate="$(printf '%s\n' "$DASHBOARD_STATES" | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }')"
  fi
  if [ -z "$gstate" ]; then
    DIRECT=$((DIRECT + 1))
    gstate=$(github_state "$repo" "$name" --cache "$GH_CACHE") || answered=0
    [ "$answered" = "1" ] && [ -z "$gstate" ] && gstate="not-registered"
  fi
  case "$gstate" in
    online|busy) ;;
    unknown) answered=0 ;;
    *)
      if [ "$answered" = "1" ]; then
        DIRECT=$((DIRECT + 1))
        gstate=$(github_state "$repo" "$name") || answered=0
      fi
      ;;
  esac
  if [ "$answered" = "1" ]; then
    [ -n "$gstate" ] || gstate="not-registered"
    [ "$gstate" = "not-registered" ] && rc=1
  else
    gstate="unknown (GitHub did not answer)"
    UNANSWERED=$((UNANSWERED + 1))
  fi
  [ "$gstate" = "offline" ] && rc=1

  printf "%-42s %-10s %s\n" "$name" "$lstate" "$gstate"

  # A listener can remain alive locally while GitHub has dropped its session.
  # Restarting that idle listener is the only way to establish a fresh session;
  # drained runners were already excluded above, and a busy runner is never
  # reported as offline.
  if [ "$REPAIR" = "1" ] && { [ "$lstate" != "running" ] || [ "$gstate" = "offline" ]; }; then
    echo "    -> restarting $label"
    (cd "$d" && ./svc.sh stop >/dev/null 2>&1; ./svc.sh start >/dev/null 2>&1)
  fi
done

if [ "$DRAINED" != "0" ]; then
  echo
  echo "$DRAINED runner(s) are drained and were skipped. They are stopped on purpose;"
  echo "resume one with: scripts/drain-runner.sh <dir-name> --resume"
fi

if [ "$UNANSWERED" != "0" ]; then
  echo
  echo "GitHub did not answer for $UNANSWERED runner(s); their GitHub state is unknown."
  echo "That is not counted as unhealthy. Their launchd state above was still checked."
fi

# The count the log was missing: this is what tells you what a sweep costs.
echo
echo "Asked GitHub directly $DIRECT time(s) this sweep (a cached answer costs nothing)."

if [ "$rc" != "0" ]; then
  echo
  echo "one or more runners are unhealthy — rerun with --repair to restart them"
fi
exit "$rc"
