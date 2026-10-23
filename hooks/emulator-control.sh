#!/usr/bin/env bash
# shellcheck shell=bash
# CI Android emulators, stopped so that a quick-boot snapshot survives them.
#
#   emulator-control.sh complete   # job-completed.sh: stop THIS runner's emulators
#
# and sourced by cleanup.sh, which reaps emulators no job owns any more.
#
# The kit's android-ci (taylab-launch-kit, `emulator_snapshot`) keeps one AVD per
# runner and system image, "ci-<runner>-a<api>-<target>-<profile>", with a
# quick-boot snapshot (~4 GB of guest RAM) that the next job on that runner
# boots from. android-emulator-runner stops its emulator with `adb emu kill`,
# which is the clean path. But a job that is cancelled or times out mid-step
# leaves its emulator running (on ultra, 2026-10-23, two greenfolio emulators
# ran 9 h after their jobs were cancelled), and nothing at job end stops it:
# the runner's own orphan scan is answered "not this job's" by shims/ps. A
# SIGKILLed emulator that was saving its snapshot leaves half a snapshot.
#
# So an emulator is stopped the way the emulator expects: the console's
# `emu kill`, then SIGTERM, and SIGKILL only when neither worked. A boot that
# could save (no -no-snapshot, -no-snapshot-save or -read-only) and had to be
# SIGKILLed may have been mid-save, so its AVD's snapshot is thrown away; the
# kit saves a new one on the runner's next job.
#
# Only AVDs named for a runner ("ci-…", "shots-…", FLEET_CLEANUP_AVD_PREFIXES)
# are ever touched. Night QA's fleet-explore-* and a person's own AVDs are not.
#
# Never fails its caller: the job-completed hook must not turn a green job red.

EMU_PREFIXES="${FLEET_CLEANUP_AVD_PREFIXES:-ci shots}"
EMU_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"

emu_adb() {
  printf '%s' "${FLEET_ADB:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}/platform-tools/adb}"
}

# One line per emulator process booting a runner's AVD:
#   pid ppid age_seconds avd port could_save(1|0)
# The emulator binary is the command's first word (or the second, after an
# interpreter, which is how the tests' stand-in runs).
emu_list() {
  "${FLEET_PS:-/bin/ps}" -axo pid=,ppid=,etime=,command= 2>/dev/null | awk -v prefixes="$EMU_PREFIXES" '
    function secs(t,   d, a, p, n, i, s) {
      d = 0
      if (index(t, "-")) { split(t, a, "-"); d = a[1]; t = a[2] }
      n = split(t, p, ":"); s = 0
      for (i = 1; i <= n; i++) s = s * 60 + p[i]
      return d * 86400 + s
    }
    BEGIN { np = split(prefixes, P, " ") }
    {
      hit = 0
      for (k = 4; k <= 5 && k <= NF; k++) {
        exe = $k; sub(/.*\//, "", exe)
        if (exe ~ /^(emulator|qemu-system)/) hit = 1
      }
      if (!hit) next
      avd = ""; port = "-"; save = 1
      for (i = 5; i <= NF; i++) {
        if ($i == "-avd" && i < NF) avd = $(i + 1)
        else if ($i == "-port" && i < NF) port = $(i + 1)
        else if ($i == "-no-snapshot" || $i == "-no-snapshot-save" || $i == "-read-only") save = 0
      }
      if (avd == "") next
      ok = 0
      for (j = 1; j <= np; j++)
        if (index(avd, P[j] "-") == 1 && length(avd) > length(P[j]) + 1) ok = 1
      if (ok) print $1, $2, secs($3), avd, port, save
    }'
}

# Whose AVD is this? Given the runner names on this host (space-separated, as
# the kit spells them: anything but [A-Za-z0-9_.-] made "_"), prints
#   <runner> <plain|snapshot> <here|gone>
# "<prefix>-<runner>" is the plain AVD android-emulator-runner recreates every
# job; "<prefix>-<runner>-a<api>-<target>-<profile>" is the kit's snapshot AVD.
# The longest matching runner wins, so ultra-jerv-2's AVD is never ultra-jerv's.
emu_avd_owner() {
  local avd="$1" known="$2" p rest="" r best="" kind="" cand
  for p in $EMU_PREFIXES; do
    case "$avd" in "$p"-?*) rest="${avd#"$p"-}"; break ;; esac
  done
  [ -n "$rest" ] || return 1
  for r in $known; do
    if [ "$rest" = "$r" ]; then
      cand=plain
    else
      case "$rest" in "$r"-a[0-9]*-?*) cand=snapshot ;; *) continue ;; esac
    fi
    if [ "${#r}" -gt "${#best}" ]; then best="$r"; kind="$cand"; fi
  done
  if [ -n "$best" ]; then
    printf '%s %s here\n' "$best" "$kind"
  elif [[ "$rest" =~ ^(.+)-a[0-9]+-.+$ ]]; then
    printf '%s snapshot gone\n' "${BASH_REMATCH[1]}"
  else
    printf '%s plain gone\n' "$rest"
  fi
}

emu_wait_gone() {
  local pid="$1" n="$2" i=0
  while kill -0 "$pid" 2>/dev/null; do
    [ "$i" -ge "$n" ] && return 1
    sleep 1
    i=$((i + 1))
  done
  return 0
}

# emu_stop <pid> <port> <avd> <could_save>: prints how it went.
emu_stop() {
  local pid="$1" port="$2" avd="$3" save="$4" adb apid
  kill -0 "$pid" 2>/dev/null || { echo "already gone"; return 0; }
  adb="$(emu_adb)"
  if [ "$port" != - ] && [ -x "$adb" ]; then
    # In the background: an adb whose server is wedged must not hold the hook.
    "$adb" -s "emulator-$port" emu kill >/dev/null 2>&1 &
    apid=$!
    # A save-capable boot writes its snapshot (~4 GB) after `emu kill`.
    if emu_wait_gone "$pid" "${FLEET_EMU_KILL_WAIT_S:-120}"; then
      kill "$apid" 2>/dev/null; wait "$apid" 2>/dev/null
      echo "stopped (emu kill)"; return 0
    fi
    kill "$apid" 2>/dev/null; wait "$apid" 2>/dev/null
  fi
  kill -TERM "$pid" 2>/dev/null
  if emu_wait_gone "$pid" "${FLEET_EMU_TERM_WAIT_S:-30}"; then
    echo "stopped (SIGTERM)"; return 0
  fi
  kill -KILL "$pid" 2>/dev/null
  emu_wait_gone "$pid" 5
  if [ "$save" = 1 ] && [ -d "$EMU_AVD_HOME/$avd.avd/snapshots" ]; then
    rm -rf "$EMU_AVD_HOME/$avd.avd/snapshots/default_boot" "$EMU_AVD_HOME/$avd.avd/ci-snapshot.key"
    echo "SIGKILLed; its snapshot may have been mid-save, so it was removed"
    return 0
  fi
  echo "SIGKILLed"
}

# The job-completed path: this runner's emulators, whatever their parent. A
# runner runs one job at a time, so an emulator on its AVD is this job's, and
# one still up now would hold the AVD's lock against the next job.
emu_complete() {
  [ "${FLEET_EMULATOR_CLEANUP:-1}" = 1 ] || return 0
  local me pid avd port save owner
  me="$(printf '%s' "${RUNNER_NAME:-}" | tr -c 'A-Za-z0-9_.-' '_')"
  [ -n "$me" ] || return 0
  emu_list | while read -r pid _ _ avd port save; do
    owner="$(emu_avd_owner "$avd" "$me")" || continue
    case "$owner" in *" here") ;; *) continue ;; esac
    echo "emulator-control: $avd (pid $pid, port $port) left running by this job: $(emu_stop "$pid" "$port" "$avd" "$save")"
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  trap 'exit 0' EXIT
  _here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _root="${FLEET_ROOT:-$(cd "$_here/.." && pwd)}"
  # shellcheck source=/dev/null
  [ -f "$_root/fleet.env" ] && . "$_root/fleet.env"
  EMU_PREFIXES="${FLEET_CLEANUP_AVD_PREFIXES:-ci shots}"
  case "${1:-}" in
    complete) emu_complete ;;
    list) emu_list ;;
  esac
fi
