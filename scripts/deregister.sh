#!/usr/bin/env bash
# Remove ONE runner from this host: stop the service, uninstall its LaunchAgent,
# deregister it from GitHub, delete its directory.
#
#   scripts/deregister.sh <dir-name>           # say what would happen
#   scripts/deregister.sh <dir-name> --apply    # do it
#   scripts/deregister.sh <dir-name> --apply --force   # ignore the last-runner guard
#
# The argument is the runner's DIRECTORY name under the fleet root — `app-ios`,
# or `app-ios-2` for a second instance — which is what register.sh created and
# what the dashboard shows.
#
# This replaces teardown.sh, whose only selector was `--keep dir,dir,...`: to
# remove one runner you named every OTHER runner, and an empty or mistyped
# keep-list removed the entire fleet. The dashboard had to reconstruct the
# keep-list on every call to work around it. Naming the target directly cannot
# fail that way — the worst typo removes nothing, because the name will not
# match a directory.
#
# Dry run by default, like cleanup.sh. Scaling down is the one operation here
# that cannot be undone by running it again.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(dirname "$HERE")}"
# shellcheck source=/dev/null
[ -f "$ROOT/fleet.env" ] && . "$ROOT/fleet.env"

TARGET=""
APPLY=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) [ -z "$TARGET" ] && TARGET="$a" || { echo "one runner at a time" >&2; exit 2; } ;;
  esac
done

[ -n "$TARGET" ] || { echo "usage: deregister.sh <dir-name> [--apply] [--force]" >&2; exit 2; }

# A directory name, not a path. Rejecting separators outright means no argument
# can ever escape the fleet root, however this is called.
case "$TARGET" in
  */*|..|.) echo "refusing: '$TARGET' is not a plain directory name" >&2; exit 2 ;;
esac

DIR="$ROOT/$TARGET"
[ -f "$DIR/.runner" ] || { echo "no runner at $DIR (expected a .runner file)" >&2; exit 1; }

REPO=$(python3 -c "import json;print(json.load(open('$DIR/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1].rstrip('/'))" 2>/dev/null)
NAME=$(python3 -c "import json;print(json.load(open('$DIR/.runner',encoding='utf-8-sig'))['agentName'])" 2>/dev/null)
[ -n "$REPO" ] && [ -n "$NAME" ] || { echo "could not read repo/agent name from $DIR/.runner" >&2; exit 1; }

echo "runner:  $NAME"
echo "repo:    $REPO"
echo "dir:     $DIR"

# Mid-job is the one state where this is actively destructive: the job dies, and
# GitHub reports it as a lost runner rather than as somebody's decision, which
# reads like an infrastructure fault to whoever finds the red build.
if pgrep -f "$DIR/bin/Runner.Worker" >/dev/null 2>&1; then
  echo "REFUSING: this runner is executing a job right now." >&2
  exit 1
fi

# Leaving a repo with no runner means it has no CI at all, and that is rarely
# what someone scaling down intended. Second and later instances are the safe
# ones to remove, which is why the autoscaler only ever touches those.
SIBLINGS=0
for d in "$ROOT"/*/; do
  [ -f "$d/.runner" ] || continue
  r=$(python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1].rstrip('/'))" 2>/dev/null)
  [ "$r" = "$REPO" ] && SIBLINGS=$((SIBLINGS + 1))
done
echo "siblings: $SIBLINGS runner(s) serve $REPO"

if [ "$SIBLINGS" -le 1 ] && [ "$FORCE" = 0 ]; then
  echo "REFUSING: this is the only runner for $REPO, so removing it leaves that" >&2
  echo "repo with no CI on this host. Pass --force if that is really the intent." >&2
  exit 1
fi

if [ "$APPLY" = 0 ]; then
  echo
  echo "DRY RUN — would run, in this order:"
  echo "  (cd $DIR && ./svc.sh stop)"
  echo "  (cd $DIR && ./svc.sh uninstall)"
  echo "  (cd $DIR && ./config.sh remove --token <remove-token for $REPO>)"
  echo "  rm -rf $DIR"
  echo
  echo "Re-run with --apply to do it."
  exit 0
fi

cd "$DIR" || exit 1

echo "==> stopping"
./svc.sh stop >/dev/null 2>&1 || echo "  (svc.sh stop reported a problem; continuing)"
echo "==> uninstalling LaunchAgent"
./svc.sh uninstall >/dev/null 2>&1 || echo "  (svc.sh uninstall reported a problem; continuing)"

# Both of the above are idempotent and safe to have half-finished — an already
# stopped service stops fine. The GitHub side is not, so it is checked properly.
echo "==> deregistering from $REPO"
TOKEN="${RUNNER_TOKEN:-$(gh api -X POST "repos/$REPO/actions/runners/remove-token" --jq .token 2>/dev/null)}"
if [ -z "$TOKEN" ]; then
  echo "FAILED: could not mint a remove-token — gh is not authenticated here." >&2
  echo "The service is stopped but the runner is STILL REGISTERED, and the" >&2
  echo "directory has been left in place so this can be retried:" >&2
  echo "  RUNNER_TOKEN=<token> $0 $TARGET --apply" >&2
  exit 1
fi

if ! ./config.sh remove --token "$TOKEN" >/dev/null 2>&1; then
  echo "FAILED: config.sh could not remove the registration." >&2
  echo "Directory left in place deliberately — deleting it now would orphan the" >&2
  echo "registration on GitHub, where it would show as an offline runner that" >&2
  echo "nothing on this host can remove. Remove it in the repo's settings, or" >&2
  echo "retry this command." >&2
  exit 1
fi

cd "$ROOT" || exit 1
echo "==> removing $DIR"
rm -rf "$DIR"

echo
echo "done: $NAME is deregistered from $REPO and gone from this host."
