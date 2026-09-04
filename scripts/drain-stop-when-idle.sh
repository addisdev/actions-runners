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
  if ! pgrep -f "$DIR/bin/Runner.Worker" >/dev/null 2>&1; then
    # Re-checked after the wait for the same reason it was checked before it:
    # a resume during the wait must win.
    [ -f "$DIR/.drain-stop" ] || exit 0

    cd "$DIR" || exit 0
    ./svc.sh stop >/dev/null 2>&1
    rm -f "$DIR/.drain-stop"
    # The marker moves from draining to drained, which is what the dashboard
    # reads to stop showing this as an operation still in progress.
    printf 'drained\nrequested_at=%s\n' "$(date -u +%s)" > "$DIR/.drain"
    exit 0
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

# Timed out. The flag is left in place deliberately: the next completed job on
# this runner will try again, which is the correct behaviour for a drain that
# has been requested and not yet achieved.
exit 0
