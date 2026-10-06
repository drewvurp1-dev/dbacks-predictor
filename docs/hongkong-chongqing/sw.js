const CACHE_NAME = 'hk-trip-v44';
const ASSETS = [
  './',
  './index.html',
  './day-1.html',
  './day-2.html',
  './day-3.html',
  './day-4.html',
  './day-5.html',
  './day-6.html',
  './day-7.html',
  './day-8.html',
  './day-9.html',
  './day-10.html',
  './day-11.html',
  './calendar.html',
  './full-guide.html',
  './assets/shell.css?v=29',
  './assets/scrolly.css?v=29',
  './assets/day-art.css?v=29',
  './assets/shell.js?v=29',
  './assets/leaflet/leaflet.css?v=1',
  './assets/leaflet/leaflet.js?v=1',
  './assets/daymap.css?v=12',
  './assets/daymap.js?v=12',
  './assets/Textile.ttf',
  './assets/Yabatzoe.otf',
  './assets/Neon.ttf',
  './assets/HongKong.jpeg',
  './assets/HongKong-thumb.jpg',
  './assets/MacaoPaint.jpeg',
  './assets/GuilinPaint.jpeg',
  './assets/app-icon-192.png',
  './assets/app-icon-512.png',
  './assets/app-icon-1024.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(() => {
        console.log('Some assets failed to cache; offline may be partial');
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(() => {
        return caches.match(event.request) || new Response('Offline');
      });
    })
  );
});
