// Offline support. vite.config.ts fills in the precache list (every file of the build) and a
// version derived from it, so each deploy gets a fresh cache and old ones are dropped.

const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const CACHE = `dino3d-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dino3d-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Pages: network first so a new deploy shows up right away, the cached shell when offline.
  // Query strings (?cam=, ?theme=...) all map to the same shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('./', copy));
          }
          return response;
        })
        .catch(() => caches.match('./', { ignoreVary: true })),
    );
    return;
  }

  // Everything else is content-hashed or static: cache first. ignoreVary because servers send
  // `Vary: Origin`, and module scripts are requested with an Origin header the precache lacked.
  event.respondWith(caches.match(request, { ignoreVary: true }).then((hit) => hit ?? fetch(request)));
});
