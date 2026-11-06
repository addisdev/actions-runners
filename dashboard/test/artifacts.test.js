// The CI artifact viewer (lib/artifacts.js): the pure helpers, and the route
// end to end against a throwaway ~/ci-artifacts served by a plain http server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleArtifacts, splitArtifactPath, resolveUnder, parseRange, formatBytes, formatAge, escapeHtml, clearSizeCache,
} from '../lib/artifacts.js';

describe('helpers', () => {
  test('a path splits into decoded segments below /artifacts', () => {
    assert.deepEqual(splitArtifactPath('/artifacts/'), []);
    assert.deepEqual(splitArtifactPath('/artifacts'), []);
    assert.deepEqual(splitArtifactPath('/artifacts/homelake/123-1/agent%20shots/a.png'), ['homelake', '123-1', 'agent shots', 'a.png']);
    assert.equal(splitArtifactPath('/api/state'), null);
    assert.equal(splitArtifactPath('/artifactsx/a'), null);
  });

  test('dot segments, encoded separators and bad escapes are refused', () => {
    for (const p of ['/artifacts/../x', '/artifacts/a/%2e%2e/b', '/artifacts/a/..%2fb', '/artifacts/a%2fb',
      '/artifacts/a%5cb', '/artifacts/.ssh/id', '/artifacts/a/%00', '/artifacts/a/%zz']) {
      assert.equal(splitArtifactPath(p), null, p);
    }
  });

  test('ranges', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
    assert.deepEqual(parseRange('bytes=200-', 100), { invalid: true });
    assert.equal(parseRange('bytes=0-1,4-5', 100), null);
  });

  test('sizes, ages and escaping read as a person writes them', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
    assert.equal(formatAge(30_000), '30s');
    assert.equal(formatAge(3 * 3600_000), '3h');
    assert.equal(formatAge(3 * 86400_000), '3d');
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('/artifacts', () => {
  let base;
  let root;
  let server;
  let origin;

  before(async () => {
    base = mkdtempSync(join(tmpdir(), 'artifacts-test-'));
    root = join(base, 'ci-artifacts');
    const run = join(root, 'homelake', '41818023625-1');
    mkdirSync(join(run, 'agent-shots-ios'), { recursive: true });
    mkdirSync(join(run, 'TestResults.xcresult', 'Data'), { recursive: true });
    mkdirSync(join(run, 'playwright-report'), { recursive: true });
    writeFileSync(join(run, 'agent-shots-ios', 'today.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    writeFileSync(join(run, 'agent-shots-ios', 'day <b>.png'), 'png');
    writeFileSync(join(run, 'TestResults.xcresult', 'Info.plist'), '<plist/>');
    writeFileSync(join(run, 'TestResults.xcresult', 'Data', 'data.0'), 'x'.repeat(4096));
    writeFileSync(join(run, 'playwright-report', 'index.html'), '<script>localStorage.token</script><h1>report</h1>');
    writeFileSync(join(run, 'build.log'), 'line 1\nline 2\n');
    writeFileSync(join(run, 'app-debug.apk'), 'apk');
    writeFileSync(join(run, '.hidden'), 'secret');
    const older = join(root, 'homelake', '41700000000-2');
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, 'a.txt'), 'a');
    const t = (Date.now() - 6 * 3600_000) / 1000;
    utimesSync(older, t, t);
    mkdirSync(join(root, 'jerv'), { recursive: true });
    // Outside the root: a secret, and links a job could leave pointing at it.
    writeFileSync(join(base, 'outside.txt'), 'outside');
    symlinkSync(join(base, 'outside.txt'), join(run, 'escape.txt'));
    symlinkSync(base, join(run, 'escape-dir'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      handleArtifacts(req, res, url, {
        root,
        rootLabel: '~/ci-artifacts',
        githubRepo: (name) => (name === 'homelake' ? 'addisdev/homelake' : null),
      }).catch((err) => { res.writeHead(500); res.end(err.message); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.close();
    rmSync(base, { recursive: true, force: true });
    clearSizeCache();
  });

  const get = (path, init) => fetch(`${origin}${path}`, { redirect: 'manual', ...init });

  test('the index lists every repository with its runs and size', async () => {
    const r = await get('/artifacts/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /href="homelake\/">homelake</);
    assert.match(html, /href="jerv\/">jerv</);
    assert.match(html, /2 repositories/);
    assert.match(html, /<td class="num">2<\/td>/, 'homelake has two runs');
  });

  test('/artifacts without the slash redirects', async () => {
    const r = await get('/artifacts');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/artifacts/');
  });

  test('a repository lists its runs newest first, linked to the run log', async () => {
    const html = await (await get('/artifacts/homelake/')).text();
    const newer = html.indexOf('41818023625-1/');
    const older = html.indexOf('41700000000-2/');
    assert.ok(newer > 0 && older > newer, 'newest first');
    assert.match(html, /github\.com\/addisdev\/homelake\/actions\/runs\/41818023625\/attempts\/1/);
  });

  test('a run shows images as a grid, the report as a page, the rest as downloads', async () => {
    const r = await get('/artifacts/homelake/41818023625-1/agent-shots-ios/');
    const html = await r.text();
    assert.match(html, /<img loading="lazy" src="today\.png"/);
    assert.match(html, /src="day%20%3Cb%3E\.png" alt="day &lt;b&gt;\.png"/, 'names are escaped');
    const run = await (await get('/artifacts/homelake/41818023625-1/')).text();
    assert.match(run, /href="TestResults\.xcresult\/\?zip=1">zip</);
    assert.match(run, /href="app-debug\.apk" download/);
    assert.match(run, /href="build\.log" target="_blank"/);
    assert.match(run, /run 41818023625 attempt 1 on GitHub/);
    assert.doesNotMatch(run, /\.hidden/);
    const report = await (await get('/artifacts/homelake/41818023625-1/playwright-report/')).text();
    assert.match(report, /Open index\.html/);
  });

  test('a folder without the slash redirects so its relative links work', async () => {
    const r = await get('/artifacts/homelake/41818023625-1');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/artifacts/homelake/41818023625-1/');
  });

  test('files are served with their type, sandboxed', async () => {
    const png = await get('/artifacts/homelake/41818023625-1/agent-shots-ios/today.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(Number(png.headers.get('content-length')), 8);
    const page = await get('/artifacts/homelake/41818023625-1/playwright-report/index.html');
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /allow-same-origin/);
    const log = await get('/artifacts/homelake/41818023625-1/build.log');
    assert.match(log.headers.get('content-type'), /text\/plain/);
    assert.equal(await log.text(), 'line 1\nline 2\n');
    const apk = await get('/artifacts/homelake/41818023625-1/app-debug.apk');
    assert.match(apk.headers.get('content-disposition'), /^attachment; filename="app-debug\.apk"/);
  });

  test('a range is answered with 206', async () => {
    const r = await get('/artifacts/homelake/41818023625-1/build.log', { headers: { range: 'bytes=0-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 0-5/14');
    assert.equal(await r.text(), 'line 1');
  });

  test('a bundle downloads as a zip built on the fly', async (t) => {
    try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { return t.skip('zip is not installed'); }
    const r = await get('/artifacts/homelake/41818023625-1/TestResults.xcresult/?zip=1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.match(r.headers.get('content-disposition'), /TestResults\.xcresult\.zip/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.subarray(0, 2).toString(), 'PK');
    const out = join(base, 'unzipped');
    mkdirSync(out);
    writeFileSync(join(out, 'x.zip'), body);
    execFileSync('unzip', ['-q', 'x.zip'], { cwd: out });
    assert.equal(statSync(join(out, 'TestResults.xcresult', 'Data', 'data.0')).size, 4096);
  });

  test('a whole repository is not offered as one zip', async () => {
    const r = await get('/artifacts/homelake/?zip=1');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  });

  test('nothing outside the root is reachable, by .. or by a symlink', async () => {
    for (const p of ['/artifacts/../outside.txt', '/artifacts/%2e%2e/outside.txt', '/artifacts/homelake/..%2f..%2foutside.txt',
      '/artifacts/homelake/41818023625-1/escape.txt', '/artifacts/homelake/41818023625-1/escape-dir/outside.txt',
      '/artifacts/homelake/41818023625-1/escape-dir/', '/artifacts/homelake/41818023625-1/.hidden']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(await r.text(), /outside|secret/, p);
    }
  });

  test('a zipped run leaves out symlinks instead of following them', async (t) => {
    try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { return t.skip('zip is not installed'); }
    const r = await get('/artifacts/homelake/41818023625-1/?zip=1');
    assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.includes(Buffer.from('outside')), false, 'nothing from outside the root');
    const out = join(base, 'unzipped-run');
    mkdirSync(out);
    writeFileSync(join(out, 'x.zip'), body);
    const listing = execFileSync('unzip', ['-l', 'x.zip'], { cwd: out }).toString();
    assert.match(listing, /41818023625-1\/agent-shots-ios\/today\.png/);
    assert.match(listing, /41818023625-1\/TestResults\.xcresult\/Data\/data\.0/);
    assert.doesNotMatch(listing, /escape/);
  });

  test('it is read only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await get('/artifacts/homelake/41818023625-1/build.log', { method });
      assert.equal(r.status, 405, method);
    }
    assert.ok(readdirSync(join(root, 'homelake')).length === 2);
  });

  test('a missing root is an empty index, not an error', async () => {
    const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b ?? ''; } };
    await handleArtifacts({ method: 'GET', headers: {} }, res, new URL('http://x/artifacts/'), { root: join(base, 'nope') });
    assert.equal(res.status, 200);
    assert.match(res.body, /Nothing here yet/);
  });

  test('resolveUnder refuses a path that resolves outside the root', async () => {
    assert.equal(await resolveUnder(root, ['homelake', '41818023625-1', 'escape.txt']), null);
    assert.ok(await resolveUnder(root, ['homelake']));
  });
});
