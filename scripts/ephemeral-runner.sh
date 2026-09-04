#!/usr/bin/env bash
# Register a one-job runner in a fresh directory, then remove it.
#
#   scripts/ephemeral-runner.sh owner/repo [extra-label]      # show what it would do
#   scripts/ephemeral-runner.sh owner/repo [extra-label] --apply
#
# WHAT --ephemeral ACTUALLY DOES
#
# The runner takes exactly one job, then deregisters itself from GitHub and
# exits. GitHub removes the registration; nothing removes the DIRECTORY, which is
# the part that matters here. A fleet that creates ephemeral runners and never
# cleans up leaves a 121 MB unpacked runner plus a full checkout behind for every
# job it ran, and on a machine that keeps ~50 GB free that is a disk-full outage
# with a lead time of a few hundred jobs.
#
# So this script owns the whole lifecycle: fresh directory, one job, remove the
# directory. It runs in the FOREGROUND for exactly that reason — a backgrounded
# version cannot clean up after itself if the caller goes away, and the trap
# below is the only thing standing between this feature and a full disk.
#
# WHY A FRESH DIRECTORY IS THE POINT
#
# A persistent runner accumulates: DerivedData, node_modules, a warm Gradle
# cache, and whatever a job left in _work. Usually that is a feature and it is
# why the rest of this fleet is persistent. But it is also the reason for the
# class of failure where a build passes on CI and fails for everyone else, or
# passes only on the runner that happens to hold a stale cache. An ephemeral
# runner is the answer to "does this build actually work from nothing", and it is
# worth the several minutes it costs to find out.
#
# WHAT THIS IS NOT FOR
#
# Not for routine CI on this fleet. Unpacking the runner and cloning from scratch
# costs minutes per job, and the persistent runners exist precisely to avoid
# paying that every time. Use this for release builds, for reproducing a
# cache-poisoning suspicion, and for anything where a clean machine is the thing
# being tested.
set -euo pipefail

REPO="${1:?usage: ephemeral-runner.sh owner/repo [extra-label] [--apply]}"
LABEL=""
APPLY=0
for arg in "${@:2}"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h | --help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown argument: $arg" >&2; exit 1 ;;
    *) LABEL="$arg" ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/fleet.env" ] && . "$HERE/fleet.env"
ROOT="${FLEET_ROOT:-$HERE}"

case "$REPO" in
  */*) ;;
  *) echo "repo must be owner/name, got: $REPO" >&2; exit 1 ;;
esac

VERSION="$(sed -n 's/^VERSION="\([^"]*\)"/\1/p' "$ROOT/register.sh" | head -1)"
SHA="$(sed -n 's/^SHA="\([^"]*\)"/\1/p' "$ROOT/register.sh" | head -1)"
[ -n "$VERSION" ] || { echo "could not read the runner version from register.sh" >&2; exit 1; }

NAME="$(basename "$REPO")"
# The PID and a timestamp, so two ephemeral runners for the same repo cannot
# collide and a leftover directory says when it was created.
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
DIR="$ROOT/.ephemeral/$NAME-$STAMP"
RUNNER_NAME="$(scutil --get LocalHostName)-$NAME-eph-$STAMP"
CACHE="$ROOT/actions-runner-osx-arm64-$VERSION.tar.gz"

echo "repo:      $REPO"
echo "directory: $DIR"
echo "runner:    $RUNNER_NAME"
echo "labels:    self-hosted, macOS, ARM64${LABEL:+, $LABEL}"
echo "version:   $VERSION"
echo
echo "It will accept ONE job, deregister itself, and then this script deletes the"
echo "directory. Expect several minutes of setup before the job starts — the"
echo "checkout and every cache start empty, which is the entire point."
echo

if [ "$APPLY" -eq 0 ]; then
  echo "dry run — nothing was created. Re-run with --apply."
  exit 0
fi

# Cleanup runs on EVERY exit path, including Ctrl-C and an error partway through
# registration. This is the trap the whole script is built around: without it a
# failed run leaves an unpacked runner and a checkout behind, and the failure mode
# of this feature is a disk that fills up over weeks.
#
# It is also careful about WHAT it deletes. $DIR is built from a name this script
# generated inside .ephemeral, and the guard below refuses anything that does not
# look like that — an rm -rf driven by a variable deserves a second check.
cleanup() {
  local code=$?
  if [ -d "$DIR" ]; then
    case "$DIR" in
      "$ROOT/.ephemeral/"*)
        echo
        echo "==> cleaning up $DIR"
        # If the runner is still registered — the job never ran, or this is being
        # interrupted — try to remove it from GitHub first. A registration with no
        # directory behind it shows on GitHub as a permanently offline runner, and
        # somebody has to clean that up by hand later.
        if [ -f "$DIR/.runner" ]; then
          echo "==> removing the registration from GitHub"
          TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/remove-token" --jq .token 2>/dev/null || true)"
          if [ -n "$TOKEN" ]; then
            (cd "$DIR" && ./config.sh remove --token "$TOKEN" >/dev/null 2>&1) || true
          else
            echo "    warn: could not mint a removal token. The runner may linger on GitHub as"
            echo "          offline; remove it in Settings > Actions > Runners."
          fi
        fi
        rm -rf "$DIR"
        echo "==> done"
        ;;
      *)
        echo "refusing to delete an unexpected path: $DIR" >&2
        ;;
    esac
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

mkdir -p "$DIR"
cd "$DIR"

# The same cached tarball the persistent runners use. Downloading 121 MB per
# ephemeral job would make this unusable.
if [ ! -f "$CACHE" ]; then
  echo "==> downloading runner $VERSION (121 MB, cached for future runs)"
  curl -sSL -o "$CACHE" \
    "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-osx-arm64-$VERSION.tar.gz"
fi
if [ -n "$SHA" ]; then
  [ "$(shasum -a 256 "$CACHE" | cut -d' ' -f1)" = "$SHA" ] \
    || { echo "checksum mismatch on $CACHE" >&2; exit 1; }
fi
tar xzf "$CACHE"

# A LaunchAgent's missing PATH is not a problem here — this runs in the
# foreground with the caller's environment — but .env is written anyway so an
# ephemeral runner behaves like every other runner in the fleet.
cat > .env <<'ENV'
PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin
ENV
if [ -d "$HOME/Library/Android/sdk" ]; then
  printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\n' \
    "$HOME/Library/Android/sdk" "$HOME/Library/Android/sdk" >> .env
fi

echo "==> registering $RUNNER_NAME with $REPO"
TOKEN="${RUNNER_TOKEN:-$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)}"
[ -n "$TOKEN" ] || { echo "no registration token — is gh authenticated here?" >&2; exit 1; }

# --ephemeral is what makes this one job rather than many. Without it the runner
# would sit waiting after its first job and the trap would delete the directory
# out from under a live listener.
#
# No --replace: an ephemeral runner's name is unique by construction, and
# --replace on a colliding name would evict a runner somebody else is using.
LABELS="${LABEL:+--labels $LABEL}"
# shellcheck disable=SC2086
./config.sh --url "https://github.com/$REPO" --token "$TOKEN" \
  --name "$RUNNER_NAME" $LABELS \
  --work _work --unattended --ephemeral >/dev/null

echo "==> waiting for one job (Ctrl-C to give up and clean up)"
# Foreground, no service install. run.sh exits after the single job completes,
# and the trap then removes the directory. Installing a LaunchAgent would outlive
# this process and leave nothing to do the cleanup.
./run.sh

echo "==> the job finished and the runner deregistered itself"
