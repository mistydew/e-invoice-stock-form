import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCtc,detectionSize} from '../js/ocr-math.js';
import {applyOcrReview} from '../js/rapid-ocr.js';
import {parseInvoiceItems} from '../js/invoice-parser.js';

test('CTC 合并重复预测，但保留 blank 分隔的相同字符及真实时间间隔',()=>{
  const classes=4,ids=[0,1,1,0,1,0,0,0,2,3,0],data=new Float32Array(ids.length*classes);
  ids.forEach((id,t)=>data[t*classes+id]=.99);
  const result=decodeCtc(data,ids.length,classes,['blank','1','金','额']);
  assert.equal(result.text,'11金额');
  assert.deepEqual(result.tokens.map(t=>[t.start,t.end]),[[1,2],[4,4],[8,8],[9,9]]);
  assert.ok(result.confidence>98);
});

test('大幅图片检测缩放保持比例并对齐模型要求的 32 像素',()=>{
  assert.deepEqual(detectionSize(4000,2000),{width:1280,height:640});
  assert.deepEqual(detectionSize(10,10),{width:32,height:32});
});

test('复核不能静默删掉原始规格中可信的尾部字符',()=>{
  const tail={text:'16V±',confidence:85};
  applyOcrReview(tail,{text:'16V',confidence:99});
  assert.equal(tail.text,'16V±');assert.equal(tail.disagreement,true);
});

test('精细模型不可用时，同引擎裁剪不能覆盖可靠初读导致名称漏字',()=>{
  const word={text:'示例电子有限公司',confidence:98,chars:[{text:'子'}]};
  applyOcrReview(word,{text:'示例电有限公司',confidence:99,reviewLimited:true});
  assert.equal(word.text,'示例电子有限公司');assert.equal(word.disagreement,true);assert.ok(word.chars);
  const incomplete={text:'示例电有限公司',confidence:98};
  applyOcrReview(incomplete,{text:'示例电子有限公司',confidence:99,reviewLimited:true});
  assert.equal(incomplete.text,'示例电子有限公司');assert.equal(incomplete.disagreement,true);
});

test('PDF 将名称标签和值放在同一文字块时，仍分开购销方',()=>{
  const item=(str,x,y,w=str.length*14)=>({str,x,y,w});
  const items=[item('名称： 清风采购中心',35,405),item('名称： 远山材料有限公司',475,405)];
  [['项目名称',40],['规格型号',250],['单位',365],['数量',465],['单价',550],['金额',660],['税率',730],['税额',830]].forEach(([s,x])=>items.push(item(s,x,355)));
  [['实验用连接线',30],['A-12',250],['米',365],['2',480],['50.00',550],['100.00',660],['13%',730],['13.00',830]].forEach(([s,x])=>items.push(item(s,x,310)));
  items.push(item('合计',60,170));
  const result=parseInvoiceItems(items);
  assert.equal(result.buyer,'清风采购中心');assert.equal(result.seller,'远山材料有限公司');
});
