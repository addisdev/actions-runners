#!/usr/bin/env bash
# What every runner on this Mac is doing, and what the fleet costs while idle.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"

printf "%-26s %-10s %s\n" "REPO" "STATUS" "RUNNER"

# Deduplicated by repo, not by directory. A repo with a second runner has two
# directories (<repo> and <repo>-2) that name the same repo, and the API returns
# every runner belonging to it — so looping over directories printed each of
# that repo's runners twice.
# plutil is part of macOS and accepts both the runner's JSON format and its
# UTF-8 BOM. Do not use /usr/bin/python3 here: after an Xcode update that binary
# can be blocked by the license prompt, which used to turn this into an empty
# report even while runners were busy.
repos=$(for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  if url=$(plutil -extract gitHubUrl raw -o - "$d/.runner" 2>/dev/null); then
    printf '%s\n' "${url#https://github.com/}"
  else
    echo "warning: cannot parse $d/.runner" >&2
  fi
done | sort -u)

for repo in $repos; do
  # `gh api` has no --arg. It is not jq — it only forwards a filter string to
  # it — so the previous `--jq --arg r "$repo" '…$ARGS.named.r…'` made "--arg"
  # the filter and errored out. With stderr suppressed that printed an empty
  # table that looked like "no runners" rather than like a broken command.
  # Interpolate the repo into the filter instead.
  gh api "repos/$repo/actions/runners" \
    --jq ".runners[] | [\"$repo\", (if .busy then \"BUSY\" else .status end), .name] | @tsv" \
    2>/dev/null | awk -F'\t' '{printf "%-26s %-10s %s\n", $1, $2, $3}'
done
echo
ps -o rss= -p "$(pgrep -f Runner.Listener | tr '\n' ',' | sed 's/,$//')" 2>/dev/null \
  | awk '{s+=$1; n++} END {printf "%d listeners, %.0f MB resident, ", n, s/1024}'
du -sh "$ROOT" 2>/dev/null | awk '{print $1 " on disk"}'
