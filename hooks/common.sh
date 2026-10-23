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
ADMIT_LOG="${FLEET_ADMISSION_LOG:-$ROOT/dashboard/logs/admission.ndjson}"

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
#
# The floor is on USABLE space, counting what macOS can purge (see
# free-disk.sh); a lower hard floor on plain df free covers the time a purge
# takes.
# shellcheck disable=SC2034  # used by the files that source this
ADMIT_MIN_DISK_GB="$(admit_int "${FLEET_ADMIT_MIN_FREE_DISK_GB:-}" 40)"
# shellcheck disable=SC2034  # used by the files that source this
ADMIT_MIN_PLAIN_DISK_GB="$(admit_int "${FLEET_ADMIT_MIN_PLAIN_FREE_GB:-}" 15)"

# Never zero: a zero poll with a non-zero wait is a busy loop on a machine that
# is by definition already under load.
ADMIT_POLL="$(admit_int "${FLEET_ADMIT_POLL_S:-}" 5)"
[ "$ADMIT_POLL" -lt 1 ] && ADMIT_POLL=1

# Short mutex spin per wait-loop iteration. The enforce loop retries every
# ADMIT_POLL seconds, so a long single lock attempt would stall timeout and
# cancellation checks — five concurrent hooks each spinning 10 s once made the
# bounded wait lie about elapsed time and occasionally fail open.
ADMIT_MUTEX_TRIES="$(admit_int "${FLEET_ADMIT_MUTEX_TRIES:-}" 50)"
[ "$ADMIT_MUTEX_TRIES" -lt 1 ] && ADMIT_MUTEX_TRIES=1

# Six hours, which was GitHub's own default job ceiling. A slot older than this
# belongs to a job that cannot still be running, even if a PID happens to be
# live after a reboot recycled the number.
ADMIT_SLOT_TTL="$(admit_int "${FLEET_ADMIT_SLOT_TTL_S:-}" 21600)"

# LANES. One host-wide limit treats a 5-second grep like a 12-minute Xcode
# build: on ultra (30 cores) load rises about 8 per concurrent job, 74 % of jobs
# finish in under 90 s, and with one FIFO the short ones queued behind the long
# ones. Lanes classify each job as `light`, `heavy` or `simulator` (a heavy job
# on a runner FLEET_SIMULATOR_RUNNERS selects) and limit each lane on its own,
# under FLEET_ADMIT_MAX_CONCURRENT as the total cap, with the waiting line kept
# per lane: the oldest light job is never behind an older heavy one.
#
# off      — no lane logic at all (the default): today's single lane.
# observe  — the single lane still decides; every decision also records what
#            the lanes would have decided, so the limits can be checked first.
# enforce  — the lanes decide.
case "${FLEET_ADMIT_LANES:-off}" in
  observe) ADMIT_LANES=observe ;;
  enforce) ADMIT_LANES=enforce ;;
  *) ADMIT_LANES=off ;;
esac
# The total cap the lanes apply, FLEET_ADMIT_MAX_CONCURRENT unless set. Its own
# setting so that in observe the lanes can be judged at the total they will
# enforce, while the single lane keeps deciding at its own limit; switching to
# enforce is then FLEET_ADMIT_LANES alone.
ADMIT_TOTAL_MAX="$(admit_int "${FLEET_ADMIT_TOTAL_MAX_CONCURRENT:-}" "$ADMIT_MAX")"
[ "$ADMIT_TOTAL_MAX" -lt 1 ] && ADMIT_TOTAL_MAX=1
# A simulator job counts against the heavy limit too.
ADMIT_HEAVY_MAX="$(admit_int "${FLEET_ADMIT_HEAVY_MAX_CONCURRENT:-}" 4)"
[ "$ADMIT_HEAVY_MAX" -lt 1 ] && ADMIT_HEAVY_MAX=1
# FLEET_ADMIT_SHORT_MAX_CONCURRENT is the name this setting had in fleet.env
# before anything read it; still honoured.
ADMIT_LIGHT_MAX="$(admit_int "${FLEET_ADMIT_LIGHT_MAX_CONCURRENT:-${FLEET_ADMIT_SHORT_MAX_CONCURRENT:-}}" 12)"
[ "$ADMIT_LIGHT_MAX" -lt 1 ] && ADMIT_LIGHT_MAX=1
# A job whose recent median run is under this many seconds is light.
ADMIT_SHORT_JOB_S="$(admit_int "${FLEET_ADMIT_SHORT_JOB_S:-}" 90)"
# How long the dashboard's answer for one repo:job is reused. A burst of a
# dozen jobs from one push then costs the daemon one request per job name.
ADMIT_CLASS_TTL="$(admit_int "${FLEET_ADMIT_CLASS_CACHE_S:-}" 300)"
ADMIT_CLASSES="$ADMIT_STATE/job-class"
# Where the job's class is asked, next to /api/run-status by default: an empty
# FLEET_ADMIT_STATUS_URL (a host whose daemon is elsewhere) skips this too.
if [ -n "${FLEET_ADMIT_CLASS_URL+x}" ]; then
  ADMIT_CLASS_URL="$FLEET_ADMIT_CLASS_URL"
elif [ -n "${FLEET_ADMIT_STATUS_URL+x}" ]; then
  case "$FLEET_ADMIT_STATUS_URL" in
    '') ADMIT_CLASS_URL="" ;;
    */api/run-status) ADMIT_CLASS_URL="${FLEET_ADMIT_STATUS_URL%/api/run-status}/api/job-class" ;;
    *) ADMIT_CLASS_URL="http://127.0.0.1:${FLEET_PORT:-7878}/api/job-class" ;;
  esac
else
  ADMIT_CLASS_URL="http://127.0.0.1:${FLEET_PORT:-7878}/api/job-class"
fi

# The limit a log line reports: the total cap that is actually deciding.
if [ "$ADMIT_LANES" = enforce ]; then ADMIT_LOG_LIMIT="$ADMIT_TOTAL_MAX"; else ADMIT_LOG_LIMIT="$ADMIT_MAX"; fi

# Set by admit_classify (job-started.sh) or read back from the slot
# (job-completed.sh). Empty while lanes are off.
ADMIT_LANE=""
ADMIT_LANE_SOURCE=""
# The lane policy's view of the current decision, for the log. VIEWED is 0 when
# it was not worked out (lanes off, or a poll that could not take the mutex).
ADMIT_HEAVY_BUSY=0
ADMIT_LIGHT_BUSY=0
ADMIT_LANE_BLOCKER=""
ADMIT_LANE_VIEWED=0
# observe: seconds into a hold at which the lanes would first have admitted.
ADMIT_LANE_WAIT=""

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

admit_simulator_blocked() {
  admit_is_simulator_job \
    && [ "${1:-0}" -ge "$ADMIT_SIMULATOR_MAX" ]
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
  printf '{"ts":%s,"event":"%s","mode":"%s","runner":"%s","repo":"%s","run":"%s","job":"%s","waited_s":%s,"ran_s":%s,"busy":%s,"limit":%s,"owner_kind":"%s","owner_pid":"%s","reason":"%s"%s}\n' \
    "$(admit_now)" \
    "$(admit_json_str "$event")" \
    "$(admit_json_str "$ADMIT_MODE")" \
    "$(admit_json_str "${RUNNER_NAME:-}")" \
    "$(admit_json_str "${GITHUB_REPOSITORY:-}")" \
    "$(admit_json_str "${GITHUB_RUN_ID:-}")" \
    "$(admit_json_str "${GITHUB_JOB:-}")" \
    "${waited:-0}" "${ran:-0}" "${busy:-0}" "$ADMIT_LOG_LIMIT" \
    "$(admit_json_str "$ADMIT_OWNER_KIND")" \
    "$(admit_json_str "$ADMIT_OWNER_PID")" \
    "$(admit_json_str "$reason")" \
    "$(admit_lane_json)" \
    >> "$ADMIT_LOG" 2>/dev/null || true
}

# The lane fields of a log line, with their leading comma, or nothing while
# lanes are off: an off host writes exactly the line it always has.
# lane_reason is the lane policy's own reason text. In enforce it is the hold's
# reason; in observe it is what the lanes would have said (empty: admit now).
admit_lane_json() {
  [ "$ADMIT_LANES" = off ] && return 0
  local would=null wait=null
  if [ "$ADMIT_LANE_VIEWED" = 1 ]; then
    if [ -n "$ADMIT_LANE_BLOCKER" ]; then would=true; else would=false; fi
  fi
  case "$ADMIT_LANE_WAIT" in '' | *[!0-9]*) ;; *) wait="$ADMIT_LANE_WAIT" ;; esac
  printf ',"lanes":"%s","lane":"%s","lane_source":"%s","heavy_busy":%s,"light_busy":%s,"heavy_limit":%s,"light_limit":%s,"total_limit":%s,"lane_would_hold":%s,"lane_wait_s":%s,"lane_reason":"%s"' \
    "$ADMIT_LANES" \
    "$(admit_json_str "$ADMIT_LANE")" \
    "$(admit_json_str "$ADMIT_LANE_SOURCE")" \
    "${ADMIT_HEAVY_BUSY:-0}" "${ADMIT_LIGHT_BUSY:-0}" \
    "$ADMIT_HEAVY_MAX" "$ADMIT_LIGHT_MAX" "$ADMIT_TOTAL_MAX" \
    "$would" "$wait" \
    "$(admit_json_str "$ADMIT_LANE_BLOCKER")"
}

# mkdir is the portable atomic test-and-set. macOS ships no flock(1), and this
# needs no dependency beyond coreutils behaviour that has been stable for
# decades.
#
# Returns non-zero when the mutex cannot be taken within ADMIT_MUTEX_TRIES.
# Enforce mode retries on the next poll tick instead of bypassing the limit;
# observe mode may still claim a slot without the lock so dry-run counts stay
# useful under burst contention.
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
    [ "$tries" -ge "$ADMIT_MUTEX_TRIES" ] && return 1
    sleep 0.05
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
  printf 'pid=%s\nowner=%s\nts=%s\nrunner=%s\nrepo=%s\nrun=%s\njob=%s\nlane=%s\n' \
    "$ADMIT_OWNER_PID" "$ADMIT_OWNER_KIND" "$(admit_now)" \
    "${RUNNER_NAME:-}" \
    "${GITHUB_REPOSITORY:-}" "${GITHUB_RUN_ID:-}" "${GITHUB_JOB:-}" "$ADMIT_LANE" \
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
  # With lanes on, the lane's line is in the name (after the fixed-width
  # stamp), so the lockless check can find the head of its own line from one
  # directory listing. The stamp still comes first: sorting by name is still
  # arrival order across every line.
  if [ "$ADMIT_LANES" = off ]; then
    ADMIT_WAITER="$ADMIT_WAITERS/$stamp-$key"
  else
    ADMIT_WAITER="$ADMIT_WAITERS/$stamp-$(admit_lane_line "$ADMIT_LANE")-$key"
  fi
  printf 'pid=%s\nts=%s\nrunner=%s\nrepo=%s\nrun=%s\njob=%s\nlane=%s\n' \
    "$$" "$(admit_now)" "${RUNNER_NAME:-}" "${GITHUB_REPOSITORY:-}" \
    "${GITHUB_RUN_ID:-}" "${GITHUB_JOB:-}" "$ADMIT_LANE" \
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

# True when the Runner.Worker this hook belongs to has exited. GitHub cancels a
# job whose timeout runs out at "Set up runner"; the worker goes, the hook is
# reparented to launchd, and admit_run_completed keeps answering "no" because
# the RUN is still in progress (other jobs, or a re-run). Such a hook used to
# wait forever, holding a place in the line for a job that no longer exists.
# Only a worker owner counts: a fallback owner is just the parent shell, and
# reading its exit as "the job is gone" would let a live job run unthrottled.
#
# The owner is resolved once, before the wait, into its own variables: the
# ADMIT_OWNER_* pair is what a log line reports as the owner of a claimed slot,
# and a hold claims nothing.
ADMIT_WAIT_OWNER_PID=""
ADMIT_WAIT_OWNER_KIND=""
admit_resolve_wait_owner() {
  admit_resolve_owner
  ADMIT_WAIT_OWNER_PID="$ADMIT_OWNER_PID"
  ADMIT_WAIT_OWNER_KIND="$ADMIT_OWNER_KIND"
  ADMIT_OWNER_PID=""
  ADMIT_OWNER_KIND=""
}

# The worker's own diagnostic log, the only place a cancel shows while this
# hook holds the job. Measured on runner-host 2026-10-07 (map-web run
# 37236945666): the worker logged "Cancellation/Shutdown message received"
# within a second of the cancel, but it runs this hook with "Force kill process
# on cancellation: False" and never signals it, and GitHub kept the run AND the
# job `in_progress` until it force-completed the job about four minutes later.
# So neither the daemon's run status nor `gh` can see a cancel sooner than
# that, and the held job kept its runner and its place in line all along.
# Resolved once from the worker's command line (<runner>/bin[.<version>]/
# Runner.Worker): one worker serves one job and writes one Worker_*.log, the
# newest in its runner's _diag by the time it starts this hook. When no log can
# be found the run-status poll below still applies.
#
# Only what the worker writes AFTER the hook starts counts, and only as the
# worker's own log line. Before running anything the worker dumps the whole job
# message into this log, commit messages included: a push whose message quoted
# the cancel line released every hook at once (this repo's CI, 2026-10-07).
ADMIT_WORKER_LOG=""
ADMIT_WORKER_LOG_FROM=0
admit_resolve_worker_log() {
  local cmd path
  ADMIT_WORKER_LOG=""
  ADMIT_WORKER_LOG_FROM=0
  [ "$ADMIT_WAIT_OWNER_KIND" = "worker" ] && [ -n "$ADMIT_WAIT_OWNER_PID" ] || return 1
  cmd="$(ps -o command= -p "$ADMIT_WAIT_OWNER_PID" 2>/dev/null)"
  case "$cmd" in */Runner.Worker*) ;; *) return 1 ;; esac
  # The last absolute path before /Runner.Worker: production starts the binary
  # directly, but an interpreter may come first ("/bin/bash /x/Runner.Worker").
  path="${cmd%%/Runner.Worker*}"
  case "$path" in *" /"*) path="/${path##* /}" ;; esac
  ADMIT_WORKER_LOG="$(ls -1t "$(dirname "$path")/_diag"/Worker_*.log 2>/dev/null | head -1)"
  [ -n "$ADMIT_WORKER_LOG" ] || return 1
  ADMIT_WORKER_LOG_FROM="$(wc -c < "$ADMIT_WORKER_LOG" 2>/dev/null | tr -d ' ')"
  case "$ADMIT_WORKER_LOG_FROM" in '' | *[!0-9]*) ADMIT_WORKER_LOG="" ; return 1 ;; esac
}

admit_worker_cancelled() {
  [ -n "$ADMIT_WORKER_LOG" ] || return 1
  tail -c +"$((ADMIT_WORKER_LOG_FROM + 1))" "$ADMIT_WORKER_LOG" 2>/dev/null \
    | grep -q '^\[[^]]* INFO Worker] Cancellation/Shutdown message received'
}

admit_owner_gone() {
  [ "$ADMIT_WAIT_OWNER_KIND" = "worker" ] || return 1
  [ -n "$ADMIT_WAIT_OWNER_PID" ] || return 1
  ! kill -0 "$ADMIT_WAIT_OWNER_PID" 2>/dev/null
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

# True when this job already has its place in the queue and a live waiter that
# could take the next slot stands ahead of it. Checked WITHOUT the mutex, and
# that is the point: only the oldest waiter can be admitted, so a later one has
# nothing to decide under the lock. When every waiter polled through the mutex,
# each critical section cost a sed, a kill and a ps per waiter, the lock was
# never free, and the oldest waiter won it about once in N tries — on a loaded
# host with 40 waiters, nothing was admitted for a day while every slot sat
# empty (2026-10-03/04, logged as `held` with an empty reason). A stale read
# here costs one poll: anything it cannot vouch for (no queue place, a dead
# head, a Simulator job at the head, which the locked check may skip past)
# falls through to the locked path, which reaps and decides as before.
admit_waiting_behind_older() {
  local first pid runner
  [ -n "$ADMIT_WAITER" ] && [ -f "$ADMIT_WAITER" ] || return 1
  first="$(LC_ALL=C ls -1 "$ADMIT_WAITERS" 2>/dev/null | head -1)"
  [ -n "$first" ] || return 1
  [ "$ADMIT_WAITERS/$first" = "$ADMIT_WAITER" ] && return 1
  pid="$(sed -n 's/^pid=//p' "$ADMIT_WAITERS/$first" 2>/dev/null | head -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  if [ "$ADMIT_SIMULATOR_MAX" -gt 0 ]; then
    runner="$(sed -n 's/^runner=//p' "$ADMIT_WAITERS/$first" 2>/dev/null | head -1)"
    admit_runner_matches "$runner" && return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Lanes (FLEET_ADMIT_LANES). Every function here returns 0 unless it is a test
# used in a condition: the runner runs this hook under `bash -e`, and a failed
# command substitution there would exit the hook, whose EXIT trap then admits
# the job without a slot.
# ---------------------------------------------------------------------------

# The waiting line a lane belongs to. A simulator job waits in the heavy line,
# because it takes a heavy slot as well as a Simulator one.
admit_lane_line() {
  case "${1:-}" in
    light) printf 'light' ;;
    *) printf 'heavy' ;;
  esac
}

# Sets ADMIT_WAITER_LINE from a waiter file's name: <20-digit ts>-<10-digit
# pid>-<line>-<runner>. A name from before lanes (no line) reads as heavy, the
# safe side, and so does anything else unexpected.
ADMIT_WAITER_LINE=""
admit_waiter_line_of() {
  local rest="${1:32}"
  case "${rest%%-*}" in
    light) ADMIT_WAITER_LINE=light ;;
    *) ADMIT_WAITER_LINE=heavy ;;
  esac
  return 0
}

# True when this job matches one of a space- (or comma-) separated list of
# `repo:job` shell patterns. The job is GITHUB_JOB, the id (YAML key) of the
# job that runs, which inside a reusable workflow is that workflow's own key
# (`test`, not `ios / test`). The repo may be written with or without its
# owner: `acme/app:test`, `app:test`, `*:e2e` and `site:*` all work.
admit_job_matches() {
  local list="${1:-}" pattern full short
  local -a patterns
  [ -n "$list" ] || return 1
  full="${GITHUB_REPOSITORY:-}:${GITHUB_JOB:-}"
  short="${GITHUB_REPOSITORY##*/}:${GITHUB_JOB:-}"
  list="${list//,/ }"
  read -r -a patterns <<< "$list"
  for pattern in "${patterns[@]}"; do
    # shellcheck disable=SC2254
    case "$full" in $pattern) return 0 ;; esac
    # shellcheck disable=SC2254
    case "$short" in $pattern) return 0 ;; esac
  done
  return 1
}

# The dashboard's class for this repo:job (light, heavy or unknown), from its
# own history of how long the job runs; cached for ADMIT_CLASS_TTL seconds in
# the state directory. Returns non-zero, printing nothing, when there is no
# answer: no URL, no curl, or the daemon is down or too old to know the route.
admit_class_from_daemon() {
  local repo="${GITHUB_REPOSITORY:-}" job="${GITHUB_JOB:-}" key file now ts cls body tmp
  [ -n "$repo" ] && [ -n "$job" ] || return 1
  [ -n "$ADMIT_CLASS_URL" ] && command -v curl >/dev/null 2>&1 || return 1
  key="$(printf '%s__%s' "$repo" "$job" | tr -c 'A-Za-z0-9._-' '_')"
  file="$ADMIT_CLASSES/$key"
  now="$(admit_now)"
  if [ -f "$file" ]; then
    ts="$(sed -n 's/^ts=//p' "$file" 2>/dev/null | head -1)"
    cls="$(sed -n 's/^class=//p' "$file" 2>/dev/null | head -1)"
    case "$ts" in
      '' | *[!0-9]*) ;;
      *)
        if [ $((now - ts)) -lt "$ADMIT_CLASS_TTL" ] && [ -n "$cls" ]; then
          printf '%s' "$cls"
          return 0
        fi
        ;;
    esac
  fi
  body="$(curl -fsS --max-time 3 -G "$ADMIT_CLASS_URL" \
    --data-urlencode "repo=$repo" --data-urlencode "job=$job" \
    --data-urlencode "short_s=$ADMIT_SHORT_JOB_S" 2>/dev/null)" || return 1
  cls="$(printf '%s' "$body" | sed -n 's/.*"class":"\([a-z]*\)".*/\1/p' | head -1)"
  case "$cls" in
    light | heavy | unknown) ;;
    *) return 1 ;;
  esac
  # Written aside and renamed, so a concurrent reader never sees half a file.
  mkdir -p "$ADMIT_CLASSES" 2>/dev/null || true
  tmp="$file.$$"
  if printf 'class=%s\nts=%s\n' "$cls" "$now" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  fi
  printf '%s' "$cls"
  return 0
}

# Sets ADMIT_LANE and ADMIT_LANE_SOURCE. In order: the Simulator runner rule,
# FLEET_ADMIT_HEAVY_PATTERNS, FLEET_ADMIT_LIGHT_PATTERNS, the dashboard's
# history; anything it cannot place is heavy, because a heavy job let into the
# light lane is what overloads the host, and a light job in the heavy lane only
# waits a little longer.
admit_classify() {
  local cls=""
  ADMIT_LANE=""
  ADMIT_LANE_SOURCE=""
  [ "$ADMIT_LANES" = off ] && return 0
  if admit_is_simulator_job; then
    ADMIT_LANE=simulator
    ADMIT_LANE_SOURCE=runner
    return 0
  fi
  if admit_job_matches "${FLEET_ADMIT_HEAVY_PATTERNS:-}"; then
    ADMIT_LANE=heavy
    ADMIT_LANE_SOURCE=pattern
    return 0
  fi
  if admit_job_matches "${FLEET_ADMIT_LIGHT_PATTERNS:-}"; then
    ADMIT_LANE=light
    ADMIT_LANE_SOURCE=pattern
    return 0
  fi
  cls="$(admit_class_from_daemon)" || cls=""
  case "$cls" in
    light) ADMIT_LANE=light ; ADMIT_LANE_SOURCE=history ;;
    heavy) ADMIT_LANE=heavy ; ADMIT_LANE_SOURCE=history ;;
    unknown) ADMIT_LANE=heavy ; ADMIT_LANE_SOURCE=unknown ;;
    *) ADMIT_LANE=heavy ; ADMIT_LANE_SOURCE=fallback ;;
  esac
  return 0
}

# Sets ADMIT_HEAVY_BUSY and ADMIT_LIGHT_BUSY from the slot files, given the
# total ($1, from admit_live_slots, which has just reaped the dead ones). A slot
# written without a lane (lanes off, or a hook from before lanes) is heavy.
admit_lane_counts() {
  local total="${1:-0}" light
  light="$(grep -l '^lane=light$' "$ADMIT_SLOTS"/* 2>/dev/null | wc -l | tr -d ' ')"
  case "$light" in '' | *[!0-9]*) light=0 ;; esac
  case "$total" in '' | *[!0-9]*) total=0 ;; esac
  ADMIT_LIGHT_BUSY="$light"
  ADMIT_HEAVY_BUSY=$((total - light))
  [ "$ADMIT_HEAVY_BUSY" -lt 0 ] && ADMIT_HEAVY_BUSY=0
  return 0
}

# Why the lanes would hold this job on capacity alone, or empty. The total cap
# and the Simulator limit keep the reasons they have always had, word for word:
# the lake classifies holds by this text.
admit_lane_capacity_blocker() {
  local busy="${1:-0}" simulator_busy="${2:-0}"
  if [ "$busy" -ge "$ADMIT_TOTAL_MAX" ]; then
    printf '%s job(s) already running, at the limit of %s' "$busy" "$ADMIT_TOTAL_MAX"
    return 0
  fi
  if [ "$ADMIT_LANE" = simulator ] && admit_simulator_blocked "$simulator_busy"; then
    printf '%s Simulator job(s) already running, at the limit of %s' \
      "$simulator_busy" "$ADMIT_SIMULATOR_MAX"
    return 0
  fi
  if [ "$ADMIT_LANE" = light ]; then
    if [ "$ADMIT_LIGHT_BUSY" -ge "$ADMIT_LIGHT_MAX" ]; then
      printf '%s light job(s) already running, at the light limit of %s' \
        "$ADMIT_LIGHT_BUSY" "$ADMIT_LIGHT_MAX"
    fi
    return 0
  fi
  if [ "$ADMIT_HEAVY_BUSY" -ge "$ADMIT_HEAVY_MAX" ]; then
    printf '%s heavy job(s) already running, at the heavy limit of %s' \
      "$ADMIT_HEAVY_BUSY" "$ADMIT_HEAVY_MAX"
  fi
  return 0
}

# The hold reason for a job behind an older one in its own line. Starts like
# the single-lane reason so the lake files both as queue order.
admit_lane_queue_reason() {
  printf 'an older job is waiting for the next %s slot' "$(admit_lane_line "$ADMIT_LANE")"
}

# The per-lane FIFO, under the mutex: true when this waiter is the oldest one
# in its own line that could take a slot. As in the single line, a Simulator
# job held by the Simulator limit is skipped rather than allowed to block the
# heavy jobs behind it. $2=noreap skips the reaping a caller has just done.
admit_waiter_is_first_in_lane() {
  local simulator_busy="${1:-0}" f name first="" mine runner
  [ -n "$ADMIT_WAITER" ] || return 1
  [ "${2:-}" = noreap ] || admit_reap_waiters
  mine="$(admit_lane_line "$ADMIT_LANE")"
  for f in "$ADMIT_WAITERS"/*; do
    [ -f "$f" ] || continue
    name="${f##*/}"
    admit_waiter_line_of "$name"
    [ "$ADMIT_WAITER_LINE" = "$mine" ] || continue
    if [ "$ADMIT_SIMULATOR_MAX" -gt 0 ] && [ "$simulator_busy" -ge "$ADMIT_SIMULATOR_MAX" ]; then
      runner="$(sed -n 's/^runner=//p' "$f" 2>/dev/null | head -1)"
      admit_runner_matches "$runner" && continue
    fi
    if [ -z "$first" ] || [ "$name" \< "${first##*/}" ]; then
      first="$f"
    fi
  done
  [ "$first" = "$ADMIT_WAITER" ]
}

# The lockless check of admit_waiting_behind_older, per line: true when a live
# waiter ahead of this one is in this job's own line. Anything it cannot vouch
# for falls through to the locked check, as there.
admit_waiting_behind_older_in_lane() {
  local name first="" mine pid runner
  [ -n "$ADMIT_WAITER" ] && [ -f "$ADMIT_WAITER" ] || return 1
  mine="$(admit_lane_line "$ADMIT_LANE")"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    admit_waiter_line_of "$name"
    if [ "$ADMIT_WAITER_LINE" = "$mine" ]; then
      first="$name"
      break
    fi
  done < <(LC_ALL=C ls -1 "$ADMIT_WAITERS" 2>/dev/null)
  [ -n "$first" ] || return 1
  [ "$ADMIT_WAITERS/$first" = "$ADMIT_WAITER" ] && return 1
  pid="$(sed -n 's/^pid=//p' "$ADMIT_WAITERS/$first" 2>/dev/null | head -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  if [ "$ADMIT_SIMULATOR_MAX" -gt 0 ]; then
    runner="$(sed -n 's/^runner=//p' "$ADMIT_WAITERS/$first" 2>/dev/null | head -1)"
    admit_runner_matches "$runner" && return 1
  fi
  return 0
}

# Returns the GitHub Actions run status string, or empty when unknown.
#
# The dashboard daemon is asked first. Runner LaunchAgents set SessionCreate,
# so a job runs without the login keychain and `gh` here has no token: it goes
# out anonymously, cannot see a private repo, and hits the anonymous rate limit.
# Until 2026-10-05 that meant no held job ever noticed its run had ended, and
# waits for runs cancelled hours earlier held places in the queue. The daemon
# holds a token resolved outside that session. FLEET_ADMIT_STATUS_URL= (empty)
# skips it, e.g. on a host whose daemon is elsewhere. gh, then curl with
# GITHUB_TOKEN/GH_TOKEN, remain for hosts where those do work.
ADMIT_STATUS_URL="${FLEET_ADMIT_STATUS_URL-http://127.0.0.1:${FLEET_PORT:-7878}/api/run-status}"
admit_run_status() {
  local status repo="${GITHUB_REPOSITORY:-}" run_id="${GITHUB_RUN_ID:-}"
  [ -n "$repo" ] && [ -n "$run_id" ] || return 1
  if [ -n "$ADMIT_STATUS_URL" ] && command -v curl >/dev/null 2>&1; then
    status="$(curl -fsS --max-time 5 -G "$ADMIT_STATUS_URL" \
      --data-urlencode "repo=$repo" --data-urlencode "run=$run_id" 2>/dev/null \
      | sed -n 's/.*"status":"\([a-z_]*\)".*/\1/p' | head -1)"
    if [ -n "$status" ]; then
      printf '%s' "$status"
      return 0
    fi
  fi
  if command -v gh >/dev/null 2>&1; then
    status="$(gh api "repos/${repo}/actions/runs/${run_id}" --jq .status 2>/dev/null)"
    if [ -n "$status" ]; then
      printf '%s' "$status"
      return 0
    fi
  fi
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  command -v curl >/dev/null 2>&1 && [ -n "$token" ] || return 1
  status="$(curl -fsSL \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${repo}/actions/runs/${run_id}" 2>/dev/null \
    | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("status","") or "")
except Exception:
  pass' 2>/dev/null)"
  [ -n "$status" ] && printf '%s' "$status"
  return 0
}

admit_run_completed() {
  [ "$(admit_run_status)" = "completed" ]
}

# A host updated without free-disk.sh keeps df's number rather than failing:
# job-started runs under -e, and a failed source there admits without a slot.
# Checked before sourcing: under bash 3.2 with -e a missing file is fatal even
# inside an `if`.
ADMIT_FREE_DISK_LIB="$(dirname "${BASH_SOURCE[0]}")/free-disk.sh"
if [ -f "$ADMIT_FREE_DISK_LIB" ]; then
  # shellcheck source=hooks/free-disk.sh
  . "$ADMIT_FREE_DISK_LIB"
else
  fleet_plain_free_gb() {
    local kb
    kb="$(df -k / 2>/dev/null | tail -1 | awk '{print $4}')"
    case "$kb" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s' "$((kb / 1048576))"
  }
  fleet_usable_free_gb() { fleet_plain_free_gb; }
fi

admit_free_disk_gb() { fleet_usable_free_gb; }
admit_plain_free_disk_gb() { fleet_plain_free_gb; }
