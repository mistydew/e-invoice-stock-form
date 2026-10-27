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
      if(data.progress){task.refresh();task.onProgress?.(data.progress);return;}
      clearTimeout(task.timer);pending.delete(data.id);
      if(data.error)task.reject(new Error(data.error));else task.resolve(data.result);
    };
    worker.onerror=()=>stop('浏览器识别引擎加载失败，请刷新后重试（首次需下载模型）');
  }
  const id=++serial;
  return new Promise((resolve,reject)=>{
    // Real download/field progress resets the inactivity timeout. A healthy
    // long invoice should not be terminated at a fixed total elapsed time.
    const task={resolve,reject,onProgress,timer:null,refresh(){
      clearTimeout(this.timer);
      this.timer=setTimeout(()=>stop('识别长时间无进展，请刷新重试或更换清晰图片'),180000);
    }};
    task.refresh();pending.set(id,task);worker.postMessage({id,...request});
  });
}

export function browserOcrStatus() {
  return typeof Worker!=='undefined' && typeof OffscreenCanvas!=='undefined'
    ? {ready:true,engine:'PP-OCRv5 · 浏览器增强识别'} : null;
}
