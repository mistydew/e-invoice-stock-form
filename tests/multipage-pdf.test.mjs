import test from 'node:test';
import assert from 'node:assert/strict';
import {readPdf} from '../js/file-reader.js';

function page(number,amounts,total,seller='示例供应商') {
  const text=(str,x,y)=>({str,width:str.length*8,transform:[1,0,0,1,x,y]});
  const items=[text('发票号码：'+number,550,760),text('开票日期：2026年10月01日',550,730),text('名称：示例采购方',30,690),text('名称：'+seller,450,690)];
  for(const [str,x]of [['项目名称',30],['规格型号',240],['单位',340],['数量',430],['单价',520],['金额',650],['税率',750],['税额',840]])items.push(text(str,x,600));
  amounts.forEach(([name,amount,tax],i)=>{
    const y=550-i*50;
    items.push(text(name,30,y),text(String(amount),650,y),text('13%',750,y),text(String(tax),840,y));
    if(amount>=0)items.push(text('个',340,y),text('1',430,y),text(String(amount),520,y));
  });
  items.push(text('小计',30,350),text('¥'+amounts.reduce((s,r)=>s+r[1],0).toFixed(2),650,350));
  if(total!==null)items.push(text('价税合计（小写）¥'+total.toFixed(2),450,280));
  return {getTextContent:async()=>({items})};
}

async function read(pages,options={}) {
  const previous=globalThis.pdfjsLib;
  let destroyed=false;
  globalThis.pdfjsLib={getDocument:()=>({promise:Promise.resolve({numPages:pages.length,getPage:async p=>pages[p-1],destroy:async()=>{destroyed=true;}})})};
  try {const result=await readPdf(new ArrayBuffer(0),'虚构多页.pdf',{ocr:false,fold:false,...options});assert.equal(destroyed,true);return result;}
  finally {globalThis.pdfjsLib=previous;}
}

test('多页 PDF 按页序保留全部明细，用末页总额核对整票',async()=>{
  const result=await read([page('12345678901234567890',[['*材料*商品甲',20,2.6]],null),page('12345678901234567890',[['*材料*商品甲',-2,-.26],['*材料*商品乙',5,.65]],25.99)]);
  assert.deepEqual(result.records.map(r=>r.amount),[20,-2,5]);
  assert.equal(Math.round(result.records.reduce((s,r)=>s+r.total,0)*100)/100,25.99);
  assert.deepEqual(result.warnings,[]);
});

test('折扣跨页时在同一发票内合并，不覆盖票面单价',async()=>{
  const result=await read([page('12345678901234567890',[['*材料*商品甲',20,2.6]],null),page('12345678901234567890',[['*材料*商品甲',-2,-.26],['*材料*商品乙',5,.65]],25.99)],{fold:true});
  assert.deepEqual(result.records.map(r=>[r.amount,r.tax,r.price]),[[18,2.34,20],[5,.65,5]]);
});

test('合订 PDF 中不同票号保留各自销售方日期和金额，不套用第一页信息',async()=>{
  const result=await read([page('12345678901234567890',[['*材料*商品甲',20,2.6]],22.6,'示例甲公司'),page('12345678901234567891',[['*材料*商品乙',5,.65]],5.65,'示例乙公司')]);
  assert.deepEqual(result.records.map(r=>r.seller),['示例甲公司','示例乙公司']);
  assert.deepEqual(result.records.map(r=>r.invoiceNo),['12345678901234567890','12345678901234567891']);
  assert.deepEqual(result.warnings,[]);
});

test('多页合并后仍报告真实的总额差异，不能用合计倒推明细',async()=>{
  const result=await read([page('12345678901234567890',[['*材料*商品甲',20,2.6]],null),page('12345678901234567890',[['*材料*商品乙',5,.65]],99)]);
  assert.deepEqual(result.records.map(r=>r.amount),[20,5]);
  assert.ok(result.warnings.some(w=>w.includes('99') && w.includes('不一致')));
});

test('页首无金额的名称续行接回同票上一页商品，不生成空金额明细',async()=>{
  const first=page('12345678901234567890',[['*材料*电容系列100p',20,2.6]],null);
  const second=page('12345678901234567890',[['*材料*商品乙',5,.65]],28.25);
  const original=second.getTextContent;
  second.getTextContent=async()=>{const content=await original();content.items.push({str:'F220pF1uF',width:72,transform:[1,0,0,1,30,575]});return content;};
  const result=await read([first,second]);
  assert.equal(result.records.length,2);
  assert.equal(result.records[0].name,'*材料*电容系列100pF220pF1uF');
  assert.deepEqual(result.records.map(r=>r.amount),[20,5]);
  assert.deepEqual(result.warnings,[]);
});

test('不同票号的页首无金额行不能拼到前一张发票或被静默丢弃',async()=>{
  const second=page('12345678901234567891',[['*材料*商品乙',5,.65]],5.65);
  const original=second.getTextContent;
  second.getTextContent=async()=>{const content=await original();content.items.push({str:'未确认描述',width:72,transform:[1,0,0,1,30,575]});return content;};
  const result=await read([page('12345678901234567890',[['*材料*商品甲',20,2.6]],22.6),second]);
  assert.equal(result.records.length,3);assert.equal(result.records[0].name,'*材料*商品甲');
  assert.equal(result.records[1].amount,null);assert.equal(result.records[1].name,'未确认描述');
});

test('带商品分类开头但金额缺失的新商品不能当作续行',async()=>{
  const second=page('12345678901234567890',[['*材料*商品乙',5,.65]],28.25);
  const original=second.getTextContent;
  second.getTextContent=async()=>{const content=await original();content.items.push({str:'*材料*待核对商品',width:100,transform:[1,0,0,1,30,575]});return content;};
  const result=await read([page('12345678901234567890',[['*材料*商品甲',20,2.6]],null),second]);
  assert.equal(result.records.length,3);assert.equal(result.records[1].amount,null);
  assert.equal(result.records[0].name,'*材料*商品甲');
});
