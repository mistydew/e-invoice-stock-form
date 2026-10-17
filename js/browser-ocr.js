let worker,serial=0;
const pending=new Map();

function stop(message) {
  worker?.terminate();worker=null;
  for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error(message));}
  pending.clear();
}

export function browserOcrCall(request,onProgress) {
  if(!worker) {
    worker=new Worker(new URL('./ocr-worker.js',import.meta.url));
    worker.onmessage=({data})=>{
      const task=pending.get(data.id);if(!task)return;
      if(data.progress){task.onProgress?.(data.progress);return;}
      clearTimeout(task.timer);pending.delete(data.id);
      if(data.error)task.reject(new Error(data.error));else task.resolve(data.result);
    };
    worker.onerror=()=>stop('浏览器识别引擎加载失败，请刷新后重试（首次需下载模型）');
  }
  const id=++serial;
  return new Promise((resolve,reject)=>{
    // Loading large models on a slow first connection can take several minutes.
    const timer=setTimeout(()=>stop('识别超时，请检查网络或裁剪图片后重试'),300000);
    pending.set(id,{resolve,reject,onProgress,timer});worker.postMessage({id,...request});
  });
}

export function browserOcrStatus() {
  return typeof Worker!=='undefined' && typeof OffscreenCanvas!=='undefined'
    ? {ready:true,engine:'PP-OCRv5 · 浏览器增强识别'} : null;
}
