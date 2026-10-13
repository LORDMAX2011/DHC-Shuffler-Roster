const CACHE_NAME = 'school-classroom-shuffle-v12';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(APP_SHELL.map(async path => {
    const response = await fetch(path, { cache: 'no-store' });
    if (response.ok) await cache.put(path, response);
  }))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    const update = fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => {
        cache.put(request, response.clone());
        cache.put('/', response.clone());
      });
      return response;
    });
    event.waitUntil(update.then(() => undefined, () => undefined));
    event.respondWith(caches.match('/').then(cached => cached || update.catch(async () => (await caches.match(request)) || (await caches.match('/')))));
    return;
  }
  event.respondWith(fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  }).catch(async () => (await caches.match(request)) || (await caches.match('/'))));
});
