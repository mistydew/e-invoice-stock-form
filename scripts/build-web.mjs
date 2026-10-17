import {mkdir,cp,rm} from 'node:fs/promises';
// Publish an explicit static allowlist; development files never enter Pages.
const root=new URL('../',import.meta.url),out=new URL('../dist-web/',import.meta.url);
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
for(const path of ['index.html','css','js','lib','icons','models','manifest.webmanifest','sw.js','README.md']) {
  await cp(new URL(path,root),new URL(path,out),{recursive:true});
}
