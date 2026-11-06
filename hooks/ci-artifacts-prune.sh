#!/usr/bin/env bash
# Prune ~/ci-artifacts, the folder self-hosted jobs keep their screenshots,
# reports and test bundles in instead of uploading them to GitHub
# (~/ci-artifacts/<repo>/<run_id>-<run_attempt>/, viewed at /artifacts/ on the
# dashboard). Retention is one day (owner decision D2, 2026-11-05): the jobs
# prune their own repo's folder when they write, and this is the safety net for
# a repo whose job did not, or a run that was cancelled before it could.
#
#   bash hooks/ci-artifacts-prune.sh             # dry run: lists what it would remove
#   bash hooks/ci-artifacts-prune.sh --apply     # remove
#   bash hooks/ci-artifacts-prune.sh --apply --if-due   # what job-completed.sh runs:
#                                                # at most once per FLEET_CI_ARTIFACTS_EVERY_S
#
# Sourced by cleanup.sh for ci_artifacts_prune and ci_artifacts_kb.
#
# What goes: an entry directly under a repo's folder (~/ci-artifacts/*/*) not
# modified for FLEET_CI_ARTIFACTS_KEEP_MIN minutes (1440), unless anything
# inside it was modified in the last FLEET_CI_ARTIFACTS_FRESH_MIN (60): a job
# that is still writing into an old run's folder (a re-run's attempt, a stitch
# step) keeps it. Nothing else under ~/ci-artifacts, and never anything
# outside it: find does not follow symlinks, and rm -rf removes a link, not
# what it points at.
#
# Never fails its caller: the job-completed hook must not turn a green job red.

CI_ARTIFACTS="${FLEET_CI_ARTIFACTS:-$HOME/ci-artifacts}"
CI_ARTIFACTS_KEEP_MIN="${FLEET_CI_ARTIFACTS_KEEP_MIN:-1440}"
case "$CI_ARTIFACTS_KEEP_MIN" in '' | *[!0-9]*) CI_ARTIFACTS_KEEP_MIN=1440 ;; esac
CI_ARTIFACTS_FRESH_MIN="${FLEET_CI_ARTIFACTS_FRESH_MIN:-60}"
case "$CI_ARTIFACTS_FRESH_MIN" in '' | *[!0-9]*) CI_ARTIFACTS_FRESH_MIN=60 ;; esac

# A root that is not an absolute folder of its own (unset HOME, "/", HOME
# itself) is refused rather than pruned.
ci_artifacts_root_ok() {
  case "$CI_ARTIFACTS" in
    /*) ;;
    *) return 1 ;;
  esac
  [ "$CI_ARTIFACTS" != "/" ] && [ "${CI_ARTIFACTS%/}" != "${HOME%/}" ] && [ -d "$CI_ARTIFACTS" ]
}

# KB used under the root, or empty when there is none.
ci_artifacts_kb() {
  ci_artifacts_root_ok || return 0
  du -sk "$CI_ARTIFACTS" 2>/dev/null | cut -f1
}

# ci_artifacts_prune APPLY: one line per entry it removes (or would, when
# APPLY is not 1), then a total line. Returns 0.
ci_artifacts_prune() {
  local apply="${1:-0}" n=0 kb=0 k entry
  if ! ci_artifacts_root_ok; then
    printf '%s\n' "(no $CI_ARTIFACTS)"
    return 0
  fi
  while IFS= read -r -d '' entry; do
    if [ -d "$entry" ] && [ -n "$(find "$entry" -mmin "-$CI_ARTIFACTS_FRESH_MIN" -print -quit 2>/dev/null)" ]; then
      printf '%s\n' "kept ${entry#"$CI_ARTIFACTS"/} (written in the last ${CI_ARTIFACTS_FRESH_MIN}m)"
      continue
    fi
    k="$(du -sk "$entry" 2>/dev/null | cut -f1)"
    case "$k" in '' | *[!0-9]*) k=0 ;; esac
    if [ "$apply" = "1" ]; then
      rm -rf -- "$entry" 2>/dev/null || continue
      printf '%s\n' "$((k / 1024)) MB  ${entry#"$CI_ARTIFACTS"/}"
    else
      printf '%s\n' "[dry-run] $((k / 1024)) MB  ${entry#"$CI_ARTIFACTS"/}"
    fi
    n=$((n + 1))
    kb=$((kb + k))
  done < <(find "$CI_ARTIFACTS" -mindepth 2 -maxdepth 2 ! -name '.*' -mmin "+$CI_ARTIFACTS_KEEP_MIN" -print0 2>/dev/null)
  printf '%s\n' "${n} older than $((CI_ARTIFACTS_KEEP_MIN / 60))h, $((kb / 1024)) MB"
  return 0
}

ci_artifacts_main() {
  local apply=0 if_due=0 arg stamp lock now last every
  for arg in "$@"; do
    case "$arg" in
      --apply) apply=1 ;;
      --if-due) if_due=1 ;;
    esac
  done
  # One prune at a time, and from the hook at most every few minutes: every
  # one of the host's runners runs it when a job ends, and a find over a few
  # thousand run folders each time is wasted.
  stamp="${FLEET_CI_ARTIFACTS_STAMP:-${TMPDIR:-/tmp}/ci-artifacts-prune.$(id -u).last}"
  lock="${stamp%.last}.lock"
  every="${FLEET_CI_ARTIFACTS_EVERY_S:-600}"
  case "$every" in '' | *[!0-9]*) every=600 ;; esac
  now="$(date +%s)"
  if [ "$if_due" = 1 ]; then
    last="$(cat "$stamp" 2>/dev/null)"
    case "$last" in '' | *[!0-9]*) last=0 ;; esac
    [ $((now - last)) -ge "$every" ] || return 0
  fi
  if ! mkdir "$lock" 2>/dev/null; then
    # A lock older than an hour is a prune that died holding it.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      rmdir "$lock" 2>/dev/null; mkdir "$lock" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  [ "$apply" = 1 ] && printf '%s\n' "$now" > "$stamp" 2>/dev/null
  ci_artifacts_prune "$apply"
  rmdir "$lock" 2>/dev/null
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  ci_artifacts_main "$@"
  exit 0
fi
