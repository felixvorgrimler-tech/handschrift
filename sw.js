// Offline-Cache: App-Dateien und Modell einmal laden, danach ohne Internet nutzbar.
const CACHE = 'handschrift-v13';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'engine.js', 'ink.js', 'kern.wasm', 'ocr.js', 'notewise.js', 'icon.svg', 'manifest.webmanifest',
  'model/meta.json', 'model/weights.bin', 'model/presets.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Eigene Antworten bekommen COOP/COEP-Kopfzeilen: Dann ist die Seite „cross-origin isolated“ und die
// Texterkennung darf mehrere Prozessorkerne nutzen (GitHub Pages kann diese Kopfzeilen nicht selbst setzen).
function isolate(r) {
  if (!r || r.type === 'opaque' || r.type === 'opaqueredirect') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// Netz zuerst (damit Updates ankommen), sonst Cache
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // eigene Dateien immer beim Server nachfragen (no-cache), sonst mischt der Browser-Cache alte und neue Dateien
  const own = new URL(e.request.url).origin === location.origin;
  const req = own ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request);
  e.respondWith(
    req.then((r) => {
      // eigene Dateien und die Texterkennungs-Bibliothek (jsdelivr) für offline merken
      const u = new URL(e.request.url);
      if (r.ok && (u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net')) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return own ? isolate(r) : r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => (own ? isolate(r) : r)))
  );
});
