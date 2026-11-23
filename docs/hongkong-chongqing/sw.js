const CACHE_NAME = 'hk-trip-v59';
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
  './assets/scrolly.css?v=31',
  './assets/day-art.css?v=33',
  './assets/shell.js?v=29',
  './assets/leaflet/leaflet.css?v=1',
  './assets/leaflet/leaflet.js?v=1',
  './assets/daymap.css?v=12',
  './assets/daymap.js?v=13',
  './assets/Textile.ttf',
  './assets/Yabatzoe.otf',
  './assets/Neon.ttf',
  './assets/MaShanZheng.woff',
  './assets/MaShanZheng.ttf',
  './assets/Codystar.woff2',
  './assets/Codystar.woff',
  './assets/HongKong.jpeg',
  './assets/HongKong-thumb.jpg',
  './assets/MacaoPaint.jpeg',
  './assets/GuilinPaint.jpeg',
  './assets/OldTownPaint.jpeg',
  './assets/OldTownPaint-thumb.jpg',
  './assets/CyberpunkCity.jpeg',
  './assets/CyberpunkCity-thumb.jpg',
  './assets/ChongqingNight.jpeg',
  './assets/ChongqingNight-thumb.jpg',
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
  const req = event.request;
  // Only GETs are cached. POSTs (e.g. the live metro-line lookups) go straight to the network.
  if (!req.url.startsWith('http') || req.method !== 'GET') return;

  // Pages: network first, so a new version shows up on the very next load instead of the
  // old saved copy. If the network is slow (>3s, e.g. bad hotel Wi-Fi) or offline, fall back
  // to the saved copy; the fetch keeps going in the background and refreshes the saved copy.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type !== 'error') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
      if (!cached) return net.catch(() => new Response('Offline', { status: 503 }));
      try {
        return await Promise.race([
          net,
          new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000)),
        ]);
      } catch (e) {
        return cached;
      }
    })());
    return;
  }

  // Everything else (CSS/JS carry ?v=N, images and fonts have fixed names): saved copy first.
  event.respondWith(
    caches.match(req).then((response) => {
      if (response) return response;
      return fetch(req).then((res) => {
        if (!res || res.status !== 200 || res.type === 'error') return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});
