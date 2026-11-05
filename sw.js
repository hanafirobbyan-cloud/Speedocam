// SpeedoCam service worker: offline app shell.
// VERSION is replaced with the commit SHA by the GitHub Pages workflow, so every deploy
// installs a fresh cache and the app shows an "Update" banner.

const VERSION = 'dev';
const CACHE = `speedocam-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/camera.js',
  './js/compositor.js',
  './js/exporters.js',
  './js/format.js',
  './js/gps.js',
  './js/overlay.js',
  './js/platform.js',
  './js/recorder.js',
  './js/settings.js',
  './js/storage.js',
  './js/trip.js',
  './js/units.js',
  './js/wakelock.js',
  './js/ui/dashboard.js',
  './js/ui/diagnostics.js',
  './js/ui/dom.js',
  './js/ui/library.js',
  './js/ui/settings-view.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// On localhost always prefer the network so development edits show up immediately.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
  // In production do not skipWaiting automatically: the page asks first, so a recording is never interrupted.
  if (DEV) self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('speedocam-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/tests/')) return; // test pages are never cached

  if (DEV) {
    event.respondWith(fetch(req.url, { cache: 'no-cache' }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  // Navigations: serve the cached shell (works offline, e.g. on a ride without signal).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      return cached || fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  })());
});
