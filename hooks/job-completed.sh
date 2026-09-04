#!/usr/bin/env bash
# Runs after a job's last step, via ACTIONS_RUNNER_HOOK_JOB_COMPLETED in each
# runner's .env. Its whole job is to give back the slot that job-started.sh
# took, so the next queued job can start.
#
# The PID check in common.sh means a leaked slot is eventually reclaimed even if
# this never runs — a job killed with SIGKILL skips its completed hook. This is
# the fast path, not the only path: without it a slot would sit occupied until
# the next admission noticed the worker had exited, which on an idle host could
# be the next push.
#
# Same rule as the started hook: never fail. A non-zero exit here marks the job
# failed after its steps have already succeeded, which is the most confusing
# possible outcome — a green build reported red by its own cleanup.

trap 'exit 0' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"

# Drain, handled BEFORE the admission-mode check below, because a drain has
# nothing to do with admission and must work on a fleet that never turned
# admission on.
#
# RUNNER_WORKSPACE points into _work inside the runner's own directory, which is
# how the runner's directory is identified from inside a job. Falling back to
# GITHUB_WORKSPACE covers older runner versions.
#
# Launched detached, with output discarded, and this hook returns immediately.
# Doing the stop here instead would unload the LaunchAgent while the worker is
# still reporting this job's result, turning a passing job into a lost runner —
# see scripts/drain-stop-when-idle.sh.
DRAIN_WS="${RUNNER_WORKSPACE:-${GITHUB_WORKSPACE:-}}"
if [ -n "$DRAIN_WS" ]; then
  # .../<runner-dir>/_work/<repo>/<repo> — walk up to the directory holding _work.
  DRAIN_DIR="${DRAIN_WS%%/_work/*}"
  if [ -f "$DRAIN_DIR/.drain-stop" ] && [ -x "$ROOT/scripts/drain-stop-when-idle.sh" ]; then
    nohup "$ROOT/scripts/drain-stop-when-idle.sh" "$DRAIN_DIR" >/dev/null 2>&1 &
  fi
fi

# shellcheck source=hooks/common.sh
. "$HERE/common.sh" 2>/dev/null || exit 0

[ "$ADMIT_MODE" = "off" ] && exit 0

KEY="$(admit_key)"

# How long the slot was held, read from the slot file before it is removed. This
# is the job's execution time as the host saw it, which is the number that
# matters for concurrency accounting — GitHub's own duration includes the queue.
HELD=0
SLOT="$ADMIT_SLOTS/$KEY"
if [ -f "$SLOT" ]; then
  TS="$(sed -n 's/^ts=//p' "$SLOT" 2>/dev/null | head -1)"
  case "$TS" in
    '' | *[!0-9]*) ;;
    *) HELD=$(($(admit_now) - TS)) ;;
  esac
fi

admit_free_slot "$KEY"

BUSY=0
if admit_lock; then
  BUSY="$(admit_live_slots)"
  admit_unlock
fi

# HELD is reported as ran_s, not as a wait: this job did not wait, it occupied a
# slot for that long.
admit_log released '' 0 "$BUSY" "$HELD"
