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

const SCOPE_PATH = new URL(self.registration.scope).pathname;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // The leaderboard API (and sign-in redirects) always goes to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // The game page: network first so a new deploy shows up right away, the cached shell when
  // offline. Query strings (?cam=, ?theme=...) all map to the same shell. Other pages
  // (admin.html) are online-only.
  if (request.mode === 'navigate') {
    if (url.pathname !== SCOPE_PATH && url.pathname !== `${SCOPE_PATH}index.html`) return;
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
  // Assets missing from the precache (funny mode's crash clips) are cached on first fetch.
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && url.pathname.includes('/assets/')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
