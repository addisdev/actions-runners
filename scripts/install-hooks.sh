#!/usr/bin/env bash
# Point every registered runner at the fleet's job hooks.
#
#   scripts/install-hooks.sh              # show what would change
#   scripts/install-hooks.sh --apply      # write it
#   scripts/install-hooks.sh --apply --restart
#   scripts/install-hooks.sh --remove --apply
#
# The hooks are the mechanism for two separate features, and they behave
# differently:
#
#   Job admission is inert until FLEET_ADMIT_MODE is set in fleet.env, so
#   installing the hooks does not start holding jobs. That separation is
#   deliberate: rolling a hook out to 29 runners and turning it on are two
#   decisions, and the second one is the one that can cost a build.
#
#   Draining a BUSY runner needs the completion hook and works as soon as it is
#   installed, with no opt-in. That is not an inconsistency — it does nothing
#   until somebody asks for a drain, and it only acts on the runner they asked
#   about. Without the hook, draining a busy runner records the intent and waits;
#   the service is not stopped until that runner is idle and someone drains it
#   again.
#
# Dry run by default, like every other destructive script here — this edits a
# file inside each runner installation, and a bad edit is a fleet that will not
# take work.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"

STARTED="$ROOT/hooks/job-started.sh"
COMPLETED="$ROOT/hooks/job-completed.sh"

APPLY=0
REMOVE=0
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    --restart) RESTART=1 ;;
    -h | --help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "$REMOVE" -eq 0 ]; then
  for f in "$STARTED" "$COMPLETED"; do
    [ -x "$f" ] || { echo "missing or not executable: $f" >&2; exit 1; }
  done
fi

CHANGED=0
SKIPPED=0
BUSY=()

# One awk rather than `sed | head -1`: a runner with no .env made that pipeline
# fail, and under `set -e` the whole run then aborted at the first such runner —
# silently, and after having already rewritten the runners ahead of it.
env_value() {
  [ -f "$2" ] || return 0
  awk -v k="$1=" 'index($0, k) == 1 { print substr($0, length(k) + 1); exit }' "$2"
}

for dir in "$ROOT"/*/; do
  [ -f "${dir}.runner" ] || continue
  name="$(basename "$dir")"
  env_file="${dir}.env"

  current_started="$(env_value ACTIONS_RUNNER_HOOK_JOB_STARTED "$env_file")"
  current_completed="$(env_value ACTIONS_RUNNER_HOOK_JOB_COMPLETED "$env_file")"

  if [ "$REMOVE" -eq 1 ]; then
    if [ -z "$current_started" ] && [ -z "$current_completed" ]; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    echo "  $name: remove hook lines"
  else
    if [ "$current_started" = "$STARTED" ] && [ "$current_completed" = "$COMPLETED" ]; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    if [ -n "$current_started" ] || [ -n "$current_completed" ]; then
      echo "  $name: update hook lines (was: ${current_started:-none})"
    elif [ -f "$env_file" ]; then
      echo "  $name: add hook lines"
    else
      # A runner register.sh did not create. Writing the file is still correct,
      # but say so rather than silently inventing a config file.
      echo "  $name: add hook lines (no .env yet, creating one)"
    fi
  fi
  CHANGED=$((CHANGED + 1))

  [ "$APPLY" -eq 1 ] || continue

  # Rewritten via a temp file in the same directory and moved into place, so a
  # failure mid-write cannot leave a runner with a truncated .env — which would
  # strip its PATH and break every job on it.
  tmp="${dir}.env.fleet-tmp"
  : > "$tmp"
  if [ -f "$env_file" ]; then
    grep -v -e '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' \
      -e '^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' "$env_file" > "$tmp" || true
  fi
  if [ "$REMOVE" -eq 0 ]; then
    printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$STARTED" >> "$tmp"
    printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\n' "$COMPLETED" >> "$tmp"
  fi
  mv "$tmp" "$env_file"

  if [ "$RESTART" -eq 1 ]; then
    # Never restart a runner that is mid-job: stopping the service under a
    # running Runner.Worker kills the build, and the whole point of this change
    # is to stop breaking builds.
    if pgrep -f "${dir}bin/Runner.Worker" >/dev/null 2>&1; then
      BUSY+=("$name")
    else
      (cd "$dir" && ./svc.sh stop >/dev/null 2>&1 && ./svc.sh start >/dev/null 2>&1) \
        || echo "  warn: $name did not restart cleanly — check ./health.sh"
    fi
  fi
done

echo
if [ "$REMOVE" -eq 1 ]; then
  echo "$CHANGED runner(s) to clean, $SKIPPED already clean"
else
  echo "$CHANGED runner(s) to change, $SKIPPED already correct"
fi

# Said before the dry-run exit, not after it: an operator planning the rollout is
# exactly who needs to know that finishing it changes nothing by itself.
if [ "$REMOVE" -eq 0 ] && [ "$CHANGED" -gt 0 ]; then
  echo
  echo "Job admission stays INERT until FLEET_ADMIT_MODE is set in fleet.env, so"
  echo "this does not start holding jobs. Set it to 'observe' to see what enforcing"
  echo "would have done before it can hold a real job."
  echo
  echo "Draining a busy runner does start working immediately, because it needs the"
  echo "completion hook. It still does nothing until somebody drains a runner."
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "dry run — nothing was written. Re-run with --apply."
  exit 0
fi

if [ "${#BUSY[@]}" -gt 0 ]; then
  echo
  echo "not restarted because a job is running: ${BUSY[*]}"
  echo "re-run with --restart when they are idle, or let the next restart pick it up."
fi

if [ "$RESTART" -eq 0 ] && [ "$CHANGED" -gt 0 ]; then
  echo
  echo "Runner.Listener reads .env when the service starts, so restart the runners"
  echo "to be certain the hooks are picked up:"
  echo "  scripts/install-hooks.sh --apply --restart"
  echo "Runner.Worker reads .env too, so the hooks may take effect on the next job"
  echo "without a restart — but a restart is the only way to know."
fi
