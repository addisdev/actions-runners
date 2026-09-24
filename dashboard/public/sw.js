// Service worker for the fleet dashboard.
//
// Strategy:
//   App shell (HTML, CSS, JS, assets) — cache-first. Updated on each SW activation.
//   /api/state — network-first, fallback to cached. Shows "Last seen HH:MM" offline.
//   Everything else (SSE, POST, other API) — network only, never cached.
//
// The service worker is registered only when isSecureContext is true (localhost
// or HTTPS). Plain LAN HTTP will not get a service worker; the docs say so.

const CACHE_SHELL = 'fleet-shell-v1';
const CACHE_STATE = 'fleet-state-v1';

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
  event.waitUntil(
    caches.open(CACHE_SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept: SSE stream, POST requests, non-GET
  if (request.method !== 'GET') return;
  if (url.pathname === '/api/stream') return;

  // /api/state — network-first with offline fallback
  if (url.pathname === '/api/state') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_STATE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Other API routes — network only
  if (url.pathname.startsWith('/api/')) return;

  // App shell — cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_SHELL).then((c) => c.put(request, clone));
        }
        return res;
      });
    })
  );
});
