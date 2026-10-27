import {round2} from './utils.js';

export function recordTotal(row) {
  return Number.isFinite(row.amount) && Number.isFinite(row.tax) ? round2(row.amount+row.tax) : null;
}

export function recordIssues(rows) {
  const counts=new Map(),issues=[];
  rows.forEach((row,index)=>{
    const source=row.src||'未标注来源',sourceRow=(counts.get(source)||0)+1;
    counts.set(source,sourceRow);
    const fields=[];
    for(const [key,label,required] of [['amount','金额',true],['tax','税额',true],['qty','数量',false],['price','单价',false]]) {
      const value=row[key],empty=value===null || value===undefined || value==='';
      if((required || !empty) && !Number.isFinite(value))fields.push({key,label,reason:empty?'未填写':'不是有效数字'});
    }
    if(fields.length)issues.push({index,source,sourceRow,name:row.name||'未填写项目名称',fields});
  });
  return issues;
}
