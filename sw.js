// Offline-Cache: App-Dateien und Modell einmal laden, danach ohne Internet nutzbar.
const CACHE = 'handschrift-v7';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'engine.js', 'ink.js', 'ocr.js', 'icon.svg', 'manifest.webmanifest',
  'model/meta.json', 'model/weights.bin', 'model/presets.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Netz zuerst (damit Updates ankommen), sonst Cache
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((r) => {
      // eigene Dateien und die Texterkennungs-Bibliothek (jsdelivr) für offline merken
      const u = new URL(e.request.url);
      if (r.ok && (u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net')) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
