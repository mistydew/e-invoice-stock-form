import {findOcrTable, refineOcrNumericColumns, groupOcrLines, parseInvoiceOcr, numeric} from './ocr-invoice-parser.js';
import {browserOcrCall} from './browser-ocr.js';

const midY=w=>(w.bbox.y0+w.bbox.y1)/2;
const midX=w=>(w.bbox.x0+w.bbox.x1)/2;
const mean=words=>words.length ? words.reduce((n,w)=>n+w.confidence,0)/words.length : 0;
const encoded=blob=>new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);
});
function wordRegion(canvas,word) {
  const b=word.bbox,pad=3;
  const x=Math.max(0,Math.floor(b.x0)-pad),y=Math.max(0,Math.floor(b.y0)-2);
  const width=Math.min(canvas.width-x,Math.ceil(b.x1)+pad-x),height=Math.min(canvas.height-y,Math.ceil(b.y1)+2-y);
  const out=document.createElement('canvas');out.width=width+12;out.height=height+8;
  const ctx=out.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(canvas,x,y,width,height,6,4,width,height);
  // Red table rules and header descenders can overlap the first black item
  // line inside a detector box. Remove only red ink from body review crops.
  if(word.bodyReview) {
    const pixels=ctx.getImageData(0,0,out.width,out.height);
    for(let i=0;i<pixels.data.length;i+=4) {
      const [r,g,b]=pixels.data.slice(i,i+3);
      if(r>g+25 && r>b+25)pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;
    }
    ctx.putImageData(pixels,0,0);
  }
  return out.toDataURL('image/png').split(',')[1];
}
function numberRegion(canvas,box,words) {
  const nearby=words.filter(w=>midY(w)>=box.top && midY(w)<box.top+box.height && w.bbox.x1>box.left && w.bbox.x0<box.left+box.width && /\d/.test(w.text));
  let left=box.left,right=box.left+box.width,top=box.top,bottom=box.top+box.height;
  if(nearby.length) {
    left=Math.max(left,Math.min(...nearby.map(w=>w.bbox.x0)));
    right=Math.min(right,Math.max(...nearby.map(w=>w.bbox.x1)));
    top=Math.max(top,Math.min(...nearby.map(w=>w.bbox.y0)));
    bottom=Math.min(bottom,Math.max(...nearby.map(w=>w.bbox.y1)));
  }
  // White padding is added outside the exact crop, so it cannot include a
  // neighbouring digit at a tightly packed quantity/price boundary.
  left=Math.max(0,Math.floor(left));top=Math.max(0,Math.floor(top));
  const width=Math.max(1,Math.min(canvas.width-left,Math.ceil(right)-left));
  const height=Math.max(1,Math.min(canvas.height-top,Math.ceil(bottom)-top));
  const out=document.createElement('canvas');out.width=width+16;out.height=height+12;
  const ctx=out.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(canvas,left,top,width,height,8,6,width,height);
  return out.toDataURL('image/png').split(',')[1];
}
function selectedWords(words,box,key) {
  if(!box)return [];
  return words.filter(w=>{
    const y=midY(w);
    // Assign wrapped name/spec lines by their left edge: OCR boxes can extend
    // slightly beyond the nominal column into its blank neighbour.
    const x=['name','spec'].includes(key) ? w.bbox.x0+2 : midX(w);
    return x>=box.left && x<box.left+box.width && y>=box.top && y<box.top+box.height;
  });
}
function joinWords(words) {
  return groupOcrLines(words).map(l=>l.words.map(w=>w.text).join('')).join('');
}

async function recoverHeaders(canvas,table,words,call) {
  const order=['name','spec','unit','qty','price','amount','rate','tax'],jobs=[];
  for(const key of ['spec','unit','rate']) {
    if(table.fields[key])continue;
    const index=order.indexOf(key),left=table.fields[order[index-1]],right=table.fields[order[index+1]];
    if(!left || !right)continue;
    const x=Math.max(0,Math.floor(left.x1+table.h*.1)),end=Math.min(canvas.width,Math.ceil(right.x0-table.h*.1));
    const y=Math.max(0,Math.floor(Math.min(...Object.values(table.fields).map(f=>f.y0))-table.h*.25));
    const bottom=Math.min(canvas.height,Math.ceil(table.bottom+1));
    if(end<=x || bottom<=y)continue;
    const crop=document.createElement('canvas');crop.width=end-x;crop.height=bottom-y;
    crop.getContext('2d').drawImage(canvas,x,y,crop.width,crop.height,0,0,crop.width,crop.height);
    jobs.push({key,x,y,image:crop.toDataURL('image/png').split(',')[1]});
    crop.width=crop.height=1;
  }
  if(!jobs.length)return;
  const response=await call({op:'regions',regions:jobs.map(j=>({image:j.image,returnChars:true}))});
  response.regions.forEach((r,i)=>{
    const label={spec:'规格型号',unit:'单位',rate:'税率'}[jobs[i].key];
    if(r.text.replace(/\s/g,'')!==label || r.confidence<65 || !r.chars?.length)return;
    const {x,y}=jobs[i];
    const chars=r.chars.filter(c=>c.text.trim()).map(c=>({...c,bbox:{x0:c.bbox.x0+x,y0:c.bbox.y0+y,x1:c.bbox.x1+x,y1:c.bbox.y1+y}}));
    words.push({text:label,confidence:r.confidence,chars,bbox:{x0:Math.min(...chars.map(c=>c.bbox.x0)),y0:Math.min(...chars.map(c=>c.bbox.y0)),x1:Math.max(...chars.map(c=>c.bbox.x1)),y1:Math.max(...chars.map(c=>c.bbox.y1))}});
  });
}

// Shared by every reviewed word, independent of invoice or product identity.
export function applyOcrReview(word,result) {
  if(!result.text?.trim())return;
  const different=result.text.replace(/\s/g,'')!==word.text.replace(/\s/g,'');
  // The fallback repeats the same recognizer on a smaller crop; it is not an
  // independent accurate reading. Do not shorten a confident full-page result,
  // but still allow a crop to recover omitted characters.
  if(result.reviewLimited && different && word.confidence>=90 && result.text.replace(/\s/g,'').length<=word.text.replace(/\s/g,'').length){word.disagreement=true;return;}
  // A second recognizer may omit a trailing symbol or the start of a name.
  // Keep the fuller plausible reading and flag it for the user to verify.
  const initial=word.text.replace(/\s/g,''),reviewedText=result.text.replace(/\s/g,'');
  if(different && initial.includes(reviewedText) && reviewedText.length<initial.length && word.confidence>=75){word.disagreement=true;return;}
  // A larger recognizer can still be less reliable on a particular crop.
  if(different && result.confidence<90 && word.confidence>=95){word.disagreement=true;return;}
  const originalLabel=word.text.match(/^名称\s*[：:]/)?.[0];
  const reviewed=originalLabel ? originalLabel+result.text.replace(/^.{1,3}?[：:]\s*/,'') : result.text;
  word.disagreement=reviewed.replace(/\s/g,'')!==word.text.replace(/\s/g,'');
  word.text=reviewed;word.confidence=result.confidence;
  // Old character boxes belong to the previous transcription.
  delete word.chars;
}

export async function recognizeRapidImage(blob,onProgress,name,options={}) {
  const call=request=>browserOcrCall(request,detail=>onProgress?.({file:name,stage:'ocr',...detail}));
  const image=await createImageBitmap(blob);
  const canvas=document.createElement('canvas');
  try {
    if(image.width*image.height>60000000)throw new Error('图片过大，请先裁剪到发票区域');
    const scale=Math.min(1,3200/image.width,Math.sqrt(16000000/(image.width*image.height)));
    canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    onProgress?.({file:name,stage:'ocr',progress:.05});
    let png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    let page=await call({op:'page',image:await encoded(png)});
    if(page.rotate) {
      onProgress?.({file:name,stage:'ocr',message:'正在校正倾斜的发票…'});
      const original=document.createElement('canvas');original.width=canvas.width;original.height=canvas.height;
      original.getContext('2d').drawImage(canvas,0,0);
      const angle=-page.rotate*Math.PI/180,c=Math.abs(Math.cos(angle)),s=Math.abs(Math.sin(angle));
      const rotatedWidth=Math.ceil(original.width*c+original.height*s),rotatedHeight=Math.ceil(original.height*c+original.width*s);
      const rotationScale=Math.min(1,Math.sqrt(16000000/(rotatedWidth*rotatedHeight)));
      canvas.width=Math.floor(rotatedWidth*rotationScale);canvas.height=Math.floor(rotatedHeight*rotationScale);
      ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.save();
      ctx.translate(canvas.width/2,canvas.height/2);ctx.scale(rotationScale,rotationScale);ctx.rotate(angle);ctx.drawImage(original,-original.width/2,-original.height/2);ctx.restore();
      original.width=original.height=1;
      png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      page=await call({op:'page',image:await encoded(png),deskewed:true});
    }
    if(!page.words.length)throw new Error('未检测到清晰文字，请裁剪或更换图片');
    const words=page.words;
    let passes=[{words,text:words.map(w=>w.text).join('\n'),confidence:mean(words)}];
    let table=findOcrTable(passes,canvas.width,canvas.height);
    if(!table?.rows.length)throw new Error('未能定位发票明细表，请使用完整清晰的发票截图');
    await recoverHeaders(canvas,table,words,call);
    table=findOcrTable(passes,canvas.width,canvas.height);
    onProgress?.({file:name,stage:'ocr',progress:.35});
    // Always review names, including high-confidence omissions: a confidence
    // score does not prove that all printed characters were retained.
    const review=new Set(words.filter(w=>/名称\s*[：:]/.test(w.text) && w.bbox.y0<table.bottom));
    const bodyWords=words.filter(w=>midY(w)>table.bodyTop && midY(w)<table.end);
    for(const row of table.rows)for(const key of ['name','spec'])for(const w of selectedWords(bodyWords,row.cells[key],key)){w.bodyReview=true;review.add(w);}
    const jobs=[...review];
    // Bound each request for large invoices, while keeping a single model loaded.
    let reviewLimited=false;
    for(let i=0;i<jobs.length;i+=30) {
      const batch=jobs.slice(i,i+30);
      const response=await call({op:'regions',regions:batch.map(w=>({image:wordRegion(canvas,w),accurate:true}))});
      reviewLimited ||= response.regions.some(r=>r.reviewLimited);
      response.regions.forEach((r,j)=>applyOcrReview(batch[j],r));
      onProgress?.({file:name,stage:'ocr',progress:.35+.45*Math.min(1,(i+30)/jobs.length)});
    }
    passes=[{words,text:words.map(w=>w.text).join('\n'),confidence:mean(words)}];
    table=refineOcrNumericColumns(findOcrTable(passes,canvas.width,canvas.height),words);
    if(!table?.rows.length)throw new Error('复核后仍无法确认明细表，请使用清晰的完整发票');
    const finalBody=words.filter(w=>midY(w)>table.bodyTop && midY(w)<table.end);
    const chars=finalBody.flatMap(w=>w.chars?.length ? w.chars : [w]);
    const cells=table.rows.map(row=>{
      const cell={};
      for(const [key,box]of Object.entries(row.cells)) {
        const numericField=['qty','price','amount','rate','tax'].includes(key);
        const selected=selectedWords(numericField ? chars : finalBody,box,key);
        cell[key]={text:joinWords(selected),confidence:mean(selected),disagreement:selected.some(w=>w.disagreement)};
      }
      return cell;
    });
    // Invalid/missing numbers get an independent crop recognition. Never infer
    // digits solely from arithmetic or silently shift adjacent columns.
    const retries=[];
    for(const [i,row]of table.rows.entries())for(const key of ['qty','price','amount','tax','unit','rate']) {
      const cell=cells[i][key];
      if(!cell)continue;
      const numericField=!['unit','rate'].includes(key);
      const q=numeric(cells[i].qty?.text),p=numeric(cells[i].price?.text),a=numeric(cells[i].amount?.text);
      const mismatch=q!==null && p!==null && a!==null && Math.abs(Math.round(q*p*100)/100-a)>.02;
      if((numericField ? numeric(cell.text)===null : !cell.text.trim()) || cell.confidence<95 || (mismatch && ['qty','price'].includes(key))) {
        const b=row.cells[key];
        const top=numericField ? b.top : Math.max(b.top,table.bottom+1);
        retries.push({i,key,image:numberRegion(canvas,{...b,top,height:Math.max(1,b.top+b.height-top)},numericField ? finalBody : [])});
      }
    }
    for(let offset=0;offset<retries.length;offset+=120) {
      const batch=retries.slice(offset,offset+120);
      const response=await call({op:'regions',regions:batch.map(r=>({image:r.image}))});
      response.regions.forEach((r,j)=>{
        const {i,key}=batch[j];
        if(['unit','rate'].includes(key) ? r.text.trim() && r.confidence>=65 : numeric(r.text)!==null)cells[i][key]=r;
      });
    }
    const confidence=mean(words),invoice=parseInvoiceOcr({passes,table,cells,confidence,checkTotal:options.checkTotal});
    if(reviewLimited)invoice.warnings.push('精细复核模型未能加载，已保留轻量识别结果，请对照原图核对');
    invoice.ocr={confidence,method:jobs.length && !reviewLimited ? 'PP-OCRv5 · 精细复核' : 'PP-OCRv5 · 轻量识别',text:passes[0].text,cells,table};
    onProgress?.({file:name,stage:'ocr',progress:1});return invoice;
  } finally {image.close();canvas.width=canvas.height=1;}
}
