#!/usr/bin/env bash
# Runs after a job's last step, via ACTIONS_RUNNER_HOOK_JOB_COMPLETED in each
# runner's .env. Its whole job is to give back the slot that job-started.sh
# took, so the next queued job can start.
#
# The PID check in common.sh means a leaked slot is eventually reclaimed even if
# this never runs — a job killed with SIGKILL skips its completed hook. This is
# the fast path, not the only path: without it a slot would sit occupied until
# the next admission noticed the worker had exited, which on an idle host could
# be the next push.
#
# Same rule as the started hook: never fail. A non-zero exit here marks the job
# failed after its steps have already succeeded, which is the most confusing
# possible outcome — a green build reported red by its own cleanup.

trap 'exit 0' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_ROOT:-$(cd "$HERE/.." && pwd)}"

# Drain, handled BEFORE the admission-mode check below, because a drain has
# nothing to do with admission and must work on a fleet that never turned
# admission on.
#
# RUNNER_WORKSPACE points into _work inside the runner's own directory, which is
# how the runner's directory is identified from inside a job. Falling back to
# GITHUB_WORKSPACE covers older runner versions.
#
# Launched detached, with output discarded, and this hook returns immediately.
# Doing the stop here instead would unload the LaunchAgent while the worker is
# still reporting this job's result, turning a passing job into a lost runner —
# see scripts/drain-stop-when-idle.sh.
DRAIN_WS="${RUNNER_WORKSPACE:-${GITHUB_WORKSPACE:-}}"
if [ -n "$DRAIN_WS" ]; then
  # .../<runner-dir>/_work/<repo>/<repo> — walk up to the directory holding _work.
  DRAIN_DIR="${DRAIN_WS%%/_work/*}"
  if [ -f "$DRAIN_DIR/.drain-stop" ] && [ -x "$ROOT/scripts/drain-stop-when-idle.sh" ]; then
    nohup "$ROOT/scripts/drain-stop-when-idle.sh" "$DRAIN_DIR" >/dev/null 2>&1 &
  fi
fi

# shellcheck source=hooks/common.sh
. "$HERE/common.sh" 2>/dev/null || exit 0

[ "$ADMIT_MODE" = "off" ] && exit 0

KEY="$(admit_key)"

# How long the slot was held, read from the slot file before it is removed. This
# is the job's execution time as the host saw it, which is the number that
# matters for concurrency accounting — GitHub's own duration includes the queue.
HELD=0
SLOT="$ADMIT_SLOTS/$KEY"
if [ -f "$SLOT" ]; then
  TS="$(sed -n 's/^ts=//p' "$SLOT" 2>/dev/null | head -1)"
  case "$TS" in
    '' | *[!0-9]*) ;;
    *) HELD=$(($(admit_now) - TS)) ;;
  esac
fi

admit_free_slot "$KEY"

BUSY=0
if admit_lock; then
  BUSY="$(admit_live_slots)"
  admit_unlock
fi

# HELD is reported as ran_s, not as a wait: this job did not wait, it occupied a
# slot for that long.
admit_log released '' 0 "$BUSY" "$HELD"

# ---- Playwright per-test results ingest ------------------------------------
# Parse the Playwright JSON report and append normalized outcome records to an
# NDJSON spool. The dashboard daemon reads the spool asynchronously; this hook
# only appends and never fails.
PW_JSON=""
if [ -n "${RUNNER_WORKSPACE:-}" ]; then
  # Walk up from _work/<repo>/<repo> to the runner dir to find the workspace.
  WS_DIR="${RUNNER_WORKSPACE%%/_work/*}"
  PW_WORK="${RUNNER_WORKSPACE}/$(basename "${RUNNER_WORKSPACE}")"
  # Common output locations — check both app/test-results and root test-results.
  for candidate in \
    "$PW_WORK/app/test-results/results.json" \
    "$PW_WORK/test-results/results.json" \
    "$PW_WORK/app/playwright-report/results.json" \
    "$PW_WORK/playwright-report/results.json"; do
    if [ -f "$candidate" ]; then
      PW_JSON="$candidate"
      break
    fi
  done
fi

if [ -n "$PW_JSON" ] && [ -x "$(command -v python3)" ]; then
  SPOOL="$ROOT/.playwright-outcomes.ndjson"
  REPO="${GITHUB_REPOSITORY:-}"
  SHA="${GITHUB_SHA:-}"
  RUN_ID="${GITHUB_RUN_ID:-}"
  JOB="${GITHUB_JOB:-}"
  python3 - "$PW_JSON" "$SPOOL" "$REPO" "$SHA" "$RUN_ID" "$JOB" <<'PYEOF'
import json, sys, os, time

pw_json, spool_path, repo, sha, run_id, job_id = sys.argv[1:7]

try:
    with open(pw_json) as f:
        report = json.load(f)
except Exception:
    sys.exit(0)

records = []
for suite in report.get('suites', []):
    # Playwright JSON has nested suites: file > describe > test
    def walk(suite, file_path=None):
        fp = suite.get('file') or file_path or suite.get('title', '')
        for spec in suite.get('specs', []):
            title = spec.get('title', '')
            for test in spec.get('tests', []):
                results = test.get('results', [])
                attempts = len(results)
                last = results[-1] if results else {}
                status = last.get('status', 'unknown')
                # A test is flaky if it failed earlier and passed on a retry.
                flaky = attempts > 1 and status == 'passed'
                duration_ms = last.get('duration')
                project = test.get('projectName') or test.get('projectId') or ''
                browser = ''
                proj_lower = project.lower()
                for b in ('chromium', 'firefox', 'webkit'):
                    if b in proj_lower:
                        browser = b
                        break
                records.append({
                    'ts': int(time.time() * 1000),
                    'repo': repo,
                    'head_sha': sha,
                    'run_id': run_id,
                    'job_id': job_id,
                    'browser': browser or None,
                    'project': project or None,
                    'file': fp,
                    'title': title,
                    'attempts': attempts,
                    'status': status,
                    'flaky': flaky,
                    'duration_ms': duration_ms,
                })
        for child in suite.get('suites', []):
            walk(child, fp)
    walk(suite)

if not records:
    sys.exit(0)

try:
    with open(spool_path, 'a') as out:
        for r in records:
            out.write(json.dumps(r, separators=(',', ':')) + '\n')
except Exception:
    pass  # never fail the hook
PYEOF
fi
