// Page-local FIFO. Keep File objects in memory and run one complete import at a
// time, including all OCR page/region requests and files nested inside a ZIP.
export function createImportQueue({processFile,onResult,onError,onChange=()=>{}}) {
  let waiting=[],active=null,running=false,generation=0,serial=0,finished=0;
  const describe=job=>({id:job.id,name:job.file.name,progress:job.progress,obsolete:job.generation!==generation});
  function snapshot() {
    return {active:active?describe(active):null,waiting:waiting.map(describe),finished,busy:!!active||waiting.length>0};
  }
  const notify=()=>onChange(snapshot());
  async function drain() {
    if(running)return;
    running=true;
    try {
      while(waiting.length) {
        const job=waiting.shift();active=job;notify();
        try {
          const result=await processFile(job.file,job.options,progress=>{
            if(job.generation!==generation)return;
            job.progress=progress;notify();
          });
          if(job.generation===generation){finished++;onResult(result,job.file);}
        } catch(error) {
          if(job.generation===generation){finished++;onError(error,job.file);}
        } finally {active=null;notify();}
      }
    } finally {running=false;notify();}
  }
  return {
    snapshot,
    enqueue(files,options={}) {
      for(const file of files)waiting.push({id:++serial,file,options:{...options},generation,progress:null});
      notify();void drain();
    },
    cancelWaiting() {waiting=[];notify();},
    clear() {
      generation++;waiting=[];finished=0;notify();
      // Let an in-flight OCR release the worker, but ignore its late results
      // and progress. A new import waits until that work has actually ended.
    }
  };
}
