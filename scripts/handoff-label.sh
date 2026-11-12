#!/usr/bin/env bash
# Put the hand-off routing label on one host's runners (or take it off), through
# GitHub's runner labels API. No re-registration, no restart, no job touched.
#
#   scripts/handoff-label.sh --host <id> --repos owner/a,owner/b            # what it would change
#   scripts/handoff-label.sh --host <id> --repos owner/a,owner/b --apply    # add the label
#   scripts/handoff-label.sh --host <id> --repos owner/a --remove --apply   # take it off
#
# Why: some jobs hand files to each other through the runner host's disk
# (~/ci-artifacts): a stitch or merge job reads what the jobs before it kept
# there. With one runner host that always works. With two, GitHub may run the
# producer on one and the consumer on the other. Those jobs ask for one more
# label, `handoff` (FLEET_HANDOFF_LABEL), that exactly one host's runners carry,
# so the whole hand-off lands on one disk. scripts/mirror-runners.sh drops the
# label when another host copies these runners (FLEET_HOST_ONLY_LABELS).
#
# Order matters. Label the runners FIRST, then merge the workflow change that
# asks for the label: a job asking for a label no runner has queues forever.
# To move the route to another host (docs/claude/promote-coordinator.md):
# --apply on the new host, then --remove --apply on the old one.
#
# A runner is this host's when its name starts with "<host>-". Runs wherever
# `gh` is logged in (a laptop is fine). Calls are serial, and it stops when the
# GitHub API budget falls under FLEET_HANDOFF_API_FLOOR (500): the dashboard
# polls with the same account.
set -uo pipefail
LABEL="${FLEET_HANDOFF_LABEL:-handoff}"
FLOOR="${FLEET_HANDOFF_API_FLOOR:-500}"
HOST=""; REPOS=""; APPLY=0; REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a host id}"; shift ;;
    --repos) REPOS="${2:?--repos needs owner/repo,...}"; shift ;;
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$HOST" ] || { echo "--host is required" >&2; exit 2; }
[ -n "$REPOS" ] || { echo "--repos is required" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }

budget() { gh api rate_limit --jq .resources.core.remaining 2>/dev/null || echo 0; }
left="$(budget)"
if [ "$left" -lt "$FLOOR" ]; then
  echo "GitHub API budget is $left (floor $FLOOR): not starting. Try after the hourly reset." >&2
  exit 1
fi
echo "handoff-label: ${LABEL}, host ${HOST}, $([ "$REMOVE" -eq 1 ] && echo remove || echo add), $([ "$APPLY" -eq 1 ] && echo applying || echo 'dry run'); API budget $left"

changed=0; same=0; failed=0
for repo in ${REPOS//,/ }; do
  rows="$(gh api "repos/$repo/actions/runners?per_page=100" \
    --jq ".runners[] | select(.name | startswith(\"$HOST-\")) | \"\(.id) \(.name) \([.labels[].name] | join(\",\"))\"" 2>&1)" || {
    echo "  ✗ $repo: cannot list runners: ${rows:0:160}"; failed=$((failed + 1)); continue; }
  [ -n "$rows" ] || { echo "  · $repo: no runner named $HOST-*"; continue; }
  while read -r id name labels; do
    case ",$labels," in *",$LABEL,"*) has=1 ;; *) has=0 ;; esac
    if { [ "$REMOVE" -eq 0 ] && [ "$has" -eq 1 ]; } || { [ "$REMOVE" -eq 1 ] && [ "$has" -eq 0 ]; }; then
      same=$((same + 1)); continue
    fi
    if [ "$APPLY" -eq 0 ]; then
      echo "  · would $([ "$REMOVE" -eq 1 ] && echo remove "$LABEL" from || echo add "$LABEL" to) $name ($labels)"
      changed=$((changed + 1)); continue
    fi
    if [ "$REMOVE" -eq 1 ]; then
      gh api -X DELETE "repos/$repo/actions/runners/$id/labels/$LABEL" >/dev/null 2>&1
    else
      gh api -X POST "repos/$repo/actions/runners/$id/labels" -f "labels[]=$LABEL" >/dev/null 2>&1
    fi && { echo "  ✓ $name"; changed=$((changed + 1)); } || { echo "  ✗ $name: the API refused"; failed=$((failed + 1)); }
  done <<< "$rows"
  left="$(budget)"
  [ "$left" -ge "$FLOOR" ] || { echo "API budget fell to $left: stopping after $repo" >&2; failed=$((failed + 1)); break; }
done
echo "$changed $([ "$APPLY" -eq 1 ] && echo changed || echo 'to change'), $same already right, $failed failed"
[ "$failed" -eq 0 ]
