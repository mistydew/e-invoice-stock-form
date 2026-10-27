// Static model bytes only. An optional review model must not hold an invoice
// indefinitely when its download stalls or fails.
export async function downloadModel(url,onProgress,timeoutMs=60000,options={}) {
  const controller=new AbortController();
  let timer;
  const refresh=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),timeoutMs);};
  refresh();
  try {
    const response=await fetch(url,{...options,signal:controller.signal});
    if(!response.ok)throw new Error('识别模型下载失败，请检查网络后重试');
    const reader=response.body.getReader(),chunks=[];
    const total=Number(response.headers.get('content-length'))||0;
    let received=0,last=0;
    for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
      refresh();
      chunks.push(value);received+=value.length;
      if(Date.now()-last>250){onProgress?.({received,total});last=Date.now();}
    }
    const bytes=new Uint8Array(received);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    onProgress?.({received,total});
    return bytes;
  } catch(error) {
    if(controller.signal.aborted)throw new Error('识别模型下载超时');
    throw error;
  } finally {clearTimeout(timer);}
}

const RESOURCE_CACHE='invoice-stock-resources-ppocr5-ort123';
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}

// Cache complete, verified chunks. A later attempt only downloads the missing
// chunks; the original ONNX bytes and model accuracy remain unchanged.
export async function downloadChunkedModel(manifestUrl,onProgress,legacyUrl) {
  const manifest=JSON.parse(new TextDecoder().decode(await downloadModel(manifestUrl)));
  if(!Array.isArray(manifest.parts) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes<=0 ||
    manifest.parts.reduce((n,p)=>n+p.bytes,0)!==manifest.bytes)throw new Error('识别模型分块清单无效');
  let cache;
  try {cache=await caches.open(RESOURCE_CACHE);}catch{/* Recognition also works without persistent storage. */}
  const notify=received=>onProgress?.({received,total:manifest.bytes});
  if(cache && legacyUrl) {
    const old=await cache.match(legacyUrl);
    if(old) {
      const bytes=new Uint8Array(await old.arrayBuffer());
      if(bytes.length===manifest.bytes && await digest(bytes)===manifest.sha256){notify(bytes.length);return bytes;}
    }
  }
  const chunks=new Array(manifest.parts.length),progress=new Array(chunks.length).fill(0);
  const update=(i,size)=>{progress[i]=size;notify(progress.reduce((a,b)=>a+b,0));};
  let next=0,failure;
  async function runner() {
    while(!failure && next<chunks.length) {
      const i=next++,part=manifest.parts[i],url=new URL(part.path,manifestUrl);
      if(url.origin!==new URL(manifestUrl).origin || !url.pathname.startsWith(new URL('./',manifestUrl).pathname)){
        failure=new Error('识别模型分块路径无效');return;
      }
      try {
        const hit=await cache?.match(url.href);
        if(hit){const bytes=new Uint8Array(await hit.arrayBuffer());if(bytes.length===part.bytes && await digest(bytes)===part.sha256){chunks[i]=bytes;update(i,bytes.length);continue;}}
        for(let attempt=0;attempt<3;attempt++) {
          try {
            const bytes=await downloadModel(url.href,p=>update(i,p.received),60000,{cache:'no-store'});
            if(bytes.length!==part.bytes || await digest(bytes)!==part.sha256)throw new Error('识别模型分块校验失败');
            chunks[i]=bytes;update(i,bytes.length);
            try{await cache?.put(url.href,new Response(bytes));}catch{/* Storage quota does not block this run. */}
            break;
          } catch(error) {
            update(i,0);
            if(attempt===2)throw error;
          }
        }
      } catch(error) {failure=error;}
    }
  }
  await Promise.all(Array.from({length:Math.min(3,chunks.length)},()=>runner()));
  if(failure)throw failure;
  const bytes=new Uint8Array(manifest.bytes);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(await digest(bytes)!==manifest.sha256)throw new Error('识别模型校验失败');
  return bytes;
}
