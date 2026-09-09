#!/usr/bin/env python3
"""Work out which of preflight.sh's checks this fleet's workflows actually need.

Reads the workflow YAML the dashboard has already fetched into SQLite and prints
shell assignments for preflight.sh to eval. Exits non-zero, printing nothing, if
there is no usable data — the caller then checks everything, which is the safe
direction to fail in.

A separate file rather than a heredoc inside preflight.sh because /bin/bash on
macOS is still 3.2, which mis-parses a heredoc inside command substitution.
"""

import re
import sqlite3
import sys

# Marker -> the checks it justifies. Substring matching on lowercased YAML, not
# a YAML parse: the interesting facts live inside `run:` shell blocks, where a
# parser gives you one long string and no more structure than this does.
MARKERS = {
    'NEED_XCODEGEN': ('xcodegen',),
    'NEED_WATCHOS': ('watchos',),
    'NEED_SIM': ('iphone', 'simctl'),
    'NEED_XCODE': ('xcodebuild', 'xcrun', 'swift ', '.xcodeproj', '.xcworkspace'),
    'NEED_NODE': ('npm ', 'npx ', 'setup-node', 'yarn ', 'pnpm '),
    'NEED_DOCKER': ('docker ', 'docker-compose', 'compose config', 'docker/'),
    'NEED_ANDROID': ('gradle', 'gradlew', 'android'),
    'NEED_PLAYWRIGHT': ('playwright install', 'playwright test', '@playwright/test', 'microsoft/playwright'),
}


def main() -> int:
    if len(sys.argv) < 2:
        return 1
    try:
        # Read-only: the dashboard daemon is very likely writing to this file
        # right now, and a preflight run must not block it or be blocked by it.
        db = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
        rows = db.execute(
            'SELECT content FROM workflow_files WHERE content IS NOT NULL'
        ).fetchall()
    except Exception:
        return 1

    # Only files with a self-hosted job say anything about this machine. A
    # workflow pinned to ubuntu-latest runs on GitHub's hardware, and treating
    # its dependencies as local requirements is how you end up installing
    # Postgres for a job that was never going to run here.
    files = [r[0] for r in rows if 'self-hosted' in (r[0] or '').lower()]
    if not files:
        return 1
    blob = '\n'.join(files).lower()

    for key, needles in MARKERS.items():
        print(f'{key}={1 if any(n in blob for n in needles) else 0}')

    # Postgres versions are whatever the workflows name, never a default. Two
    # shapes occur in practice: a reusable workflow's input, as in
    # postgres_versions: '["14", "17"]', and a direct Homebrew path such as
    # postgresql@14. The first is the one that matters — the versions are chosen
    # per-caller, so a hardcoded pair here goes stale the moment one changes.
    versions = set(re.findall(r'postgresql@(\d+)', blob))
    for array in re.findall(r'postgres_versions:\s*\'?\[([^\]]*)\]', blob):
        versions.update(re.findall(r'\d+', array))

    print(f'NEED_POSTGRES={1 if (versions or "postgres" in blob) else 0}')
    print('PG_VERSIONS="%s"' % ' '.join(sorted(versions, key=int)))
    print(f'INFERRED_FROM="{len(files)} self-hosted workflow files"')
    return 0


if __name__ == '__main__':
    sys.exit(main())
