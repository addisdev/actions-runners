#!/usr/bin/env bash
# Runs before a job's first step, via ACTIONS_RUNNER_HOOK_JOB_STARTED in each
# runner's .env. This is the only place in the fleet where code runs BEFORE a
# job is allowed to begin, which is what makes admission control possible at
# all.
#
# THE PROBLEM THIS EXISTS FOR, quoted from lib/capacity.js because it says it
# best: nothing in this fleet throttles EXECUTION. There is no scheduler. Every
# registered runner listens independently, and if 27 of them are offered work in
# the same second, 27 jobs start — which is how this host recorded a load
# average of 760. `ceiling` only refuses to ADD a runner; it cannot stop a burst
# across runners that already exist. This hook can.
#
# THIS HOOK CAN NEVER FAIL A JOB. A non-zero exit from a job-started hook fails
# the job before its first step, so an admission controller that errors would
# turn every build on the host red at once — strictly worse than the thrashing
# it was added to prevent. Hence the EXIT trap below and the absence of `set -e`:
# every unexpected condition here means "let the job run".
#
# TWO COSTS WORTH KNOWING BEFORE ENABLING enforce MODE:
#
#   A held job is IN PROGRESS as far as GitHub is concerned, so the hold counts
#   against that job's own `timeout-minutes`. The wait is bounded for exactly
#   this reason, and the job is admitted anyway when the bound is reached.
#
#   The hold also counts toward the job's measured duration, which means it
#   lands in the duration percentiles on the Analytics tab. waited_s is recorded
#   on every decision so that time can be attributed rather than silently
#   inflating the numbers the capacity work depends on.

# Belt and braces on top of the error tolerance below: whatever happens in this
# script, the job runs.
trap 'exit 0' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"

# Apple simulators have no supported per-device mute. For runners selected in
# fleet.env, mute the host for the job and let a detached guardian restore it
# even if cancellation prevents the completed hook from running.
[ -f "$HERE/audio-control.sh" ] && FLEET_ROOT="$ROOT" bash "$HERE/audio-control.sh" start

# Selected simulator jobs take a cancellation-safe lease before their first
# step. The final overlapping job to finish shuts down only devices that were
# not already booted before CI began.
[ -f "$HERE/simulator-control.sh" ] && FLEET_ROOT="$ROOT" bash "$HERE/simulator-control.sh" start

# shellcheck source=hooks/common.sh
. "$HERE/common.sh" 2>/dev/null || exit 0

[ "$ADMIT_MODE" = "off" ] && exit 0

KEY="$(admit_key)"

# Why the job would be held right now, or empty if there is room. Callers must
# hold the mutex, because the count it reads is only meaningful under it.
admit_blocker() {
  local busy="$1" disk
  if [ "$busy" -ge "$ADMIT_MAX" ]; then
    printf '%s job(s) already running, at the limit of %s' "$busy" "$ADMIT_MAX"
    return 0
  fi
  disk="$(admit_free_disk_gb)"
  if [ -n "$disk" ] && [ "$disk" -lt "$ADMIT_MIN_DISK_GB" ]; then
    printf '%s GB disk free, below the %s GB floor' "$disk" "$ADMIT_MIN_DISK_GB"
    return 0
  fi
  return 0
}

# observe: take the slot so the count stays honest, never delay anything, and
# record whether enforcing would have held this job. Mirrors autoscaleDryRun —
# the log has to look right before the mechanism is allowed to cost a build.
if [ "$ADMIT_MODE" = "observe" ]; then
  BUSY=0
  BLOCKER=""
  if admit_lock; then
    BUSY="$(admit_live_slots)"
    BLOCKER="$(admit_blocker "$BUSY")"
    admit_claim_slot "$KEY"
    admit_unlock
  else
    admit_claim_slot "$KEY"
  fi
  if [ -n "$BLOCKER" ]; then
    admit_log would-hold "$BLOCKER" 0 "$BUSY"
  else
    admit_log observed '' 0 "$BUSY"
  fi
  exit 0
fi

# enforce
WAITED=0
ANNOUNCED=0
TIMEOUT_ANNOUNCED=0
LAST_CANCEL_CHECK=-1
while :; do
  BUSY=0
  BLOCKER=""
  if admit_lock; then
    admit_join_waiters "$KEY" || true
    BUSY="$(admit_live_slots)"
    if admit_waiter_is_first; then
      BLOCKER="$(admit_blocker "$BUSY")"
    else
      BLOCKER="an older job is waiting for the next host slot"
    fi
    if [ -z "$BLOCKER" ]; then
      admit_claim_slot "$KEY"
      admit_leave_waiters
      admit_unlock
      admit_log admitted '' "$WAITED" "$BUSY"
      exit 0
    fi
    admit_unlock
  else
    # Lock contention is not a reason to stop CI. The count may be off by one
    # for a moment; a build blocked by a mutex would be off by a lot more.
    admit_leave_waiters
    admit_claim_slot "$KEY"
    admit_log admitted 'mutex unavailable, admitted without counting' "$WAITED" 0
    exit 0
  fi

  # Runner.Worker does not reliably interrupt a hook that is sleeping when its
  # run is cancelled. Polling lets the hook return so the worker can observe the
  # cancellation and become available for another job.
  if [ "$LAST_CANCEL_CHECK" -lt 0 ] \
    || [ $((WAITED - LAST_CANCEL_CHECK)) -ge "$ADMIT_CANCEL_POLL" ]; then
    LAST_CANCEL_CHECK="$WAITED"
    if admit_run_completed; then
      admit_leave_waiters
      admit_log cancelled 'GitHub run completed while waiting' "$WAITED" "$BUSY"
      echo "fleet: run ended while waiting — releasing this runner"
      exit 0
    fi
  fi

  if [ "$WAITED" -ge "$ADMIT_MAX_WAIT" ] \
    && [ "$ADMIT_TIMEOUT_ACTION" = "admit" ]; then
    # Compatibility mode: bounded wait reached, so admit despite the limit.
    admit_leave_waiters
    admit_claim_slot "$KEY"
    admit_log timeout "$BLOCKER" "$WAITED" "$BUSY"
    exit 0
  fi

  if [ "$WAITED" -ge "$ADMIT_MAX_WAIT" ] \
    && [ "$ADMIT_TIMEOUT_ACTION" = "hold" ] \
    && [ "$TIMEOUT_ANNOUNCED" -eq 0 ]; then
    admit_log continued-hold "$BLOCKER" "$WAITED" "$BUSY"
    echo "fleet: admission wait reached ${ADMIT_MAX_WAIT}s; keeping the host limit strict"
    TIMEOUT_ANNOUNCED=1
  fi

  # Logged once per hold rather than once per poll, so a ten-minute wait is one
  # line and a `held`/`admitted` pair carries the total in waited_s.
  if [ "$ANNOUNCED" -eq 0 ]; then
    admit_log held "$BLOCKER" 0 "$BUSY"
    ANNOUNCED=1
    if [ "$ADMIT_TIMEOUT_ACTION" = "hold" ]; then
      echo "fleet: holding this job — $BLOCKER (strict host limit)"
    else
      echo "fleet: holding this job — $BLOCKER (waiting up to ${ADMIT_MAX_WAIT}s)"
    fi
  fi

  sleep "$ADMIT_POLL"
  WAITED=$((WAITED + ADMIT_POLL))
done
