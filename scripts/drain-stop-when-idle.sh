#!/usr/bin/env bash
# Stop a runner's service once it is no longer executing a job.
#
#   scripts/drain-stop-when-idle.sh <runner-dir> [timeout-seconds]
#
# Called DETACHED by hooks/job-completed.sh when a .drain-stop flag is present.
# Never call it in the foreground from a hook.
#
# WHY THIS IS A SEPARATE, DETACHED PROCESS
#
# The completion hook runs as a child of Runner.Worker, and the worker has not
# yet reported the job's result to GitHub when the hook runs. `svc.sh stop`
# unloads the LaunchAgent, which tears down Runner.Listener and the worker under
# it — so calling it from inside the hook kills the process that was about to say
# "this job passed". The job then shows on GitHub as a lost runner: a red build
# whose steps all succeeded, caused by the drain rather than by the code.
#
# So this waits for the worker to exit on its own, which happens seconds after
# the hook returns, and only then stops the service. Being a detached process is
# what lets the hook return immediately — the runner finishes reporting, exits,
# and this notices and stops the service cleanly.
#
# PGREP -a, BECAUSE THIS RUNS UNDER THE WORKER IT IS WAITING FOR
#
# macOS pgrep leaves the calling process and all of its ancestors out of the
# match unless it is given -a. This script is started by the completion hook,
# which is a child of Runner.Worker, so without -a the worker it waits for is
# invisible: the first poll read "no worker", and svc.sh stop ran while the hook
# was still running. The listener then cancelled the job before it could report,
# and GitHub kept the job in_progress ("Complete runner" cancelled, "Complete
# job" stuck) until someone force-cancelled the run: addisdev/lake-api PR #73,
# 2026-10-12/13, three jobs, 10-25 minutes each. runner-host's worker logs show
# 40 jobs on 15+ runners shut down inside this hook from 10-10 to 10-13.
#
# IGNORING SIGTERM AROUND THE STOP
#
# This process is still in the runner's launchd job (nohup only ignores
# SIGHUP), and unloading that job signals its whole process group. Without the
# trap the stop killed this script before it could record the drain as done,
# so the marker stayed "draining" and .drain-stop stayed behind.
#
# BOUNDED, ALWAYS. If the worker never exits — a wedged job is exactly the sort
# of thing someone is draining a runner to deal with — this gives up and leaves
# the drain marker in place rather than waiting forever. The dashboard keeps
# showing "draining", which is true: the intent is recorded and the operator can
# see it was not carried out.
set -uo pipefail

DIR="${1:?usage: drain-stop-when-idle.sh <runner-dir> [timeout-seconds]}"
TIMEOUT="${2:-3600}"

[ -d "$DIR" ] || exit 0
# No flag means the drain was cancelled between the hook firing and this
# starting. Resuming a runner should not be undone by a stop that was already
# in flight.
[ -f "$DIR/.drain-stop" ] || exit 0

# Poll rather than wait: the worker is not this process's child, so there is
# nothing to wait(2) on. Two seconds is well below the time the runner takes to
# report a result, so this adds no meaningful delay.
WAITED=0
while [ "$WAITED" -lt "$TIMEOUT" ]; do
  if ! pgrep -a -f "$DIR/bin(\.[^/]+)?/Runner\.Worker" >/dev/null 2>&1; then
    # Re-checked after the wait for the same reason it was checked before it:
    # a resume during the wait must win.
    [ -f "$DIR/.drain-stop" ] || exit 0

    cd "$DIR" || exit 0
    trap '' TERM INT HUP
    ./svc.sh stop >/dev/null 2>&1
    rm -f "$DIR/.drain-stop"
    # The marker moves from draining to drained, which is what the dashboard
    # reads to stop showing this as an operation still in progress. Its by=
    # line is carried over: a drain the tiers controller started must still
    # read as the controller's once it completes, or the controller would
    # never resume it (it only resumes its own drains).
    OWNER="$(sed -n 's/^by=//p' "$DIR/.drain" 2>/dev/null | head -1 | tr -d '\r')"
    if [ -n "$OWNER" ]; then
      printf 'drained\nrequested_at=%s\nby=%s\n' "$(date -u +%s)" "$OWNER" > "$DIR/.drain"
    else
      printf 'drained\nrequested_at=%s\n' "$(date -u +%s)" > "$DIR/.drain"
    fi
    exit 0
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

# Timed out. The flag is left in place deliberately: the next completed job on
# this runner will try again, which is the correct behaviour for a drain that
# has been requested and not yet achieved.
exit 0
