// Service Worker: macht die App offline-fähig und installierbar.
// Bei Änderungen an der App die Versionsnummer erhöhen.
const CACHE = 'hypna-app-v6';
// Eigene Caches, die Updates überleben (nur bei Änderungen an vendor/ erhöhen)
const VENDOR_CACHE = 'hypna-vendor-v1';
const HF_JSON_CACHE = 'hypna-hf-json';
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
  // Nur eigene, veraltete App-Caches löschen. Das Sprachmodell liegt im Cache
  // der TTS-Bibliothek (pocket-tts-models-*) und darf hier nie gelöscht werden.
  const own = (k) => /^hypna-v\d+$/.test(k) || (k.startsWith('hypna-app-') && k !== CACHE);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(own).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(event, cacheName) {
  event.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Kleine JSON-Dateien des Sprachmodells (Manifest, Stimmen): zuerst Netz, sonst Cache.
  // Die großen .onnx-Dateien speichert die TTS-Bibliothek selbst.
  if (url.hostname === 'huggingface.co' && url.pathname.endsWith('.json')) {
    event.respondWith(
      caches.open(HF_JSON_CACHE).then((cache) =>
        fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cache.match(req).then((hit) => hit || Response.error()))
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/')) return staleWhileRevalidate(event, VENDOR_CACHE);
  staleWhileRevalidate(event, CACHE);
});
