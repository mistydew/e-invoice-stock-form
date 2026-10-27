import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadModel,downloadChunkedModel} from '../js/model-download.js';
import {createHash} from 'node:crypto';

test('模型分块下载返回完整字节并报告实际进度',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3]));c.close();}}),{headers:{'content-length':'3'}}));
  const progress=[];
  const result=await downloadModel('https://example.invalid/model',p=>progress.push(p));
  assert.deepEqual([...result],[1,2,3]);assert.deepEqual(progress.at(-1),{received:3,total:3});
});

test('模型下载卡住时中止请求，不能无限等待精细复核资源',async t=>{
  let aborted=false;
  t.mock.method(globalThis,'fetch',async(url,{signal})=>new Response(new ReadableStream({start(c){signal.addEventListener('abort',()=>{aborted=true;c.error(new Error('aborted'));});}})));
  await assert.rejects(downloadModel('https://example.invalid/model',null,15),/模型下载超时/);
  assert.equal(aborted,true);
});

test('404 模型文件不能当作模型字节继续推理',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('missing',{status:404}));
  await assert.rejects(downloadModel('https://example.invalid/model'),/模型下载失败/);
});

test('下载持续收到字节时，总耗时超过超时值仍可完成',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){let sent=0;const timer=setInterval(()=>{c.enqueue(new Uint8Array([++sent]));if(sent===8){clearInterval(timer);c.close();}},5);}})));
  assert.equal((await downloadModel('https://example.invalid/model',null,25)).length,8);
});

function chunkFixture(t) {
  const pieces=[new Uint8Array([1,2]),new Uint8Array([3,4]),new Uint8Array([5,6])];
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const manifest={bytes:6,sha256:hash(new Uint8Array([1,2,3,4,5,6])),parts:pieces.map((p,i)=>({path:`part-${i}.bin`,bytes:p.length,sha256:hash(p)}))};
  const entries=new Map(),cache={match:async url=>entries.get(String(url))?.clone(),put:async(url,response)=>{entries.set(String(url),response.clone());}};
  const previous=globalThis.caches;globalThis.caches={open:async()=>cache};
  t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
  return {pieces,manifest,entries};
}

test('分块失败会重试，完成后再次加载复用全部已验证分块',async t=>{
  const {pieces,manifest}=chunkFixture(t),calls=[0,0,0];
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).endsWith('manifest.json'))return Response.json(manifest);
    const i=Number(String(url).match(/part-(\d)/)[1]);calls[i]++;
    if(i===1 && calls[i]===1)throw new Error('temporary network error');
    return new Response(pieces[i]);
  });
  const first=await downloadChunkedModel('https://example.invalid/models/manifest.json');
  assert.deepEqual([...first],[1,2,3,4,5,6]);assert.deepEqual(calls,[1,2,1]);
  await downloadChunkedModel('https://example.invalid/models/manifest.json');assert.deepEqual(calls,[1,2,1]);
});

test('中断后保留已完成分块，恢复时只下载缺失部分',async t=>{
  const {pieces,manifest}=chunkFixture(t),calls=[0,0,0];let offline=true;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).endsWith('manifest.json'))return Response.json(manifest);
    const i=Number(String(url).match(/part-(\d)/)[1]);calls[i]++;
    if(i===1 && offline)throw new Error('disconnected');
    return new Response(pieces[i]);
  });
  await assert.rejects(downloadChunkedModel('https://example.invalid/models/manifest.json'),/disconnected/);
  assert.deepEqual(calls,[1,3,1]);offline=false;
  assert.deepEqual([...await downloadChunkedModel('https://example.invalid/models/manifest.json')],[1,2,3,4,5,6]);
  assert.deepEqual(calls,[1,4,1]);
});

test('损坏的分块不会进入模型，校验失败后重新下载',async t=>{
  const {pieces,manifest}=chunkFixture(t);let attempts=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).endsWith('manifest.json'))return Response.json(manifest);
    const i=Number(String(url).match(/part-(\d)/)[1]);
    if(i===0 && attempts++===0)return new Response(new Uint8Array([9,9]));
    return new Response(pieces[i]);
  });
  assert.deepEqual([...await downloadChunkedModel('https://example.invalid/models/manifest.json')],[1,2,3,4,5,6]);
  assert.equal(attempts,2);
});

test('持续有进度的 OCR 超过五分钟不误判超时，无进展仍可恢复队列',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let instance;
  class FakeWorker {
    constructor(){instance=this;this.terminated=false;}
    postMessage(request){this.id=request.id;}
    terminate(){this.terminated=true;}
  }
  const old=globalThis.Worker;
  globalThis.Worker=FakeWorker;
  try {
    const {browserOcrCall}=await import('../js/browser-ocr.js?timeout-regression');
    const pending=browserOcrCall({op:'page'});
    for(let i=0;i<6;i++){
      t.mock.timers.tick(60000);
      instance.onmessage({data:{id:instance.id,progress:{message:'正在处理'}}});
    }
    assert.equal(instance.terminated,false);
    instance.onmessage({data:{id:instance.id,result:{words:[]}}});
    assert.deepEqual(await pending,{words:[]});
    const stalled=browserOcrCall({op:'page'});
    const rejection=assert.rejects(stalled,/无进展/);
    t.mock.timers.tick(180000);await rejection;
    assert.equal(instance.terminated,true);
    const recovered=browserOcrCall({op:'page'});
    instance.onmessage({data:{id:instance.id,result:{words:[]}}});
    assert.deepEqual(await recovered,{words:[]});
  }finally{globalThis.Worker=old;}
});
