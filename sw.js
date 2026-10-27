const CACHE='invoice-stock-web-v5-1-0';
const RESOURCES='invoice-stock-resources-ppocr5-ort123';
const SCOPE=new URL('./',self.location.href);
const ASSETS=['./','index.html','css/style.css','js/app.js','js/utils.js','js/invoice-parser.js','js/invoice-pages.js','js/file-reader.js','js/excel-output.js','js/image-ocr.js','js/ocr-invoice-parser.js','js/rapid-ocr.js','js/browser-ocr.js','js/ocr-worker.js','js/ocr-math.js','js/model-download.js','js/import-queue.js','js/rmb.js','js/sample-data.js','lib/exceljs.min.js','lib/jszip.min.js','lib/pdf.min.js','lib/pdf.worker.min.js','icons/icon.svg','manifest.webmanifest'];
const isResource=url=>url.origin===SCOPE.origin && url.pathname.startsWith(SCOPE.pathname) && /^(models\/|lib\/(onnx|opencv|ocr|pdf)\/)/.test(url.pathname.slice(SCOPE.pathname.length));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(p=>new URL(p,SCOPE).href))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const resources=await caches.open(RESOURCES);
  for(const key of await caches.keys()) {
    if(!key.startsWith('invoice-stock-') || key===CACHE || key===RESOURCES)continue;
    const old=await caches.open(key);
    for(const request of await old.keys())if(isResource(new URL(request.url)) && !await resources.match(request)) {
      try{await resources.put(request,await old.match(request));}catch{/* Re-download if storage is full. */}
    }
    await caches.delete(key);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET' || url.origin!==SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname))return;
  const assets=isResource(url);
  const network=async()=>{
    const response=await fetch(event.request);
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(assets?RESOURCES:CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{}));}
    return response;
  };
  // Only GET static assets are cached. Invoice pixels exist only in memory.
  event.respondWith(assets ? caches.open(RESOURCES).then(cache=>cache.match(event.request)).then(hit=>hit || network()) : network().catch(()=>caches.open(CACHE).then(cache=>cache.match(event.request))));
});
