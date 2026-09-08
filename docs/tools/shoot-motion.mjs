// Records docs/img/drift-repair.gif — a runner dying and being repaired.
//
// Everything else in docs/img/ comes from fixtures, and shoot-dash.mjs exists
// so that it can. This one cannot. deriveDrift opens `launchd-dead` when
// launchd holds a job with no process behind it, and health.sh --repair closes
// it by restarting the service — so the recording is worth something only if a
// real LaunchAgent really loses its process and the real daemon really notices
// on its own clock. A fixture fleet can hold a dead runner; it cannot die.
// Stepping a state machine with a script and filming the result would be a
// recording of the script.
//
// So this films a real fleet, over SSH:
//
//   * the front-end is served from dashboard/public/ in THIS checkout, so the
//     recording matches the screenshots captured beside it rather than
//     whatever build the fleet host happens to be running;
//   * every /api/ request is proxied to the fleetd already running on that
//     host, so every number on screen was measured;
//   * repository, host and path names are replaced on the way through, the
//     same substitution fleet-live.png and analytics-live.png use.
//
// What it does to the fleet, in order, and undoes afterwards:
//
//   1. stops the auto-remediation bridge. dashboard/autofix/bridge.js answers
//      a fleetd alert by running health.sh --repair, which is the right
//      behaviour and the wrong recording: it would reach the runner seconds
//      after the alert and turn fifteen seconds of an operator repairing a
//      runner into fifteen seconds of the bridge doing it first;
//   2. SIGKILLs the chosen runner's service, leaving the launchd job loaded.
//      Not `launchctl unload` — an unloaded job reads as `not-loaded`, which is
//      `launchd-missing`, a different finding with a different fix. `dead` is a
//      loaded job with no process, which is the OOM kill health.sh was written
//      for and the one no runner plist's KeepAlive will undo, because none of
//      them sets it;
//   3. runs ./health.sh --repair once the drift row and the alert are both
//      open, streaming its output into a terminal strip over the dashboard;
//   4. waits for the runner to come back online and the drift row to close;
//   5. starts the bridge again, whatever happened above.
//
// Fifteen seconds is the length of the GIF, not of the take. fleetd polls
// launchd every 15s while the fleet is busy and every 45s while it is idle, and
// a restarted listener needs another 10-20s to reach GitHub — so the real
// sequence runs to a hundred-odd seconds and no setting makes it fifteen.
// Frames are captured throughout at a steady interval and sampled onto the
// output grid afterwards. Every frame is one a viewer would have seen; the
// clock runs fast and nothing else does.
//
// `gh` is why the token is forwarded. On macOS `gh auth login` puts its token
// in the login keychain, which a non-GUI ssh session cannot read, so `gh` on
// the fleet host reports "the token in default is invalid" over SSH while
// working perfectly for fleetd under launchd. health.sh asks GitHub whether it
// agrees about each runner, and without a token every row reads `unknown`.
// register.sh documents the same problem and takes RUNNER_TOKEN for it; this
// reads `gh auth token` here at run time, passes it through the ssh
// environment, and never writes it down.
//
//   node shoot-motion.mjs --runner <dir-name>     the take
//   node shoot-motion.mjs --runner <dir-name> --dry-run
//                                                 everything but the SIGKILL
//   node shoot-motion.mjs --serve                 serve the redacted dashboard
//
// --runner names a directory under the fleet root, and has no default on
// purpose: the runner that dies should be one whose repo has a second runner
// still serving it, and that is a judgement about a particular fleet rather
// than a constant. There is no repository name anywhere in this file.

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, stat, rm, writeFile, readdir } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../../dashboard/public');
const FONT_DIR = resolve(HERE, '../figures/fonts');
const OUT_DIR = resolve(HERE, '../img');

// ------------------------------------------------------------------ options

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const SSH_HOST = opt('host', process.env.MOTION_SSH_HOST ?? 'runner-host');
const RUNNER_DIR = opt('runner', process.env.MOTION_RUNNER ?? null);
const FLEET_PORT = Number(opt('fleet-port', process.env.MOTION_FLEET_PORT ?? 7878));
const AUTOFIX_LABEL = opt('autofix-label', process.env.MOTION_AUTOFIX ?? 'com.addisdev.fleet-autofix');
const SERVE_ONLY = flag('serve');
const DRY_RUN = flag('dry-run');
const KEEP_FRAMES = flag('keep-frames');

// The output grid. 1280 wide because that is what the README column can show
// without the reader zooming, and 12 fps because a dashboard that changes four
// times in two minutes does not need more.
const OUT_WIDTH = 1280;
const OUT_HEIGHT = 800;
const OUT_SECONDS = 15;
const OUT_FPS = 12;
const SIZE_BUDGET = 8 * 1024 * 1024;

// Captured much faster than the output grid, so the sampler always has a real
// frame within a fifth of a second of every timestamp it wants.
const CAPTURE_MS = 400;

const log = (...a) => console.log('[motion]', ...a);
const warn = (...a) => console.warn('[motion]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SERVE_ONLY && !RUNNER_DIR) {
  console.error('[motion] --runner <dir-name> is required (the runner that dies). See the header.');
  process.exit(2);
}

// --------------------------------------------------------------------- ssh

const ssh = async (command) => {
  const { stdout } = await execFileAsync('ssh', ['-o', 'BatchMode=yes', SSH_HOST, command],
    { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

// Streams stdout line by line rather than buffering it, because the terminal
// strip is meant to fill in while the reader watches rather than appear whole.
//
// `secret` is written to the remote shell's stdin for it to read into a
// variable, rather than interpolated into the command. A command string is
// argv on the far side, and argv is world-readable in `ps`.
function sshStream(command, onLine, { secret = null } = {}) {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', SSH_HOST, command]);
  if (secret != null) child.stdin.end(secret + '\n');
  else child.stdin.end();
  let buf = '';
  const pump = (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) onLine(l);
  };
  child.stdout.setEncoding('utf8').on('data', pump);
  child.stderr.setEncoding('utf8').on('data', pump);
  return new Promise((res) => child.on('close', (code) => { if (buf) onLine(buf); res(code); }));
}

// ------------------------------------------------------------------ tunnel

// fleetd binds loopback by design — its control plane runs shell commands as
// the fleet user, so the documented way to reach it is exactly this.
let tunnel = null;
async function openTunnel() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-N', '-L', `${port}:127.0.0.1:${FLEET_PORT}`, SSH_HOST], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return port;
    } catch { /* not up yet */ }
  }
  throw new Error(`could not reach fleetd on ${SSH_HOST}:${FLEET_PORT} through the tunnel`);
}

// -------------------------------------------------------------- redaction

// Same principle as shoot-dash.mjs's present(): nothing reaches the browser by
// a path this does not cover, so there is one substitution rather than two that
// eventually disagree.
//
// The mapping is positional and derived from the snapshot rather than written
// down, so it reproduces itself: the daemon's own project order becomes
// project-a, project-b, ... exactly as it did for fleet-live.png, and a repo
// keeps the role word that makes its tile readable — a reader needs to see that
// the fleet has a backend and three web runners, only not whose.
//
// The host prefix on a runner name becomes one hyphenless token, because the
// Fleet tile prints `name.replace(/^[^-]+-/, '')`: a replacement carrying a
// hyphen would have its first half eaten and the tile would read `host-web-2`.
function buildRedactions(snapshot) {
  const pairs = [];
  const push = (from, to) => { if (from && from !== to) pairs.push([String(from), to]); };

  const projects = (snapshot.projects ?? []).filter((p) =>
    (snapshot.runners ?? []).some((r) => r.project === p));
  const letter = new Map(projects.map((p, i) => [p, String.fromCharCode(97 + i)]));

  const owners = new Set();
  const repoNames = new Set();
  for (const r of [...(snapshot.runners ?? []), ...(snapshot.elsewhere ?? [])]) {
    if (r.repo) repoNames.add(r.repo);
  }
  for (const r of snapshot.repos ?? []) if (r.repo) repoNames.add(r.repo);

  const seen = new Map();
  for (const full of [...repoNames].sort()) {
    const [owner, name] = full.split('/');
    owners.add(owner);
    const project = (snapshot.runners ?? []).find((r) => r.repo === full)?.project;
    const ltr = letter.get(project);
    let mapped;
    if (ltr && name.startsWith(project)) {
      // `<product>-web` becomes `project-a-web`. The role is the part that
      // carries meaning; the product name is the part that does not belong.
      const role = name.slice(project.length).replace(/^[-_]/, '') || 'main';
      mapped = `project-${ltr}-${role}`;
    } else {
      const ltr2 = ltr ?? 'x';
      const n = (seen.get(ltr2) ?? 0) + 1;
      seen.set(ltr2, n);
      mapped = `project-${ltr2}-${n}`;
    }
    push(name, mapped);
  }
  // A project name is replaced everywhere it appears, because it turns up in
  // free text this rig does not otherwise reach — a commit message naming the
  // product, a workflow title, a release URL — and those render on the Fleet
  // tab the moment anything is queued.
  //
  // Except for the ones that are also words this product says about itself.
  // This fleet has a group called `actions` and one called `fleet`; replacing
  // those blind rewrote `actions.runner.<label>` into nonsense and turned the
  // fleet root `/Users/owner/actions-runners` into a directory that never
  // existed. Those are replaced only where they are a whole JSON value, which
  // is the only place a group name is one.
  const GENERIC = new Set(['actions', 'fleet', 'runner', 'runners', 'template', 'other', 'main', 'web']);
  const pushValue = (from, to) => push(`"${from}"`, `"${to}"`);
  const pushName = (from, to) => {
    pushValue(from, to);
    if (!GENERIC.has(from)) push(from, to);
  };
  for (const p of projects) pushName(p, `project-${letter.get(p)}`);
  // Groups with no runners render nowhere, but they are still in the payload
  // and they are still somebody's product name. They keep going down the
  // alphabet, after the ones the letters in fleet-live.png already mean.
  let spare = projects.length;
  for (const p of snapshot.projects ?? []) {
    if (letter.has(p)) continue;
    pushName(p, `project-${String.fromCharCode(97 + spare++)}`);
  }
  for (const o of owners) push(o, 'owner');

  // The host, in all three forms it reaches the browser in: the LocalHostName
  // that prefixes every runner name, the display name in the header, and the
  // home directory that the runner drawer prints in full.
  //
  // The two forms are the same string and need different replacements, which
  // the longest-first pass below resolves: `<prefix>-` only ever begins a
  // runner name, and what is left over is the header's own hostname.
  const hostName = snapshot.host?.hostname ?? snapshot.host?.name ?? null;
  const prefix = (snapshot.runners ?? [])[0]?.name?.split('-')[0] ?? null;
  if (prefix) push(`${prefix}-`, 'runnerhost-');
  if (hostName) push(hostName, 'runner-host');
  if (prefix && prefix !== hostName) push(prefix, 'runner-host');
  const root = snapshot.runners?.[0]?.dir?.replace(/\/[^/]+$/, '') ?? null;
  if (root) {
    push(root, '/Users/owner/actions-runners');
    const user = root.match(/^\/Users\/([^/]+)\//)?.[1];
    if (user) push(user, 'owner');
  }

  // Longest first: `<product>-web` has to be replaced before `<product>`, or
  // the tail of the longer name survives as `project-a` with `-web` still on
  // the end of it.
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

let REDACTIONS = [];
const redact = (text) => {
  let out = text;
  for (const [from, to] of REDACTIONS) out = out.split(from).join(to);
  return out;
};

// ------------------------------------------------------------------ server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function serveFile(res, file, root) {
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

function createServer(upstream) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // The strip's face, served from the same copies the figures use so the
    // recording and the figures are one type pairing.
    if (p.startsWith('/motion-fonts/')) {
      return serveFile(res, resolve(FONT_DIR, p.slice('/motion-fonts/'.length)), FONT_DIR);
    }

    if (p.startsWith('/api/')) {
      // Read-only, like shoot-dash. A rig that can change a live fleet is a rig
      // that can be blamed for changing one — and this one is pointed at a
      // fleet that is actually serving repositories.
      if (req.method !== 'GET') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end('{"error":"the motion rig is read-only"}');
      }

      if (p === '/api/stream') {
        const upstreamRes = await fetch(upstream + req.url, { headers: { accept: 'text/event-stream' } });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        // Buffered to the event boundary: a substitution applied to half a name
        // that arrived split across two chunks would leak the other half.
        let buf = '';
        const reader = upstreamRes.body.getReader();
        const dec = new TextDecoder();
        req.on('close', () => { try { reader.cancel(); } catch { /* gone */ } });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            res.write(redact(buf.slice(0, i + 2)));
            buf = buf.slice(i + 2);
          }
        }
        return res.end();
      }

      try {
        const upstreamRes = await fetch(upstream + req.url);
        const body = await upstreamRes.text();
        res.writeHead(upstreamRes.status, {
          'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        });
        return res.end(redact(body));
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: String(err.message) }));
      }
    }

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    return serveFile(res, resolve(PUBLIC_DIR, rel), PUBLIC_DIR);
  });
}

// ------------------------------------------------------------------- strip

// The terminal strip is composited in the page rather than over the frames
// afterwards, so a captured frame is a screenshot of the whole composition and
// there is no second pipeline that could drift out of alignment with the first.
const STRIP_CSS = `
@font-face {
  font-family: 'JetBrains Mono Docs';
  src: url('/motion-fonts/JetBrainsMono-latin.woff2') format('woff2');
  font-weight: 100 800;
  font-display: block;
}
#motion-strip {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999;
  background: #0b0f17; border-top: 1px solid #253142;
  box-shadow: 0 -18px 40px rgba(5, 8, 13, 0.85);
  padding: 12px 20px 14px;
  font-family: 'JetBrains Mono Docs', ui-monospace, monospace;
  font-size: 13px; line-height: 1.5; color: #f6f8fb;
  font-variant-numeric: tabular-nums;
}
#motion-strip.is-hidden { display: none; }
#motion-strip .motion-head {
  color: #7f8a9b; font-size: 13px; letter-spacing: 0.04em;
  text-transform: uppercase; margin-bottom: 6px;
}
#motion-strip .motion-cmd { color: #60a5fa; }
#motion-strip .motion-line { white-space: pre; color: #f6f8fb; }
#motion-strip .motion-line.is-bad { color: #f36a6a; }
#motion-strip .motion-line.is-act { color: #f5b942; }
#motion-strip .motion-line.is-muted { color: #7f8a9b; }
`;

// Only the tail is shown, which is what a terminal shows: health.sh prints a
// row per runner and the fleet has more runners than a strip has lines.
//
// With one exception, and it is a deliberate one. health.sh sweeps the whole
// fleet, so the two lines this recording is about — the dead runner's row and
// the `-> restarting` under it — arrive about a fifth of the way through and
// are gone from a seven-line tail long before the command returns. At the
// speed the take is played back that is one frame, which is no frames. So
// lines naming the runner being repaired, and the restart lines, are held at
// the bottom of the strip instead of scrolling away. Nothing is invented and
// nothing is reordered; two lines out of thirty-odd are kept on screen after
// the terminal would have scrolled them off, and docs/brand.md says so.
const STRIP_LINES = 7;

function stripState() {
  return { visible: false, lines: [], pinned: [], subject: null };
}

async function installStrip(page) {
  await page.addStyleTag({ content: STRIP_CSS });
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'motion-strip';
    el.className = 'is-hidden';
    document.body.append(el);
  });
}

async function paintStrip(page, strip) {
  await page.evaluate(({ visible, lines, pinned, max }) => {
    const el = document.getElementById('motion-strip');
    if (!el) return;
    el.classList.toggle('is-hidden', !visible);
    if (!visible) return;
    const tail = lines.slice(-(max - pinned.length));
    const cls = (l) => {
      if (/^\s*->/.test(l)) return 'motion-line is-act';
      if (/\bDEAD\b|\bNOT-LOADED\b|unhealthy/.test(l)) return 'motion-line is-bad';
      if (/^SERVICE\b/.test(l)) return 'motion-line is-muted';
      return 'motion-line';
    };
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'motion-head';
    head.textContent = 'runner-host';
    el.append(head);
    const cmd = document.createElement('div');
    cmd.className = 'motion-line motion-cmd';
    cmd.textContent = '$ ./health.sh --repair';
    el.append(cmd);
    for (const l of [...tail, ...pinned]) {
      const d = document.createElement('div');
      d.className = cls(l);
      d.textContent = l;
      el.append(d);
    }
  }, { visible: strip.visible, lines: strip.lines, pinned: strip.pinned, max: STRIP_LINES });
}

// ------------------------------------------------------------------ capture

// One owner for the page. The recorder reads the DOM on every tick and the
// orchestration waits on what it saw, rather than both driving Playwright and
// interleaving a screenshot with someone else's waitForFunction.
async function probe(page, runnerDisplay) {
  return page.evaluate((name) => {
    const tile = [...document.querySelectorAll('#fleet .runner')]
      .find((n) => n.querySelector('.runner-name')?.textContent === name);
    const state = tile ? [...tile.classList].find((c) => c.startsWith('state-'))?.slice(6) ?? null : null;
    const drift = [...document.querySelectorAll('#drift .drift-item')]
      .map((n) => n.querySelector('.drift-subject')?.textContent ?? '');
    return {
      state,
      driftForRunner: drift.some((s) => s.endsWith(name)),
      driftCount: drift.length,
      alerts: !document.querySelector('#alerts-badge')?.hidden,
      conn: document.querySelector('#conn-label')?.textContent ?? '',
    };
  }, runnerDisplay);
}

// ------------------------------------------------------------------ encode

async function ffmpeg(args) {
  try {
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${(err.stderr ?? err.message).toString().trim().split('\n').pop()}`);
  }
}

// Sample the take onto the output grid: for each frame the GIF wants, the
// captured frame closest in time to it. Nearest rather than interpolated,
// because a blended frame is one nobody saw.
function sampleFrames(captured, wanted) {
  const t0 = captured[0].t;
  const span = captured[captured.length - 1].t - t0;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < wanted; i++) {
    const target = t0 + (span * i) / (wanted - 1);
    while (cursor + 1 < captured.length
      && Math.abs(captured[cursor + 1].t - target) <= Math.abs(captured[cursor].t - target)) cursor++;
    out.push(captured[cursor]);
  }
  return out;
}

async function encode(frames, workDir) {
  const seqDir = join(workDir, 'seq');
  await mkdir(seqDir, { recursive: true });
  const wanted = OUT_SECONDS * OUT_FPS;
  const picked = sampleFrames(frames, wanted);
  await Promise.all(picked.map((f, i) =>
    readFile(f.path).then((b) => writeFile(join(seqDir, `f${String(i).padStart(4, '0')}.png`), b))));

  const pattern = join(seqDir, 'f%04d.png');
  const mp4 = join(OUT_DIR, 'drift-repair.mp4');
  const gif = join(OUT_DIR, 'drift-repair.gif');

  // The MP4 is for the portfolio, where a video element is available and a
  // 15-second GIF is a waste of somebody's data plan.
  await ffmpeg(['-framerate', String(OUT_FPS), '-i', pattern,
    '-vf', `scale=${OUT_WIDTH}:-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);

  // Stepped down until it fits rather than guessed at: the frame count is
  // fixed by the fifteen seconds, so the only levers are the palette and the
  // frame rate, and dropping the palette first keeps the motion smooth.
  const ladder = [
    { fps: OUT_FPS, colors: 192 },
    { fps: OUT_FPS, colors: 128 },
    { fps: OUT_FPS, colors: 96 },
    { fps: 10, colors: 96 },
    { fps: 10, colors: 64 },
    { fps: 8, colors: 64 },
  ];
  let used = null;
  for (const step of ladder) {
    const palette = join(workDir, 'palette.png');
    const chain = `fps=${step.fps},scale=${OUT_WIDTH}:-2:flags=lanczos`;
    await ffmpeg(['-framerate', String(OUT_FPS), '-i', pattern,
      '-vf', `${chain},palettegen=max_colors=${step.colors}:stats_mode=diff`, palette]);
    await ffmpeg(['-framerate', String(OUT_FPS), '-i', pattern, '-i', palette,
      '-lavfi', `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0', gif]);
    const { size } = await stat(gif);
    used = { ...step, size };
    log(`gif at ${step.fps} fps / ${step.colors} colours — ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size <= SIZE_BUDGET) break;
  }
  const gifSize = (await stat(gif)).size;
  const mp4Size = (await stat(mp4)).size;
  if (gifSize > SIZE_BUDGET) {
    warn(`the GIF is ${(gifSize / 1024 / 1024).toFixed(2)} MB, over the ${SIZE_BUDGET / 1024 / 1024} MB budget`);
  }
  return { gif, mp4, gifSize, mp4Size, used, frames: picked.length };
}

// -------------------------------------------------------------------- take

async function run() {
  const port = await openTunnel();
  const upstream = `http://127.0.0.1:${port}`;
  log(`tunnelled to ${SSH_HOST}:${FLEET_PORT}`);

  const snapshot = await (await fetch(`${upstream}/api/state`)).json();
  REDACTIONS = buildRedactions(snapshot);

  const target = (snapshot.runners ?? []).find((r) => r.dirName === RUNNER_DIR);
  if (!SERVE_ONLY) {
    if (!target) throw new Error(`no runner directory named ${RUNNER_DIR} on ${SSH_HOST}`);
    if (target.launchdState !== 'running') throw new Error(`${RUNNER_DIR} is ${target.launchdState}, not running`);
    if (target.ghBusy || target.workingLocally) throw new Error(`${RUNNER_DIR} is running a job — try again when it is idle`);
    const siblings = (snapshot.runners ?? [])
      .filter((r) => r.repo === target.repo && r.name !== target.name && r.launchdState === 'running');
    if (!siblings.length) {
      warn(`${RUNNER_DIR} is the only runner for its repository — jobs for it will queue while it is down`);
    } else {
      log(`${siblings.length} sibling runner(s) stay up for the same repository`);
    }
  }

  const server = createServer(upstream);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  if (SERVE_ONLY) {
    log(`serving the redacted dashboard on ${base} — ctrl-c to stop`);
    await new Promise(() => {});
    return null;
  }

  const runnerDisplay = redact(target.name).replace(/^[^-]+-/, '');
  const label = target.launchdLabel;
  const uid = (await ssh('id -u')).trim();
  log(`filming ${runnerDisplay} (${RUNNER_DIR})`);

  const workDir = join(tmpdir(), `motion-${Date.now()}`);
  await mkdir(join(workDir, 'frames'), { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: OUT_WIDTH, height: OUT_HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    try { localStorage.removeItem('fleet-theme'); } catch { /* ignore */ }
  });
  const page = await context.newPage();

  const strip = stripState();
  const captured = [];
  const observed = { last: null };
  let recording = true;
  let bridgeStopped = false;

  const waitFor = async (predicate, what, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (observed.last && predicate(observed.last)) return;
      await sleep(200);
    }
    throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
  };

  // Started only once the page is up and the strip is in the DOM. A tick that
  // lands mid-navigation evaluates against a context that is being torn down,
  // and losing the whole take to that would be a poor trade for four hundred
  // milliseconds of head start.
  let recorder = Promise.resolve();
  const startRecorder = () => {
    recorder = (async () => {
      let seq = 0;
      while (recording) {
        const at = Date.now();
        try {
          await paintStrip(page, strip);
          const path = join(workDir, 'frames', `c${String(seq).padStart(5, '0')}.png`);
          await page.screenshot({ path, animations: 'disabled' });
          captured.push({ path, t: at });
          observed.last = await probe(page, runnerDisplay);
          seq++;
        } catch (err) {
          // A dropped frame is a gap in a time-lapse. A thrown one is no film.
          if (recording) warn(`frame skipped: ${err.message.split('\n')[0]}`);
        }
        const spent = Date.now() - at;
        if (spent < CAPTURE_MS) await sleep(CAPTURE_MS - spent);
      }
    })();
  };

  let result = null;
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#conn-label:text-is("Live")', { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('#fleet .runner').length > 0);
    await installStrip(page);

    // Past the KPI row, for the reason shoot-dash scrolls past it: the row is
    // meant to be hidden on some tabs and is not, and the composition wants the
    // drift panel and the runner that is about to die in the same frame.
    await page.evaluate(() => {
      const el = document.querySelector('#drift');
      if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 88));
    });
    startRecorder();

    await waitFor((o) => o.state === 'idle' && !o.driftForRunner, 'the runner to be idle and undrifted', 60_000);
    log('baseline: online, no drift');
    await sleep(6000);

    if (DRY_RUN) {
      log('dry run — not killing anything');
      await sleep(6000);
    } else {
      await ssh(`launchctl bootout gui/${uid}/${AUTOFIX_LABEL}`).catch(() => {});
      bridgeStopped = true;
      log('auto-remediation bridge stopped for the take');

      await ssh(`launchctl kill 9 gui/${uid}/${label}`);
      log('service killed — launchd job still loaded, no process behind it');

      await waitFor((o) => o.state === 'dead', 'the tile to go dead', 150_000);
      await waitFor((o) => o.driftForRunner, 'launchd-dead drift to open', 60_000);
      log('drift open, alert open');
      await sleep(5000);

      strip.visible = true;
      const token = (await execFileAsync('gh', ['auth', 'token'])).stdout.trim();
      strip.subject = runnerDisplay;
      await sshStream(
        'IFS= read -r GH_TOKEN; export GH_TOKEN; '
        + 'export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH; '
        + 'cd ~/actions-runners && ./health.sh --repair',
        (line) => {
          const text = redact(line.replace(/\s+$/, ''));
          if (text.includes(strip.subject) || /^\s*->/.test(text)) strip.pinned.push(text);
          else strip.lines.push(text);
        },
        { secret: token },
      );
      log('health.sh --repair finished');

      await waitFor((o) => o.state !== 'dead', 'the service to come back', 120_000);
      await waitFor((o) => o.state === 'idle' && !o.driftForRunner, 'online, drift closed', 180_000);
      log('back online, drift closed');
      await sleep(4000);
      strip.visible = false;
      await sleep(2500);
    }
  } finally {
    recording = false;
    await recorder.catch(() => {});
    if (bridgeStopped) {
      try {
        await ssh(`launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${AUTOFIX_LABEL}.plist`);
        log('auto-remediation bridge started again');
      } catch (err) {
        warn(`COULD NOT RESTART THE BRIDGE — do it by hand: ${err.message}`);
      }
    }
    await browser.close();
    server.close();
    tunnel?.kill();
  }

  if (captured.length > 2) {
    log(`captured ${captured.length} frames over ${Math.round((captured.at(-1).t - captured[0].t) / 1000)}s`);
    result = await encode(captured, workDir);
    const realSeconds = (captured.at(-1).t - captured[0].t) / 1000;
    result.speed = realSeconds / OUT_SECONDS;
    log(`drift-repair.gif — ${(result.gifSize / 1024 / 1024).toFixed(2)} MB, `
      + `${OUT_SECONDS}s at ${result.used.fps} fps (${result.speed.toFixed(1)}x real time)`);
    log(`drift-repair.mp4 — ${(result.mp4Size / 1024 / 1024).toFixed(2)} MB`);
    log('wrote docs/img/drift-repair.gif and docs/img/drift-repair.mp4');
  }
  if (!KEEP_FRAMES) await rm(workDir, { recursive: true, force: true });
  else log(`frames kept in ${workDir}`);
  return result;
}

// The tunnel is a child process, and a child process outlives a parent that is
// killed rather than returned from — `--serve` blocks forever by design, so
// without this every ctrl-c leaves an ssh holding a forwarded port.
const closeTunnel = () => { try { tunnel?.kill(); } catch { /* already gone */ } };
process.on('SIGINT', () => { closeTunnel(); process.exit(130); });
process.on('SIGTERM', () => { closeTunnel(); process.exit(143); });
process.on('exit', closeTunnel);

run().then(
  () => process.exit(0),
  (err) => { console.error('[motion] failed:', err.message); process.exit(1); },
);
