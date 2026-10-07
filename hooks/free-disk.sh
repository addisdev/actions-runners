# shellcheck shell=bash
# Free disk as a build will actually get it. Sourced by hooks/common.sh and
# cleanup.sh; never executed.
#
# df counts macOS's purgeable space as used: caches the system frees by itself
# when something needs the room. On runner-host (2026-10-07) df said 101 GB
# free while macOS reported 163 GB available for important use, so 62 GB that
# any build could have had. The admission floor read df, so it held every job
# with that room still there, and macOS only purges when space actually runs
# short, which a held, idle fleet never makes happen. The fleet sat at the floor
# until someone deleted something by hand (+78 GB on 09-30).
#
# fleet_usable_free_gb is what macOS will provide on request: plain free plus
# purgeable (NSURLVolumeAvailableCapacityForImportantUsageKey). It costs one
# osascript, about 0.2 s. fleet_plain_free_gb is df's number; a hard floor on it
# stays, because a purge takes time to happen. FLEET_DISK_PROBE=df, or a host
# without osascript, uses df for both.
#
# Nothing here may fail its caller: the hook runs under bash -e, where a failed
# read would exit it, and its EXIT trap would admit the job without a slot.

fleet_plain_free_gb() {
  local kb
  kb="$(df -k / 2>/dev/null | tail -1 | awk '{print $4}')" || kb=""
  case "$kb" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' "$((kb / 1048576))"
}

fleet_usable_free_gb() {
  local gb=""
  if [ "${FLEET_DISK_PROBE:-}" != "df" ] && command -v osascript >/dev/null 2>&1; then
    # shellcheck disable=SC2016  # $ is JavaScript here, not shell
    gb="$(osascript -l JavaScript -e '
      ObjC.import("Foundation");
      var out = Ref();
      $.NSURL.fileURLWithPath("/").getResourceValueForKeyError(
        out, "NSURLVolumeAvailableCapacityForImportantUsageKey", null);
      Math.floor(ObjC.unwrap(out[0]) / 1073741824)' 2>/dev/null)" || gb=""
  fi
  case "$gb" in
    '' | *[!0-9]*) fleet_plain_free_gb ;;
    *) printf '%s' "$gb" ;;
  esac
}
