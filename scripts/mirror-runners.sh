#!/usr/bin/env bash
# Register runners on THIS host that mirror the coordinator's, label set for
# label set, so GitHub can hand a repo's jobs to either host.
#
#   scripts/mirror-runners.sh                      # show the plan
#   scripts/mirror-runners.sh --apply              # register what the plan lists
#   scripts/mirror-runners.sh --apply --only peertest,radiator   # a pilot
#   ... | scripts/mirror-runners.sh --apply --tokens-from -     # tokens minted elsewhere
#
# The plan is dashboard/lib/mirror.js: one runner per distinct label set the
# coordinator's runners carry for a repo, skipping any set that needs a label
# this host does not advertise (FLEET_HOST_LABELS), a Simulator runner on a host
# without Xcode, and repos named in FLEET_MIRROR_SKIP_REPOS. Already-registered
# runners are reported as present and left alone, so re-running is safe.
#
# REGISTRATION TOKENS. register.sh mints one with `gh` on this host, which does
# not work over SSH: gh keeps its token in the login keychain and a non-GUI
# session cannot read it. --tokens-from reads "owner/repo token" lines instead
# (a file, or - for stdin), so the tokens can be minted on a machine where gh
# works and piped in. They are short-lived and good only for registering.
#
# Dry run by default, like every other script here that changes the fleet.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"
export FLEET_HOST_LABELS="${FLEET_HOST_LABELS:-}" FLEET_SIMULATOR_RUNNERS="${FLEET_SIMULATOR_RUNNERS:-}" \
  FLEET_MIRROR_SKIP_REPOS="${FLEET_MIRROR_SKIP_REPOS:-}"

APPLY=0
ONLY=""
TOKENS_FROM=""
COORD="${FLEET_COORDINATOR:-${FLEET_COORDINATORS%%,*}}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only) ONLY="${2:?--only needs a list}"; shift ;;
    --tokens-from) TOKENS_FROM="${2:?--tokens-from needs a file or -}"; shift ;;
    --coordinator) COORD="${2:?--coordinator needs a URL}"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$COORD" ] || { echo "no coordinator: set FLEET_COORDINATOR in fleet.env or pass --coordinator" >&2; exit 2; }

node_bin() {
  command -v node 2>/dev/null && return 0
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  echo "node not found" >&2; return 1
}
NODE="$(node_bin)"

PLAN="$("$NODE" "$HERE/dashboard/scripts/mirror-plan.mjs" --coordinator "$COORD" --root "$ROOT" ${ONLY:+--only "$ONLY"})"
printf '%s\n' "$PLAN" | awk -F'\t' '
  $1=="register" { printf "  + %-34s #%s  [%s]  like %s\n", $2, $3, $4, $5 }
  $1=="present"  { printf "  = %-34s #%s  [%s]  already here\n", $2, $3, $4 }
  $1=="skip"     { printf "  - %-34s     [%s]  %s\n", $2, $4, $5 }'

TODO="$(printf '%s\n' "$PLAN" | awk -F'\t' '$1=="register"')"
if [ -z "$TODO" ]; then echo "nothing to register"; exit 0; fi
if [ "$APPLY" -ne 1 ]; then echo "dry run: re-run with --apply to register the + lines"; exit 0; fi

# Tokens by repo, read once. bash 3.2 has no associative arrays, so a file.
TOKFILE=""
if [ -n "$TOKENS_FROM" ]; then
  TOKFILE="$(mktemp)"; chmod 600 "$TOKFILE"
  trap 'rm -f "$TOKFILE"' EXIT
  if [ "$TOKENS_FROM" = "-" ]; then cat > "$TOKFILE"; else cat "$TOKENS_FROM" > "$TOKFILE"; fi
fi
token_for() { [ -n "$TOKFILE" ] && awk -v r="$1" '$1==r {print $2; exit}' "$TOKFILE"; return 0; }

ok=0; failed=0
while IFS=$'\t' read -r _ repo instance labels _; do
  tok="$(token_for "$repo")"
  if [ -n "$TOKFILE" ] && [ -z "$tok" ]; then
    echo "!! $repo: no token supplied, skipped" >&2; failed=$((failed + 1)); continue
  fi
  args=("$repo")
  [ "$labels" = "-" ] || args+=("$labels")
  echo "==> $repo #$instance [$labels]"
  if RUNNER_INSTANCE="$instance" RUNNER_TOKEN="$tok" "$ROOT/register.sh" "${args[@]}" </dev/null; then
    ok=$((ok + 1))
  else
    echo "!! $repo #$instance failed" >&2; failed=$((failed + 1))
  fi
done <<< "$TODO"
echo "registered $ok, failed $failed"
[ "$failed" -eq 0 ]
