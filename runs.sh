#!/usr/bin/env bash
# What the fleet is doing right now, across every repo, and on which machine.
#
#   ./runs.sh            # one snapshot
#   ./runs.sh --watch    # refresh every 15s until interrupted
#   ./runs.sh --host     # group by machine instead of by repo
#   ./runs.sh --refresh  # rediscover which repos have CI, then report
#
# GitHub has no cross-repo view of Actions. Each repo has its own tab, so past a
# handful of repos there is no single page that answers "is anything running,
# and where" — which is exactly the question when runners live on more than one
# machine. Hence this.
#
# Runs are attributed to a HOST, not just a runner: after a migration the same
# repo has runners on two machines, and "did that job go to the new box" is
# otherwise only answerable by opening the run in a browser.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"

WATCH=0
BYHOST=0
REFRESH=0
for a in "$@"; do
  case "$a" in
    --watch)   WATCH=1 ;;
    --host)    BYHOST=1 ;;
    --refresh) REFRESH=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  esac
done

REPOS=$(for d in "${FLEET_ROOT:-$HERE}"/*/; do
  [ -f "$d/.runner" ] || continue
  python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1])" 2>/dev/null
done | sort -u)

# Everything below only runs on a machine with no runners of its own — a laptop
# that is only watching a fleet hosted elsewhere. On the runner host the
# directories above are the answer, and they are free to read.

CACHE="${FLEET_REPO_CACHE:-$HERE/.fleet-repos}"
CACHE_TTL="${FLEET_REPO_CACHE_TTL:-21600}"

cache_age() {
  [ -f "$CACHE" ] || { echo 999999999; return; }
  echo $(( $(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || echo 0) ))
}

# Which of the account's repos actually have Actions. The filter is the point:
# without it this reports on every boilerplate and tutorial checkout the account
# has ever held, and each one costs an API call on every single snapshot. On the
# fleet this was written against that was 66 repos to cover 24 real ones.
#
# Cached because the answer changes about as often as someone creates a repo,
# while --watch asks the question every 15 seconds.
discover_repos() {
  local owner tmp i
  owner="${FLEET_OWNER:-$(gh api user --jq .login 2>/dev/null)}"
  [ -n "$owner" ] || return 1

  tmp=$(mktemp -d) || return 1
  i=0
  while read -r repo; do
    [ -n "$repo" ] || continue
    (
      n=$(gh api "repos/$repo/actions/workflows" --jq .total_count 2>/dev/null)
      case "$n" in
        ''|0|*[!0-9]*) ;;
        *) echo "$repo" > "$tmp/$(echo "$repo" | tr '/' '_')" ;;
      esac
    ) &
    i=$((i + 1))
    # Bounded fan-out. bash 3.2 has no `wait -n`, so this waits for a whole
    # batch rather than for the next free slot — cruder, but it keeps a
    # 200-repo account from opening 200 sockets at once.
    [ $((i % 12)) -eq 0 ] && wait
  done <<EOF
$(gh repo list "$owner" --limit "${FLEET_REPO_LIMIT:-200}" --no-archived \
    --json nameWithOwner --jq '.[].nameWithOwner' 2>/dev/null)
EOF
  wait

  cat "$tmp"/* 2>/dev/null | sort -u
  rm -rf "$tmp"
}

if [ -z "$REPOS" ] && [ -n "${FLEET_REPOS:-}" ]; then
  # An explicit list always wins over discovery. Bare names get FLEET_OWNER
  # prepended, which defaults to whoever gh is logged in as.
  #
  # Tested with a prefix strip rather than `case`, because bash 3.2 — still what
  # /bin/bash is on macOS — mis-parses a case pattern's `)` inside `$( )`.
  OWNER="${FLEET_OWNER:-$(gh api user --jq .login 2>/dev/null)}"
  REPOS=$(for r in ${FLEET_REPOS}; do
    if [ "${r#*/}" != "$r" ]; then
      echo "$r"
    elif [ -n "$OWNER" ]; then
      echo "$OWNER/$r"
    fi
  done | sort -u)
fi

if [ -z "$REPOS" ]; then
  if [ "$REFRESH" = "1" ] || [ "$(cache_age)" -gt "$CACHE_TTL" ]; then
    echo "discovering repos with Actions (cached for $((CACHE_TTL / 3600))h)..." >&2
    found=$(discover_repos)
    # Only replace a good cache with a good answer. A failed discovery — no
    # network, gh not authenticated — must not blank a list that still works.
    [ -n "$found" ] && printf '%s\n' "$found" > "$CACHE"
  fi
  [ -f "$CACHE" ] && REPOS=$(cat "$CACHE")
fi

if [ -z "$REPOS" ]; then
  echo "no repos to report on. This host has no runner directories, and" >&2
  echo "discovery found nothing — check \`gh auth status\`, or name the repos" >&2
  echo "explicitly with FLEET_REPOS in fleet.env (see fleet.env.example)." >&2
  exit 1
fi

snapshot() {
  tmp=$(mktemp -d)
  # Fan out: thirteen sequential API calls is several seconds of staring at
  # nothing, and this is a tool you run repeatedly.
  for repo in $REPOS; do
    (
      gh api "repos/$repo/actions/runs?per_page=6" --jq \
        ".workflow_runs[] | [\"$repo\", .status, (.conclusion // \"-\"), .name, .head_branch, (.run_started_at // .created_at), (.id|tostring)] | @tsv" \
        2>/dev/null > "$tmp/$(echo "$repo" | tr '/' '_')"
    ) &
  done
  wait

  python3 - "$tmp" "$BYHOST" "$(scutil --get LocalHostName 2>/dev/null || hostname -s)" <<'PY'
import sys, os, glob, subprocess, datetime, json

tmpdir, byhost, localhost = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
now = datetime.datetime.now(datetime.timezone.utc)

def ago(ts):
    try:
        d = now - datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return "?"
    s = int(d.total_seconds())
    if s < 60:  return f"{s}s"
    if s < 3600: return f"{s//60}m"
    if s < 86400: return f"{s//3600}h"
    return f"{s//86400}d"

active, recent = [], []
for f in glob.glob(os.path.join(tmpdir, "*")):
    for line in open(f):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 7:
            continue
        repo, status, concl, name, branch, started, rid = parts
        row = dict(repo=repo.split("/")[-1], full=repo, status=status, concl=concl,
                   name=name, branch=branch, started=started, rid=rid)
        (active if status in ("queued", "in_progress") else recent).append(row)

# The runner is only known per-JOB, so it costs an extra call. Spend it on the
# active runs, which is where "on which machine" is a live question.
for r in active:
    try:
        out = subprocess.run(["gh", "api", f"repos/{r['full']}/actions/runs/{r['rid']}/jobs"],
                             capture_output=True, text=True, timeout=20).stdout
        names = [j.get("runner_name") or "-" for j in json.loads(out).get("jobs", [])
                 if j.get("status") in ("in_progress", "queued", "completed")]
        r["runner"] = next((n for n in names if n and n != "-"), "unassigned")
    except Exception:
        r["runner"] = "?"

# register.sh names every runner "<LocalHostName>-<repo>", so the host a job
# landed on is readable straight off the runner name — no list of known machines
# to keep up to date, and a runner registered from a host this script has never
# heard of still resolves to "other" rather than to a wrong answer.
def host_of(runner):
    if not runner or runner in ("unassigned", "?", "-"):
        return "-"
    return "this" if runner.startswith(localhost) else "other"

C = {"success": "\033[32m", "failure": "\033[31m", "cancelled": "\033[33m",
     "in_progress": "\033[36m", "queued": "\033[35m"}
R = "\033[0m"

print(f"\033[1mACTIVE\033[0m ({len(active)})")
if not active:
    print("  nothing running")
for r in sorted(active, key=lambda x: x["started"]):
    c = C.get(r["status"], "")
    print(f"  {c}{r['status']:<12}{R} {r['repo']:<20} {r['name'][:22]:<24} "
          f"{r['branch'][:26]:<28} {ago(r['started']):>4} ago  "
          f"[{host_of(r.get('runner'))}] {r.get('runner','')}")

print()
print(f"\033[1mRECENT\033[0m")
for r in sorted(recent, key=lambda x: x["started"], reverse=True)[:14]:
    c = C.get(r["concl"], "")
    print(f"  {c}{r['concl']:<12}{R} {r['repo']:<20} {r['name'][:22]:<24} "
          f"{r['branch'][:26]:<28} {ago(r['started']):>4} ago")
PY
  rm -rf "$tmp"
}

if [ "$WATCH" = "1" ]; then
  # `tput clear` rather than `clear`: on a terminal that cannot clear, this is a
  # no-op instead of an error that scrolls the screen it was meant to tidy.
  trap 'echo; echo "stopped."; exit 0' INT
  while true; do
    tput clear 2>/dev/null || true
    printf '\033[1mfleet runs\033[0m — %s   (ctrl-c to stop)\n\n' "$(date '+%H:%M:%S')"
    snapshot
    sleep 15
  done
else
  snapshot
fi
