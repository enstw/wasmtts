// ORT／lamejs 以 packName 供檔,清單由 vendor-mobile 產生。
importScripts('/mobile-host/vendor/runtime-manifest.js');

const CACHE = 'wasmtts-mobile-stream-v10';
const SHELL = [
  ...self.WASMTTS_RUNTIME_FILES,
  '/mobile-host/',
  '/mobile-host/index.html',
  '/mobile-host/stream-test.html',
  '/mobile-host/matcha-stream-test.html',
  '/mobile-host/frequency-ab-score.html',
  '/mobile-host/frequency-ab-score.css',
  '/mobile-host/frequency-ab-score.mjs',
  '/mobile-host/stream-test.css',
  '/mobile-host/stream-test.mjs',
  '/mobile-host/matcha-stream-test.mjs',
  '/mobile-host/manifest.webmanifest',
  '/mobile-host/assets/huayan-medium-segment.mp3',
  '/mobile-host/vendor/runtime-manifest.js',
  '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.js',
  '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.wasm',
  '/platform/matcha-frontend.js',
  '/platform/matcha-taiwan-profile.js',
  '/platform/kaldifst-normalizer.js',
  '/platform/matcha-synthesis.js',
  '/platform/matcha-engine.js',
  '/platform/matcha-worker.js',
  '/platform/matcha-producer.mjs',
  '/platform/continuous-stream-player.mjs',
];

const SHARED_PATHS = new Set([
  '/platform/matcha-frontend.js',
  '/platform/matcha-taiwan-profile.js',
  '/platform/kaldifst-normalizer.js',
  '/platform/matcha-synthesis.js',
  '/platform/matcha-engine.js',
  '/platform/matcha-worker.js',
  '/platform/matcha-producer.mjs',
  '/platform/continuous-stream-player.mjs',
]);

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
  const cacheable = url.pathname.startsWith('/mobile-host/') || SHARED_PATHS.has(url.pathname);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !cacheable) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        return caches.match(event.request);
      }
    })(),
  );
});
