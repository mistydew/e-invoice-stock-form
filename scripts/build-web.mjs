import {mkdir,cp,rm,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Publish an explicit static allowlist; development files never enter Pages.
const root=new URL('../',import.meta.url),out=new URL('../dist-web/',import.meta.url);
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
for(const path of ['index.html','css','js','lib','icons','models','manifest.webmanifest','sw.js','README.md']) {
  await cp(new URL(path,root),new URL(path,out),{recursive:true});
}
const modelDir=new URL('models/rapidocr/',out);
const model=await readFile(new URL('ch_PP-OCRv5_rec_server.onnx',modelDir));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha256=hash(model),folder=`rec-server-${sha256.slice(0,12)}`;
await mkdir(new URL(folder+'/',modelDir),{recursive:true});
const parts=[];
for(let offset=0,index=0;offset<model.length;offset+=4*1024*1024,index++) {
  const bytes=model.subarray(offset,Math.min(model.length,offset+4*1024*1024));
  const path=`${folder}/part-${String(index).padStart(3,'0')}.bin`;
  await writeFile(new URL(path,modelDir),bytes);
  parts.push({path,bytes:bytes.length,sha256:hash(bytes)});
}
await writeFile(new URL('ch_PP-OCRv5_rec_server.parts.json',modelDir),JSON.stringify({bytes:model.length,sha256,parts}));
