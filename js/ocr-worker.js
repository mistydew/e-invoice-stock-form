// All invoice pixels and inference stay inside this worker. Only static assets are fetched.
let runtime;
const sessions=new Map();
const modelRoot=new URL('../models/rapidocr/',self.location.href);
let activeId;
let serverUnavailable=false;
const progress=message=>self.postMessage({id:activeId,progress:{message}});

async function initialize() {
  if(!runtime)runtime=(async()=>{
    progress('首次加载浏览器识别引擎…');
    const [{default:ort},math,assets]=await Promise.all([
      import('../lib/onnx/ort.wasm.min.mjs'),import('./ocr-math.js'),import('./model-download.js')
    ]);
    ort.env.wasm.numThreads=1;
    ort.env.wasm.wasmPaths=new URL('../lib/onnx/',self.location.href).href;
    importScripts('../lib/opencv/opencv.js');
    const cv=await self.cv;
    return {ort,cv,...math,...assets};
  })();
  return runtime;
}

async function session(kind) {
  if(!sessions.has(kind)) {
    const job=(async()=>{
      const {ort,downloadModel}=await initialize();
      const name=kind==='det' ? 'ch_PP-OCRv5_det_mobile' : kind==='server' ? 'ch_PP-OCRv5_rec_server' : 'ch_PP-OCRv5_rec_mobile';
      const label=kind==='server' ? '精细复核模型' : kind==='det' ? '文字检测模型' : '文字识别模型';
      progress(`正在加载${label}…`);
      const bytes=await downloadModel(new URL(name+'.onnx',modelRoot).href,({received,total})=>{
        progress(`正在下载${label} ${(received/1e6).toFixed(1)}${total ? '/'+(total/1e6).toFixed(1) : ''} MB…`);
      },kind==='server' ? 20000 : 120000);
      progress(`正在初始化${label}…`);
      const model=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
      let dictionary;
      if(kind!=='det') {
        const response=await fetch(new URL(name+'.json',modelRoot));
        if(!response.ok)throw new Error('识别字典下载失败，请检查网络后重试');
        dictionary=await response.json();
      }
      return {model,dictionary};
    })().catch(error=>{sessions.delete(kind);throw error;});
    sessions.set(kind,job);
  }
  return sessions.get(kind);
}

async function imageFromBase64(encoded) {
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
  try {
    if(bitmap.width*bitmap.height>16000000)throw new Error('图片过大，请先裁剪');
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
    ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);
    return canvas;
  } finally {bitmap.close();}
}

async function tensor(canvas,width,height,det=false,contentWidth=width) {
  const {ort}=await initialize();
  const scaled=new OffscreenCanvas(width,height),ctx=scaled.getContext('2d');
  ctx.drawImage(canvas,0,0,contentWidth,height);
  const pixels=ctx.getImageData(0,0,width,height).data,n=width*height,out=new Float32Array(n*3);
  const mean=[.485,.456,.406],std=[.229,.224,.225];
  // Paddle/RapidOCR models consume BGR, including normalization in that order.
  for(let c=0;c<3;c++)for(let i=0;i<n;i++) {
    const value=pixels[i*4+2-c]/255;
    out[c*n+i]=i%width>=contentWidth ? 0 : det ? (value-mean[c])/std[c] : (value-.5)/.5;
  }
  return new ort.Tensor('float32',out,[1,3,height,width]);
}

async function run(model,input) {
  let outputs;
  try {outputs=await model.run({[model.inputNames[0]]:input});return outputs[model.outputNames[0]];}
  finally {input.dispose();}
}

function orderedCorners(rect) {
  const angle=rect.angle*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:rect.center.x+x*rect.size.width*c/2-y*rect.size.height*s/2,y:rect.center.y+x*rect.size.width*s/2+y*rect.size.height*c/2}));
  const left=corners.sort((a,b)=>a.x-b.x).slice(0,2).sort((a,b)=>a.y-b.y);
  const right=corners.slice(2).sort((a,b)=>a.y-b.y);
  return [left[0],right[0],right[1],left[1]];
}

async function detect(canvas) {
  const {cv,detectionSize}=await initialize(),{model}=await session('det');
  const size=detectionSize(canvas.width,canvas.height);
  const output=await run(model,await tensor(canvas,size.width,size.height,true));
  const height=output.dims[2],width=output.dims[3],data=output.data;
  const bitmap=new cv.Mat(height,width,cv.CV_8UC1),contours=new cv.MatVector(),hierarchy=new cv.Mat();
  try {
    for(let i=0;i<data.length;i++)bitmap.data[i]=data[i]>.3 ? 255 : 0;
    cv.findContours(bitmap,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
    const boxes=[];
    for(let i=0;i<Math.min(contours.size(),1500);i++) {
      const contour=contours.get(i);
      try {
        const rect=cv.minAreaRect(contour);
        if(Math.min(rect.size.width,rect.size.height)<3)continue;
        const bounds=cv.boundingRect(contour);let total=0,count=0;
        for(let y=bounds.y;y<bounds.y+bounds.height;y++)for(let x=bounds.x;x<bounds.x+bounds.width;x++)if(bitmap.data[y*width+x]){total+=data[y*width+x];count++;}
        if(!count || total/count<.6)continue;
        const distance=rect.size.width*rect.size.height*1.5/(2*(rect.size.width+rect.size.height));
        rect.size.width+=2*distance;rect.size.height+=2*distance;
        const points=orderedCorners(rect).map(p=>({x:Math.max(0,Math.min(canvas.width-1,p.x*canvas.width/width)),y:Math.max(0,Math.min(canvas.height-1,p.y*canvas.height/height))}));
        boxes.push(points);
      } finally {contour.delete();}
    }
    return boxes.sort((a,b)=>a[0].y-b[0].y || a[0].x-b[0].x);
  } finally {bitmap.delete();contours.delete();hierarchy.delete();output.dispose();}
}

function cropQuad(source,points,cv) {
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const width=Math.max(1,Math.round(Math.max(distance(points[0],points[1]),distance(points[3],points[2]))));
  const height=Math.max(1,Math.round(Math.max(distance(points[0],points[3]),distance(points[1],points[2]))));
  const from=cv.matFromArray(4,1,cv.CV_32FC2,points.flatMap(p=>[p.x,p.y]));
  const to=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,width,0,width,height,0,height]);
  const transform=cv.getPerspectiveTransform(from,to),out=new cv.Mat();
  try {
    cv.warpPerspective(source,out,transform,new cv.Size(width,height),cv.INTER_CUBIC,cv.BORDER_REPLICATE);
    const crop=new OffscreenCanvas(width,height);
    crop.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data),width,height),0,0);
    return crop;
  } finally {from.delete();to.delete();transform.delete();out.delete();}
}

async function recognize(canvas,accurate=false) {
  const {decodeCtc}=await initialize();
  let selected,reviewLimited=false;
  if(accurate && !serverUnavailable) {
    try {selected=await session('server');}
    catch {serverUnavailable=true;}
  }
  if(!selected){selected=await session('mobile');reviewLimited=accurate;}
  const {model,dictionary}=selected;
  const contentWidth=Math.ceil(48*canvas.width/canvas.height),width=Math.max(320,contentWidth);
  if(width>4096)throw new Error('文字区域过长，请使用清晰的完整发票');
  const output=await run(model,await tensor(canvas,width,48,false,contentWidth));
  try {
    const result=decodeCtc(output.data,output.dims[1],output.dims[2],dictionary);
    result.reviewLimited=reviewLimited;
    const steps=output.dims[1];
    result.tokens.forEach(t=>t.center=(t.start+t.end+1)/2/steps*width*canvas.width/contentWidth);
    return result;
  } finally {output.dispose();}
}

function characterBoxes(crop,result,points) {
  const width=crop.width,height=crop.height,pixels=crop.getContext('2d').getImageData(0,0,width,height).data;
  const project=(x,y)=>({x:points[0].x+(points[1].x-points[0].x)*x/width+(points[3].x-points[0].x)*y/height,y:points[0].y+(points[1].y-points[0].y)*x/width+(points[3].y-points[0].y)*y/height});
  return result.tokens.map((token,i,tokens)=>{
    const half=height*(/[\u2e80-\uffff]/u.test(token.text) ? .55 : .32);
    const start=Math.max(0,Math.floor(Math.max(token.center-half,i ? (tokens[i-1].center+token.center)/2 : 0)));
    const end=Math.min(width,Math.ceil(Math.min(token.center+half,i+1<tokens.length ? (token.center+tokens[i+1].center)/2 : width)));
    let left=end,right=start,top=height,bottom=0;
    for(let x=start;x<end;x++)for(let y=Math.floor(height*.12);y<height*.88;y++) {
      const p=(y*width+x)*4;
      // Printed invoice headers are often red. They still define column edges.
      if(pixels[p]+pixels[p+1]+pixels[p+2]<510){
        left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);
      }
    }
    if(right<=left){left=start;right=end;top=0;bottom=height;}
    const corners=[project(left,top),project(right,top),project(right,bottom),project(left,bottom)];
    return {text:token.text,confidence:token.score*100,bbox:{x0:Math.min(...corners.map(p=>p.x)),y0:Math.min(...corners.map(p=>p.y)),x1:Math.max(...corners.map(p=>p.x)),y1:Math.max(...corners.map(p=>p.y))}};
  });
}

async function page(encoded,deskewed=false) {
  const canvas=await imageFromBase64(encoded),{cv}=await initialize();
  try {
    progress('正在定位发票文字…');
    const boxes=await detect(canvas),words=[];
    if(!deskewed) {
      const angles=boxes.filter(p=>Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)>Math.hypot(p[3].x-p[0].x,p[3].y-p[0].y)*3)
        .map(p=>Math.atan2(p[1].y-p[0].y,p[1].x-p[0].x)*180/Math.PI).sort((a,b)=>a-b);
      const angle=angles[Math.floor(angles.length/2)];
      if(Math.abs(angle)>.35 && Math.abs(angle)<15)return {rotate:angle};
    }
    const source=cv.matFromImageData(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height));
    try {
    for(let i=0;i<boxes.length;i++) {
      const points=boxes[i],crop=cropQuad(source,points,cv);
      try {
        const result=await recognize(crop);
        if(result.text.trim() && result.confidence>=40)words.push({text:result.text,confidence:result.confidence,bbox:{x0:Math.min(...points.map(p=>p.x)),y0:Math.min(...points.map(p=>p.y)),x1:Math.max(...points.map(p=>p.x)),y1:Math.max(...points.map(p=>p.y))},chars:characterBoxes(crop,result,points)});
      } finally {crop.width=crop.height=1;}
      progress(`正在识别文字 ${i+1}/${boxes.length}…`);
    }
    } finally {source.delete();}
    return {width:canvas.width,height:canvas.height,words};
  } finally {canvas.width=canvas.height=1;}
}

// Serialize messages even when several callers post while models are loading.
let queue=Promise.resolve();
self.onmessage=({data:request})=>{
  queue=queue.then(async()=>{
    activeId=request.id;
    try {
      let result;
      if(request.op==='page')result=await page(request.image,request.deskewed);
      else if(request.op==='regions') {
        if(!Array.isArray(request.regions) || request.regions.length>120)throw new Error('一次最多复核 120 个区域');
        result={regions:[]};
        for(const [index,region] of request.regions.entries()) {
          const canvas=await imageFromBase64(region.image);
          try {
            const r=await recognize(canvas,region.accurate);
            const chars=region.returnChars ? characterBoxes(canvas,r,[{x:0,y:0},{x:canvas.width,y:0},{x:canvas.width,y:canvas.height},{x:0,y:canvas.height}]) : undefined;
            result.regions.push({text:r.text,confidence:r.confidence,reviewLimited:r.reviewLimited,chars});
          }
          finally {canvas.width=canvas.height=1;}
          progress(`正在复核字段 ${index+1}/${request.regions.length}…`);
        }
      } else throw new Error('不支持的识别操作');
      self.postMessage({id:request.id,result});
    } catch(error) {
      // Keep invoice text and pixels out of logs and error reports.
      self.postMessage({id:request.id,error:/^(图片|识别模型)/.test(error.message||'') ? error.message : '浏览器识别未完成，请刷新或更换清晰图片后重试'});
    }
  });
};
