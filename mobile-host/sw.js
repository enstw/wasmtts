const CACHE = 'wasmtts-mobile-stream-v1';
const SHELL = [
  '/mobile-host/',
  '/mobile-host/index.html',
  '/mobile-host/stream-test.html',
  '/mobile-host/stream-test.css',
  '/mobile-host/stream-test.mjs',
  '/mobile-host/continuous-stream-player.mjs',
  '/mobile-host/manifest.webmanifest',
  '/mobile-host/assets/huayan-medium-segment.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('wasmtts-mobile-stream-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/mobile-host/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
