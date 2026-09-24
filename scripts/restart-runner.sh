#!/usr/bin/env bash
# Restart one runner service by directory name.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(dirname "$HERE")}"
TARGET="${1:-}"

case "$TARGET" in
  ""|*/*|..|.) echo "usage: restart-runner.sh <dir-name>" >&2; exit 2 ;;
esac

DIR="$ROOT/$TARGET"
[ -f "$DIR/.runner" ] || { echo "no runner at $DIR" >&2; exit 1; }

cd "$DIR"
./svc.sh stop >/dev/null 2>&1 || true
./svc.sh start
