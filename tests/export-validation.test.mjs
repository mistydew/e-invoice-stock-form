import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInvoiceItems} from '../js/invoice-parser.js';
import {recordIssues,recordTotal} from '../js/record-validation.js';

test('零金额和负数折扣合法，折扣数量单价可为空',()=>{
  assert.deepEqual(recordIssues([{amount:0,tax:0},{amount:-10,tax:-1.3,qty:null,price:null}]),[]);
});

test('导出问题指出来源内条目和表格行，空值与非法数字区分显示',()=>{
  const rows=[{src:'示例甲.pdf',amount:10,tax:1.3},{src:'示例甲.pdf',name:'测试商品',amount:null,tax:0},{src:'示例乙.jpg',amount:NaN,tax:1,qty:'abc'}];
  const issues=recordIssues(rows);
  assert.equal(issues.length,2);assert.equal(issues[0].index,1);assert.equal(issues[0].sourceRow,2);assert.equal(issues[0].source,'示例甲.pdf');
  assert.deepEqual(issues[0].fields,[{key:'amount',label:'金额',reason:'未填写'}]);
  assert.deepEqual(issues[1].fields.map(f=>[f.key,f.reason]),[['amount','不是有效数字'],['qty','不是有效数字']]);
});

test('未知金额和非法数字不能在界面上变成零金额',()=>{
  for(const value of [null,undefined,NaN,Infinity,'abc'])assert.equal(recordTotal({amount:value,tax:0}),null);
  assert.equal(recordTotal({amount:0,tax:0}),0);assert.equal(recordTotal({amount:-10,tax:-1.3}),-11.3);
});

test('密集明细后的小计合计不能并入最后一个商品名称',()=>{
  const item=(str,x,y)=>({str,x,y,w:str.length*8});
  const items=[item('名称：示例采购方',30,690),item('名称：示例供应商',450,690)];
  for(const [str,x] of [['项目名称',30],['规格型号',240],['单位',340],['数量',430],['单价',520],['金额',650],['税率',750],['税额',840]])items.push(item(str,x,600));
  for(let i=0;i<20;i++){
    const y=550-i*12;
    items.push(item('*材料*商品'+(i+1),30,y),item('1',430,y),item('10',520,y),item('10',650,y),item('13%',750,y),item('1.3',840,y));
  }
  items.push(item('小',50,310),item('计',100,310),item('¥200',650,310),item('¥26',840,310),item('合计',50,298),item('¥200',650,298),item('¥26',840,298));
  const result=parseInvoiceItems(items);
  assert.equal(result.rows.length,20);assert.equal(result.rows.at(-1).name,'*材料*商品20');
  assert.equal(result.sumAmount,200);assert.equal(result.sumTax,26);
});
