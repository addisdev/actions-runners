// Renders every figure in docs/figures/ to docs/img/ at 2x.
//
// A figure is an HTML file whose root element carries class="figure" and
// declares its own CSS size and its own ground. The rendered PNG is exactly
// that element at twice its CSS size, so a 1280x800 figure becomes a 2560x1600
// image. Fonts are the ones in docs/figures/fonts/, so the output is the same
// on any machine — which an SVG with web fonts on GitHub is not.
//
//   npm run assets                        every figure
//   npm run assets -- --only architecture one figure, by file name
//
// Paths resolve from this file's own location, never from the working
// directory: a script with a hard-coded path into somebody's checkout is a
// script that works until the next machine.

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const FIGURES = path.resolve(import.meta.dirname, "../figures");
const OUT = path.resolve(import.meta.dirname, "../img");

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];
if (onlyAt !== -1 && !only) {
  console.error("--only needs a figure name");
  process.exit(2);
}

const figures = (await readdir(FIGURES))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -".html".length))
  .filter((f) => !only || f === only)
  .sort();

if (figures.length === 0) {
  console.error(only ? `no figure named ${only} in ${FIGURES}` : `no figures in ${FIGURES}`);
  process.exit(1);
}

// The figures are served over HTTP rather than opened as file:// URLs. A
// figure imports its shared shapes from symbols.js as an ES module, and a
// browser refuses a module import from a file:// origin — which showed up as a
// figure rendering with every shared shape silently missing.
//
// It also means `python3 -m http.server` in docs/figures/ shows exactly what
// the renderer sees, which is how you iterate on one without rendering it.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  const file = path.join(FIGURES, rel);
  // A figure cannot read outside its own directory.
  if (!file.startsWith(FIGURES) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failed = 0;

try {
  for (const name of figures) {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
    });

    // A figure that references an image which does not load renders a hole,
    // and a hole is invisible in a diff of binary files. Fail on it instead.
    const missing = [];
    page.on("requestfailed", (r) => missing.push(r.url()));

    await page.goto(`${origin}/${name}.html`, { waitUntil: "load" });

    // @font-face loads asynchronously; a screenshot before this resolves gets
    // the fallback face, which is the whole failure the self-hosted fonts
    // exist to prevent.
    await page.evaluate(() => document.fonts.ready);

    const figure = page.locator(".figure").first();
    if ((await figure.count()) === 0) {
      console.error(`FAIL ${name}: no .figure element`);
      failed++;
      await page.close();
      continue;
    }

    // A figure may declare `data-requires="photo/shelf.jpg"` for an input that
    // does not exist yet. Skip it with a message rather than rendering a hole.
    const needs = await figure.getAttribute("data-requires");
    if (needs && !existsSync(path.join(FIGURES, needs))) {
      console.log(`skip ${name}: needs ${needs}, which does not exist yet`);
      await page.close();
      continue;
    }

    const format = (await figure.getAttribute("data-format")) === "jpeg" ? "jpeg" : "png";
    const file = path.join(OUT, `${name}.${format === "jpeg" ? "jpg" : "png"}`);
    await figure.screenshot(
      format === "jpeg" ? { path: file, type: "jpeg", quality: 82 } : { path: file },
    );

    if (missing.length) {
      console.error(`FAIL ${name}: ${missing.length} resource(s) did not load`);
      for (const u of missing) console.error(`      ${u}`);
      failed++;
      await page.close();
      continue;
    }

    const { size } = await stat(file);
    const box = await figure.boundingBox();
    const over = size > 400 * 1024 ? "  OVER 400 KB - cut padding, not quality" : "";
    console.log(
      `ok   ${path.basename(file)}  ${box.width * 2}x${box.height * 2}  ${(size / 1024).toFixed(0)} KB${over}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);
