#!/usr/bin/env bash
# Register a self-hosted GitHub Actions runner for one repo on this Mac.
#
#   ./register.sh owner/repo [extra-label...]
#
# Extra labels are passed to config.sh as a comma-separated --labels value.
# One label or several work the same way:
#
#   ./register.sh owner/repo xcode-16.3
#   ./register.sh owner/repo ci playwright
#
# A SECOND runner for a repo that already has one — one runner serves exactly
# one job at a time, so a repo with two jobs runs them back to back:
#
#   RUNNER_INSTANCE=2 ./register.sh owner/repo postgres
#
# Pass the same extra-label as the first runner, or the second one will not
# match the same `runs-on:` and will sit idle while the first one queues —
# which looks exactly like the problem you were trying to fix.
#
# There is no way to cover "every repo, including future ones" from here if the
# repos belong to a USER account. Runners attach to a repo, an organization, or
# an enterprise, and a user account has none of the latter two — so an
# organization-level runner, the only mechanism GitHub offers for automatic
# coverage, is unavailable until the repos move into an org. Until then: one
# runner per repo, and this script so that costs ten seconds rather than ten
# minutes.
#
# Every runner is a separate directory and a separate LaunchAgent, all running
# as this user. Idle they cost about 7 MB each, which is nothing; the real cost
# is what they let run *at the same time*. On a 16 GB machine two concurrent
# Xcode builds will swap where two shell jobs will not. Check `./status.sh`
# before adding many more.
set -euo pipefail

REPO="${1:?usage: register.sh owner/repo [extra-label...]   (RUNNER_INSTANCE=2 for a second runner)}"
shift
EXTRA_LABELS=()
append_label() {
  local label="$1"
  label="${label#"${label%%[![:space:]]*}"}"
  label="${label%"${label##*[![:space:]]}"}"
  [ -n "$label" ] && EXTRA_LABELS+=("$label")
}
while [ $# -gt 0 ]; do
  # The dashboard Duplicate action passes comma-separated labels in one arg;
  # the shell path passes each label separately. Both end up as --labels a,b,c.
  if [[ "$1" == *","* ]]; then
    IFS=',' read -ra PARTS <<< "$1"
    for p in "${PARTS[@]}"; do
      append_label "$p"
    done
  else
    append_label "$1"
  fi
  shift
done
INSTANCE="${RUNNER_INSTANCE:-1}"
VERSION="2.336.0"
SHA="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
# Where the fleet lives. Defaults to this script's own directory rather than a
# hardcoded ~/actions-runners, so a clone somewhere else registers into itself
# instead of silently building a second fleet in a directory nobody is watching.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$HERE}"
NAME="$(basename "$REPO")"
# Instance 1 keeps the bare name, so adding the second-runner feature left every
# already-registered runner's directory and name untouched.
SUFFIX=""
[ "$INSTANCE" = "1" ] || SUFFIX="-$INSTANCE"
DIR="$ROOT/$NAME$SUFFIX"
RUNNER_NAME="$(scutil --get LocalHostName)-$NAME$SUFFIX"

if [ -f "$DIR/.runner" ]; then
  echo "$REPO already has runner instance $INSTANCE at $DIR — remove it first with:"
  echo "  cd $DIR && ./svc.sh stop && ./svc.sh uninstall && ./config.sh remove --token \$(gh api -X POST repos/$REPO/actions/runners/remove-token --jq .token)"
  echo "(or add another with RUNNER_INSTANCE=$((INSTANCE + 1)) $0 $REPO ${EXTRA_LABELS[*]:-})"
  exit 1
fi

mkdir -p "$DIR" && cd "$DIR"

# Downloaded once and reused. Ten copies of a 121 MB tarball is a waste of a
# morning's bandwidth and of the disk it lands on.
CACHE="$ROOT/actions-runner-osx-arm64-$VERSION.tar.gz"
if [ ! -f "$CACHE" ]; then
  echo "==> downloading runner $VERSION (121 MB, once for all repos)"
  curl -sSL -o "$CACHE" \
    "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-osx-arm64-$VERSION.tar.gz"
fi
# Checked every time, not just on download: a truncated or swapped cache is
# otherwise found by a runner that behaves strangely rather than by this line.
[ "$(shasum -a 256 "$CACHE" | cut -d' ' -f1)" = "$SHA" ] || { echo "checksum mismatch on $CACHE" >&2; exit 1; }
tar xzf "$CACHE"

# A LaunchAgent does not inherit a login shell's PATH, so anything under
# /opt/homebrew is missing unless it is named here. That failure reads as a
# missing dependency rather than a missing PATH, which costs an hour.
cat > .env <<'ENV'
PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin
ENV
# Same reason: Gradle finds the SDK through ANDROID_HOME, and a LaunchAgent has
# no login shell to set it. Only written when the SDK is actually installed.
if [ -d "$HOME/Library/Android/sdk" ]; then
  printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\n' "$HOME/Library/Android/sdk" "$HOME/Library/Android/sdk" >> .env
fi
# Job hooks. This is the only place code can run before a job's first step,
# which is what lets the fleet cap how many jobs execute at once — `ceiling`
# only refuses to ADD a runner and cannot stop a burst across runners that
# already exist. See hooks/job-started.sh.
#
# Written for every new runner, but INERT: both hooks exit immediately unless
# FLEET_ADMIT_MODE is set in fleet.env, so registering a runner behaves exactly
# as it did before until somebody opts in. Existing runners are retrofitted with
# scripts/install-hooks.sh.
if [ -x "$ROOT/hooks/job-started.sh" ] && [ -x "$ROOT/hooks/job-completed.sh" ]; then
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\n' \
    "$ROOT/hooks/job-started.sh" "$ROOT/hooks/job-completed.sh" >> .env
fi

echo "==> registering with $REPO"
# RUNNER_TOKEN lets a caller supply the registration token instead of minting it
# here. That matters when registering over SSH: `gh auth login` on macOS stores
# its token in the login keychain, and a non-GUI ssh session cannot read it, so
# gh reports "the token in default is invalid" on a host where gh is in fact
# logged in. Mint the token on a machine whose gh works and pass it in.
#
# The runner itself is unaffected by this — it runs as a LaunchAgent inside the
# GUI session, which does have keychain access.
#
# These tokens are short-lived (about an hour) and only good for registering a
# runner. Prefer piping one in over putting it in argv, where `ps` can see it.
TOKEN="${RUNNER_TOKEN:-$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)}"
[ -n "$TOKEN" ] || { echo "no registration token — gh is not authenticated here, and RUNNER_TOKEN was not set" >&2; exit 1; }
LABEL_CSV=""
if [ ${#EXTRA_LABELS[@]} -gt 0 ]; then
  LABEL_CSV=$(IFS=,; echo "${EXTRA_LABELS[*]}")
fi
LABELS="${LABEL_CSV:+--labels $LABEL_CSV}"
# shellcheck disable=SC2086
./config.sh --url "https://github.com/$REPO" --token "$TOKEN" \
  --name "$RUNNER_NAME" $LABELS \
  --work _work --unattended --replace >/dev/null

./svc.sh install >/dev/null
./svc.sh start >/dev/null
# Reported by name rather than `head -1` of the online list: once a repo has two
# runners that shortcut prints whichever one GitHub happened to list first, so a
# second runner that failed to come up would still report success.
#
# Polled rather than read once. `svc.sh start` returns as soon as launchd has
# accepted the job, several seconds before the listener has finished connecting,
# so a single immediate query reports "offline" for a runner that is in fact
# fine — which sends you debugging a healthy runner.
#
# Skipped entirely when gh cannot authenticate here — otherwise this reports
# "no runner named X" for a runner that registered perfectly well, which reads
# as a failure and is not one. The svc.sh calls above are the real evidence.
if gh auth status >/dev/null 2>&1; then
  for _ in $(seq 1 15); do
    STATUS="$(gh api "repos/$REPO/actions/runners" \
      --jq ".runners[] | select(.name==\"$RUNNER_NAME\") | \"\(.name) \(.status) [\([.labels[].name]|join(\",\"))]\"")"
    case "$STATUS" in *" online "*) break ;; esac
    sleep 2
  done
  echo "==> $REPO: ${STATUS:-no runner named $RUNNER_NAME}"
else
  echo "==> $REPO: installed and started as $RUNNER_NAME (gh cannot authenticate here, so status was not verified)"
fi
