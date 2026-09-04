// Everything the GitHub API cannot tell you.
//
// This half is why the daemon runs on the runner host rather than on a laptop:
// launchd state, listener PIDs and resident memory, swap pressure, disk, and
// which runner directory currently has a Runner.Worker in it are all local
// facts. Reaching them over SSH means the dashboard goes dark exactly when the
// laptop is asleep — which is when you need it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

async function sh(cmd, args, timeout = 15000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

// The runner writes .runner with a UTF-8 BOM. Python's json.load raises on it
// with a plain utf-8 handle; JSON.parse does the same thing, quieter and
// weirder — the BOM becomes an invalid first character. Strip it explicitly.
function readRunnerJson(path) {
  try {
    let raw = readFileSync(path, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Read the .drain file written by scripts/drain-runner.sh.
// Returns null (not draining), 'draining' (busy, will stop after job), or
// 'drained' (stopped intentionally).
function readDrainState(dir) {
  const p = join(dir, '.drain');
  if (!existsSync(p)) return null;
  try {
    const first = readFileSync(p, 'utf8').split('\n')[0].trim();
    if (first === 'draining' || first === 'drained') return first;
  } catch { /* ignore */ }
  return 'drained';
}

// A .drain file at the fleet root drains the whole host, the same way one in a
// runner's directory drains that runner. Same file name and same contents on
// purpose: a second convention for the same idea is one more thing to remember
// at the moment somebody is taking a machine out of service in a hurry.
//
// It cannot collide with a runner's own flag — runners live in subdirectories,
// and discoverRunnerDirs skips dotfiles at the root.
export function hostDrainState(root) {
  return readDrainState(root);
}

export function discoverRunnerDirs(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const dotRunner = join(dir, '.runner');
    if (!existsSync(dotRunner)) continue;
    const cfg = readRunnerJson(dotRunner);
    if (!cfg?.agentName || !cfg?.gitHubUrl) continue;
    const repo = cfg.gitHubUrl.split('github.com/').pop().replace(/\/+$/, '');
    out.push({
      dir,
      dirName: entry.name,
      name: cfg.agentName,
      repo,
      drainState: readDrainState(dir),
      version: runnerVersion(dir),
      // Derived exactly the way svc.sh derives it, which is the only way the
      // label will actually match what launchd loaded.
      launchdLabel: `actions.runner.${repo.replace(/\//g, '-')}.${cfg.agentName}`,
    });
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

// One `launchctl list` for the whole fleet rather than one per runner. Sixteen
// subprocess spawns every 15 seconds is a real cost on a machine that is also
// compiling Swift.
export async function launchdJobs() {
  const out = await sh('launchctl', ['list']);
  const map = new Map();
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [pid, status, label] = parts;
    if (label === 'Label') continue;
    map.set(label.trim(), {
      pid: pid === '-' ? null : Number(pid),
      lastExit: status === '-' ? null : Number(status),
    });
  }
  return map;
}

// Also one call. Returns listeners and workers keyed by the runner directory
// they were launched from, which is how a busy runner is detected locally with
// no API call at all.
export async function runnerProcesses() {
  const out = await sh('ps', ['-axo', 'pid=,rss=,etime=,command=']);
  const listeners = new Map();
  const workers = new Map();
  for (const line of out.split('\n')) {
    if (!line.includes('Runner.Listener') && !line.includes('Runner.Worker')) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, rss, etime, command] = m;
    const dirMatch = command.match(/(.*)\/bin\/Runner\.(Listener|Worker)/);
    if (!dirMatch) continue;
    const rec = { pid: Number(pid), rssKb: Number(rss), etime, command };
    (dirMatch[2] === 'Listener' ? listeners : workers).set(dirMatch[1], rec);
  }
  return { listeners, workers };
}

function parseSwap(text) {
  // vm.swapusage: total = 2048.00M  used = 1090.69M  free = 957.31M  (encrypted)
  const num = (key) => {
    const m = text.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([MGK])`));
    if (!m) return null;
    const v = parseFloat(m[1]);
    return m[2] === 'G' ? v * 1024 : m[2] === 'K' ? v / 1024 : v;
  };
  return { totalMb: num('total'), usedMb: num('used'), freeMb: num('free') };
}

// os.freemem() on macOS reports only the truly free pages and reads as "this
// machine is out of memory" on a box that is merely warm. vm_stat's breakdown
// is the honest one: used = active + wired + compressed.
//
// Swapins/Swapouts are cumulative since boot. Their RATE is the signal that
// matters — see the note on hostVitals below.
function parseVmStat(text) {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const page = (label) => {
    const m = text.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
    return m ? Number(m[1]) : 0;
  };
  const bytes = (n) => (n * pageSize) / (1024 * 1024);
  const active = page('Pages active');
  const wired = page('Pages wired down');
  const compressed = page('Pages occupied by compressor');
  return {
    usedMb: Math.round(bytes(active + wired + compressed)),
    compressedMb: Math.round(bytes(compressed)),
    swapins: page('Swapins'),
    swapouts: page('Swapouts'),
  };
}

function parseDf(text) {
  const line = text.trim().split('\n').pop() ?? '';
  const cols = line.split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity ... Mounted
  const totalKb = Number(cols[1]);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return {};
  return { totalGb: totalKb / 1048576, freeGb: availKb / 1048576 };
}

// os.release() is the Darwin version (25.5.0), not the macOS version (26.5.2).
// Labelling one as the other is the kind of small wrongness that costs an hour
// when someone is checking whether a runner host is on the OS a job needs.
// Resolved once — it does not change while the process is up.
let productVersion = null;
async function macosVersion() {
  if (productVersion === null) productVersion = (await sh('sw_vers', ['-productVersion'])).trim() || 'unknown';
  return productVersion;
}

// A note on swap, because the obvious metric is the wrong one.
//
// Swap USED on macOS is an accumulator, not a pressure gauge. The kernel
// compresses before it swaps and never proactively reclaims swap space, so pages
// written during any peak in the machine's uptime stay counted long after
// nothing needs them. Measured on this host: 4.3 GB of swap "used" while memory
// was 71% free, load was 1.0, and thirty seconds of sampling showed ZERO swapins
// and zero swapouts. Three hours of samples had swap pinned in a 32 MB band
// while memory in use swung by 5 GB and load peaked at 62.
//
// So what is collected here is what actually predicts a stall: the kernel's own
// pressure level, the free percentage it reports, and the swap-in RATE. Swap
// level is kept for context, not for judgement.
export async function hostVitals() {
  const [swapRaw, vmRaw, dfRaw, osVersion, pressureRaw, freePctRaw] = await Promise.all([
    sh('sysctl', ['-n', 'vm.swapusage']),
    sh('vm_stat', []),
    sh('df', ['-k', '/']),
    macosVersion(),
    // 1 = normal, 2 = warning, 4 = critical. This is the value the kernel
    // itself broadcasts to applications, and it costs about 6ms.
    sh('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    sh('memory_pressure', []),
  ]);
  const swap = parseSwap(swapRaw);
  const mem = parseVmStat(vmRaw);
  const disk = parseDf(dfRaw);
  const levelNum = Number(String(pressureRaw).trim());
  const pressure = levelNum >= 4 ? 'critical' : levelNum >= 2 ? 'warning' : 'normal';
  const freePct = Number(String(freePctRaw).match(/free percentage:\s*(\d+)/i)?.[1] ?? NaN);
  const [load1, load5, load15] = os.loadavg();
  return {
    hostname: os.hostname().replace(/\.local$/, ''),
    cores: os.cpus().length,
    platform: `macOS ${osVersion}`,
    darwin: os.release(),
    uptimeSec: Math.round(os.uptime()),
    load1,
    load5,
    load15,
    memUsedMb: mem.usedMb,
    memTotalMb: Math.round(os.totalmem() / 1048576),
    swapUsedMb: swap.usedMb,
    swapTotalMb: swap.totalMb,
    memCompressedMb: mem.compressedMb,
    memPressure: Number.isFinite(levelNum) ? pressure : null,
    memFreePct: Number.isFinite(freePct) ? freePct : null,
    // Cumulative since boot. The collector turns these into a rate.
    swapins: mem.swapins,
    swapouts: mem.swapouts,
    diskFreeGb: disk.freeGb,
    diskTotalGb: disk.totalGb,
  };
}

// Walking ~7 GB of runner directories is not something to do every 15 seconds.
// The slow loop owns this.
export async function dirSizes(dirs) {
  const sizes = new Map();
  await Promise.all(
    dirs.map(async (d) => {
      const out = await sh('du', ['-sk', d], 120000);
      const kb = Number(out.trim().split(/\s+/)[0]);
      if (Number.isFinite(kb)) sizes.set(d, kb);
    })
  );
  return sizes;
}

// Newest version first. Used for both the side-by-side list and for deciding
// which of several `bin.N.N.N` directories is the current one.
function byVersionDesc(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}

// Which runner binary version a directory is actually running.
//
// This is worth knowing because GitHub auto-updates runners and nothing tells
// you when it happened. A runner that started failing an hour ago and a runner
// that was updated an hour ago are the same fact seen from two sides, and
// without the version there is no way to connect them.
//
// Auto-update leaves BOTH versions on disk: the new one is unpacked into
// `bin.<version>` alongside the live `bin`, and the switch happens on restart.
// So a directory can legitimately hold several versions, and the interesting
// question is which is live versus which are merely present.
export function runnerVersions(dir) {
  // The runner writes this file itself on install and after each update, so it
  // is the authoritative answer for what `bin` currently contains.
  let active = null;
  for (const candidate of ['bin/runner.version', 'bin/.version', '.version']) {
    const p = join(dir, candidate);
    if (!existsSync(p)) continue;
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (/^\d+\.\d+/.test(v)) { active = v; break; }
    } catch { /* try the next candidate */ }
  }

  // Side-by-side copies from an update that has been downloaded. Read even when
  // `active` was found, because a version sitting here that is NEWER than the
  // active one means an update is staged and waiting for a restart — which is
  // the difference between "this runner is behind" and "this runner is behind
  // and already has the fix on disk".
  const sideBySide = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^bin\.(\d+\.\d+.*)$/);
      if (m) sideBySide.push(m[1]);
    }
  } catch { /* an unreadable directory is not worth failing a tick over */ }
  sideBySide.sort(byVersionDesc);

  // With no version file at all, the newest side-by-side directory is the best
  // available guess. Reported rather than left null because a version that is
  // probably right is more use than nothing during an incident.
  if (!active && sideBySide.length) active = sideBySide[0];

  const staged = sideBySide.filter((v) => active && byVersionDesc(v, active) < 0);

  return {
    active,
    sideBySide,
    // Downloaded and newer than what is running: takes effect on next restart.
    stagedUpdate: staged.length ? staged[0] : null,
  };
}

// Kept as a thin wrapper because the collector only ever wants the one string,
// and threading an object through buildRunners for it would be noise.
export function runnerVersion(dir) {
  return runnerVersions(dir).active;
}

// What the runner's own log says went wrong, parsed rather than shown verbatim.
//
// diagTail below exists for reading the last thing a runner said, which is the
// right tool when somebody is looking at one runner. This is the other question:
// across a fleet, which runners are logging errors at all? A count of warnings
// and errors plus the most recent example answers that without anybody opening
// 29 log files.
//
// Only the newest log is read, and only its tail. The full _diag directory runs
// to hundreds of megabytes on a long-lived runner and walking it on a timer is
// exactly the sort of thing that makes a monitoring tool the reason a box is
// slow.
export function diagSummary(dir, { maxLines = 2000 } = {}) {
  const diag = join(dir, '_diag');
  if (!existsSync(diag)) return null;

  let newest = null;
  try {
    for (const f of readdirSync(diag)) {
      if (!f.startsWith('Runner_') || !f.endsWith('.log')) continue;
      const p = join(diag, f);
      const mtime = statSync(p).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
    }
  } catch { return null; }
  if (!newest) return null;

  let lines;
  try {
    lines = readFileSync(newest.path, 'utf8').split('\n').slice(-maxLines);
  } catch { return null; }

  let errors = 0, warnings = 0;
  let lastError = null, lastWarning = null;
  // The runner's log format puts the level in brackets, as in
  // `[2026-09-04 12:00:00Z ERR  Terminal]`. Matching the bracketed level rather
  // than the word "error" anywhere in the line keeps a job's own output — which
  // is full of the word error — from being counted as a runner fault.
  for (const line of lines) {
    if (/\b(ERR|ERROR)\b\s/.test(line)) { errors++; lastError = line.trim().slice(0, 300); }
    else if (/\b(WARN|WARNING)\b\s/.test(line)) { warnings++; lastWarning = line.trim().slice(0, 300); }
  }

  return {
    file: newest.path,
    mtime: newest.mtime,
    linesScanned: lines.length,
    errors,
    warnings,
    lastError,
    lastWarning,
  };
}

// The tail of a runner's newest _diag log. Not parsed — shown verbatim when you
// open a runner, because the useful line during an incident is whatever the
// runner last said, not a field somebody thought to extract.
export function diagTail(dir, lines = 40) {
  const diag = join(dir, '_diag');
  if (!existsSync(diag)) return null;
  let newest = null;
  for (const f of readdirSync(diag)) {
    if (!f.startsWith('Runner_') || !f.endsWith('.log')) continue;
    const p = join(diag, f);
    const mtime = statSync(p).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
  }
  if (!newest) return null;
  try {
    const text = readFileSync(newest.path, 'utf8');
    return { file: newest.path, mtime: newest.mtime, tail: text.split('\n').slice(-lines).join('\n') };
  } catch {
    return null;
  }
}
