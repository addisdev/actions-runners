// An agent host's admission decisions, carried to the coordinator.
//
// The hooks on every host append NDJSON to their own dashboard/logs/
// admission.ndjson. On the coordinator lib/admission.js reads that file
// directly; on an agent host nothing did, so holds there never reached the
// dashboard, the Capacity tab or the admission-hold alert. The agent now sends
// the lines added since its last ACCEPTED heartbeat.
//
// At-least-once, by construction: the read offset moves only by the lines the
// coordinator says it took (admissionAccepted in the heartbeat response). A
// heartbeat that fails, or a coordinator too old to know the field, leaves the
// offset where it was and the same lines go again next time.
//
// FIRST START: no offset file means "from the end of the log", not the start.
// A host that becomes an agent after being the coordinator (the role moving to
// another Mac) has a log whose history is already in the database it hands
// over; replaying it would duplicate every row. Seed the offset file from that
// database's admission_log_offset to continue exactly where it stopped.
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export const SHIP_MAX_LINES = 500;
export const SHIP_MAX_BYTES = 192 * 1024;

export function loadOffset(offsetFile, logPath) {
  if (existsSync(offsetFile)) {
    const n = Number(readFileSync(offsetFile, 'utf8').trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const start = existsSync(logPath) ? statSync(logPath).size : 0;
  saveOffset(offsetFile, start);
  return start;
}

export function saveOffset(offsetFile, offset) {
  const tmp = `${offsetFile}.tmp`;
  writeFileSync(tmp, `${offset}\n`, { mode: 0o600 });
  renameSync(tmp, offsetFile);
}

/**
 * Complete lines after `offset`, bounded so a backlog cannot exceed the
 * coordinator's heartbeat body limit.
 * @returns {{ offset: number, lines: string[], sizes: number[] }} sizes = bytes per line incl. newline
 */
export function readPending(logPath, offset, { maxLines = SHIP_MAX_LINES, maxBytes = SHIP_MAX_BYTES } = {}) {
  if (!existsSync(logPath)) return { offset: 0, lines: [], sizes: [] };
  const size = statSync(logPath).size;
  // Rotated or truncated: what was after the old cursor is gone, start over.
  if (size < offset) offset = 0;
  if (size <= offset) return { offset, lines: [], sizes: [] };

  const want = Math.min(size - offset, maxBytes);
  const buf = Buffer.allocUnsafe(want);
  const fd = openSync(logPath, 'r');
  let read = 0;
  try {
    read = readSync(fd, buf, 0, want, offset);
  } finally {
    closeSync(fd);
  }
  const lines = [];
  const sizes = [];
  let start = 0;
  // Complete lines only: a hook may be mid-append, and half an object sent now
  // would be dropped by the coordinator and never offered again.
  for (let i = 0; i < read && lines.length < maxLines; i++) {
    if (buf[i] !== 0x0a) continue;
    lines.push(buf.subarray(start, i).toString('utf8'));
    sizes.push(i + 1 - start);
    start = i + 1;
  }
  return { offset, lines, sizes };
}

/** The new offset after the coordinator accepted the first `accepted` lines. */
export function advance(pending, accepted) {
  const n = Math.max(0, Math.min(Number(accepted) || 0, pending.sizes.length));
  return pending.offset + pending.sizes.slice(0, n).reduce((a, b) => a + b, 0);
}
