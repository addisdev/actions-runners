# shellcheck shell=bash
# Shared by job-started.sh and job-completed.sh. Sourced, never executed.
#
# WHY A SLOT DIRECTORY AND NOT `pgrep Runner.Worker`. Counting worker processes
# is the obvious way to ask "how many jobs are running", and it is what
# lib/local.js does for the dashboard. It cannot be used here. The job-started
# hook is a CHILD of the Runner.Worker that is about to run the job, so a job
# waiting inside this hook already has a worker process. Five held jobs would
# each count the other four plus themselves, all see the host as full, and all
# wait out the timeout together. The count has to come from something only an
# ADMITTED job holds, which is what a slot file is.
#
# Slots are keyed by runner name because a runner runs exactly one job at a
# time, so the name is a natural unique key that both hooks can compute without
# passing state between two separate processes.
#
# Every slot records the PID of the process that owns it, which is what makes
# this self-healing. A job killed with SIGKILL never runs its completed hook and
# leaves its slot behind; the next admission reaps it because the PID is gone.
# That matters more than it sounds: a leaked slot is permanent lost concurrency,
# and the failure mode of a stuck admission controller is a fleet that has
# quietly stopped running CI.

ADMIT_STATE="$ROOT/.admission"
ADMIT_SLOTS="$ADMIT_STATE/slots"
ADMIT_WAITERS="$ADMIT_STATE/waiters"
ADMIT_MUTEX="$ADMIT_STATE/mutex"
ADMIT_LOG="$ROOT/dashboard/logs/admission.ndjson"

# fleet.env is sourced the same way the other scripts source it, so a value set
# there applies to the hooks too. The hooks run inside a job's environment,
# which has none of these variables, so this file is the only configuration
# path that actually reaches them.
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

# A typo in fleet.env must not become a spin loop or an unbounded hold, so every
# numeric setting is coerced to a whole number and falls back to its default.
# This runs inside somebody's build; it does not get to be fragile.
admit_int() {
  case "$1" in
    '' | *[!0-9]*) printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}

# off      — do nothing at all. The default, so installing the hooks changes no
#            behaviour until somebody opts in.
# observe  — never delay a job, but take a slot and record what enforcing would
#            have done. This is how you find out whether the limit is right
#            before it can cost you a build.
# enforce  — hold a job until there is room, bounded by FLEET_ADMIT_MAX_WAIT_S.
#
# Anything unrecognised means off. A misspelled mode reading as "enforce" would
# be the most expensive possible interpretation of a typo.
case "${FLEET_ADMIT_MODE:-off}" in
  observe) ADMIT_MODE=observe ;;
  enforce) ADMIT_MODE=enforce ;;
  *) ADMIT_MODE=off ;;
esac

# 3 matches lib/capacity.js's ceiling, and for the same measured reason: on this
# 12-core host the median load1 is 60 at two concurrent jobs and 91 at three.
ADMIT_MAX="$(admit_int "${FLEET_ADMIT_MAX_CONCURRENT:-}" 3)"
[ "$ADMIT_MAX" -lt 1 ] && ADMIT_MAX=1

# A host-wide count is too blunt for Apple builds: two ordinary jobs can share
# this host, while two Simulator jobs can starve CoreSimulator's launch
# watchdogs and surface crash dialogs on the interactive desktop. When enabled,
# this second limit applies only to runner names selected by
# FLEET_SIMULATOR_RUNNERS. Zero keeps the extra limit disabled.
ADMIT_SIMULATOR_MAX="$(admit_int "${FLEET_ADMIT_SIMULATOR_MAX_CONCURRENT:-}" 0)"

# A held job is burning its own timeout-minutes while it waits, so an unbounded
# hold converts a queue into a failed build. After this long the job is admitted
# regardless and the wait is logged — the fleet is better off with a slow build
# than a red one.
# shellcheck disable=SC2034  # used by the files that source this
ADMIT_MAX_WAIT="$(admit_int "${FLEET_ADMIT_MAX_WAIT_S:-}" 600)"

# admit preserves the historical fail-open behaviour. hold keeps the host limit
# strict after max-wait and relies on cancellation polling to release a job when
# GitHub ends it. Anything unrecognised stays fail-open for compatibility.
# shellcheck disable=SC2034  # used by job-started.sh after this file is sourced
case "${FLEET_ADMIT_TIMEOUT_ACTION:-admit}" in
  hold) ADMIT_TIMEOUT_ACTION=hold ;;
  *) ADMIT_TIMEOUT_ACTION=admit ;;
esac

# A waiting hook does not reliably receive GitHub's cancellation signal. Poll
# the run periodically so a cancelled run returns from "Set up runner" instead
# of occupying its runner until the admission timeout.
ADMIT_CANCEL_POLL="$(admit_int "${FLEET_ADMIT_CANCEL_POLL_S:-}" 30)"
[ "$ADMIT_CANCEL_POLL" -lt 5 ] && ADMIT_CANCEL_POLL=5

# Matches minFreeDiskGb in lib/capacity.js. Unlike the concurrency limit this
# one cannot be satisfied by waiting unless cleanup runs, so it relies on the
# bounded wait above rather than blocking indefinitely.
# shellcheck disable=SC2034  # used by the files that source this
ADMIT_MIN_DISK_GB="$(admit_int "${FLEET_ADMIT_MIN_FREE_DISK_GB:-}" 40)"

# Never zero: a zero poll with a non-zero wait is a busy loop on a machine that
# is by definition already under load.
ADMIT_POLL="$(admit_int "${FLEET_ADMIT_POLL_S:-}" 5)"
[ "$ADMIT_POLL" -lt 1 ] && ADMIT_POLL=1

# Six hours, which was GitHub's own default job ceiling. A slot older than this
# belongs to a job that cannot still be running, even if a PID happens to be
# live after a reboot recycled the number.
ADMIT_SLOT_TTL="$(admit_int "${FLEET_ADMIT_SLOT_TTL_S:-}" 21600)"

# Resolved by admit_resolve_owner when a slot is claimed. Declared here so the
# log line is well-formed for decisions taken before any claim, such as a hold.
ADMIT_OWNER_PID=""
ADMIT_OWNER_KIND=""

# Slot files are named after the runner, which comes from the job environment.
# Anything that is not a plain identifier is replaced rather than trusted — a
# name containing a slash would otherwise write outside the slots directory.
admit_key() {
  local raw="${RUNNER_NAME:-}"
  [ -n "$raw" ] || raw="${GITHUB_RUN_ID:-unknown}-${GITHUB_JOB:-job}"
  printf '%s' "$raw" | tr -c 'A-Za-z0-9._-' '_'
}

admit_now() { date +%s; }

admit_runner_matches() {
  local runner="$1" selected pattern
  local -a patterns
  selected="${FLEET_SIMULATOR_RUNNERS:-}"
  selected="${selected//,/ }"
  read -r -a patterns <<< "$selected"
  for pattern in "${patterns[@]}"; do
    # Entries are shell patterns, matching simulator-control.sh.
    # shellcheck disable=SC2254
    case "$runner" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

admit_is_simulator_job() {
  [ "$ADMIT_SIMULATOR_MAX" -gt 0 ] \
    && admit_runner_matches "${RUNNER_NAME:-}"
}

# Minimal JSON string escaping: backslash, double quote, and control characters,
# which is the whole set that can appear in a workflow or job name and break a
# line of NDJSON.
admit_json_str() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:cntrl:]]//g'
}

# One NDJSON line per decision. A log file rather than a direct SQLite write:
# fleetd owns that database and holds it open in WAL mode, and a second writer
# appearing from inside a CI job is a race nobody wants to debug at 2am. fleetd
# ingests this file on its slow tick.
#
# Appends of a single short line are atomic with O_APPEND, which is what makes
# concurrent hooks safe here without a lock.
admit_log() {
  local event="$1" reason="${2:-}" waited="${3:-0}" busy="${4:-0}" ran="${5:-0}"
  mkdir -p "$(dirname "$ADMIT_LOG")" 2>/dev/null || return 0
  # owner_kind is 'worker' or 'fallback' and owner_pid is the process the slot is
  # keyed on. Both are named for what they hold: this once emitted the kind under
  # a key called "owner", which read as a PID everywhere downstream.
  # waited_s is time this job spent waiting for a slot; ran_s is how long a
  # released slot was occupied. Separate fields because they are separate
  # quantities — the release used to report its occupancy as a wait.
  printf '{"ts":%s,"event":"%s","mode":"%s","runner":"%s","repo":"%s","run":"%s","job":"%s","waited_s":%s,"ran_s":%s,"busy":%s,"limit":%s,"owner_kind":"%s","owner_pid":"%s","reason":"%s"}\n' \
    "$(admit_now)" \
    "$(admit_json_str "$event")" \
    "$(admit_json_str "$ADMIT_MODE")" \
    "$(admit_json_str "${RUNNER_NAME:-}")" \
    "$(admit_json_str "${GITHUB_REPOSITORY:-}")" \
    "$(admit_json_str "${GITHUB_RUN_ID:-}")" \
    "$(admit_json_str "${GITHUB_JOB:-}")" \
    "${waited:-0}" "${ran:-0}" "${busy:-0}" "$ADMIT_MAX" \
    "$(admit_json_str "$ADMIT_OWNER_KIND")" \
    "$(admit_json_str "$ADMIT_OWNER_PID")" \
    "$(admit_json_str "$reason")" \
    >> "$ADMIT_LOG" 2>/dev/null || true
}

# mkdir is the portable atomic test-and-set. macOS ships no flock(1), and this
# needs no dependency beyond coreutils behaviour that has been stable for
# decades.
#
# Returns non-zero rather than waiting forever if the mutex cannot be taken.
# Every caller treats that as "proceed without counting", because a contended
# mutex must not be the thing that stops CI.
admit_lock() {
  local tries=0 holder
  mkdir -p "$ADMIT_STATE" 2>/dev/null || return 1
  while ! mkdir "$ADMIT_MUTEX" 2>/dev/null; do
    holder="$(cat "$ADMIT_MUTEX/pid" 2>/dev/null)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$ADMIT_MUTEX" 2>/dev/null
      continue
    fi
    # A mutex with no readable pid file, or one held far longer than any
    # critical section here takes, is wreckage from a killed process.
    if [ -d "$ADMIT_MUTEX" ]; then
      local age
      age="$(admit_dir_age "$ADMIT_MUTEX")"
      if [ -n "$age" ] && [ "$age" -gt 60 ]; then
        rm -rf "$ADMIT_MUTEX" 2>/dev/null
        continue
      fi
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 100 ] && return 1
    sleep 0.1
  done
  printf '%s' "$$" > "$ADMIT_MUTEX/pid" 2>/dev/null || true
  return 0
}

admit_unlock() { rm -rf "$ADMIT_MUTEX" 2>/dev/null || true; }

# Seconds since a path was last modified. stat's format flag differs between
# BSD and GNU; this host is macOS, so BSD form first with a GNU fallback so the
# scripts stay readable if they are ever run elsewhere.
admit_dir_age() {
  local mtime now
  mtime="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)"
  [ -n "$mtime" ] || return 1
  now="$(admit_now)"
  printf '%s' "$((now - mtime))"
}

# Drops slots whose owning process is gone or whose age is implausible, then
# prints how many remain. Callers must hold the mutex.
admit_live_slots() {
  local n=0 f pid ts now
  mkdir -p "$ADMIT_SLOTS" 2>/dev/null || { printf '0'; return 0; }
  now="$(admit_now)"
  for f in "$ADMIT_SLOTS"/*; do
    [ -f "$f" ] || continue
    pid="$(sed -n 's/^pid=//p' "$f" 2>/dev/null | head -1)"
    ts="$(sed -n 's/^ts=//p' "$f" 2>/dev/null | head -1)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f" 2>/dev/null
      continue
    fi
    if [ -n "$ts" ] && [ "$((now - ts))" -gt "$ADMIT_SLOT_TTL" ]; then
      rm -f "$f" 2>/dev/null
      continue
    fi
    n=$((n + 1))
  done
  printf '%s' "$n"
}

admit_live_simulator_slots() {
  local n=0 f runner
  [ "$ADMIT_SIMULATOR_MAX" -gt 0 ] || { printf '0'; return 0; }
  for f in "$ADMIT_SLOTS"/*; do
    [ -f "$f" ] || continue
    runner="$(sed -n 's/^runner=//p' "$f" 2>/dev/null | head -1)"
    [ -n "$runner" ] || runner="$(basename "$f")"
    admit_runner_matches "$runner" && n=$((n + 1))
  done
  printf '%s' "$n"
}

# A slot must be owned by a process that lives exactly as long as the job, so
# that PID liveness is a truthful answer to "is this job still running". The
# hook itself is the wrong choice — it exits the moment the job is admitted, and
# every slot would look stale to the next caller.
#
# Runner.Worker is the right owner: the runner spawns one per job and it lives
# until the job ends. It is found by walking up from this process rather than
# assuming it is the immediate parent, because assuming that fails SILENTLY and
# expensively. If the runner ever invokes hooks through an intermediate shell,
# the parent becomes a process that exits immediately, every slot is reaped as
# soon as it is written, the count is permanently zero, and admission control
# stops holding anything while still appearing to work.
#
# ADMIT_OWNER_KIND records which branch was taken so that degradation is
# visible in the log instead of being inferred from an absence of holds.
admit_resolve_owner() {
  local pid="$PPID" depth=0 cmd next
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 12 ]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    [ -n "$cmd" ] || break
    case "$cmd" in
      *Runner.Worker*)
        ADMIT_OWNER_PID="$pid"
        ADMIT_OWNER_KIND=worker
        return 0
        ;;
    esac
    next="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$next" in
      '' | *[!0-9]*) break ;;
    esac
    pid="$next"
    depth=$((depth + 1))
  done
  ADMIT_OWNER_PID="$PPID"
  ADMIT_OWNER_KIND=fallback
  return 0
}

admit_claim_slot() {
  local key="$1"
  mkdir -p "$ADMIT_SLOTS" 2>/dev/null || return 1
  admit_resolve_owner
  printf 'pid=%s\nowner=%s\nts=%s\nrunner=%s\nrepo=%s\nrun=%s\njob=%s\n' \
    "$ADMIT_OWNER_PID" "$ADMIT_OWNER_KIND" "$(admit_now)" \
    "${RUNNER_NAME:-}" \
    "${GITHUB_REPOSITORY:-}" "${GITHUB_RUN_ID:-}" "${GITHUB_JOB:-}" \
    > "$ADMIT_SLOTS/$key" 2>/dev/null || return 1
  return 0
}

admit_free_slot() {
  rm -f "$ADMIT_SLOTS/$1" 2>/dev/null || true
}

# Waiting jobs use a separate FIFO from admitted slots. The timestamp and PID
# prefix gives every waiter a stable order even when several arrive in the same
# second; the hook PID makes abandoned entries safely reapable.
ADMIT_WAITER=""

admit_join_waiters() {
  local key="$1" stamp
  [ -n "$ADMIT_WAITER" ] && [ -f "$ADMIT_WAITER" ] && return 0
  mkdir -p "$ADMIT_WAITERS" 2>/dev/null || return 1
  stamp="$(printf '%020d-%010d' "$(admit_now)" "$$")"
  ADMIT_WAITER="$ADMIT_WAITERS/$stamp-$key"
  printf 'pid=%s\nts=%s\nrunner=%s\nrepo=%s\nrun=%s\njob=%s\n' \
    "$$" "$(admit_now)" "${RUNNER_NAME:-}" "${GITHUB_REPOSITORY:-}" \
    "${GITHUB_RUN_ID:-}" "${GITHUB_JOB:-}" \
    > "$ADMIT_WAITER" 2>/dev/null || { ADMIT_WAITER=""; return 1; }
}

admit_leave_waiters() {
  [ -n "$ADMIT_WAITER" ] && rm -f "$ADMIT_WAITER" 2>/dev/null
  ADMIT_WAITER=""
}

admit_reap_waiters() {
  local f pid
  mkdir -p "$ADMIT_WAITERS" 2>/dev/null || return 0
  for f in "$ADMIT_WAITERS"/*; do
    [ -f "$f" ] || continue
    pid="$(sed -n 's/^pid=//p' "$f" 2>/dev/null | head -1)"
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f" 2>/dev/null
    fi
  done
}

admit_waiter_is_first_eligible() {
  local simulator_busy="$1" f first="" runner
  [ -n "$ADMIT_WAITER" ] || return 1
  admit_reap_waiters
  for f in "$ADMIT_WAITERS"/*; do
    [ -f "$f" ] || continue
    runner="$(sed -n 's/^runner=//p' "$f" 2>/dev/null | head -1)"
    if [ "$ADMIT_SIMULATOR_MAX" -gt 0 ] \
      && admit_runner_matches "$runner" \
      && [ "$simulator_busy" -ge "$ADMIT_SIMULATOR_MAX" ]; then
      # Do not let a Simulator job waiting on the Simulator-specific limit
      # block an unrelated job from using otherwise-free host capacity.
      continue
    fi
    if [ -z "$first" ] || [ "$(basename "$f")" \< "$(basename "$first")" ]; then
      first="$f"
    fi
  done
  [ "$first" = "$ADMIT_WAITER" ]
}

admit_run_completed() {
  local status
  [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  status="$(gh api \
    "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
    --jq .status 2>/dev/null)"
  [ "$status" = "completed" ]
}

admit_free_disk_gb() {
  local avail
  avail="$(df -k / 2>/dev/null | tail -1 | awk '{print $4}')"
  [ -n "$avail" ] || return 1
  printf '%s' "$((avail / 1048576))"
}
