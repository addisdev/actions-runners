#!/usr/bin/env bash
# Exercises scripts/install-hooks.sh against a fake fleet: a tree of directories
# that look like runner installations (a .runner file is the only marker the
# script keys on) so nothing here touches the real runners.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Canonicalised, because the script under test resolves its own root with
# `cd && pwd` and on macOS that turns TMPDIR's /var into /private/var. Comparing
# the paths it records against an uncanonicalised one fails for the wrong reason.
mkdir -p "${TMPDIR:-/tmp}/admit-test"
WORK="$(cd "${TMPDIR:-/tmp}/admit-test" && pwd)/installwork"

pass=0
fail=0
ok() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; pass=$((pass + 1));
       else echo "  FAIL  $1: want '$2' got '$3'"; fail=$((fail + 1)); fi; }
say() { echo "== $1 =="; }

# A throwaway copy of the repo, so --apply writes into fake runners and the
# script's own $HERE/.. resolution still finds hooks/ and fleet.env.
fleet() {
  rm -rf "$WORK"
  mkdir -p "$WORK/scripts" "$WORK/hooks"
  cp "$SRC/scripts/install-hooks.sh" "$WORK/scripts/"
  cp "$SRC/hooks/"*.sh "$WORK/hooks/"
  chmod +x "$WORK/hooks/"*.sh "$WORK/scripts/install-hooks.sh"
  for name in "$@"; do
    mkdir -p "$WORK/$name"
    echo '{"agentName":"'"$name"'"}' > "$WORK/$name/.runner"
    printf 'PATH=/usr/bin\n' > "$WORK/$name/.env"
  done
}

run() { (cd "$WORK" && ./scripts/install-hooks.sh "$@" 2>&1); }
envof() { cat "$WORK/$1/.env" 2>/dev/null; }
hooklines() { envof "$1" | grep -c '^ACTIONS_RUNNER_HOOK_JOB_' | tr -d ' '; }

say "dry run reports but writes nothing"
fleet alpha beta
out="$(run)"
ok "both queued for change" 1 "$(echo "$out" | grep -c '2 runner(s) to change')"
ok "said it was a dry run" 1 "$(echo "$out" | grep -c 'dry run')"
ok "alpha untouched" 0 "$(hooklines alpha)"
ok "warned the hooks are inert" 1 "$(echo "$out" | grep -c 'INERT')"

say "--apply writes both hook lines and keeps the rest of the file"
out="$(run --apply)"
ok "alpha has both lines" 2 "$(hooklines alpha)"
ok "beta has both lines" 2 "$(hooklines beta)"
ok "existing PATH preserved" 1 "$(envof alpha | grep -c '^PATH=/usr/bin$')"
ok "absolute path recorded" 1 "$(envof alpha | grep -c "^ACTIONS_RUNNER_HOOK_JOB_STARTED=$WORK/hooks/job-started.sh$")"
ok "no temp file left behind" 0 "$(find "$WORK" -name '.env.fleet-tmp' | wc -l | tr -d ' ')"

say "a second run is a no-op"
out="$(run --apply)"
ok "nothing to change" 1 "$(echo "$out" | grep -c '0 runner(s) to change, 2 already correct')"
ok "still exactly two lines" 2 "$(hooklines alpha)"
ok "no inert warning when nothing changed" 0 "$(echo "$out" | grep -c 'INERT')"

say "a stale hook path is updated, not duplicated"
printf 'PATH=/usr/bin\nACTIONS_RUNNER_HOOK_JOB_STARTED=/old/path.sh\n' > "$WORK/alpha/.env"
out="$(run --apply)"
ok "reported as an update" 1 "$(echo "$out" | grep -c 'alpha: update hook lines (was: /old/path.sh)')"
ok "one started line, not two" 1 "$(envof alpha | grep -c '^ACTIONS_RUNNER_HOOK_JOB_STARTED=')"
ok "old path gone" 0 "$(envof alpha | grep -c '/old/path.sh')"

say "--remove strips the lines and leaves the file otherwise intact"
out="$(run --remove --apply)"
ok "both cleaned" 1 "$(echo "$out" | grep -c '2 runner(s) to clean')"
ok "no hook lines left" 0 "$(hooklines alpha)"
ok "PATH survived the removal" 1 "$(envof alpha | grep -c '^PATH=/usr/bin$')"
out="$(run --remove --apply)"
ok "removing twice is a no-op" 1 "$(echo "$out" | grep -c '0 runner(s) to clean, 2 already clean')"

say "--remove works even with the hooks deleted"
fleet alpha
run --apply > /dev/null
rm -f "$WORK/hooks/"*.sh
out="$(run --remove --apply)"
ok "cleaned without needing the hooks" 1 "$(echo "$out" | grep -c '1 runner(s) to clean')"
ok "lines gone" 0 "$(hooklines alpha)"

say "install refuses when the hooks are missing"
fleet alpha
rm -f "$WORK/hooks/job-started.sh"
out="$(run --apply)"; rc=$?
ok "exited non-zero" 1 "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
ok "named the missing file" 1 "$(echo "$out" | grep -c 'missing or not executable')"
ok "wrote nothing" 0 "$(hooklines alpha)"

say "a directory with no .runner is not a runner"
fleet alpha
mkdir -p "$WORK/dashboard" "$WORK/_diag"
printf 'PATH=/usr/bin\n' > "$WORK/dashboard/.env"
out="$(run --apply)"
ok "only the real runner changed" 1 "$(echo "$out" | grep -c '1 runner(s) to change')"
ok "dashboard/.env untouched" 0 "$(hooklines dashboard)"

say "a runner with no .env gets one, and does not abort the run"
fleet alpha zulu
rm -f "$WORK/alpha/.env"
out="$(run --apply)"
ok "the run continued past it" 2 "$(hooklines zulu)"
ok "said it was creating one" 1 "$(echo "$out" | grep -c 'no .env yet, creating one')"
ok "both lines present" 2 "$(hooklines alpha)"

say "the missing-.env note is not printed when nothing is written"
fleet alpha
rm -f "$WORK/alpha/.env"
out="$(run --remove --apply)"
ok "no bogus creation note" 0 "$(echo "$out" | grep -c 'creating one')"
ok "still no .env invented" 0 "$([ -f "$WORK/alpha/.env" ] && echo 1 || echo 0)"

say "an unknown flag is rejected"
fleet alpha
out="$(run --force)"; rc=$?
ok "exited non-zero" 1 "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
ok "named the argument" 1 "$(echo "$out" | grep -c 'unknown argument: --force')"

say "--restart skips a runner that is mid-job"
fleet alpha
mkdir -p "$WORK/alpha/bin"
printf '#!/bin/sh\nsleep 60\n' > "$WORK/alpha/bin/Runner.Worker"
chmod +x "$WORK/alpha/bin/Runner.Worker"
"$WORK/alpha/bin/Runner.Worker" > /dev/null 2>&1 &
worker=$!
sleep 0.4
out="$(run --apply --restart)"
kill "$worker" 2>/dev/null
ok "reported the busy runner" 1 "$(echo "$out" | grep -c 'not restarted because a job is running: alpha')"
ok "hooks still written" 2 "$(hooklines alpha)"

say "--restart cycles an idle runner via svc.sh"
fleet alpha
cat > "$WORK/alpha/svc.sh" <<'EOF'
#!/bin/sh
echo "$1" >> ./svc.calls
EOF
chmod +x "$WORK/alpha/svc.sh"
out="$(run --apply --restart)"
ok "stop then start" "stop start" "$(tr '\n' ' ' < "$WORK/alpha/svc.calls" | sed 's/ $//')"
ok "no restart-needed reminder" 0 "$(echo "$out" | grep -c 'restart the runners')"

say "a runner that fails to restart warns instead of aborting the run"
fleet alpha beta
for n in alpha beta; do
  printf '#!/bin/sh\nexit 1\n' > "$WORK/$n/svc.sh"
  chmod +x "$WORK/$n/svc.sh"
done
out="$(run --apply --restart)"; rc=$?
ok "exited zero" 0 "$rc"
ok "warned on both" 2 "$(echo "$out" | grep -c 'did not restart cleanly')"
ok "beta still got its hooks" 2 "$(hooklines beta)"

echo
echo "passed $pass, failed $fail"
rm -rf "$WORK"
[ "$fail" -eq 0 ]
