import {round2} from './utils.js';

// Parse coordinates within each page; merge only pages with a matching identity.
// Fold discounts later, so a discount at the next page's top follows its item.
export function combineInvoicePages(pages) {
  const groups=[];
  pages.forEach((invoice,index)=>{
    let group=groups.find(g=>invoice.number && g.number===invoice.number &&
      (!g.seller || !invoice.seller || g.seller===invoice.seller) &&
      (!g.dateISO || !invoice.dateISO || g.dateISO===invoice.dateISO));
    if(!group){group={...invoice,rows:[],warnings:[],totals:[],pageNumbers:[]};groups.push(group);}
    const incoming=invoice.rows.map(row=>({...row}));
    const previous=group.rows.at(-1);
    if(group.pageNumbers.at(-1)===index && incoming[0]?.continuation &&
      previous && Number.isFinite(previous.amount) && /^\*/.test(previous.name)) {
      const tail=incoming.shift();
      previous.name+=tail.name;
      previous.spec+=tail.spec;
    }
    group.rows.push(...incoming);
    group.pageNumbers.push(index+1);
    group.seller ||= invoice.seller;
    group.dateISO ||= invoice.dateISO;
    group.buyer ||= invoice.buyer;
    group.ocr ||= invoice.ocr;
    group.warnings.push(...(invoice.warnings||[]).map(w=>pages.length>1 ? `第 ${index+1} 页：${w}` : w));
    if(Number.isFinite(invoice.totalWithTax))group.totals.push(invoice.totalWithTax);
  });
  for(const group of groups) {
    group.sumAmount=round2(group.rows.reduce((s,r)=>s+(r.amount||0),0));
    group.sumTax=round2(group.rows.reduce((s,r)=>s+(r.tax||0),0));
    const totals=[...new Set(group.totals)];
    group.totalWithTax=totals.at(-1)??null;
    if(totals.length>1)group.warnings.push('同一发票各页的价税合计不同，请核对页次与票号');
    if(group.totalWithTax===null)group.warnings.push('未识别出票面价税合计，无法完成总额核对');
    else if(Math.abs(round2(group.sumAmount+group.sumTax)-group.totalWithTax)>.01)group.warnings.push(`明细合计 ${round2(group.sumAmount+group.sumTax)} 与价税合计 ${group.totalWithTax} 不一致，请核对`);
    delete group.totals;
  }
  return groups;
}
