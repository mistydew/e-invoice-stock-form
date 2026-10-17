const CACHE='invoice-stock-web-v5-0-1';
const SCOPE=new URL('./',self.location.href);
const ASSETS=['./','index.html','css/style.css','js/app.js','js/utils.js','js/invoice-parser.js','js/file-reader.js','js/excel-output.js','js/image-ocr.js','js/ocr-invoice-parser.js','js/rapid-ocr.js','js/browser-ocr.js','js/ocr-worker.js','js/ocr-math.js','js/import-queue.js','js/rmb.js','js/sample-data.js','lib/exceljs.min.js','lib/jszip.min.js','lib/pdf.min.js','lib/pdf.worker.min.js','icons/icon.svg','manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(p=>new URL(p,SCOPE).href))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('invoice-stock-') && key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET' || url.origin!==SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname))return;
  const path=url.pathname.slice(SCOPE.pathname.length);
  const assets=/^(models\/|lib\/(onnx|opencv|ocr|pdf)\/)/.test(path);
  const network=async()=>{
    const response=await fetch(event.request);
    if(response.ok){const cache=await caches.open(CACHE);try{await cache.put(event.request,response.clone());}catch{/* Storage quota must not block recognition. */}}
    return response;
  };
  // Only GET static assets are cached. Invoice pixels exist only in memory.
  event.respondWith(assets ? caches.match(event.request).then(hit=>hit || network()) : network().catch(()=>caches.match(event.request)));
});
