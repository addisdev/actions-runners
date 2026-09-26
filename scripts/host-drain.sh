#!/usr/bin/env bash
# Remove a host from new-runner placement without stopping existing jobs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(dirname "$HERE")}"

case "${1:-}" in
  --drain)
    printf 'drained\n' > "$ROOT/.drain"
    echo "host drained: new runner placement is disabled"
    ;;
  --resume)
    rm -f "$ROOT/.drain"
    echo "host resumed: new runner placement is enabled"
    ;;
  *)
    echo "usage: host-drain.sh --drain|--resume" >&2
    exit 2
    ;;
esac
