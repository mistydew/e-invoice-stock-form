import test from 'node:test';
import assert from 'node:assert/strict';
import {createImportQueue} from '../js/import-queue.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const file=name=>({name});
function fixture() {
  const started=[],results=[],errors=[];let active=0,maxActive=0;
  const queue=createImportQueue({
    processFile:(file,options,progress)=>new Promise((resolve,reject)=>{
      active++;maxActive=Math.max(active,maxActive);
      started.push({name:file.name,options,progress,resolve:value=>{active--;resolve(value);},reject:error=>{active--;reject(error);}});
    }),
    onResult:(result,file)=>results.push({name:file.name,result}),
    onError:(error,file)=>errors.push({name:file.name,error}),
  });
  return {queue,started,results,errors,get maxActive(){return maxActive;}};
}

test('一次加入多文件并快速追加多批次，始终按 FIFO 串行处理',async()=>{
  const f=fixture();
  f.queue.enqueue([file('A.pdf'),file('B.jpg')]);
  f.queue.enqueue([file('C.png')]);f.queue.enqueue([file('D.jpg'),file('E.pdf')]);
  assert.equal(f.started.length,1);assert.equal(f.queue.snapshot().waiting.length,4);
  for(let i=0;i<5;i++){assert.equal(f.started.length,i+1);f.started[i].resolve(i);await tick();}
  assert.deepEqual(f.started.map(j=>j.name),['A.pdf','B.jpg','C.png','D.jpg','E.pdf']);
  assert.deepEqual(f.results.map(j=>j.name),f.started.map(j=>j.name));
  assert.equal(f.maxActive,1);assert.equal(f.queue.snapshot().finished,5);assert.equal(f.queue.snapshot().busy,false);
});

test('一个文件失败不阻塞后面的待识别文件',async()=>{
  const f=fixture();f.queue.enqueue([file('bad.jpg'),file('good.pdf')]);
  f.started[0].reject(new Error('测试损坏文件'));await tick();
  assert.equal(f.started[1].name,'good.pdf');f.started[1].resolve('ok');await tick();
  assert.equal(f.errors.length,1);assert.equal(f.results.length,1);assert.equal(f.queue.snapshot().finished,2);
});

test('清空后丢弃旧结果和进度，新文件等待旧 OCR 释放后再执行',async()=>{
  const f=fixture();f.queue.enqueue([file('old.jpg'),file('cancelled.jpg')]);
  f.queue.clear();f.queue.enqueue([file('new.pdf')]);
  assert.equal(f.started.length,1);assert.ok(f.queue.snapshot().active.obsolete);
  f.started[0].progress({progress:.8,file:'old.jpg'});
  assert.equal(f.queue.snapshot().active.progress,null);
  f.started[0].resolve('旧结果');await tick();
  assert.equal(f.results.length,0);assert.equal(f.started[1].name,'new.pdf');
  f.started[1].resolve('新结果');await tick();
  assert.deepEqual(f.results,[{name:'new.pdf',result:'新结果'}]);assert.equal(f.maxActive,1);assert.equal(f.queue.snapshot().finished,1);
});

test('清空后旧任务失败也不能写回失败记录',async()=>{
  const f=fixture();f.queue.enqueue([file('old.jpg')]);f.queue.clear();
  f.started[0].reject(new Error('旧失败'));await tick();
  assert.equal(f.errors.length,0);assert.equal(f.queue.snapshot().busy,false);assert.equal(f.queue.snapshot().finished,0);
});

test('取消等待只移除尚未开始的文件，当前文件和新追加仍能完成',async()=>{
  const f=fixture();f.queue.enqueue([file('active.jpg'),file('waiting.pdf')]);f.queue.cancelWaiting();
  f.queue.enqueue([file('added.png')]);f.started[0].resolve('first');await tick();
  assert.equal(f.started[1].name,'added.png');f.started[1].resolve('second');await tick();
  assert.equal(f.results.length,2);assert.equal(f.queue.snapshot().waiting.length,0);
});

test('队列排空后可再次启动，每批使用加入时的设置快照',async()=>{
  const f=fixture(),options={fold:false};f.queue.enqueue([file('first.pdf')],options);options.fold=true;
  f.started[0].resolve('first');await tick();f.queue.enqueue([file('second.jpg')],options);
  assert.equal(f.started[0].options.fold,false);assert.equal(f.started[1].options.fold,true);
  f.started[1].resolve('second');await tick();assert.equal(f.queue.snapshot().finished,2);assert.equal(f.maxActive,1);
});
