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

# Remove SysV shared memory left by Postgres clusters a cancelled job killed, so
# this job's own cluster can get one. Independent of admission: a full table
# fails Postgres suites whether or not anything here throttles them.
[ -f "$HERE/shm-reap.sh" ] && FLEET_ROOT="$ROOT" bash "$HERE/shm-reap.sh" started

# shellcheck source=hooks/common.sh
. "$HERE/common.sh" 2>/dev/null || exit 0

[ "$ADMIT_MODE" = "off" ] && exit 0

KEY="$(admit_key)"

# Why the single lane would hold the job on capacity, or empty. Callers must
# hold the mutex, because the count it reads is only meaningful under it.
admit_capacity_blocker() {
  local busy="$1" simulator_busy="$2"
  if [ "$busy" -ge "$ADMIT_MAX" ]; then
    printf '%s job(s) already running, at the limit of %s' "$busy" "$ADMIT_MAX"
    return 0
  fi
  if admit_simulator_blocked "$simulator_busy"; then
    printf '%s Simulator job(s) already running, at the limit of %s' \
      "$simulator_busy" "$ADMIT_SIMULATOR_MAX"
    return 0
  fi
  return 0
}

# The disk floors, shared by both policies.
admit_disk_blocker() {
  local disk
  # `|| disk=""`: production runs this under bash -e, where a failed read
  # would exit the hook, and its EXIT trap admits the job without a slot.
  disk="$(admit_free_disk_gb)" || disk=""
  if [ -n "$disk" ] && [ "$disk" -lt "$ADMIT_MIN_DISK_GB" ]; then
    printf '%s GB disk free, below the %s GB floor' "$disk" "$ADMIT_MIN_DISK_GB"
    return 0
  fi
  disk="$(admit_plain_free_disk_gb)" || disk=""
  if [ -n "$disk" ] && [ "$disk" -lt "$ADMIT_MIN_PLAIN_DISK_GB" ]; then
    printf '%s GB plain disk free, below the %s GB hard floor' "$disk" "$ADMIT_MIN_PLAIN_DISK_GB"
    return 0
  fi
  return 0
}

# Works out both policies' answer for this moment, under the mutex. Sets
# ADMIT_GATE_BLOCKER (what decides: the lanes in lanes-enforce, the single lane
# otherwise; empty = room) and, with lanes on, ADMIT_LANE_BLOCKER (the lanes'
# answer, logged beside the decision). The per-lane and single-lane queue
# order are the caller's, because only a waiter has a place in a line.
ADMIT_GATE_BLOCKER=""
admit_decide() {
  local busy="$1" simulator_busy="$2" legacy="" lane="" disk=""
  [ "$ADMIT_LANES" = enforce ] || legacy="$(admit_capacity_blocker "$busy" "$simulator_busy")"
  if [ "$ADMIT_LANES" != off ]; then
    admit_lane_counts "$busy"
    lane="$(admit_lane_capacity_blocker "$busy" "$simulator_busy")"
  fi
  if { [ "$ADMIT_LANES" != enforce ] && [ -z "$legacy" ]; } \
    || { [ "$ADMIT_LANES" != off ] && [ -z "$lane" ]; }; then
    disk="$(admit_disk_blocker)"
  fi
  [ -n "$legacy" ] || legacy="$disk"
  [ -n "$lane" ] || lane="$disk"
  if [ "$ADMIT_LANES" = enforce ]; then
    ADMIT_GATE_BLOCKER="$lane"
  else
    ADMIT_GATE_BLOCKER="$legacy"
  fi
  if [ "$ADMIT_LANES" != off ]; then
    ADMIT_LANE_BLOCKER="$lane"
    ADMIT_LANE_VIEWED=1
  fi
  return 0
}

# observe-lanes only: the lanes' answer for a waiter the single line keeps
# behind an older job, read without the mutex (slots are counted, not reaped,
# and the disk is re-read at most every 30 s). It is a log field, not a
# decision, and it stops being worked out once the lanes would have admitted.
ADMIT_DISK_AT=-1000
ADMIT_DISK_REASON=""
admit_lane_view_lockless() {
  local total simulator_busy now
  total="$(ls -1 "$ADMIT_SLOTS" 2>/dev/null | wc -l | tr -d ' ')"
  simulator_busy="$(admit_live_simulator_slots)"
  admit_lane_counts "$total"
  ADMIT_LANE_BLOCKER="$(admit_lane_capacity_blocker "$total" "$simulator_busy")"
  if [ -z "$ADMIT_LANE_BLOCKER" ]; then
    now="$(admit_now)"
    if [ $((now - ADMIT_DISK_AT)) -ge 30 ]; then
      ADMIT_DISK_REASON="$(admit_disk_blocker)"
      ADMIT_DISK_AT="$now"
    fi
    ADMIT_LANE_BLOCKER="$ADMIT_DISK_REASON"
  fi
  if [ -z "$ADMIT_LANE_BLOCKER" ] && admit_waiting_behind_older_in_lane; then
    ADMIT_LANE_BLOCKER="$(admit_lane_queue_reason)"
  fi
  ADMIT_LANE_VIEWED=1
  return 0
}

# Network, so outside the mutex and once per job: the lane cannot change while
# the job waits.
admit_classify

# observe: take the slot so the count stays honest, never delay anything, and
# record whether enforcing would have held this job. Mirrors autoscaleDryRun —
# the log has to look right before the mechanism is allowed to cost a build.
if [ "$ADMIT_MODE" = "observe" ]; then
  BUSY=0
  SIMULATOR_BUSY=0
  BLOCKER=""
  if admit_lock; then
    BUSY="$(admit_live_slots)"
    SIMULATOR_BUSY="$(admit_live_simulator_slots)"
    admit_decide "$BUSY" "$SIMULATOR_BUSY"
    BLOCKER="$ADMIT_GATE_BLOCKER"
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
ADMIT_WAIT_START="$(admit_now)"
ANNOUNCED=0
TIMEOUT_ANNOUNCED=0
LAST_CANCEL_CHECK=-1
admit_resolve_wait_owner
admit_resolve_worker_log || true
while :; do
  WAITED=$(($(admit_now) - ADMIT_WAIT_START))
  BUSY=0
  SIMULATOR_BUSY=0
  STRICT_LIMIT=0
  BLOCKER=""
  if admit_owner_gone; then
    admit_leave_waiters
    admit_log orphaned 'its Runner.Worker exited while it waited' "$WAITED" "$BUSY"
    exit 0
  fi
  # Every poll, not every cancel poll: it is a local grep, and GitHub shows
  # nothing for minutes after a cancel (see admit_resolve_worker_log).
  if admit_worker_cancelled; then
    admit_leave_waiters
    admit_log cancelled 'the runner was told to cancel this job' "$WAITED" "$BUSY"
    echo "fleet: job cancelled while waiting — releasing this runner"
    exit 0
  fi
  # Only the oldest waiter in a line can be admitted, so a later one decides
  # nothing under the mutex (see admit_waiting_behind_older). With lanes
  # enforced the line is the job's own lane, not the host.
  BEHIND=0
  if [ "$ADMIT_LANES" = enforce ]; then
    if admit_waiting_behind_older_in_lane; then
      BEHIND=1
      BLOCKER="$(admit_lane_queue_reason)"
      ADMIT_LANE_BLOCKER="$BLOCKER"
      ADMIT_LANE_VIEWED=1
    fi
  elif admit_waiting_behind_older; then
    BEHIND=1
    BLOCKER="an older job is waiting for the next host slot"
    if [ "$ADMIT_LANES" = observe ] && [ -z "$ADMIT_LANE_WAIT" ]; then
      admit_lane_view_lockless
      [ -n "$ADMIT_LANE_BLOCKER" ] || ADMIT_LANE_WAIT="$WAITED"
    fi
  fi
  if [ "$BEHIND" -eq 1 ]; then
    :
  elif admit_lock; then
    admit_join_waiters "$KEY" || true
    BUSY="$(admit_live_slots)"
    SIMULATOR_BUSY="$(admit_live_simulator_slots)"
    admit_simulator_blocked "$SIMULATOR_BUSY" && STRICT_LIMIT=1
    admit_decide "$BUSY" "$SIMULATOR_BUSY"
    BLOCKER="$ADMIT_GATE_BLOCKER"
    if [ "$ADMIT_LANES" = enforce ]; then
      if [ -z "$BLOCKER" ] \
        && ! admit_waiter_is_first_in_lane "$SIMULATOR_BUSY"; then
        BLOCKER="$(admit_lane_queue_reason)"
        ADMIT_LANE_BLOCKER="$BLOCKER"
      fi
    elif [ -z "$BLOCKER" ] \
      && ! admit_waiter_is_first_eligible "$SIMULATOR_BUSY"; then
      BLOCKER="an older job is waiting for the next host slot"
    fi
    # observe-lanes: would the job's own line have let it go? And from when.
    if [ "$ADMIT_LANES" = observe ]; then
      # noreap: the single line's own check has just reaped, or had no need
      # to (the host was full, which holds the lanes too).
      if [ -z "$ADMIT_LANE_BLOCKER" ] \
        && ! admit_waiter_is_first_in_lane "$SIMULATOR_BUSY" noreap; then
        ADMIT_LANE_BLOCKER="$(admit_lane_queue_reason)"
      fi
      [ -n "$ADMIT_LANE_BLOCKER" ] || [ -n "$ADMIT_LANE_WAIT" ] || ADMIT_LANE_WAIT="$WAITED"
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
    # Mutex contended — retry on the next poll tick. Enforce mode keeps the
    # host limit strict; skipping the count here was the source of bursts past
    # FLEET_ADMIT_MAX_CONCURRENT under simultaneous job starts.
    :
  fi

  # Runner.Worker never interrupts this hook when its run is cancelled. The
  # worker's log above usually answers first; this catches a run that ended
  # some other way, and a host where the log cannot be found.
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
    && [ "$ADMIT_TIMEOUT_ACTION" = "admit" ] \
    && [ "$STRICT_LIMIT" -eq 0 ]; then
    # Compatibility mode: bounded wait reached, so admit despite the host or
    # disk limit. The Simulator limit stays strict because exceeding it is what
    # causes watchdog crashes and interactive crash dialogs.
    admit_leave_waiters
    admit_claim_slot "$KEY"
    admit_log timeout "$BLOCKER" "$WAITED" "$BUSY"
    exit 0
  fi

  if [ "$WAITED" -ge "$ADMIT_MAX_WAIT" ] \
    && { [ "$ADMIT_TIMEOUT_ACTION" = "hold" ] || [ "$STRICT_LIMIT" -eq 1 ]; } \
    && [ "$TIMEOUT_ANNOUNCED" -eq 0 ]; then
    admit_log continued-hold "$BLOCKER" "$WAITED" "$BUSY"
    echo "fleet: admission wait reached ${ADMIT_MAX_WAIT}s; keeping the active resource limit strict"
    TIMEOUT_ANNOUNCED=1
  fi

  # Logged once per hold rather than once per poll, so a ten-minute wait is one
  # line and a `held`/`admitted` pair carries the total in waited_s.
  if [ "$ANNOUNCED" -eq 0 ]; then
    admit_log held "$BLOCKER" 0 "$BUSY"
    ANNOUNCED=1
    if [ "$ADMIT_TIMEOUT_ACTION" = "hold" ] || [ "$STRICT_LIMIT" -eq 1 ]; then
      echo "fleet: holding this job — $BLOCKER (strict resource limit)"
    else
      echo "fleet: holding this job — $BLOCKER (waiting up to ${ADMIT_MAX_WAIT}s)"
    fi
  fi

  sleep "$ADMIT_POLL"
done
