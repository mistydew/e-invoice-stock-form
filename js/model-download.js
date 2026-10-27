// Static model bytes only. An optional review model must not hold an invoice
// indefinitely when its download stalls or fails.
export async function downloadModel(url,onProgress,timeoutMs=120000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(url,{signal:controller.signal});
    if(!response.ok)throw new Error('识别模型下载失败，请检查网络后重试');
    const reader=response.body.getReader(),chunks=[];
    const total=Number(response.headers.get('content-length'))||0;
    let received=0,last=0;
    for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
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
