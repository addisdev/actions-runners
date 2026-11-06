#!/usr/bin/env bash
# Give a runner's disk back when its job ends.
#
# Each runner keeps _work/<repo>/ between jobs: the checkout, and beside it
# whatever the workflows park in $RUNNER_WORKSPACE so the next build is
# incremental (DerivedData-*, venvs, venv-kit-*, node-kit-*, gradle-kit-*,
# spm-kit-*, duckdb-native-work). With 100 runners on one disk that is the
# disk: on ultra (2026-11-05) homelake-3/_work/homelake was 11 GB for a 1.4 GB
# checkout, and a busy night took the host from 80 to 59 GB in 40 minutes,
# under the 70 GB admission floor, faster than cleanup.sh's 15-minute tick.
#
#   bash hooks/work-trim.sh job      # what job-completed.sh runs (env from the job)
#   bash hooks/work-trim.sh empty    # empty the trash (run detached by `job`)
#
# Sourced by cleanup.sh for wt_checkout_trim, wt_cache_trim and wt_empty_trash,
# which it runs over idle runners.
#
# What goes, from the job's own workspace only:
#   - the checkout's ignored and untracked files (build/, node_modules, .venv,
#     test output). actions/checkout runs `git clean -ffdx` before the next job
#     anyway (no workflow in the fleet sets `clean: false`), so this only moves
#     that deletion from the next job's start to this job's end. Tracked files
#     and .git stay: the next fetch is still incremental.
#   - the workspace's warm caches (every entry beside the checkout that is not
#     itself a git checkout), when the disk is under the pressure line
#     (FLEET_CLEANUP_PRESSURE_GB, else the admission floor + 20 GB, the same
#     line cleanup.sh uses), or when nothing in one was written for
#     FLEET_CLEANUP_RUNNER_CACHE_DAYS (7). With room on the disk the caches
#     stay and builds stay incremental; without it a cold build is cheaper than
#     a fleet held at the floor. FLEET_WORK_TRIM_KEEP names caches (shell
#     patterns) the pressure rule leaves alone.
# Never the runner's own _temp, _tool, _actions; never another runner's work.
#
# Fast inside the hook: everything is renamed into $ROOT/.work-trash (same
# volume, one rename each) and deleted by a detached `empty`, so a 6 GB tree
# does not hold the job's completion for a minute, and the next job on this
# runner cannot find half of a deleted tree.
#
# FLEET_WORK_TRIM=0 turns the hook's part off; cleanup.sh still trims idle
# runners. Never fails its caller: a hook that exits non-zero turns a green job
# red.

WT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$WT_HERE/.." && pwd)}"
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"
if [ -f "$WT_HERE/free-disk.sh" ]; then
  # shellcheck source=hooks/free-disk.sh
  . "$WT_HERE/free-disk.sh"
fi

WT_TRASH="${FLEET_WORK_TRASH:-$ROOT/.work-trash}"
WT_CACHE_DAYS="${FLEET_CLEANUP_RUNNER_CACHE_DAYS:-7}"
case "$WT_CACHE_DAYS" in '' | *[!0-9]*) WT_CACHE_DAYS=7 ;; esac
WT_FLOOR_GB="${FLEET_ADMIT_MIN_FREE_DISK_GB:-40}"
case "$WT_FLOOR_GB" in '' | *[!0-9]*) WT_FLOOR_GB=40 ;; esac
WT_PRESSURE_GB="${FLEET_CLEANUP_PRESSURE_GB:-$((WT_FLOOR_GB + 20))}"
case "$WT_PRESSURE_GB" in '' | *[!0-9]*) WT_PRESSURE_GB=$((WT_FLOOR_GB + 20)) ;; esac
WT_KEEP="${FLEET_WORK_TRIM_KEEP:-}"
WT_LOG="${FLEET_WORK_TRIM_LOG:-$ROOT/logs/work-trim.log}"

# Set by the caller: 1 moves things, anything else only says what it would.
WT_APPLY="${WT_APPLY:-1}"
# What this run moved, and its lines (one per entry).
WT_N=0
WT_KB=0
WT_LINES=""
WT_RUN=""
WT_PREFIX=""

wt_say() {
  WT_LINES="${WT_LINES}${WT_PREFIX}$*
"
}

# wt_trash PATH WHY: move PATH into this run's trash folder (or say it would).
wt_trash() {
  local p="$1" why="$2" kb rel
  [ -e "$p" ] || [ -L "$p" ] || return 0
  kb="$(du -sk "$p" 2>/dev/null | cut -f1)"
  case "$kb" in '' | *[!0-9]*) kb=0 ;; esac
  rel="${p#"$ROOT"/}"
  if [ "$WT_APPLY" = 1 ]; then
    if [ -z "$WT_RUN" ]; then
      mkdir -p "$WT_TRASH" 2>/dev/null && WT_RUN="$(mktemp -d "$WT_TRASH/run.XXXXXX" 2>/dev/null)" || WT_RUN=""
    fi
    # A rename on the same volume, or, when that fails, the slow way.
    if [ -z "$WT_RUN" ] || ! mv -- "$p" "$WT_RUN/$WT_N" 2>/dev/null; then
      rm -rf -- "$p" 2>/dev/null
      if [ -e "$p" ] || [ -L "$p" ]; then
        chmod -R u+w -- "$p" 2>/dev/null
        rm -rf -- "$p" 2>/dev/null
      fi
      { [ -e "$p" ] || [ -L "$p" ]; } && return 0
    fi
    wt_say "$((kb / 1024)) MB  $rel ($why)"
  else
    wt_say "[dry-run] $((kb / 1024)) MB  $rel ($why)"
  fi
  WT_N=$((WT_N + 1))
  WT_KB=$((WT_KB + kb))
}

# wt_checkout_trim CHECKOUT: its ignored and untracked files, which the next
# actions/checkout removes anyway. Only a git checkout; .git itself never.
wt_checkout_trim() {
  local co="$1" rel
  [ -d "$co" ] && [ -e "$co/.git" ] || return 0
  while IFS= read -r rel; do
    case "$rel" in
      '' | '"'*) continue ;; # empty, or a name git had to quote: leave it to checkout
    esac
    rel="${rel%/}"
    case "/$rel/" in */.git/*) continue ;; esac
    wt_trash "$co/$rel" "ignored in the checkout"
  done < <(git -C "$co" -c core.quotePath=false clean -ndffx 2>/dev/null | sed -n 's/^Would remove //p')
}

wt_kept() {
  local name="$1" pat
  for pat in $WT_KEEP; do
    # shellcheck disable=SC2254
    case "$name" in $pat) return 0 ;; esac
  done
  return 1
}

# wt_cache_trim WORKSPACE PRESSURE: the warm caches beside the checkout in
# _work/<repo>/. One unused for WT_CACHE_DAYS goes; with PRESSURE=1, all of
# them but FLEET_WORK_TRIM_KEEP. The checkout (_work/<repo>/<repo>) and any
# other git checkout there (a fixture repo) are not caches.
wt_cache_trim() {
  local ws="$1" pressure="${2:-0}" e name why
  [ -d "$ws" ] || return 0
  for e in "$ws"/* "$ws"/.[!.]* "$ws"/..?*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    name="${e##*/}"
    [ "$name" = "${ws##*/}" ] && continue
    [ -e "$e/.git" ] && continue
    if [ -z "$(find "$e" -maxdepth 2 -mtime -"$WT_CACHE_DAYS" -print -quit 2>/dev/null)" ]; then
      why="unused ${WT_CACHE_DAYS}d"
    elif [ "$pressure" = 1 ] && ! wt_kept "$name"; then
      why="disk under ${WT_PRESSURE_GB} GB"
    else
      continue
    fi
    wt_trash "$e" "$why"
  done
}

# Delete what the trims moved. One emptier at a time; a lock older than an
# hour is one that died holding it. Read-only trees (Go's module cache) are
# made writable first.
wt_empty_trash() {
  local lock="$WT_TRASH.lock" e pass=0
  [ -d "$WT_TRASH" ] || return 0
  if ! mkdir "$lock" 2>/dev/null; then
    [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ] || return 0
    rmdir "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || return 0
  fi
  # Again while new runs arrive, a bounded number of times.
  while [ "$pass" -lt 20 ]; do
    pass=$((pass + 1))
    set -- "$WT_TRASH"/run.*
    [ -e "$1" ] || break
    for e in "$@"; do
      rm -rf -- "$e" 2>/dev/null
      if [ -e "$e" ]; then
        chmod -R u+w -- "$e" 2>/dev/null
        rm -rf -- "$e" 2>/dev/null
      fi
    done
  done
  rmdir "$lock" 2>/dev/null
  return 0
}

wt_usable_gb() {
  local gb=""
  if command -v fleet_usable_free_gb >/dev/null 2>&1; then gb="$(fleet_usable_free_gb)"; fi
  case "$gb" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' "$gb"
}

# The job's own workspace, $ROOT/<runner>/_work/<repo>, and nothing else.
wt_job_workspace() {
  local ws="${RUNNER_WORKSPACE:-}" rd root_p rd_p
  case "$ws" in /*) ;; *) return 1 ;; esac
  ws="${ws%/}"
  rd="${ws%/_work/*}"
  [ "$rd" != "$ws" ] || return 1
  [ "$rd/_work/${ws##*/}" = "$ws" ] || return 1
  case "${ws##*/}" in '' | _* | .*) return 1 ;; esac
  [ -f "$rd/.runner" ] && [ -d "$ws" ] || return 1
  root_p="$(cd "$ROOT" 2>/dev/null && pwd -P)" || return 1
  rd_p="$(cd "$rd/.." 2>/dev/null && pwd -P)" || return 1
  [ "$root_p" = "$rd_p" ] || return 1
  printf '%s' "$ws"
}

wt_job() {
  local ws co free pressure=0 t0 secs line
  [ "${FLEET_WORK_TRIM:-1}" = 0 ] && return 0
  ws="$(wt_job_workspace)" || return 0
  t0="$(date +%s)"
  co="${GITHUB_WORKSPACE:-}"
  co="${co%/}"
  [ "${co%/*}" = "$ws" ] || co="$ws/${ws##*/}"
  free="$(wt_usable_gb)" || free=""
  [ -n "$free" ] && [ "$free" -lt "$WT_PRESSURE_GB" ] && pressure=1
  wt_checkout_trim "$co"
  wt_cache_trim "$ws" "$pressure"
  secs=$(($(date +%s) - t0))
  [ "$WT_N" -gt 0 ] || return 0
  line="work-trim: ${ws#"$ROOT"/} gave back $((WT_KB / 1024)) MB in ${WT_N} entries (${secs}s, ${free:-?} GB usable, pressure line ${WT_PRESSURE_GB} GB)"
  printf '%s\n' "$line"
  if mkdir -p "$(dirname "$WT_LOG")" 2>/dev/null; then
    {
      printf '%s %s %s\n' "$(date '+%F %T')" "${RUNNER_NAME:-?}" "$line"
      printf '%s' "$WT_LINES" | sed 's/^/    /'
    } >> "$WT_LOG" 2>/dev/null
  fi
  # The emptier must outlive the job: an empty RUNNER_TRACKING_ID keeps the
  # runner's end-of-job process sweep from killing it.
  RUNNER_TRACKING_ID="" FLEET_ROOT="$ROOT" nohup bash "$WT_HERE/work-trim.sh" empty >/dev/null 2>&1 &
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    job) wt_job ;;
    empty) wt_empty_trash ;;
  esac
  exit 0
fi
