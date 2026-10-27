import { findOcrTable, parseInvoiceOcr } from './ocr-invoice-parser.js';
import {recognizeRapidImage} from './rapid-ocr.js';
import {browserOcrStatus} from './browser-ocr.js';
const UNITS=new Set(['个','只','件','台','套','米','吨','千克','克','斤','升','毫升','张','块','根','条','卷','包','箱','盒','支','把','片','枚','组','批','次','双','副','桶','袋','罐','瓶','册','本','对']);

let loading;
async function engine() {
  if(globalThis.Tesseract) return globalThis.Tesseract;
  if(!loading) loading=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=new URL('../lib/ocr/tesseract.min.js',import.meta.url).href;
    script.onload=()=>resolve(globalThis.Tesseract);
    script.onerror=()=>{loading=null;reject(new Error('本地 OCR 文件缺失，请保持 lib/ocr 文件夹完整'));};
    document.head.appendChild(script);
  });
  return loading;
}

async function prepare(blob) {
  const image=await createImageBitmap(blob);
  try {
    // Bound memory for large photos, while increasing the pixels available for small invoice text.
    if(image.width*image.height>60000000) throw new Error('图片过大，请先裁剪到发票区域');
    const scale=Math.min(3,Math.max(1,3200/image.width),Math.sqrt(16000000/(image.width*image.height)));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
    for(let i=0;i<pixels.data.length;i+=4) {
      const v=Math.round(.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2]);
      pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;
    }
    ctx.putImageData(pixels,0,0);
    return canvas;
  } finally {image.close();}
}

function crop(canvas,box) {
  const padding=20;
  const out=document.createElement('canvas');
  out.width=box.width+padding*2;out.height=box.height+padding*2;
  const ctx=out.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);
  ctx.drawImage(canvas,box.left,box.top,box.width,box.height,padding,padding,box.width,box.height);
  // Long table rules at the page/cell edge interfere with single-line recognition.
  const data=ctx.getImageData(0,0,out.width,out.height), p=data.data;
  const white=(x,y)=>{const i=(y*out.width+x)*4;p[i]=p[i+1]=p[i+2]=255;};
  for(let x=padding;x<out.width-padding;x++) {
    let count=0;
    for(let y=padding;y<out.height-padding;y++) if(p[(y*out.width+x)*4]<225) count++;
    if(count>box.height*.75) for(let y=padding;y<out.height-padding;y++) white(x,y);
  }
  ctx.putImageData(data,0,0);
  return out;
}

export async function recognizeInvoiceImage(blob,onProgress,name,options={}) {
  if(browserOcrStatus()?.ready)return recognizeRapidImage(blob,onProgress,name,options);
  const T=await engine();
  const canvas=await prepare(blob);
  const base=new URL('../lib/ocr/',import.meta.url);
  let stage=0;
  const worker=await T.createWorker('chi_sim+eng',1,{
    workerPath:new URL('worker.min.js',base).href,
    corePath:new URL('core/',base).href,
    langPath:new URL('lang/',base).href,
    gzip:false,
    cacheMethod:'none',
    logger:m=>{if(m.status==='recognizing text') onProgress?.({file:name,stage:'ocr',progress:Math.min(.98,stage+m.progress*.3)});}
  });
  try {
    const passes=[];
    for(const mode of ['3','11']) {
      stage=passes.length*.3;
      await worker.setParameters({tessedit_pageseg_mode:mode,preserve_interword_spaces:'1',user_defined_dpi:'300'});
      const {data}=await worker.recognize(canvas);
      passes.push({text:data.text,confidence:data.confidence,words:data.words.map(w=>({text:w.text,confidence:w.confidence,bbox:w.bbox}))});
    }
    const table=findOcrTable(passes,canvas.width,canvas.height);
    const cells=[];
    const boxes=table?.rows || [];
    // Each field gets its own image region; whitespace is never used as a column boundary.
    for(const [i,row] of boxes.entries()) {
      const result={};
      for(const [key,box] of Object.entries(row.cells)) {
        stage=.6+.35*(i/Math.max(1,boxes.length));
        const words=passes[0].words.filter(w=>{
          const x=(w.bbox.x0+w.bbox.x1)/2,y=(w.bbox.y0+w.bbox.y1)/2;
          return w.text?.trim() && x>=box.left && x<box.left+box.width && y>=box.top && y<box.top+box.height;
        }).sort((a,b)=>a.bbox.x0-b.bbox.x0);
        const numericField=['qty','price','amount','tax'].includes(key);
        // Tesseract sees the horizontal table rule as punctuation if the crop
        // begins above the bottom of the printed header.
        const top=Math.min(box.top+box.height-1,Math.max(box.top,table.bottom+2));
        let region={...box,top,height:box.top+box.height-top};
        // Use text coordinates to exclude neighbouring glyphs, but retain the full
        // row height so the original text (including decimal points) is read again.
        if(words.length) {
          const left=Math.max(box.left,Math.min(...words.map(w=>w.bbox.x0))-(key==='name' ? 1 : 5));
          const right=Math.min(box.left+box.width,Math.max(...words.map(w=>w.bbox.x1))+5);
          region={...region,left,width:right-left};
        }
        await worker.setParameters({tessedit_pageseg_mode:['name','spec'].includes(key) && box.height>table.h*2 ? '6' : '7',tessedit_char_whitelist:numericField ? '0123456789.-+,' : key==='rate' ? '0123456789.%免税不征*' : ''});
        const {data}=await worker.recognize(crop(canvas,region));
        result[key]={text:data.text.trim(),confidence:data.confidence};
        const source=words.map(w=>w.text).join('').replace(/\s/g,'');
        const sourceConfidence=words.length ? words.reduce((s,w)=>s+w.confidence,0)/words.length : 0;
        if(source===result[key].text.replace(/\s/g,'')) result[key].confidence=Math.max(result[key].confidence,sourceConfidence);
        if(key==='unit' && !UNITS.has(result[key].text) && UNITS.has(source)) result[key]={text:source,confidence:sourceConfidence,disagreement:true};
      }
      cells.push(result);
    }
    const confidence=passes[0].confidence;
    const invoice=parseInvoiceOcr({passes,table,cells,confidence,checkTotal:options.checkTotal});
    invoice.ocr={confidence,method:'本地 OCR · 坐标分列',text:passes[0].text,cells,table};
    onProgress?.({file:name,stage:'ocr',progress:1});
    return invoice;
  } finally {await worker.terminate();canvas.width=canvas.height=1;}
}
