#!/usr/bin/env bash
# Are the plain CLI tools in scripts/cli-tools.txt on the runners' PATH?
#
#   scripts/check-tools.sh shellcheck jq      # check these
#   scripts/check-tools.sh --list always      # names of the `always` tools
#   scripts/check-tools.sh --list all         # every listed tool
#
# One line per tool, tab-separated, for preflight.sh and join-host.sh to format:
#   ok    <tool>  <path>
#   miss  <tool>  <formula or ->  <why>
# Exits 1 when any is missing. A tool not in the list is checked with formula -.
#
# Looked up on the PATH register.sh writes into each runner's .env, not on the
# caller's: a tool in ~/.local/bin or a shell-only shim passes in a terminal and
# is still "No such file or directory" to a job. CHECK_TOOLS_PATH overrides it
# (tests).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="${CHECK_TOOLS_LIST:-$HERE/cli-tools.txt}"
RUNNER_PATH="${CHECK_TOOLS_PATH:-/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin}"

entries() { grep -v '^[[:space:]]*#' "$LIST" | awk 'NF >= 3'; }

if [ "${1:-}" = --list ]; then
  case "${2:-}" in
    all)    entries | awk '{print $1}' ;;
    always) entries | awk '$3 == "always" {print $1}' ;;
    *) echo "usage: $0 --list always|all" >&2; exit 2 ;;
  esac
  exit 0
fi

rc=0
for tool in "$@"; do
  if path="$(PATH="$RUNNER_PATH" command -v "$tool" 2>/dev/null)" && [ -n "$path" ]; then
    printf 'ok\t%s\t%s\n' "$tool" "$path"
  else
    line="$(entries | awk -v t="$tool" '$1 == t' | head -1)"
    formula="$(printf '%s' "$line" | awk '{print $2}')"
    why="$(printf '%s' "$line" | awk '{$1=$2=$3=""; sub(/^ +/, ""); print}')"
    printf 'miss\t%s\t%s\t%s\n' "$tool" "${formula:--}" "${why:-not in scripts/cli-tools.txt}"
    rc=1
  fi
done
exit "$rc"
