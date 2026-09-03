// Cache-first app shell. GitHub Pages can't set custom Cache-Control headers, so
// cache-busting on deploy happens here: bump CACHE_VERSION and old caches are dropped on activate.
const CACHE_VERSION = 'v37';
const CACHE_NAME = `calorie-tracker-${CACHE_VERSION}`;

// Paths are relative to this file's own scope so this works unmodified whether the app is
// served from a domain root or a GitHub Pages project subpath (username.github.io/repo/).
const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/db.js',
  'js/logic.js',
  'js/seed.js',
  'js/import-export.js',
  'js/auth.js',
  'js/firebase.js',
  'js/firebase-config.js',
  'js/migrate.js',
  'js/workouts.js',
  'js/pull-refresh.js',
  'vendor/firebase/firebase-app.js',
  'vendor/firebase/firebase-auth.js',
  'vendor/firebase/firebase-firestore.js',
  'fonts/hanken-grotesk.woff2',
  'fonts/space-grotesk.woff2',
  'images/exercises/back-squat.svg',
  'images/exercises/leg-press.svg',
  'images/exercises/bulgarian-split-squat.svg',
  'images/exercises/romanian-deadlift.svg',
  'images/exercises/calf-raises.svg',
  'images/exercises/plank.svg',
  'images/exercises/side-plank.svg',
  'images/exercises/dead-bug.svg',
  'images/exercises/russian-twist.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES.map(f => new URL(f, self.registration.scope))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match(new URL('index.html', self.registration.scope));
        }
        throw new Error('offline and not cached');
      });
    })
  );
});
