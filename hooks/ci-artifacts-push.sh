#!/usr/bin/env bash
# Copy this job's run folder of ~/ci-artifacts to the coordinator, so the
# dashboard's /artifacts/ viewer (which serves only the coordinator's own
# folder) and every PR comment's gallery link keep working whichever host ran
# the job.
#
#   bash hooks/ci-artifacts-push.sh                 # what job-completed.sh runs, detached
#   bash hooks/ci-artifacts-push.sh --dry-run       # print the copy, do nothing
#
# Off unless FLEET_CI_ARTIFACTS_PUSH_TO is set, and set only on a host that is
# NOT the coordinator. It names where the coordinator keeps the folder:
#   FLEET_CI_ARTIFACTS_PUSH_TO=coordinator-mac:ci-artifacts     # ssh host:path (path under its home)
#   FLEET_CI_ARTIFACTS_PUSH_TO=/Volumes/shared/ci-artifacts     # a local path (tests)
#
# The run folder is ~/ci-artifacts/<repo>/<run_id>-<run_attempt>/, from the
# job's GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT. Every job of a
# run pushes the same folder; rsync sends only what is new, so the last job's
# push carries the whole run. Plain `rsync -a`: macOS ships openrsync, which
# fails on GNU-only flags.
#
# This is NOT how jobs hand files to each other. A job that reads what an
# earlier job kept must run on the same host as it (the `handoff` routing label,
# docs/claude/promote-coordinator.md): a push is detached and may land after
# the next job has started.
#
# Never fails its caller. Logs one line per push to $FLEET_ROOT/logs/ci-artifacts-push.log.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"
[ -f "$ROOT/fleet.env" ] && [ -z "${FLEET_CI_ARTIFACTS_PUSH_TO+x}" ] && . "$ROOT/fleet.env" 2>/dev/null
DEST="${FLEET_CI_ARTIFACTS_PUSH_TO:-}"
SRC_ROOT="${FLEET_CI_ARTIFACTS:-$HOME/ci-artifacts}"
LOG="${FLEET_CI_ARTIFACTS_PUSH_LOG:-$ROOT/logs/ci-artifacts-push.log}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ -n "$DEST" ] || exit 0
repo="${GITHUB_REPOSITORY:-}"; repo="${repo##*/}"
run="${GITHUB_RUN_ID:-}"
attempt="${GITHUB_RUN_ATTEMPT:-1}"
case "$repo" in '' | . | .. | */*) exit 0 ;; esac
case "$run" in '' | *[!0-9]*) exit 0 ;; esac
case "$attempt" in '' | *[!0-9]*) attempt=1 ;; esac
src="$SRC_ROOT/$repo/$run-$attempt"
# Nothing kept by this run on this host: nothing to send.
[ -d "$src" ] && [ ! -L "$src" ] || exit 0

log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$repo/$run-$attempt" "$*" >> "$LOG" 2>/dev/null
}

case "$DEST" in
  *:*)
    host="${DEST%%:*}"; path="${DEST#*:}"
    target="$host:$path/$repo/$run-$attempt/"
    prepare() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "mkdir -p '$path/$repo/$run-$attempt'"; }
    ;;
  /*)
    target="$DEST/$repo/$run-$attempt/"
    prepare() { mkdir -p "$DEST/$repo/$run-$attempt"; }
    ;;
  *) log "refused: FLEET_CI_ARTIFACTS_PUSH_TO is neither host:path nor an absolute path"; exit 0 ;;
esac

if [ "$DRY" -eq 1 ]; then
  echo "would copy $src/ to $target"
  exit 0
fi

# Three tries, a little apart: a coordinator that is busy or briefly away
# should not lose a run's screenshots.
for try in 1 2 3; do
  if prepare >/dev/null 2>&1 && rsync -a "$src/" "$target" >/dev/null 2>&1; then
    log "pushed to $target (try $try)"
    exit 0
  fi
  [ "$try" -lt 3 ] && sleep "${FLEET_CI_ARTIFACTS_PUSH_RETRY_S:-20}"
done
log "FAILED after 3 tries to $target"
exit 0
