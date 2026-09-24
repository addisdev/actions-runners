// Service worker for the fleet dashboard.
//
// Strategy:
//   App shell (HTML, CSS, JS, assets) — network-first, cached copy when the
//     network fails or is slow. Cache-first would pin phones to the old UI
//     after every dashboard upgrade until someone remembered to bump a version.
//   /api/state — network-first, cached copy offline, so a launch with no
//     connection still shows the last snapshot (labelled stale by the page).
//   Everything else (SSE, POST, other API) — network only, never cached.
//
// The service worker is registered only when isSecureContext is true (localhost
// or HTTPS). Plain LAN HTTP will not get a service worker; the docs say so.

const CACHE_SHELL = 'fleet-shell-v2';
const CACHE_STATE = 'fleet-state-v1';
// How long a shell request waits for the network before falling back to the
// cached copy. Tailscale or hotel Wi-Fi can hang rather than fail.
const NETWORK_TIMEOUT_MS = 4000;

const SHELL_URLS = [
  '/',
  '/style.css',
  '/app.js',
  '/tip.js',
  '/charts.js',
  '/control.js',
  '/alerts.js',
  '/capacity.js',
  '/hosts.js',
  '/lint.js',
  '/analytics.js',
  '/vendor/qrcodegen.js',
  '/site.webmanifest',
  '/assets/favicon.svg',
  '/assets/fleet-mark.svg',
  '/assets/app-icon.svg',
  '/assets/empty-fleet.svg',
  '/assets/empty-runs.svg',
  '/assets/theme-moon.svg',
  '/assets/theme-sun.svg',
  '/assets/icon-192.png',
  '/assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // Per file, not addAll: one missing asset must not abort the whole install
  // and leave the dashboard with no offline shell at all.
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_SHELL && k !== CACHE_STATE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function networkFirst(request, cacheName, cacheKey, timeoutMs) {
  const network = fetch(request).then((res) => {
    if (res.ok) {
      const clone = res.clone();
      caches.open(cacheName).then((c) => c.put(cacheKey, clone)).catch(() => {});
    }
    return res;
  });
  try {
    return await (timeoutMs ? withTimeout(network, timeoutMs) : network);
  } catch {
    const cached = await caches.match(cacheKey, { ignoreSearch: true });
    if (cached) return cached;
    return network; // no cached copy: wait for the network after all
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api/stream') return;

  if (url.pathname === '/api/state') {
    event.respondWith(networkFirst(request, CACHE_STATE, '/api/state', 0));
    return;
  }

  if (url.pathname.startsWith('/api/') || url.pathname === '/metrics') return;

  // Every navigation is the one-page shell; the hash picks the tab.
  const key = request.mode === 'navigate' ? '/' : url.pathname;
  event.respondWith(networkFirst(request, CACHE_SHELL, key, NETWORK_TIMEOUT_MS));
});
