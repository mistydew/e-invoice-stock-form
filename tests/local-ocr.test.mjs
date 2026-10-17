import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDetailLine, parseInvoicePlainText, parseInvoiceItems, foldDiscountRows, mkRow } from '../js/invoice-parser.js';
import { findOcrTable, refineOcrNumericColumns, parseInvoiceOcr, validateOcrInvoice, numeric, invoiceName, findOcrTotal } from '../js/ocr-invoice-parser.js';
import {applyOcrReview} from '../js/rapid-ocr.js';

test('票号、税号和日期不能成为商品金额',()=>{
  for(const text of ['发票号码： 12345678901234567890','发 票 号 码 : 12345678901234567890','纳税人识别号： 123456789012345678','开票日期： 2026年10月01日']) assert.equal(parseDetailLine(text),null);
});
test('数字只拼接小数点附近空格，不能将邻列数字拼成金额',()=>{
  assert.equal(numeric('30. 37'),30.37);
  assert.equal(numeric('3 . 95'),3.95);
  assert.equal(numeric('1                 30.37'),null);
  assert.equal(numeric('10 3.037168'),null);
});
test('名称只合并重复的开头分隔符，保留型号中的井号',()=>{
  assert.equal(invoiceName('*#材料*胶水'),'*材料*胶水');
  assert.equal(invoiceName('*材料*胶水#2'),'*材料*胶水#2');
  assert.equal(invoiceName('ABC#2'),'ABC#2');
});
test('识别合计附近误读的货币符号，仍使用独立的票面数字',()=>{
  const word=(text,x0)=>({text,confidence:90,bbox:{x0,y0:100,x1:x0+40,y1:120}});
  const total=findOcrTotal([{words:[word('(小写)',0),word('对',50),word('34.',100),word('32',145)]}]);
  assert.equal(total.text,'34.32');assert.equal(total.currencyUncertain,true);
});
test('分开的合计标签和货币金额后缀不能变成第二个商品',()=>{
  const word=(text,x0,y0,x1)=>({text,confidence:90,bbox:{x0,y0,x1,y1:y0+20}});
  const words=[word('项目名称',20,100,150),word('规格型号',180,100,250),word('单位',280,100,320),word('数量',400,100,440),word('单价',500,100,540),word('金额',600,100,640),word('税率',700,100,760),word('税额',850,100,900),word('测试商品',20,150,140),word('10',410,150,440),word('3.0371681415929',465,150,550),word('30.',600,150,620),word('37',625,150,640),word('合',20,250,40),word('计',100,250,120),word('¥30.',600,250,620),word('37',625,250,640),word(' ',0,245,1000),word('价税合计',20,300,150)];
  const table=findOcrTable([{words}],1000,400);
  assert.equal(table.rows.length,1);assert.equal(table.end,250);
  assert.ok(table.rows[0].cells.amount.left>550);
});
test('纯文本解析限定在表头和合计之间，并恢复小数点后的空格',()=>{
  const invoice=parseInvoicePlainText('发票号码：12345678901234567890\n开票日期：2026年10月01日\n名称：示例采购单位\n名称：示例销售有限公司\n项目名称 规格型号 单位 数量 单价 金额 税率 税额\n*材料*测试商品 个 2 5. 00 10. 00 13% 1. 30\n合计 10.00 1.30\n备注：订单编号 98765432109876543210');
  assert.equal(invoice.rows.length,1);assert.equal(invoice.rows[0].qty,2);assert.equal(invoice.rows[0].amount,10);assert.equal(invoice.rows[0].tax,1.3);
  assert.equal(invoice.seller,'示例销售有限公司');assert.equal(invoice.number,'12345678901234567890');
  assert.equal(parseInvoicePlainText('发票号码：12345678901234567890').rows.length,0);
});
test('缺失税额保持未知，并报告总额差异，不能默认当作零税额',()=>{
  const word=(text,x0,y0,x1)=>({text,confidence:90,bbox:{x0,y0,x1,y1:y0+20}});
  const invoice=parseInvoiceOcr({passes:[{words:[word('发票号码:12345678901234567890',0,0,250),word('开票日期:2026年10月01日',0,30,250),word('名称:示例采购单位',0,60,180),word('名称:示例销售有限公司',300,60,550),word('(小写)¥11.30',0,250,200)]}],table:{bottom:100},cells:[{name:{text:'测试商品',confidence:90},qty:{text:'2',confidence:90},price:{text:'5',confidence:90},amount:{text:'10',confidence:90},tax:{text:'',confidence:0}}],confidence:90});
  assert.equal(invoice.rows[0].tax,null);assert.equal(invoice.rows[0].total,null);assert.equal(invoice.totalWithTax,11.3);
  assert.ok(invoice.warnings.some(w=>w.includes('税额未识别')));assert.ok(invoice.warnings.some(w=>w.includes('不一致')));
});
test('金额校验独立使用票面合计，并检查数量×单价与金额',()=>{
  const invoice=validateOcrInvoice({seller:'示例单位',number:'12345678',dateISO:'2026-10-01',rows:[mkRow('商品','','个',2,5,20,'13%',2.6)],totalWithTax:11.3});
  assert.ok(invoice.warnings.some(w=>w.includes('数量×单价')));assert.ok(invoice.warnings.some(w=>w.includes('票面 11.3')));
});
test('按表头坐标定位多行商品，票头号码和合计不进入明细',()=>{
  const word=(text,x0,y0,x1)=>({text,confidence:90,bbox:{x0,y0,x1,y1:y0+20}});
  const words=[word('发票号码12345678901234567890',600,10,980)];
  const columns=[['项目名称',20,150],['规格型号',180,250],['单位',280,320],['数量',400,440],['单价',500,540],['金额',600,640],['税率',700,760],['税额',850,900]];
  columns.forEach(([text,left,right])=>words.push(word(text,left,100,right)));
  for(const y of [150,195]) words.push(word('测试商品',20,y,140),word('2',425,y,440),word('5.00',500,y,540),word('10.00',600,y,640),word('13%',700,y,740),word('1.30',850,y,900));
  words.push(word('价税合计',20,260,150),word('22.60',600,260,640));
  const table=findOcrTable([{words}],1000,400);
  assert.equal(table.rows.length,2);
  for(const row of table.rows) for(const box of Object.values(row.cells)) {assert.ok(box.left>=0);assert.ok(box.left+box.width<=1000);assert.ok(box.width>0);}
  assert.ok(table.rows[0].cells.tax.left>table.rows[0].cells.rate.left);
});

test('检测框与表头重叠时仍识别首行，并归并三行名称',()=>{
  const word=(text,x0,y0,x1,y1=y0+28)=>({text,confidence:95,bbox:{x0,y0,x1,y1}});
  const words=[word('项目名称',85,296,170),word('规格型号',233,296,316),word('单位',373,294,441),word('数量',520,294,589),word('单价',664,296,728),word('金额',811,298,874),word('税率',885,298,950),word('税额',1094,294,1165),word('*材料*商品第一行',24,315,225),word('名称第二行',24,342,210),word('名称第三行',24,369,210),word('2',566,320,589,341),word('18.145',595,318,728,341),word('36.29',815,317,874,344),word('价税合计',93,555,234)];
  const table=findOcrTable([{words}],1191,794);
  assert.equal(table.rows.length,1);
  const name=table.rows[0].cells.name;
  assert.ok(name.top+name.height>=397);
  assert.ok(table.bodyTop<330 && table.bodyTop>310);
  assert.ok(table.rows[0].cells.qty.left+table.rows[0].cells.qty.width<=595);
  assert.ok(table.rows[0].cells.price.left>=589);
});

test('合并的金额税率表头使用真实字符坐标分开',()=>{
  const word=(text,x0,x1,y0=100)=>({text,confidence:95,bbox:{x0,y0,x1,y1:y0+20}});
  const merged=word('金额税率',600,760);
  merged.chars=[word('金',600,620),word('额',620,640),word('税',700,720),word('率',720,740)];
  const words=[word('项目名称',20,150),word('规格型号',180,250),word('单位',280,320),word('数量',400,440),word('单价',500,540),merged,word('税额',850,900),word('商品',20,140,150),word('10.00',600,640,150),word('价税合计',20,150,260)];
  const table=findOcrTable([{words}],1000,400);
  assert.equal(table.rows.length,1);assert.equal(table.fields.amount.x1,640);assert.equal(table.fields.rate.x0,700);
});

test('紧邻的数量和单价按字符间隙分开，不能把单价首位移到数量',()=>{
  const char=(text,x0,x1)=>({text,confidence:99,bbox:{x0,y0:320,x1,y1:344}});
  const table={h:28,rows:[{y:332,cells:{qty:{left:448,width:143},price:{left:591,width:154}}}]};
  const merged={text:'204.125',chars:[char('2',562,570),char('0',570,579),char('4',585,594),char('.',594,602),char('1',605,613),char('2',613,621),char('5',621,630)]};
  refineOcrNumericColumns(table,[merged]);
  assert.equal(table.rows[0].cells.qty.left+table.rows[0].cells.qty.width,582);
  assert.equal(table.rows[0].cells.price.left,582);
  assert.equal(table.rows[0].cells.price.left+table.rows[0].cells.price.width,745);
});

test('首行商品字符与表头交错时，不得混入表头导致整票失败',()=>{
  const word=(text,x0,y0,x1,y1=y0+30)=>({text,confidence:95,bbox:{x0,y0,x1,y1}});
  const header=(text,x0,x1)=>{
    const result=word(text,x0,295,x1,326),step=(x1-x0)/text.length;
    result.chars=[...text].map((c,i)=>word(c,x0+i*step,295,x0+(i+1)*step,326));
    return result;
  };
  const item=word('电子材料测试商品',23,314,228,343);
  item.chars=[...item.text].map((c,i)=>word(c,23+i*28,314,48+i*28,343));
  const words=[header('项目名称',86,168),header('规格型号',233,316),header('单位',373,440),header('数量',519,587),header('单价',663,729),header('金额',811,874),header('税率',885,950),header('税额',1094,1165),item,word('件',388,316,420,345),word('2',566,320,589,341),word('18.25',595,318,726,340),word('36.50',816,318,872,343),word('价税合计',93,555,234,582)];
  const table=findOcrTable([{words}],1191,794);
  assert.ok(table);assert.equal(table.rows.length,1);
  assert.equal(table.fields.name.x0,86);assert.equal(table.fields.amount.x1,874);
});

test('所有表头均拆成单个汉字时仍可定位完整明细表',()=>{
  const word=(text,x0,y0,x1)=>({text,confidence:95,bbox:{x0,y0,x1,y1:y0+20}});
  const labels=[['项目名称',20],['规格型号',180],['单位',280],['数量',400],['单价',500],['金额',600],['税率',700],['税额',850]];
  const words=labels.flatMap(([text,x])=>[...text].map((c,i)=>word(c,x+i*15,100,x+(i+1)*15)));
  words.push(word('商品',20,150,140),word('10.00',580,150,630),word('价税合计',20,260,150));
  const table=findOcrTable([{words}],1000,400);
  assert.ok(table);assert.equal(table.rows.length,1);assert.equal(Object.keys(table.fields).length,8);
});

test('PDF 日期和号码按视觉行读取，支持标签内空格及不同基线',()=>{
  const item=(str,x,y,w=30)=>({str,x,y,w});
  const headers=[['项目名称',20],['规格型号',130],['单位',200],['数量',260],['单价',330],['金额',410],['税率',470],['税额',550]].map(([s,x])=>item(s,x,240));
  const invoice=parseInvoiceItems([...headers,item('发 票 号 码 ：',440,357),item('12345678901234567890',485,357.3),item('开 票 日 期 ：',440,340.1),item('2026年10月06日',485,340),item('*材料*示例商品',20,225,70),item('个',200,225,9),item('2',285,225,4),item('5.00',340,225,20),item('10.00',415,225,25),item('13%',470,225,15),item('1.30',565,225,20)]);
  assert.equal(invoice.dateISO,'2026-10-06');assert.equal(invoice.number,'12345678901234567890');assert.equal(invoice.rows.length,1);
});

test('折扣合并只调整净额和入库含税价，不能覆盖票面单价',()=>{
  const product=mkRow('*材料*垫片','M5','件',2,5,10,'13%',1.3);
  const discount=mkRow('*材料*垫片','','',null,null,-1,'13%',-.13);
  const rows=foldDiscountRows([product,discount]);
  assert.equal(rows.length,1);assert.equal(rows[0].price,5);assert.equal(rows[0].amount,9);assert.equal(rows[0].tax,1.17);assert.equal(rows[0].priceIncl,5.085);
  assert.equal(foldDiscountRows([product,discount],'keep').length,2);
});

test('发票负数折扣行合法留空数量单价，不应当作缺失商品字段',()=>{
  const inv=validateOcrInvoice({seller:'示例单位',dateISO:'2026-10-01',number:'12345678',rows:[mkRow('折扣','','',null,null,-1,'13%',-.13)],totalWithTax:-1.13});
  assert.ok(!inv.warnings.some(w=>w.includes('字段缺失')));assert.equal(inv.rows[0].qty,null);
});

test('最后一行商品检测框与合计重叠时保留尾行文字，合计仍被排除',()=>{
  const word=(text,x0,y0,x1,y1=y0+20)=>({text,confidence:95,bbox:{x0,y0,x1,y1}});
  const headers=[['项目名称',20,150],['规格型号',180,250],['单位',280,320],['数量',400,440],['单价',500,540],['金额',600,640],['税率',700,760],['税额',850,900]].map(([t,x0,x1])=>word(t,x0,100,x1));
  const words=[...headers,word('*材料*商品',20,210,140),word('5.00',600,210,640),word('末尾三个字',20,235,140,265),word('合计',20,260,140),word('¥5.00',600,260,640)];
  const table=findOcrTable([{words}],1000,400);
  assert.equal(table.rows.length,1);assert.equal(table.end,260);
  assert.ok(table.rows[0].cells.name.top+table.rows[0].cells.name.height>=265);
});

test('不同型号遇到低质量复核时保留可靠初读，不能按商品内容打补丁',()=>{
  for(const [first,second]of [['8472mAh','842mhh'],['RZ-813B','R2-81B'],['54029','402']]){
    const chars=[{text:first}],word={text:first,confidence:99,chars};
    applyOcrReview(word,{text:second,confidence:70});
    assert.equal(word.text,first);assert.equal(word.chars,chars);assert.equal(word.disagreement,true);
  }
});

test('可靠复核可恢复首次漏掉的文字，并清除旧字符坐标',()=>{
  for(const [first,second]of [['温传感器','温度传感器'],['杜线接口','杜邦线接口'],['AB-24','ABC-24']]){
    const word={text:first,confidence:98,chars:[{text:first}]};
    applyOcrReview(word,{text:second,confidence:97});
    assert.equal(word.text,second);assert.equal(word.chars,undefined);assert.equal(word.disagreement,true);
  }
});

test('更换公司名称且复核标签有误时，销售方字段仍可被提取',()=>{
  for(const seller of ['示例甲电子有限公司','示例乙机械经营部','示例丙五金商行']){
    const word={text:'名称：'+seller,confidence:97};
    applyOcrReview(word,{text:'名您：'+seller,confidence:96});
    assert.equal(word.text,'名称：'+seller);
    const item=(text,x)=>({text,confidence:98,bbox:{x0:x,y0:20,x1:x+160,y1:40}});
    const inv=parseInvoiceOcr({passes:[{words:[item('名称：示例采购单位',0),item(word.text,300)]}],table:{bottom:100},cells:[],confidence:98});
    assert.equal(inv.seller,seller);
  }
});

test('更换商品内容并平移缩放版面，跨行和合计边界规则仍适用',()=>{
  let cases=0;
  for(const scale of [.5,1,1.6,2.4])for(const dx of [0,37])for(const dy of [0,55])for(const name of ['*材料*排针','*电子元件*温度传感器','*耗材*绝缘套管']){
    const word=(text,x0,y0,x1,y1=y0+20)=>({text,confidence:98,bbox:{x0:x0*scale+dx,y0:y0*scale+dy,x1:x1*scale+dx,y1:y1*scale+dy}});
    const headers=[['项目名称',20,150],['规格型号',180,250],['单位',280,320],['数量',400,440],['单价',500,540],['金额',600,640],['税率',700,760],['税额',850,900]].map(([t,x0,x1])=>word(t,x0,100,x1));
    const words=[...headers,word(name,20,150,140),word('5.00',600,150,640),word(name,20,195,140),word('8.00',600,195,640),word('型号尾部',180,220,250,250),word('合计',20,245,140),word('¥13.00',600,245,640)];
    const table=findOcrTable([{words}],1000*scale+dx,400*scale+dy);
    assert.equal(table.rows.length,2,JSON.stringify({scale,dx,dy,name}));
    assert.equal(table.end,245*scale+dy);
    const box=table.rows[1].cells.spec;
    assert.ok(box.top+box.height>=250*scale+dy-1);
    cases++;
  }
  assert.equal(cases,48);
});

test('竖排购销方标题不能把左右公司名称串成一个字段',()=>{
  for(const scale of [.6,1,1.8])for(const offset of [0,73])for(const company of ['示例甲智能科技有限公司','示例乙自动化经营部']){
    const word=(text,x0,y0,x1,y1)=>({text,confidence:98,bbox:{x0:x0*scale+offset,y0:y0*scale+offset,x1:x1*scale+offset,y1:y1*scale+offset}});
    const words=[word('购买方信息',20,90,45,200),word('销售方信息',590,90,615,200),word('名称：示例采购有限公司',55,115,500,142),word('名称：'+company,625,114,1000,142),word('下载次数：',1150,80,1170,170),word('统一社会信用代码/纳税人识别号：123456789012345678',55,155,550,180),word('统一社会信用代码/纳税人识别号：987654321098765432',625,155,1110,180)];
    const inv=parseInvoiceOcr({passes:[{words:words.reverse()}],table:{bottom:220*scale+offset},cells:[],confidence:98});
    assert.equal(inv.seller,company);assert.equal(inv.buyer,'示例采购有限公司');
    assert.ok(!inv.warnings.some(w=>w.includes('销售方')));
  }
});

test('相邻或合框的两个名称标签都形成独立字段',()=>{
  const word=(text,x0,x1)=>({text,confidence:98,bbox:{x0,y0:20,x1,y1:40}});
  for(const words of [
    [word('名称：示例采购单位',0,180),word('名称：示例销售有限公司',185,500)],
    [word('名称：示例采购单位名称：示例销售有限公司',0,500)],
    [word('名',0,20),word('称',20,40),word('：',40,50),word('示例采购单位',50,180),word('名',185,205),word('称',205,225),word('：',225,235),word('示例销售有限公司',235,500)]
  ]){
    const inv=parseInvoiceOcr({passes:[{words}],table:{bottom:100},cells:[],confidence:98});
    assert.equal(inv.buyer,'示例采购单位');assert.equal(inv.seller,'示例销售有限公司');
  }
});

test('规格从居中表头左侧开始时，按实际文字间隙分开名称和规格',()=>{
  for(const scale of [.6,1,1.8])for(const dx of [0,57]){
    const word=(text,x0,y0,x1)=>({text,confidence:98,bbox:{x0:x0*scale+dx,y0:y0*scale,x1:x1*scale+dx,y1:(y0+25)*scale}});
    const headers=[['项目名称',85,165],['规格型号',260,330],['单位',400,465],['数量',520,585],['单价',665,730],['金额',810,880],['税率',895,950],['税额',1095,1160]].map(([t,x0,x1])=>word(t,x0,100,x1));
    const name=word('*设备*教学装置',25,140,212),spec=word('AB-731(PRO-',220,140,390),tail=word('32GB,增强版)',220,170,350);
    const table=findOcrTable([{words:[...headers,name,spec,word('说明续行',25,170,190),tail,word('10.00',810,140,880),word('价税合计',90,300,230)]}],1200*scale+dx,450*scale);
    assert.equal(table.rows.length,1);
    const cells=table.rows[0].cells;
    const belongs=(w,b)=>w.bbox.x0+2>=b.left && w.bbox.x0+2<b.left+b.width;
    assert.ok(belongs(name,cells.name));assert.ok(!belongs(spec,cells.name));
    assert.ok(belongs(spec,cells.spec));assert.ok(belongs(tail,cells.spec));
  }
});

test('规格为空时不因商品名称越过表头中心而拆分长名称',()=>{
  const word=(text,x0,y0,x1)=>({text,confidence:98,bbox:{x0,y0,x1,y1:y0+25}});
  const headers=[['项目名称',85,165],['规格型号',260,330],['单位',400,465],['数量',520,585],['单价',665,730],['金额',810,880],['税率',895,950],['税额',1095,1160]].map(([t,x0,x1])=>word(t,x0,100,x1));
  const table=findOcrTable([{words:[...headers,word('*材料*较长商品完整说明',25,140,380),word('件',415,140,445),word('10.00',810,140,880),word('价税合计',90,300,230)]}],1200,450);
  assert.equal(table.rows.length,1);assert.ok(table.rows[0].cells.name.left+table.rows[0].cells.name.width>240);
});
