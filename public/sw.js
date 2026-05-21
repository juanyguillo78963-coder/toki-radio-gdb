const CACHE = 'gdb-radio-kandu-ui-operadores-v3-20260521';
const ASSETS = ['/', '/s/gases-belen', '/style.css?v=ui-operadores-20260521', '/app.js?v=ui-operadores-20260521', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).catch(() => null));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.url.includes('/socket.io/')) return;
  event.respondWith(fetch(req).catch(() => caches.match(req, {ignoreSearch:true}).then(r => r || caches.match('/s/gases-belen'))));
});
