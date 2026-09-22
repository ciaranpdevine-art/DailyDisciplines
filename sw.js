const CACHE_NAME = 'daily-disciplines-v13';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .catch(function () { /* ignore individual failures, e.g. offline first install */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var isPage = event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    event.request.url.indexOf('index.html') !== -1;

  if (isPage) {
    // Network-first for the app itself: always try to get the latest version.
    // Only fall back to whatever's cached if there's no connection at all.
    event.respondWith(
      fetch(event.request).then(function (networkRes) {
        var clone = networkRes.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
        return networkRes;
      }).catch(function () {
        return caches.match(event.request).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Cache-first for static assets (icons, manifest, fonts) — these change
  // rarely, so it's fine if they lag a version behind.
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (networkRes) {
        if (event.request.url.indexOf(self.location.origin) === 0) {
          var clone = networkRes.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
        }
        return networkRes;
      });
    })
  );
});
