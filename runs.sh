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
  # plutil is built into macOS and keeps this inventory usable when
  # /usr/bin/python3 is blocked by a newly updated Xcode license.
  if url=$(plutil -extract gitHubUrl raw -o - "$d/.runner" 2>/dev/null); then
    printf '%s\n' "${url#https://github.com/}"
  else
    echo "warning: cannot parse $d/.runner" >&2
  fi
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

  # The dashboard already requires Node, while Apple's /usr/bin/python3 can be
  # blocked after an Xcode update until a human accepts the new license.
  node - "$tmp" "$BYHOST" "$(scutil --get LocalHostName 2>/dev/null || hostname -s)" \
    "${FLEET_ROOT:-$HERE}" <<'JS'
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [tmpdir, , localhost, fleetRoot] = process.argv.slice(2);
const now = Date.now();

function admissionEntries(kind) {
  const entries = new Map();
  const dir = path.join(fleetRoot, '.admission', kind);
  if (!fs.existsSync(dir)) return entries;
  for (const file of fs.readdirSync(dir)) {
    const values = {};
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      const split = line.indexOf('=');
      if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
    }
    if (values.run) entries.set(values.run, values);
  }
  return entries;
}

const waiters = admissionEntries('waiters');
const slots = admissionEntries('slots');

function ago(ts) {
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return '?';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const active = [];
const recent = [];
for (const file of fs.readdirSync(tmpdir)) {
  const contents = fs.readFileSync(path.join(tmpdir, file), 'utf8');
  for (const line of contents.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [full, status, concl, name, branch, started, rid] = parts;
    const row = {
      repo: full.split('/').at(-1), full, status, concl, name, branch, started, rid,
    };
    (status === 'queued' || status === 'in_progress' ? active : recent).push(row);
  }
}

// The runner is only known per job, so spend the extra API call on active runs.
for (const run of active) {
  try {
    const result = spawnSync(
      'gh',
      ['api', `repos/${run.full}/actions/runs/${run.rid}/jobs`],
      { encoding: 'utf8', timeout: 20_000 },
    );
    const jobs = JSON.parse(result.stdout || '{}').jobs ?? [];
    const relevant = jobs.filter((job) => ['in_progress', 'queued', 'completed'].includes(job.status));
    const names = relevant
      .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'))
      .map((job) => job.runner_name || '-');
    run.runner = names.find((name) => name !== '-') ?? 'unassigned';
    const activeJobs = relevant.filter((job) => job.status === 'in_progress');
    const allAtSetup = activeJobs.length > 0 && activeJobs.every((job) =>
      (job.steps ?? []).some((step) => step.status === 'in_progress' && step.name === 'Set up runner'));
    if (!slots.has(run.rid) && (waiters.has(run.rid) || allAtSetup)) {
      run.displayStatus = 'waiting_host';
    }
  } catch {
    run.runner = '?';
  }
}

// register.sh names every runner "<LocalHostName>-<repo>", so the host is
// readable from the runner name without maintaining a separate host list.
function hostOf(runner) {
  if (!runner || ['unassigned', '?', '-'].includes(runner)) return '-';
  return runner.startsWith(localhost) ? 'this' : 'other';
}

const colors = {
  success: '\x1b[32m',
  failure: '\x1b[31m',
  cancelled: '\x1b[33m',
  in_progress: '\x1b[36m',
  queued: '\x1b[35m',
  waiting_host: '\x1b[33m',
};
const reset = '\x1b[0m';

console.log(`\x1b[1mACTIVE\x1b[0m (${active.length})`);
if (!active.length) console.log('  nothing running');
for (const run of active.sort((a, b) => a.started.localeCompare(b.started))) {
  const status = run.displayStatus ?? run.status;
  const color = colors[status] ?? '';
  console.log(
    `  ${color}${status.padEnd(12)}${reset} ${run.repo.padEnd(20)} `
    + `${run.name.slice(0, 22).padEnd(24)} ${run.branch.slice(0, 26).padEnd(28)} `
    + `${ago(run.started).padStart(4)} ago  [${hostOf(run.runner)}] ${run.runner ?? ''}`,
  );
}

console.log();
console.log('\x1b[1mRECENT\x1b[0m');
for (const run of recent.sort((a, b) => b.started.localeCompare(a.started)).slice(0, 14)) {
  const color = colors[run.concl] ?? '';
  console.log(
    `  ${color}${run.concl.padEnd(12)}${reset} ${run.repo.padEnd(20)} `
    + `${run.name.slice(0, 22).padEnd(24)} ${run.branch.slice(0, 26).padEnd(28)} `
    + `${ago(run.started).padStart(4)} ago`,
  );
}
JS
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
