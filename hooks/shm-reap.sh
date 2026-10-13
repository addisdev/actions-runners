#!/usr/bin/env bash
# Removes System V shared memory segments that a killed job left behind. Run by
# both job hooks; never fails its caller.
#
# Postgres-backed suites start throwaway clusters with initdb/pg_ctl, and every
# postmaster creates one SysV segment. A clean shutdown removes it. A step that
# times out or is cancelled does not get one: the runner kills the cluster and
# the segment stays, attached by nobody, its creator dead. macOS caps the
# system-wide table at kern.sysv.shmmni = 32, so after about thirty such jobs
# every new cluster on the host dies in shmget with
#   FATAL: could not create shared memory segment: No space left on device
# which reads as a broken test in whichever repo is unlucky next. On 2026-10-13
# 31 orphans were removed by hand to unblock one PR, and four more had leaked
# within half an hour.
#
# What counts as an orphan, all three required:
#   - owned by the user this runner runs as. Nothing else is ours to judge.
#   - NATTCH 0. A segment some process still has mapped is in use, whoever
#     made it — the Homebrew postgres service on the host holds one.
#   - its creator PID (CPID) is not running. A cluster between shmget and
#     shmat has NATTCH 0 for a moment; its postmaster is alive, so it is kept.
#     A reused PID errs the same way: the segment is kept until the next job.
#
# ipcs columns are found by header name, not position. If the header ever
# stops naming them this removes nothing, because a column read from the wrong
# place could pick a live segment.
#
# Usage: shm-reap.sh <started|completed>

set -u
trap 'exit 0' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"

[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

[ "${FLEET_SHM_REAP:-1}" = "0" ] && exit 0

PHASE="${1:-}"
LOG="${FLEET_SHM_LOG:-$ROOT/dashboard/logs/shm.ndjson}"
IPCS="${FLEET_IPCS:-ipcs}"
IPCRM="${FLEET_IPCRM:-ipcrm}"
ME="$(id -un 2>/dev/null)"
[ -n "$ME" ] || exit 0

# Below this many free table entries after reaping, the host is one burst of
# live clusters away from the shmget failure, so it is logged even when
# nothing was removed.
LOW="${FLEET_SHM_LOW_FREE:-4}"
case "$LOW" in '' | *[!0-9]*) LOW=4 ;; esac

shm_json_str() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:cntrl:]]//g'
}

# ps, not kill -0: kill -0 answers EPERM for another user's live process,
# which would read as dead.
shm_pid_live() {
  case "$1" in '' | *[!0-9]* | 0) return 1 ;; esac
  ps -p "$1" -o pid= >/dev/null 2>&1
}

LISTING="$("$IPCS" -m -o -p 2>/dev/null)" || LISTING=""

# "id owner nattch cpid" per segment, or nothing if the header is unreadable.
ROWS="$(printf '%s\n' "$LISTING" | awk '
  !cols && $1 == "T" {
    for (i = 1; i <= NF; i++) {
      if ($i == "ID") id = i
      else if ($i == "OWNER") own = i
      else if ($i == "NATTCH") att = i
      else if ($i == "CPID") cpid = i
    }
    cols = (id && own && att && cpid)
    next
  }
  cols && $1 == "m" { print $id, $own, $att, $cpid }
')"

TOTAL=0
REAPED=0
FAILED=0
IDS=""
while read -r id owner nattch cpid; do
  [ -n "${id:-}" ] || continue
  TOTAL=$((TOTAL + 1))
  [ "$owner" = "$ME" ] || continue
  [ "$nattch" = "0" ] || continue
  shm_pid_live "$cpid" && continue
  if "$IPCRM" -m "$id" >/dev/null 2>&1; then
    REAPED=$((REAPED + 1))
    IDS="${IDS:+$IDS,}$id"
  else
    # Usually another hook removed it a moment earlier.
    FAILED=$((FAILED + 1))
  fi
done <<EOF
$ROWS
EOF

LIMIT="${FLEET_SHM_LIMIT:-$(sysctl -n kern.sysv.shmmni 2>/dev/null)}" || LIMIT=""
case "$LIMIT" in '' | *[!0-9]*) LIMIT=0 ;; esac
USED=$((TOTAL - REAPED))
FREE=-1
[ "$LIMIT" -gt 0 ] && FREE=$((LIMIT - USED))

EVENT=""
if [ "$REAPED" -gt 0 ]; then
  EVENT=reaped
  echo "fleet: removed $REAPED orphaned shared memory segment(s) left by killed jobs"
fi
if [ "$FREE" -ge 0 ] && [ "$FREE" -lt "$LOW" ]; then
  EVENT=low
  echo "fleet: only $FREE of $LIMIT System V shared memory segments free; Postgres clusters may fail in shmget"
fi
[ -n "$EVENT" ] || exit 0

mkdir -p "$(dirname "$LOG")" 2>/dev/null || exit 0
printf '{"ts":%s,"event":"%s","phase":"%s","runner":"%s","repo":"%s","run":"%s","reaped":%s,"failed":%s,"used":%s,"limit":%s,"ids":"%s"}\n' \
  "$(date +%s)" "$EVENT" \
  "$(shm_json_str "$PHASE")" \
  "$(shm_json_str "${RUNNER_NAME:-}")" \
  "$(shm_json_str "${GITHUB_REPOSITORY:-}")" \
  "$(shm_json_str "${GITHUB_RUN_ID:-}")" \
  "$REAPED" "$FAILED" "$USED" "$LIMIT" "$IDS" \
  >> "$LOG" 2>/dev/null || true
