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
BUSY_HERE=0
COOLING=0

# WHAT A REPAIR MAY STOP. `svc.sh stop` on a runner that is running a job kills
# the job ("The self-hosted runner lost communication with the server"). So a
# repair never stops a runner with a Runner.Worker under its directory, whatever
# GitHub says: the process table is a fact about this host, GitHub's "offline" is
# a report about it.
#
# GitHub's runner list is wrong at once for a whole host every night near 03:00
# UTC: every live listener, busy ones included, listed offline while it was
# long-polling the broker without an error. Seen on ultra on most nights since
# 2026-10-12 and on forge on its first night as coordinator. On 2026-11-25 this
# job restarted all 60 forge runners and all 80 ultra runners every sweep from
# 03:01Z to 03:29Z: a restarted listener meets "A session for this runner
# already exists" and stays offline for a minute or two, so the next sweep
# found them offline again, and the jobs they had taken in between were killed
# (16 of them, aliquant PR #158 among them). So:
#   - one restart per runner per FLEET_HEALTH_RESTART_COOLDOWN_S, for GitHub's
#     word alone, so a listener gets time to win its session back;
#   - when FLEET_HEALTH_MASS_OFFLINE or more listeners that are running here are
#     listed offline in one sweep, that is GitHub or the network, not that many
#     listeners, and none of them is restarted. The listener reconnects on its
#     own once GitHub does; a launchd job that is dead or unloaded is still
#     restarted, since that is a fact about this host.
#   - FLEET_HEALTH_MASS_OFFLINE=0 turns the hold off.
COOLDOWN_S="${FLEET_HEALTH_RESTART_COOLDOWN_S:-600}"
MASS_OFFLINE="${FLEET_HEALTH_MASS_OFFLINE:-3}"
STAMPS="${FLEET_HEALTH_STAMP_DIR:-$ROOT/logs/health-restarts}"
OFFLINE_CANDIDATES=""

# busy_here <runner dir>: a job is running on this runner, or ps cannot tell
# (which counts as busy: a repair that cannot see must not stop anything).
# Same test as cleanup.sh's busy_now: a Runner.Worker whose path starts with
# the runner's bin (bin/ or a self-updated bin.<version>/).
busy_here() {
  local dir="${1%/}" procs
  procs="$("${FLEET_PS:-/bin/ps}" -axo command= 2>/dev/null)" || return 0
  printf '%s\n' "$procs" \
    | awk -v d="$dir/bin" 'index($0, d) == 1 && /Runner\.Worker/ { f = 1 } END { exit !f }'
}

# restarted_ago <name>: seconds since this job last restarted it, or empty.
restarted_ago() {
  local t
  t="$(cat "$STAMPS/$1" 2>/dev/null)" || return 0
  case "$t" in ''|*[!0-9]*) return 0 ;; esac
  echo $(( $(date +%s) - t ))
}

# restart_runner <runner dir> <label> <name>: stop and start, unless a job has
# started on it since it was judged. Checked again here, right before the stop.
restart_runner() {
  local d="$1" label="$2" name="$3"
  if busy_here "$d"; then
    echo "    -> $label is running a job here; not restarted"
    return 0
  fi
  echo "    -> restarting $label"
  mkdir -p "$STAMPS" 2>/dev/null && date +%s > "$STAMPS/$name" 2>/dev/null
  (cd "$d" && ./svc.sh stop >/dev/null 2>&1; ./svc.sh start >/dev/null 2>&1)
}

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
# On an agent host 127.0.0.1:7878 is the coordinator's (a tunnel), whose
# `.runners` are its own host's only; `.fleetRunners` carries every host's, with
# the same GitHub fields. Reading only `.runners` sent ultra's 80 runners to
# GitHub every minute after the coordinator moved to forge (2026-11-24).
#
# Empty when the dashboard is not running, is not this host's, or stopped
# collecting; health.sh must keep working then, because it is what notices.
DASHBOARD_URL="${FLEET_HEALTH_STATE_URL-http://127.0.0.1:${FLEET_PORT:-7878}/api/state}"
DASHBOARD_MAX_AGE_S="${FLEET_HEALTH_STATE_MAX_AGE_S:-180}"
DASHBOARD_STATES=""
if [ -n "$DASHBOARD_URL" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  DASHBOARD_STATES="$(curl -fsS --max-time 5 "$DASHBOARD_URL" 2>/dev/null | jq -r --argjson max "$DASHBOARD_MAX_AGE_S" '
    select(((now * 1000) - (.collector.lastFast // 0)) < ($max * 1000))
    | (.runners[], (.fleetRunners // [])[])
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

  [ "$REPAIR" = "1" ] || continue

  # launchd says the service is dead or unloaded: a fact about this host.
  if [ "$lstate" != "running" ]; then
    restart_runner "$d" "$label" "$name"
    continue
  fi

  # A listener can remain alive locally while GitHub has dropped its session,
  # and restarting it is the only way to get a fresh one. But GitHub lists busy
  # runners offline too (see WHAT A REPAIR MAY STOP above), so its word alone
  # never stops a runner that is running a job, and is acted on only after the
  # sweep has seen how many runners it says it about.
  if [ "$gstate" = "offline" ]; then
    if busy_here "$d"; then
      echo "    -> running a job here; GitHub's offline is not acted on"
      BUSY_HERE=$((BUSY_HERE + 1))
      continue
    fi
    ago="$(restarted_ago "$name")"
    if [ -n "$ago" ] && [ "$ago" -ge 0 ] && [ "$ago" -lt "$COOLDOWN_S" ]; then
      echo "    -> restarted ${ago}s ago; giving it until ${COOLDOWN_S}s to reconnect"
      COOLING=$((COOLING + 1))
      continue
    fi
    OFFLINE_CANDIDATES="$OFFLINE_CANDIDATES$d	$label	$name
"
  fi
done

if [ -n "$OFFLINE_CANDIDATES" ]; then
  n_offline=$(printf '%s' "$OFFLINE_CANDIDATES" | grep -c .)
  total_offline=$((n_offline + BUSY_HERE + COOLING))
  if [ "$MASS_OFFLINE" -gt 0 ] 2>/dev/null && [ "$total_offline" -ge "$MASS_OFFLINE" ]; then
    echo
    echo "GitHub lists $total_offline runner(s) offline whose listeners are running here."
    echo "That many at once is GitHub or the network, not the listeners: none restarted"
    echo "(threshold FLEET_HEALTH_MASS_OFFLINE=$MASS_OFFLINE). They reconnect on their own."
  else
    while IFS='	' read -r d label name; do
      [ -n "$d" ] || continue
      restart_runner "$d" "$label" "$name"
    done <<< "$OFFLINE_CANDIDATES"
  fi
fi

if [ "$BUSY_HERE" != "0" ]; then
  echo
  echo "$BUSY_HERE runner(s) GitHub lists offline are running a job here; left alone."
fi

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
