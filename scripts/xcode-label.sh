#!/usr/bin/env bash
# The one rule for runner labels that name an Xcode.
#
#   scripts/xcode-label.sh check [--developer-dir DIR] LABEL[,LABEL...] ...
#   scripts/xcode-label.sh version [--developer-dir DIR]
#   scripts/xcode-label.sh facts [--root FLEET_ROOT]
#
# Or source it and call the xcode_label_* functions (register.sh and
# scripts/join-host.sh do).
#
# THE RULE. A label `xcode-<major>` or `xcode-<major>.<minor>` must name the
# Xcode a job on that runner gets, because `runs-on: [..., xcode-27]` is a
# promise about the SDK the job builds with, and nothing else checks it.
# 2026-11-19: ultra and forge advertised `xcode-26` while Xcode 27.2 was
# selected, and the Mini archived every store upload with 26.6 while CI tested
# with 27.2 (MULTI-HOST-BRIDGE-PLAN Part III, X6).
#
#   - The Xcode a job gets is the runner's DEVELOPER_DIR when its .env sets one,
#     else the host's `xcode-select -p`. Its version is `xcodebuild -version`
#     under that directory.
#   - `xcode-27` matches any 27.x; `xcode-26.6` matches 26.6 and 26.6.x only.
#   - Any other label (`ci`, `release`, `xcode`, `xcodegen`, `xcode-beta`) is
#     not an Xcode claim and is ignored.
#   - A host where xcodebuild does not answer has no Xcode for the label to
#     name, so every xcode-* label there is a mismatch.
#
# A NON-SELECTED XCODE. A host can have a second Xcode (ultra and forge have
# /Applications/Xcode-26.6.app beside the selected 27.2). A runner that should
# build with it says so in its own .env, `DEVELOPER_DIR=<app>/Contents/Developer`
# (register.sh writes it from FLEET_RUNNER_DEVELOPER_DIR), and carries that
# Xcode's label. The label is then true for every job on that runner, whether
# or not the job selects an Xcode itself; the kit's xcode-26-6 job
# (sdk/swift/Tests/xcode26.sh) keeps a DEVELOPER_DIR that is already set. There
# is no separate "installed but not selected" label: a label a job can only
# make true by selecting the Xcode itself is a label that lies to every other
# job on that runner.
#
# FACTS (for the fleet's daily re-check). One line per fact, tab-separated:
#   selected <developer-dir> <version>         (version empty: no Xcode answers)
#   runner   <dir-name> <developer-dir> <version>   (only runners whose .env sets DEVELOPER_DIR)
# The agent and fleetd read this once a day and compare it with the labels
# GitHub lists for each runner (dashboard/lib/xcode-label.js).
#
# XCODE_LABEL_XCODEBUILD and XCODE_LABEL_XCODE_SELECT name stand-ins for
# xcodebuild and xcode-select (tests).

XCODE_LABEL_RE='^[Xx][Cc][Oo][Dd][Ee]-([0-9]+)(\.([0-9]+))?$'

# The Xcode version under a developer directory (empty: the selected one), e.g.
# "27.2". Returns 1 and prints nothing when xcodebuild does not answer.
xcode_label_version() {
  local dir="${1:-}" out
  if [ -n "$dir" ]; then
    out="$(DEVELOPER_DIR="$dir" "${XCODE_LABEL_XCODEBUILD:-xcodebuild}" -version 2>/dev/null)" || return 1
  else
    # A job gets the runner's .env, not this shell's: a DEVELOPER_DIR exported
    # in the registering shell is not what the runner will run with.
    out="$(env -u DEVELOPER_DIR "${XCODE_LABEL_XCODEBUILD:-xcodebuild}" -version 2>/dev/null)" || return 1
  fi
  out="$(printf '%s\n' "$out" | sed -n 's/^Xcode \([0-9][0-9.]*\).*/\1/p' | head -1)"
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# The selected developer directory, for messages and facts.
xcode_label_selected_dir() {
  env -u DEVELOPER_DIR "${XCODE_LABEL_XCODE_SELECT:-xcode-select}" -p 2>/dev/null || true
}

# DEVELOPER_DIR from a runner directory's .env, or nothing.
xcode_label_runner_dir() {
  local env="${1:?runner dir}/.env"
  [ -f "$env" ] || return 0
  sed -n 's/^DEVELOPER_DIR=//p' "$env" | tail -1 | sed 's/^"\(.*\)"$/\1/'
}

# Is this label an Xcode claim? 0 yes, 1 no.
xcode_label_is() {
  [[ "$1" =~ $XCODE_LABEL_RE ]]
}

# Does LABEL name VERSION? 0 match, 1 mismatch (or no version), 2 not an Xcode label.
xcode_label_matches() {
  local label="$1" version="${2:-}" major minor vmajor vrest vminor
  [[ "$label" =~ $XCODE_LABEL_RE ]] || return 2
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[3]}"
  [ -n "$version" ] || return 1
  vmajor="${version%%.*}"
  vrest="${version#"$vmajor"}"; vrest="${vrest#.}"
  vminor="${vrest%%.*}"
  [ "$((10#$vmajor))" = "$((10#$major))" ] || return 1
  if [ -n "$minor" ]; then
    [ -n "$vminor" ] || vminor=0
    [ "$((10#$vminor))" = "$((10#$minor))" ] || return 1
  fi
  return 0
}

# Check a label list (any mix of separate words and comma-separated lists)
# against VERSION. Prints one line per mismatching label; returns 1 if any.
#   xcode_label_check "27.2" "/Applications/Xcode.app/Contents/Developer" ci,xcode-26
xcode_label_check() {
  local version="$1" where="$2" bad=0 label arg
  shift 2
  for arg in "$@"; do
    local IFS=','
    for label in $arg; do
      label="${label#"${label%%[![:space:]]*}"}"
      label="${label%"${label##*[![:space:]]}"}"
      [ -n "$label" ] || continue
      xcode_label_matches "$label" "$version"
      case $? in
        0|2) ;;
        *)
          bad=1
          if [ -n "$version" ]; then
            printf '%s names an Xcode jobs here do not get: Xcode %s is at %s\n' "$label" "$version" "${where:-the selected developer directory}"
          else
            printf '%s names an Xcode, but xcodebuild does not answer at %s\n' "$label" "${where:-the selected developer directory}"
          fi
          ;;
      esac
    done
  done
  return "$bad"
}

_xcode_label_main() {
  local cmd="${1:-}" dir="" root="" v
  shift || true
  case "$cmd" in
    check)
      while [ $# -gt 0 ]; do
        case "$1" in
          --developer-dir) dir="${2:?--developer-dir needs a value}"; shift 2 ;;
          *) break ;;
        esac
      done
      [ $# -gt 0 ] || { echo "usage: xcode-label.sh check [--developer-dir DIR] LABEL[,LABEL...] ..." >&2; return 2; }
      v="$(xcode_label_version "$dir")" || v=""
      xcode_label_check "$v" "${dir:-$(xcode_label_selected_dir)}" "$@"
      ;;
    version)
      [ "${1:-}" = --developer-dir ] && dir="${2:?--developer-dir needs a value}"
      xcode_label_version "$dir"
      ;;
    facts)
      [ "${1:-}" = --root ] && root="${2:?--root needs a value}"
      root="${root:-${FLEET_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
      v="$(xcode_label_version "")" || v=""
      printf 'selected\t%s\t%s\n' "$(xcode_label_selected_dir)" "$v"
      local d rd
      for d in "$root"/*/; do
        [ -f "$d/.runner" ] || continue
        rd="$(xcode_label_runner_dir "$d")"
        [ -n "$rd" ] || continue
        v="$(xcode_label_version "$rd")" || v=""
        printf 'runner\t%s\t%s\t%s\n' "$(basename "$d")" "$rd" "$v"
      done
      ;;
    -h|--help|"")
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      [ -n "$cmd" ] || return 2
      ;;
    *) echo "unknown command: $cmd" >&2; return 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  _xcode_label_main "$@"
  exit $?
fi
