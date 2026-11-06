// The CI artifact viewer: ~/ci-artifacts, read-only, at /artifacts/.
//
// Self-hosted jobs keep what they used to upload to GitHub (screenshots,
// reports, traces, test bundles) on the runner host instead, at
//   ~/ci-artifacts/<repo>/<run_id>-<run_attempt>/<name>/
// and print a link to this page in the job summary. GitHub Free's artifact
// storage was spent by the 5th of the month (2026-11), so nothing CI makes is
// kept at GitHub any more.
//
//   /artifacts/                        every repository: runs, size, newest
//   /artifacts/<repo>/                 its runs, newest first: size, age
//   /artifacts/<repo>/<run>-<att>/...  a folder: images as a grid, the rest
//                                      listed; .html opens as a page, a
//                                      folder (an .xcresult bundle, say)
//                                      downloads as a zip with ?zip=1
//
// READ ONLY. Nothing here writes, renames or deletes. Pruning is the runner
// hooks' job (hooks/ci-artifacts-prune.sh).
//
// PATH SAFETY. Every request is resolved with realpath and must land inside
// the root's own realpath, so neither `..` nor a symlink a job left behind
// can reach outside it. Dot segments are refused outright. The zip is built
// with `zip -y`, which stores a symlink as a link instead of following it.
//
// CONTENT SAFETY. An artifact is whatever a CI job wrote, and the dashboard
// keeps its control token in the page's localStorage. So every file is served
// with `Content-Security-Policy: sandbox`: an HTML report still renders and
// runs its own scripts, but in an opaque origin that cannot read the
// dashboard's storage or call its API as the dashboard.
//
// Exposure is the dashboard's: the same listener, behind the same Host check
// (lib/remote.js), and unauthenticated like the dashboard's other read routes.

import { createReadStream } from 'node:fs';
import { realpath, stat, lstat, readdir } from 'node:fs/promises';
import { join, sep, extname, basename, dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';

export const ARTIFACTS_PREFIX = '/artifacts';

// A run folder is <run_id>-<run_attempt>.
export const RUN_DIR = /^(\d+)-(\d+)$/;

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.ndjson': 'text/plain; charset=utf-8', '.diff': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
};
// Opened in the browser. Everything else downloads.
const INLINE = new Set([...IMAGE, '.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.log', '.md', '.csv',
  '.xml', '.yml', '.yaml', '.ndjson', '.diff', '.mp4', '.webm', '.mov', '.pdf']);
// Folders the toolchains write as bundles; listed with a zip link first.
const BUNDLE = new Set(['.xcresult', '.xcarchive', '.app', '.dSYM', '.trace']);

// The most images one page lays out; the rest stay in the file list.
const GRID_MAX = 400;

const FILE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': 'sandbox allow-scripts allow-popups allow-downloads',
  'cache-control': 'no-cache',
};
const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// The request path below /artifacts/ as safe segments, or null when any
// segment could step outside the root or hide in it.
export function splitArtifactPath(pathname, prefix = ARTIFACTS_PREFIX) {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const segments = [];
  for (const raw of pathname.slice(prefix.length).split('/')) {
    if (raw === '') continue;
    let seg;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    if (seg.startsWith('.') || /[/\\\0]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments;
}

// The real path of root/segments, or null when it does not exist or resolves
// outside the root (a symlink pointing elsewhere).
export async function resolveUnder(root, segments) {
  let realRoot;
  try { realRoot = await realpath(root); } catch { return null; }
  let real;
  try { real = await realpath(join(realRoot, ...segments)); } catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  return { real, realRoot };
}

// ----------------------------------------------------------------- sizes

// du is far quicker than walking a screenshot folder file by file in
// JavaScript, and its answer is the disk actually used. Cached briefly: an
// index page asks for every repository's size.
const SIZE_TTL_MS = 5 * 60 * 1000;
const sizeCache = new Map();

export function clearSizeCache() { sizeCache.clear(); }

function du(path) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', path], { timeout: 20000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const kb = Number(String(stdout ?? '').split(/\s/)[0]);
      resolve(!err && Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

export async function dirSize(path, now = Date.now()) {
  const hit = sizeCache.get(path);
  if (hit && now - hit.at < SIZE_TTL_MS) return hit.bytes;
  const bytes = await du(path);
  if (sizeCache.size > 5000) sizeCache.clear();
  sizeCache.set(path, { at: now, bytes });
  return bytes;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// One directory's entries with their stat, dot files left out, newest first.
export async function listEntries(dir, { sizes = false } = {}) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const entries = await mapLimit(names.filter((n) => !n.startsWith('.')), 8, async (name) => {
    const p = join(dir, name);
    let st;
    try { st = await stat(p); } catch {
      try { st = await lstat(p); } catch { return null; }
    }
    const isDir = st.isDirectory();
    return {
      name,
      isDir,
      mtimeMs: st.mtimeMs,
      bytes: isDir ? (sizes ? await dirSize(p) : null) : st.size,
    };
  });
  return entries.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

// ----------------------------------------------------------------- pages

const STYLE = `
:root { --bg:#f6f7f9; --fg:#1b2230; --muted:#6b7585; --line:#dfe3ea; --card:#fff; --link:#2357c6; --warn:#a15c00; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f131a; --fg:#e4e8ef; --muted:#8a94a6; --line:#273041; --card:#161c26; --link:#7aa7ff; --warn:#f0a83a; } }
* { box-sizing: border-box; }
body { margin:0; padding:20px 16px 40px; background:var(--bg); color:var(--fg);
  font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width:1200px; margin:0 auto; }
a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { font-size:20px; margin:4px 0 2px; word-break:break-all; }
.crumbs { color:var(--muted); font-size:13px; word-break:break-all; }
.meta { color:var(--muted); font-size:13px; margin:2px 0 16px; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); font-weight:600; }
td.num, th.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
td.name { word-break:break-all; }
tr:last-child td { border-bottom:0; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:10px; margin:0 0 20px; }
figure { margin:0; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px; }
figure img { display:block; width:100%; height:auto; max-height:420px; object-fit:contain; background:var(--bg); border-radius:4px; }
figcaption { font-size:11px; color:var(--muted); margin-top:4px; word-break:break-all; }
.open { display:inline-block; margin:0 0 14px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); }
.note { color:var(--muted); font-size:12px; margin-top:14px; }
.tag { font-size:11px; color:var(--muted); margin-left:6px; }
h2 { font-size:15px; margin:18px 0 8px; }
`;

function page(title, crumbs, body) {
  const nav = crumbs.map((c, i) => (i === crumbs.length - 1
    ? `<span>${escapeHtml(c.label)}</span>`
    : `<a href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`)).join(' / ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><div class="crumbs"><a href="/">fleet</a> / ${nav}</div>${body}</main></body></html>`;
}

const enc = (s) => encodeURIComponent(s);

function crumbsFor(segments) {
  const crumbs = [{ label: 'artifacts', href: `${ARTIFACTS_PREFIX}/` }];
  let href = `${ARTIFACTS_PREFIX}/`;
  for (const s of segments) {
    href += `${enc(s)}/`;
    crumbs.push({ label: s, href });
  }
  return crumbs;
}

const RETENTION_NOTE = '<p class="note">Kept on the runner host for one day, then pruned by the runner hooks. '
  + 'Read-only: nothing on this page writes or deletes.</p>';

export async function renderRootIndex(realRoot, { now = Date.now(), rootLabel = '~/ci-artifacts' } = {}) {
  const repos = (await listEntries(realRoot)).filter((e) => e.isDir);
  const rows = await mapLimit(repos, 4, async (r) => {
    const runs = (await listEntries(join(realRoot, r.name))).filter((e) => e.isDir);
    return { ...r, runs: runs.length, newest: runs[0]?.mtimeMs ?? r.mtimeMs, bytes: await dirSize(join(realRoot, r.name), now) };
  });
  rows.sort((a, b) => b.newest - a.newest || a.name.localeCompare(b.name));
  const total = rows.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const body = rows.length
    ? `<table><thead><tr><th>Repository</th><th class="num">Runs</th><th class="num">Size</th><th class="num">Newest</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td class="name"><a href="${enc(r.name)}/">${escapeHtml(r.name)}</a></td>`
        + `<td class="num">${r.runs}</td><td class="num">${formatBytes(r.bytes)}</td>`
        + `<td class="num">${formatAge(now - r.newest)} ago</td></tr>`).join('')
    }</tbody></table>`
    : '<p>No artifacts yet. A self-hosted job writes them to <code>~/ci-artifacts/&lt;repo&gt;/&lt;run_id&gt;-&lt;run_attempt&gt;/</code>.</p>';
  return page('CI artifacts', crumbsFor([]),
    `<h1>CI artifacts</h1><div class="meta">${rows.length} repositories, ${formatBytes(total)} in ${escapeHtml(rootLabel)}</div>${body}${RETENTION_NOTE}`);
}

export async function renderRepoIndex(realRoot, repo, { now = Date.now(), githubRepo = null } = {}) {
  const dir = join(realRoot, repo);
  const entries = await listEntries(dir, { sizes: true });
  const runs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);
  const total = entries.reduce((s, e) => s + (e.bytes ?? 0), 0);
  const runLink = (name) => {
    const m = RUN_DIR.exec(name);
    return m && githubRepo
      ? ` <a class="tag" href="https://github.com/${escapeHtml(githubRepo)}/actions/runs/${m[1]}/attempts/${m[2]}" rel="noreferrer" target="_blank">run log</a>`
      : '';
  };
  const body = runs.length || files.length
    ? `<table><thead><tr><th>Run</th><th class="num">Items</th><th class="num">Size</th><th class="num">Age</th></tr></thead><tbody>${
      (await mapLimit(runs, 8, async (r) => {
        const inside = await listEntries(join(dir, r.name));
        return `<tr><td class="name"><a href="${enc(r.name)}/">${escapeHtml(r.name)}</a>${runLink(r.name)}</td>`
          + `<td class="num">${inside.length}</td><td class="num">${formatBytes(r.bytes)}</td>`
          + `<td class="num">${formatAge(now - r.mtimeMs)} ago</td></tr>`;
      })).join('')
    }${files.map((f) => `<tr><td class="name"><a href="${enc(f.name)}">${escapeHtml(f.name)}</a></td><td class="num">file</td>`
      + `<td class="num">${formatBytes(f.bytes)}</td><td class="num">${formatAge(now - f.mtimeMs)} ago</td></tr>`).join('')
    }</tbody></table>`
    : '<p>No runs kept for this repository.</p>';
  return page(`${repo} artifacts`, crumbsFor([repo]),
    `<h1>${escapeHtml(repo)}</h1><div class="meta">${runs.length} runs, ${formatBytes(total)}, newest first</div>${body}${RETENTION_NOTE}`);
}

export async function renderFolder(realDir, segments, { now = Date.now(), githubRepo = null } = {}) {
  const entries = await listEntries(realDir, { sizes: true });
  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const images = files.filter((f) => IMAGE.has(extname(f.name).toLowerCase()));
  const pages = files.filter((f) => /\.html?$/i.test(f.name));
  const total = entries.reduce((s, e) => s + (e.bytes ?? 0), 0);
  const name = segments[segments.length - 1];

  let head = `<h1>${escapeHtml(name)}</h1><div class="meta">${dirs.length} folders, ${files.length} files, ${formatBytes(total)}`;
  const run = RUN_DIR.exec(segments[1] ?? '');
  if (run && githubRepo) {
    head += ` · <a href="https://github.com/${escapeHtml(githubRepo)}/actions/runs/${run[1]}/attempts/${run[2]}" rel="noreferrer" target="_blank">run ${run[1]} attempt ${run[2]} on GitHub</a>`;
  }
  head += ` · <a href="./?zip=1">download all as zip</a></div>`;

  let body = '';
  const index = pages.find((p) => /^index\.html?$/i.test(p.name));
  for (const p of index ? [index, ...pages.filter((x) => x !== index)] : pages) {
    body += `<a class="open" href="${enc(p.name)}" target="_blank" rel="noreferrer">Open ${escapeHtml(p.name)}</a> `;
  }
  if (images.length) {
    const shown = images.slice(0, GRID_MAX);
    body += `<h2>Images (${images.length}${images.length > shown.length ? `, first ${shown.length} shown` : ''})</h2><div class="grid">${
      shown.map((f) => `<figure><a href="${enc(f.name)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${enc(f.name)}" alt="${escapeHtml(f.name)}"></a>`
        + `<figcaption>${escapeHtml(f.name)}</figcaption></figure>`).join('')
    }</div>`;
  }
  const rows = [
    ...dirs.map((d) => {
      const bundle = BUNDLE.has(extname(d.name));
      const zip = `<a class="tag" href="${enc(d.name)}/?zip=1">zip</a>`;
      return `<tr><td class="name"><a href="${enc(d.name)}/">${escapeHtml(d.name)}/</a>${bundle ? '<span class="tag">bundle</span>' : ''} ${zip}</td>`
        + `<td class="num">${formatBytes(d.bytes)}</td><td class="num">${formatAge(now - d.mtimeMs)} ago</td></tr>`;
    }),
    ...files.map((f) => {
      const ext = extname(f.name).toLowerCase();
      const how = INLINE.has(ext) ? ' target="_blank" rel="noreferrer"' : ' download';
      return `<tr><td class="name"><a href="${enc(f.name)}"${how}>${escapeHtml(f.name)}</a></td>`
        + `<td class="num">${formatBytes(f.bytes)}</td><td class="num">${formatAge(now - f.mtimeMs)} ago</td></tr>`;
    }),
  ];
  body += rows.length
    ? `<h2>Contents</h2><table><thead><tr><th>Name</th><th class="num">Size</th><th class="num">Age</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<p>This folder is empty.</p>';
  return page(`${segments.join('/')} artifacts`, crumbsFor(segments), head + body + RETENTION_NOTE);
}

// ----------------------------------------------------------------- files

// A single "bytes=a-b" range, the only kind a video element asks for.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

function contentDisposition(name, attachment) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${enc(name)}`;
}

function serveFile(req, res, real, size) {
  const ext = extname(real).toLowerCase();
  const name = basename(real);
  const inline = INLINE.has(ext);
  const headers = {
    ...FILE_HEADERS,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-disposition': contentDisposition(name, !inline),
    'accept-ranges': 'bytes',
  };
  let range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (range?.invalid) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    range = { start: 0, end: Math.max(0, size - 1) };
  }
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = createReadStream(real, { start: range.start, end: range.end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Every folder and regular file under dir, as paths relative to its parent,
// found with lstat: a symlink is neither, so it is never listed and never
// followed. (zip -y would store links instead, but macOS's zip 3.0 refuses
// to write one to a pipe.)
export async function* zipEntries(dir) {
  const top = basename(dir);
  const stack = [[dir, top]];
  while (stack.length) {
    const [abs, rel] = stack.pop();
    yield `${rel}/`;
    let names;
    try { names = await readdir(abs); } catch { continue; }
    for (const n of names.sort()) {
      if (/[\n\r]/.test(n)) continue;
      let st;
      try { st = await lstat(join(abs, n)); } catch { continue; }
      if (st.isDirectory()) stack.push([join(abs, n), `${rel}/${n}`]);
      else if (st.isFile()) yield `${rel}/${n}`;
    }
  }
}

// A folder as a zip, built as it streams from the list above.
function serveZip(req, res, real) {
  const name = basename(real);
  const headers = { ...FILE_HEADERS, 'content-type': 'application/zip', 'content-disposition': contentDisposition(`${name}.zip`, true) };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  const child = spawn('zip', ['-q', '-', '-@'], { cwd: dirname(real), stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  (async () => {
    for await (const entry of zipEntries(real)) {
      if (child.exitCode != null || child.killed) return;
      if (!child.stdin.write(`${entry}\n`)) await new Promise((r) => child.stdin.once('drain', r));
    }
    child.stdin.end();
  })().catch(() => child.stdin.destroy());
  // The status waits for zip's first bytes, so a missing zip or an unreadable
  // folder is a 500 rather than a broken download.
  let started = false;
  let failed = false;
  const fail = (why) => {
    if (failed) return;
    failed = true;
    if (started) return res.destroy();
    res.writeHead(500, { ...PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end(`could not build the zip: ${why}`);
  };
  child.on('error', (err) => fail(err.message));
  child.stdout.once('data', (chunk) => {
    if (failed) return;
    started = true;
    res.writeHead(200, headers);
    res.write(chunk);
    child.stdout.pipe(res);
  });
  child.on('close', (code) => {
    if (code !== 0) fail(`zip exited ${code}`);
    else if (!started) fail('zip wrote nothing');
  });
  res.on('close', () => { if (child.exitCode == null) child.kill('SIGTERM'); });
}

// ----------------------------------------------------------------- entry

function sendPage(req, res, status, html) {
  res.writeHead(status, PAGE_HEADERS);
  res.end(req.method === 'HEAD' ? undefined : html);
}

function notFound(req, res, why = 'not found') {
  res.writeHead(404, { ...PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : why);
}

// Serves one /artifacts request. `githubRepo(name)` turns a folder name into
// owner/repo for the run-log link, or null when the fleet does not know it.
export async function handleArtifacts(req, res, url, { root, githubRepo = () => null, rootLabel, now = Date.now() } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...PAGE_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    return res.end('read only');
  }
  if (url.pathname === ARTIFACTS_PREFIX) {
    res.writeHead(301, { ...PAGE_HEADERS, location: `${ARTIFACTS_PREFIX}/` });
    return res.end();
  }
  const segments = splitArtifactPath(url.pathname);
  if (!segments) return notFound(req, res, 'bad path');

  const resolved = await resolveUnder(root, segments);
  if (!resolved) {
    if (!segments.length) {
      return sendPage(req, res, 200, page('CI artifacts', crumbsFor([]),
        `<h1>CI artifacts</h1><p>Nothing here yet: ${escapeHtml(rootLabel ?? root)} does not exist on this host.</p>`));
    }
    return notFound(req, res);
  }
  const { real, realRoot } = resolved;
  let st;
  try { st = await stat(real); } catch { return notFound(req, res); }

  if (st.isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { ...PAGE_HEADERS, location: `${url.pathname}/${url.search}` });
      return res.end();
    }
    // A whole repository's folder is too much for one download; a run or
    // anything inside one is fine.
    if (url.searchParams.get('zip') === '1' && segments.length >= 2) return serveZip(req, res, real);
    const repo = segments[0];
    const opts = { now, githubRepo: repo ? githubRepo(repo) : null, rootLabel: rootLabel ?? root };
    if (segments.length === 0) return sendPage(req, res, 200, await renderRootIndex(realRoot, opts));
    if (segments.length === 1) return sendPage(req, res, 200, await renderRepoIndex(realRoot, repo, opts));
    return sendPage(req, res, 200, await renderFolder(real, segments, opts));
  }
  if (!st.isFile()) return notFound(req, res);
  return serveFile(req, res, real, st.size);
}
