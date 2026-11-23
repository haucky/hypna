// Service Worker: macht die App offline-fähig und installierbar.
// Bei Änderungen an der App die Versionsnummer erhöhen.
const CACHE = 'hypna-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './audio-core.js',
  './capture-worklet.js',
  './db.js',
  './tts.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
// vendor/ (Pocket TTS, ~15 MB onnxruntime) wird erst beim ersten Vertonen geladen und dann zwischengespeichert

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: sofort aus dem Cache, im Hintergrund aktualisieren
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
