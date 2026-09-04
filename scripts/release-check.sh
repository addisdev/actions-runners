#!/usr/bin/env bash
# Fail if anything host- or account-specific reached a tracked file.
#
#   scripts/release-check.sh                # every tracked file
#   scripts/release-check.sh --staged       # only what is about to be committed
#   scripts/release-check.sh --list         # print what it looks for, and stop
#   scripts/release-check.sh --install-hook # run --staged on every commit
#   scripts/release-check.sh --offline      # skip the gh lookups, check the rest
#
# This exists because the repo was public-ready only after a manual scrub found
# the host's serial number in 26 blobs, its username in 11, and the names of
# private repos in comments throughout. All of that was committed by someone who
# had no intention of publishing it, which is exactly how it happens.
#
# WHAT IT LOOKS FOR IS DERIVED FROM THIS MACHINE, never from a list kept in the
# file. A hardcoded list of forbidden strings would be the same mistake one
# level up: it would go stale the moment a repo was renamed, and it could not
# ship in a public repo without publishing the very strings it was hiding.
#
# So it asks the machine: what is your serial, your username, your hostname; and
# asks gh: who are you, and what are your repos called. Anything it finds in
# tracked content is reported with a file and line.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

MODE=tracked
OFFLINE=0
for a in "$@"; do
  case "$a" in
    --staged)       MODE=staged ;;
    --list)         MODE=list ;;
    --install-hook) MODE=hook ;;
    --offline)      OFFLINE=1 ;;
    -h|--help)      sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = hook ]; then
  mkdir -p .git/hooks || { echo "no .git/hooks — not a git repo?" >&2; exit 1; }
  cat > .git/hooks/pre-commit <<'HOOK'
#!/usr/bin/env bash
# Installed by scripts/release-check.sh --install-hook
exec "$(git rev-parse --show-toplevel)/scripts/release-check.sh" --staged
HOOK
  chmod +x .git/hooks/pre-commit
  echo "installed .git/hooks/pre-commit"
  exit 0
fi

# ----------------------------------------------------------------- the patterns

# This repo's own identity. Its clone URL and default install path legitimately
# contain the owner's name and the repo's name, so both are stripped from every
# line before matching — otherwise the README's own `git clone` line is the
# first thing reported, every time, and a check that cries wolf gets disabled.
REMOTE="$(git remote get-url origin 2>/dev/null || echo '')"
OWN_REPO="$(basename "${REMOTE%.git}" 2>/dev/null || echo '')"
OWN_OWNER="$(basename "$(dirname "${REMOTE%.git}")" 2>/dev/null || echo '')"

# Minimum length for a derived pattern. A repo called `web` or a username of
# `ci` would otherwise match half the codebase, and the noise costs more than
# the coverage buys.
MIN_LEN=4

# Generic system usernames that must never become patterns. GitHub-hosted
# macOS runners run as 'runner', Ubuntu runners as 'ubuntu' or 'runner', and
# many CI environments use 'admin', 'user', or 'ec2-user'. Any of these would
# match almost every line in a codebase about GitHub Actions runners, turning
# a security check into a noise generator that gets disabled.
GENERIC_USERS="runner ubuntu admin user root ec2-user github actions macos linux"

# gh is asked ONCE, up front, and its exit status is checked — because both ways
# this can fail are bad and they fail in opposite directions.
#
# Observed: a rate-limited `gh api user` printed a JSON error body, and because
# the old version piped gh's output straight into the pattern list, the check
# started looking for strings like `"status": "403"` and
# `getting-started-with-the-rest-api#rate-limiting",`. It then reported 27 files
# as leaking, every one a false positive. A check that cries wolf gets ignored,
# and an ignored check is no check.
#
# The dangerous direction is the quiet one: if gh fails and its output is simply
# empty, the account's repo names are missing from the list, and the script
# reports a confident PASS having never looked for the thing it exists to find.
# So a gh failure is fatal unless --offline says the caller knows.
GH_LOGIN=""
GH_REPOS=""
GH_OK=1

# The repo list is the one that matters. Only its failure is fatal: it is the
# sole source of names for repos this host has no runner for, and nothing else
# can reconstruct them.
if ! GH_REPOS=$(gh repo list --limit "${FLEET_REPO_LIMIT:-200}" --json nameWithOwner \
                  --jq '.[].nameWithOwner' 2>/dev/null) || [ -z "$GH_REPOS" ]; then
  GH_OK=0
  GH_REPOS=""
fi

# The login is nice to have and not worth failing over, because it is already
# present in every `owner/name` above and in the gitHubUrl of every .runner file
# — and those are split on `/` further down, so the owner is checked either way.
# Worth knowing that these two calls fail independently: `gh api user` is REST
# and `gh repo list` is GraphQL, so they have separate rate-limit buckets and one
# can be throttled while the other answers fine. Treating a throttled REST call
# as a total failure made this script refuse to run while it had every name it
# needed.
if ! GH_LOGIN=$(gh api user --jq .login 2>/dev/null); then
  GH_LOGIN=""
fi

patterns() {
  # Hardware serial. Unambiguous, and the single worst thing to publish: it
  # identifies the machine to anyone who can read a warranty lookup.
  ioreg -l 2>/dev/null | awk -F'"' '/IOPlatformSerialNumber/ {print $4}'

  # Who and where this is.
  id -un 2>/dev/null
  scutil --get LocalHostName 2>/dev/null
  scutil --get ComputerName 2>/dev/null
  hostname -s 2>/dev/null

  # The account, and everything it owns. Repo names matter as much as the
  # account name — an unreleased product's name in a code comment gives away
  # as much as the account does, and reads as innocuous while doing it.
  [ -n "$GH_LOGIN" ] && printf '%s\n' "$GH_LOGIN"

  # Repos this host serves, read locally so the check still works offline.
  for d in "$ROOT"/*/; do
    [ -f "$d/.runner" ] || continue
    python3 -c "import json;print(json.load(open('$d/.runner',encoding='utf-8-sig'))['gitHubUrl'].split('github.com/')[-1])" 2>/dev/null
  done

  # Every repo the account has, which catches names this host has no runner for.
  [ -n "$GH_REPOS" ] && printf '%s\n' "$GH_REPOS"
}

# owner/name pairs arrive from two of the sources above; split them so both
# halves are checked, then drop this repo's own names and anything too short.
PATTERN_FILE="$(mktemp)"
trap 'rm -f "$PATTERN_FILE"' EXIT
patterns \
  | tr '/' '\n' \
  | tr -d '\r' \
  | sed 's/^ *//; s/ *$//' \
  | grep -v '^$' \
  | sort -u \
  | while IFS= read -r p; do
      [ "${#p}" -ge "$MIN_LEN" ] || continue
      [ "$p" = "$OWN_REPO" ] && continue
      [ "$p" = "$OWN_OWNER" ] && continue
      # Identifier shapes only. A serial, a username, a hostname and a repo name
      # are all drawn from this alphabet, and nothing legitimate here contains a
      # space, a quote or a colon. This is the second line of defence against a
      # failed API call becoming a pattern: even if an error body reaches this
      # point, none of its prose survives the filter.
      case "$p" in
        *[!A-Za-z0-9._-]*) continue ;;
      esac
      # Skip generic system/CI usernames that appear in almost every project
      # about GitHub Actions runners (e.g. GitHub-hosted runners run as 'runner').
      skip=0
      for _g in $GENERIC_USERS; do
        [ "$p" = "$_g" ] && skip=1 && break
      done
      [ "$skip" -eq 1 ] && continue
      echo "$p"
    done > "$PATTERN_FILE"

if [ "$MODE" = list ]; then
  echo "derived from this machine ($(wc -l < "$PATTERN_FILE" | tr -d ' ') patterns):"
  sed 's/^/  /' "$PATTERN_FILE"
  echo
  echo "not reported, because they are this repo's own name: $OWN_OWNER, $OWN_REPO"
  exit 0
fi

if [ ! -s "$PATTERN_FILE" ]; then
  echo "release-check: derived nothing to look for — is gh authenticated?" >&2
  echo "Refusing to report a pass that was not actually checked." >&2
  exit 1
fi

# Fatal, not a warning. Without the account's repo names this check still passes
# happily on a file naming every private repo the account owns, and prints a
# green line while doing it. A refusal is recoverable; a false pass is what this
# script exists to prevent.
if [ "$GH_OK" = 0 ] && [ "$OFFLINE" = 0 ]; then
  echo "release-check: gh could not list the account or its repos." >&2
  echo "Those names are most of what this checks for, so a pass here would be" >&2
  echo "meaningless. Fix gh (rate limit? auth?) and re-run, or pass --offline to" >&2
  echo "check only what can be derived from this machine." >&2
  exit 1
fi

# ------------------------------------------------------------------- the files

if [ "$MODE" = staged ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR)
else
  FILES=$(git ls-files)
fi
[ -n "$FILES" ] || { echo "release-check: no files to check"; exit 0; }

# Strip this repo's own slug, then its bare name, before matching. Longest
# first: removing `actions-runners` before `addisdev/actions-runners` would
# leave a dangling `addisdev/` that then reports as a leak of the owner.
strip_own() {
  if [ -n "$OWN_OWNER" ] && [ -n "$OWN_REPO" ]; then
    sed -e "s|$OWN_OWNER/$OWN_REPO||g" -e "s|$OWN_REPO||g" -e "s|$OWN_OWNER\\.github\\.io||g"
  else
    cat
  fi
}

hits=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # Read from the index in staged mode: the point of a pre-commit hook is to
  # judge what is about to be committed, which is not always what is on disk.
  if [ "$MODE" = staged ]; then
    content=$(git show ":$f" 2>/dev/null) || continue
  else
    [ -f "$f" ] || continue
    content=$(cat "$f" 2>/dev/null) || continue
  fi

  # -F: every pattern is a literal. A repo name containing a `.` must not
  # become a wildcard that matches a name it merely resembles.
  found=$(printf '%s\n' "$content" | strip_own | grep -n -i -F -f "$PATTERN_FILE" 2>/dev/null)
  [ -n "$found" ] || continue

  printf '%s\n' "$found" | while IFS= read -r line; do
    echo "  $f:$line"
  done
  hits=$((hits + 1))
done <<EOF
$FILES
EOF

# The loop above runs in this shell (heredoc, not a pipe), so hits survives.
if [ "$hits" -gt 0 ]; then
  echo
  echo "release-check FAILED: host- or account-specific strings in $hits file(s)."
  echo "Derive the value at runtime, or read it from fleet.env (untracked)."
  echo "See what is being matched with: scripts/release-check.sh --list"
  exit 1
fi

echo "release-check passed: $(printf '%s\n' "$FILES" | grep -c .) file(s), nothing host-specific."
