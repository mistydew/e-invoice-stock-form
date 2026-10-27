import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadModel} from '../js/model-download.js';

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
