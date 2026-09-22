// 离线缓存应用外壳（PWA）
const CACHE = 'invoice-stock-v1';
const ASSETS = [
  './', './index.html', './css/style.css', './js/app.js', './js/utils.js',
  './js/invoice-parser.js', './js/file-reader.js', './js/excel-output.js',
  './js/rmb.js', './js/sample-data.js',
  './lib/exceljs.min.js', './lib/jszip.min.js', './lib/pdf.min.js', './lib/pdf.worker.min.js',
  './icons/icon.svg', './manifest.webmanifest',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (new URL(e.request.url).origin === location.origin && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    })),
  );
});
