// Invoice-specific layout parsing for local OCR. Coordinates stay in image pixels.
import { mkRow } from './invoice-parser.js';
import { parseDate, round2, toNum } from './utils.js';

const FIELDS = [['name','项目名称'],['spec','规格型号'],['unit','单位'],['qty','数量'],['price','单价'],['amount','金额'],['rate','税率'],['tax','税额']];
const compact = s => String(s || '').normalize('NFKC').replace(/\s/g,'');
const labelText = s => compact(s).replace(/[^\u4e00-\u9fff]/g,'');
const median = a => a.length ? [...a].sort((a,b)=>a-b)[Math.floor(a.length/2)] : 20;
const centerY = w => (w.bbox.y0+w.bbox.y1)/2;
const HEADER_GLYPHS = new Set(FIELDS.map(([,label])=>label).join('')+'征收率');
function isHeaderFragment(word) {
  const text=compact(word.text).replace(/[:/()]/g,'');
  // Filter at the original word level: item names, units and numbers must not
  // enter a header just because their detection boxes overlap its vertical band.
  return text.length>0 && [...text].every(character=>HEADER_GLYPHS.has(character));
}
export function groupOcrLines(words) {
  words=words.filter(w=>w.text?.trim()); // Tesseract also emits page rules as blank "words".
  const height = median(words.filter(w=>w.bbox.y1>w.bbox.y0).map(w=>w.bbox.y1-w.bbox.y0));
  const lines=[];
  for(const word of [...words].sort((a,b)=>centerY(a)-centerY(b)||a.bbox.x0-b.bbox.x0)) {
    let line=lines.find(l=>Math.abs(l.y-centerY(word))<height*.65);
    if(!line) {line={y:centerY(word),words:[]};lines.push(line);}
    line.words.push(word);line.y=median(line.words.map(centerY));
  }
  return lines.sort((a,b)=>a.y-b.y).map(l=>({...l,words:l.words.sort((a,b)=>a.bbox.x0-b.bbox.x0)}));
}

export function findOcrTable(passes,width,height) {
  const candidates=[];
  for(const pass of passes) {
    const h=median(pass.words.map(w=>w.bbox.y1-w.bbox.y0).filter(h=>h>5));
    // Some detectors combine neighbouring headers into one box. Character boxes
    // recover their actual positions without dividing text into equal widths.
    const headerSources=pass.words.filter(isHeaderFragment);
    const headerWords=headerSources.flatMap(w=>w.chars?.length ? w.chars : [w]);
    for(const seed of headerSources) {
      const line=headerWords.filter(w=>Math.abs(centerY(w)-centerY(seed))<h*.5).sort((a,b)=>a.bbox.x0-b.bbox.x0);
      const fields={};
      for(let i=0;i<line.length;i++) {
        let joined='';
        for(let j=i;j<Math.min(i+5,line.length);j++) {
          if(j>i && line[j].bbox.x0-line[j-1].bbox.x1>h*4) break;
          joined+=labelText(line[j].text);
          for(const [key,label] of FIELDS) if(!fields[key] && joined===label) {
            fields[key]={key,x0:line[i].bbox.x0,x1:Math.max(...line.slice(i,j+1).map(w=>w.bbox.x1)),y0:median(line.slice(i,j+1).map(w=>w.bbox.y0)),y1:median(line.slice(i,j+1).map(w=>w.bbox.y1))};
          }
        }
      }
      if(fields.amount && fields.price && fields.qty) candidates.push({fields,h,y:seed.bbox.y0,count:Object.keys(fields).length});
    }
  }
  candidates.sort((a,b)=>b.count-a.count||a.y-b.y);
  if(!candidates.length) return null;
  const best=candidates[0];
  for(const candidate of candidates) if(Math.abs(candidate.y-best.y)<best.h) {
    for(const [key,field] of Object.entries(candidate.fields)) if(!best.fields[key]) best.fields[key]=field;
  }
  if(!best.fields.name) return null;
  const fields=best.fields;
  const bottom=median(Object.values(fields).map(f=>f.y1));
  const headerY=median(Object.values(fields).map(f=>(f.y0+f.y1)/2));
  const all=passes[0].words;
  const stops=passes.flatMap(p=>groupOcrLines(p.words)).filter(l=>{
    if(l.y<=bottom+best.h) return false;
    const text=compact(l.words.map(w=>w.text).join(''));
    const left=compact(l.words.filter(w=>w.bbox.x0<fields.qty.x0).map(w=>w.text).join(''));
    return /价税合计|小写|备注|开[票标]人/.test(text) || /^合计[¥￥\d.,]*$/.test(left);
  });
  const end=stops.length ? Math.min(...stops.map(l=>Math.min(...l.words.map(w=>w.bbox.y0)))) : height;
  // Detection boxes include margins and can overlap vertically even when the
  // printed header and first item are distinct. Compare their centres.
  const body=all.filter(w=>centerY(w)>headerY+best.h*.45 && centerY(w)<end && w.bbox.x0<width);
  // Anchor rows on actual numbers in the amount column, never on arbitrary page text.
  const amount=fields.amount;
  const anchors=body.filter(w=>/[0-9]/.test(w.text) && !/[¥￥]/.test(w.text) && Math.abs(w.bbox.x1-amount.x1)<best.h*2.2);
  const groups=groupOcrLines(anchors);
  const rows=[];
  for(const line of groups) {
    const members=body.filter(w=>Math.abs(centerY(w)-line.y)<best.h*.9);
    const nameEnd=(fields.spec?.x0 || fields.unit?.x0 || fields.qty.x0)-best.h*.5;
    const names=members.filter(w=>w.bbox.x0<nameEnd && /[\u4e00-\u9fffA-Za-z]/.test(w.text));
    if(!names.length) continue;
    const top=Math.max(headerY,Math.min(...members.map(w=>w.bbox.y0))-best.h*.15);
    const next=groups[groups.indexOf(line)+1];
    const lower=Math.min(end,Math.max(...members.map(w=>w.bbox.y1))+best.h*.3,next ? (line.y+next.y)/2 : end);
    const cells={};
    let previousRight=0;
    for(const [key] of FIELDS) {
      const field=fields[key];if(!field) continue;
      let left,right;
      if(key==='name') {left=0;right=nameEnd;}
      else if(key==='spec') {left=field.x0-best.h*.3;right=(fields.unit?.x0 || fields.qty.x0)-best.h*.5;}
      else if(key==='unit') {left=field.x0-best.h*.5;right=(field.x1+fields.qty.x0)/2;}
      else {left=previousRight+best.h*.2;right=field.x1+best.h*.7;}
      // A long price can extend beyond its header. Start the amount cell in the
      // whitespace between columns, then refine to the actual OCR word boxes.
      if(key==='amount') left=(fields.price.x1+field.x0)/2;
      if(key==='qty') left=(fields.unit?.x1 || fields.spec?.x1 || nameEnd)+best.h*.3;
      if(key==='qty') right=field.x1+best.h*.15;
      if(key==='price') left=fields.qty.x1+best.h*.15;
      if(key==='rate' && fields.tax) right=(field.x0+fields.tax.x0)/2;
      if(key==='tax') {left=fields.rate ? (fields.rate.x0+field.x0)/2 : left;right=width;}
      const leftPixel=Math.min(width-1,Math.max(0,Math.round(left)));
      const rightPixel=Math.min(width,Math.max(leftPixel+1,Math.round(right)));
      cells[key]={left:leftPixel,top:Math.round(top),width:rightPixel-leftPixel,height:Math.max(1,Math.round(lower-top))};
      previousRight=field.x1;
    }
    // A product description may wrap over several lines while amounts occur
    // only on the first line. Attach contiguous text up to the next item.
    for(const key of ['name','spec']) if(cells[key]) {
      const box=cells[key];
      const limit=next ? next.y-best.h*.6 : end;
      const textLines=groupOcrLines(body.filter(w=>w.bbox.x0>=box.left-best.h*.2 && w.bbox.x0<box.left+box.width && centerY(w)>=line.y-best.h*.6 && centerY(w)<limit));
      let last=line.y, textBottom=top;
      for(const continuation of textLines) {
        if(continuation.y-last>best.h*1.8)break;
        textBottom=Math.max(textBottom,...continuation.words.map(w=>w.bbox.y1));last=continuation.y;
      }
      box.height=Math.max(box.height,Math.ceil(textBottom+best.h*.1-top));
    }
    rows.push({cells,y:line.y});
  }
  // Headers are centred inside columns; their left edges are not cell borders.
  // When name and specification touch, use gaps between actual word boxes on
  // the same row, close to the midpoint of the two header centres. A long name
  // in an otherwise empty specification column has no such pair and is kept.
  if(fields.spec) {
    const nominal=(fields.name.x0+fields.name.x1+fields.spec.x0+fields.spec.x1)/4;
    const specCenter=(fields.spec.x0+fields.spec.x1)/2;
    for(const row of rows) {
      const name=row.cells.name,spec=row.cells.spec;
      const local=body.filter(w=>centerY(w)>=name.top && centerY(w)<name.top+name.height && w.bbox.x0<spec.left+spec.width);
      const gaps=[];
      for(const line of groupOcrLines(local))for(let i=1;i<line.words.length;i++) {
        const left=line.words[i-1],right=line.words[i];
        const boundary=(left.bbox.x1+right.bbox.x0)/2;
        if(right.bbox.x0>=left.bbox.x1 && left.bbox.x0<nominal && right.bbox.x1>specCenter &&
           Math.abs(boundary-nominal)<best.h && right.bbox.x0<fields.spec.x0)
          gaps.push(boundary);
      }
      if(gaps.length) {
        gaps.sort((a,b)=>Math.abs(a-nominal)-Math.abs(b-nominal));
        const boundary=Math.round(gaps[0]),right=spec.left+spec.width;
        name.width=boundary-name.left;spec.left=boundary;spec.width=right-boundary;
      }
    }
  }
  return {fields,rows,bottom,bodyTop:headerY+best.h*.45,end,h:best.h};
}

export function refineOcrNumericColumns(table,words) {
  if(!table)return table;
  for(const row of table.rows) {
    const qty=row.cells.qty,price=row.cells.price;if(!qty || !price)continue;
    const nominal=price.left;
    const chars=words.flatMap(w=>w.chars || [w]).filter(w=>/[\d.]/.test(w.text) && Math.abs(centerY(w)-row.y)<table.h*.65 && w.bbox.x0>qty.left && w.bbox.x1<price.left+price.width).sort((a,b)=>a.bbox.x0-b.bbox.x0);
    const gaps=[];
    for(let i=1;i<chars.length;i++) {
      const left=chars[i-1].bbox.x1,right=chars[i].bbox.x0,center=(left+right)/2;
      if(right-left>table.h*.13 && Math.abs(center-nominal)<table.h*.7)gaps.push({center,gap:right-left});
    }
    gaps.sort((a,b)=>Math.abs(a.center-nominal)-Math.abs(b.center-nominal)||b.gap-a.gap);
    if(!gaps.length)continue;
    const boundary=Math.round(gaps[0].center),priceRight=price.left+price.width;
    qty.width=boundary-qty.left;price.left=boundary;price.width=priceRight-boundary;
  }
  return table;
}

function nameText(s) {
  return String(s||'').normalize('NFKC').trim().replace(/(?<=[\u4e00-\u9fff*])\s+|\s+(?=[\u4e00-\u9fff*])/g,'');
}
export function invoiceName(s) {
  const text=nameText(s);
  // Only collapse a duplicated opening classification delimiter. Never remove
  // hashes in a product model or inside the classification text.
  return text.replace(/^\*#+(?=[\u4e00-\u9fff]+\*)/,'*');
}
export function numeric(s) {
  // Only reconnect whitespace at a decimal separator, never arbitrary numbers.
  const value=String(s||'').normalize('NFKC').trim().replace(/(\d)\s*\.\s*(?=\d)/g,'$1.').replace(/[¥￥,，]/g,'');
  return /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? toNum(value) : null;
}
export function validateOcrInvoice(inv, {checkTotal=true} = {}) {
  const warnings=[...(inv.warnings||[])];
  if(!inv.seller) warnings.push('未识别出销售方名称，请补填');
  if(!inv.dateISO) warnings.push('未识别出开票日期，请补填');
  if(!inv.number) warnings.push('未识别出发票号码，请核对');
  if(!inv.rows.length) warnings.push('未能可靠识别商品表格，请手动补录');
  inv.rows.forEach((r,i)=>{
    const label=`第 ${i+1} 行`;
    const discount=r.amount!==null && r.amount<0 && r.qty===null && r.price===null;
    if(!r.name || r.amount===null || (!discount && (r.qty===null || r.price===null))) warnings.push(`${label}有字段缺失，请核对名称、数量、单价和金额`);
    if(r.qty!==null && r.price!==null && r.amount!==null && Math.abs(round2(r.qty*r.price)-r.amount)>.02) warnings.push(`${label}数量×单价与金额不一致，请核对`);
    if(r.tax===null) warnings.push(`${label}税额未识别，尚不能确认含税金额`);
    const rate=String(r.rate||'').match(/^(\d+(?:\.\d+)?)%$/);
    if(r.rate && !rate && !/免税|不征税|^\*+$/.test(r.rate)) warnings.push(`${label}税率格式不完整，请核对`);
    if(rate && r.amount!==null && r.tax!==null && Math.abs(round2(r.amount*Number(rate[1])/100)-r.tax)>.02) warnings.push(`${label}金额×税率与税额不一致，请核对`);
  });
  inv.sumAmount=round2(inv.rows.reduce((s,r)=>s+(r.amount||0),0));
  inv.sumTax=round2(inv.rows.reduce((s,r)=>s+(r.tax||0),0));
  if(checkTotal && inv.totalWithTax===null) warnings.push('未识别出票面价税合计，无法完成总额核对');
  else if(checkTotal && inv.rows.length && Math.abs(round2(inv.sumAmount+inv.sumTax)-inv.totalWithTax)>.01) warnings.push(`明细含税合计 ${round2(inv.sumAmount+inv.sumTax)} 与票面 ${inv.totalWithTax} 不一致，请核对`);
  inv.warnings=[...new Set(warnings)];
  return inv;
}

export function findOcrTotal(passes) {
  for(const pass of passes) for(const line of groupOcrLines(pass.words)) {
    const text=compact(line.words.map(w=>w.text).join(''));
    const match=text.match(/[（(]小写[)）][^\d+\-.]{0,2}([-+]?\d+\.\d{2})(?!\d)/);
    if(!match) continue;
    const amountWords=line.words.filter(w=>/\d/.test(w.text));
    if(!amountWords.length) continue;
    // Decimal amount nearest the label; words for uppercase money contain no digits.
    return {text:match[1],confidence:Math.min(...amountWords.map(w=>w.confidence)),currencyUncertain:/[（(]小写[)）][^\d¥￥+\-.]/.test(text)};
  }
  return null;
}

export function parseInvoiceOcr({passes,table,cells,confidence,checkTotal=true}) {
  // Vertical side labels span several horizontal lines. Including their tall
  // boxes inflates line spacing and joins buyer/seller names across columns.
  const headerWords=passes[0].words.filter(w=>(!table || w.bbox.y0<table.bottom) &&
    !(compact(w.text).length>1 && w.bbox.y1-w.bbox.y0>(w.bbox.x1-w.bbox.x0)*1.5));
  const lines=groupOcrLines(headerWords).flatMap(l=>{
    const segments=[[]];
    const h=median(l.words.map(w=>w.bbox.y1-w.bbox.y0));
    for(const word of l.words) {
      const last=segments.at(-1).at(-1);
      const anotherName=/^名称[:：]/.test(compact(word.text)) && /名称[:：]/.test(compact(segments.at(-1).map(w=>w.text).join('')));
      if(last && (word.bbox.x0-last.bbox.x1>h*3 || anotherName)) segments.push([]);
      segments.at(-1).push(word);
    }
    return segments.map(s=>compact(s.map(w=>w.text).join('')));
  });
  const header=lines.join('\n');
  const number=header.match(/发[票景]号码[：:]?(\d{8,20})/)?.[1] || null;
  const date=header.match(/开[票标]日期[：:]?(\d{4}年\d{1,2}月\d{1,2}[日晶]?)/)?.[1];
  // Bound repeated labels even when OCR emitted both fields in a single box.
  const partyText=header.replace(/(?=名称[:：])/g,'\n');
  const names=[...partyText.matchAll(/名称[：:]([\u4e00-\u9fffA-Za-z0-9（）()·&]{2,80})/g)].map(m=>m[1]);
  const total=findOcrTotal(passes);
  const totalText=total?.text;
  const warnings=[];
  if(total?.currencyUncertain) warnings.push('票面合计旁的货币符号识别不清，请核对价税合计');
  const rows=(cells||[]).map((cell,i)=>{
    const tax=numeric(cell.tax?.text);
    const rate=compact(cell.rate?.text);
    const name=invoiceName(cell.name?.text);
    if(name!==nameText(cell.name?.text)) warnings.push(`第 ${i+1} 行名称开头的分类分隔符已规范化，请核对商品名称`);
    const row=mkRow(name,nameText(cell.spec?.text),nameText(cell.unit?.text),numeric(cell.qty?.text),numeric(cell.price?.text),numeric(cell.amount?.text),rate,tax);
    const exempt=/免税|不征税|^\*+$/.test(rate);
    if(tax===null && !exempt) {row.tax=null;row.total=null;row.priceIncl=null;}
    const uncertain=Object.entries(cell).filter(([key,c])=>c.text?.trim() && (c.confidence<65 || c.disagreement)).map(([key])=>({name:'名称',spec:'规格',unit:'单位',qty:'数量',price:'单价',amount:'金额',rate:'税率',tax:'税额'}[key]||key));
    if(uncertain.length) warnings.push(`第 ${i+1} 行${uncertain.join('、')}识别把握较低，请对照原图核对`);
    return row;
  }).filter(r=>r.name || r.amount!==null);
  if(confidence<65) warnings.push('图片整体识别把握较低，请逐项核对');
  return validateOcrInvoice({number,dateISO:parseDate(date),seller:names.length>=2 ? names.at(-1) : null,buyer:names[0]||null,rows,totalWithTax:numeric(totalText),warnings},{checkTotal});
}
