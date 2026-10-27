// 界面逻辑：上传 → 识别核对 → 设置 → 分组预览 → 生成下载
import { readFiles } from './file-reader.js';
import { buildGroups, buildWorkbook, buildIndividualFiles, TPL } from './excel-output.js';
import { sampleRecords } from './sample-data.js';
import { toNum } from './utils.js';
import {recordIssues,recordTotal} from './record-validation.js';
import {browserOcrStatus} from './browser-ocr.js';
import {createImportQueue} from './import-queue.js';

const state = { records: [], logs: [] };
const $ = (id) => document.getElementById(id);
async function showOcrStatus() {
  const status=browserOcrStatus();
  const element=$('ocr-status');if(!element)return;
  element.textContent=status?.ready ? 'PP-OCRv5 浏览器增强识别 · 首次识别下载模型，票据始终留在本机' : '当前浏览器使用兼容识别，建议使用新版 Chrome 或 Edge 以启用增强识别';
}
showOcrStatus();

// ———— 上传 ————
const drop = $('drop');
const fileInput = $('file');
const importQueue=createImportQueue({
  processFile:(file,options,onProgress)=>readFiles([file],{ocr:true,...options,onProgress}),
  onResult:results=>{
    for(const result of results){state.logs.push(result);if(result.ok)state.records.push(...result.records);}
    renderAll();
  },
  onError:(error,file)=>{
    state.logs.push({src:file.name,ok:false,records:[],warnings:[],message:'读取失败: '+(error.message||error)});
    renderAll();
  },
  onChange:renderQueue,
});

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer?.files?.length) ingest([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) ingest([...fileInput.files]);
  fileInput.value = '';
});
$('btn-sample').addEventListener('click', () => {
  importQueue.clear();
  state.records = sampleRecords.map((r) => ({ ...r }));
  state.logs = [{ src: '示例数据', ok: true, message: `${state.records.length} 行`, warnings: [] }];
  renderAll();
  toast('已载入示例数据');
});
$('btn-clear').addEventListener('click', () => {
  importQueue.clear();
  state.records = [];
  state.logs = [];
  renderAll();
});
$('btn-cancel-waiting').addEventListener('click',()=>importQueue.cancelWaiting());
$('btn-addrow').addEventListener('click', () => {
  state.records.push({ src: '手动', dateISO: todayISO(), seller: '', name: '', spec: '', unit: '', qty: null, price: null, amount: null, tax: 0 });
  renderAll();
});

function ingest(files) {
  importQueue.enqueue(files,{fold:$('chk-fold').checked});
  toast(`已加入 ${files.length} 个文件，将按顺序识别，可继续添加`);
}

function renderQueue(queue) {
  const panel=$('import-queue');
  panel.classList.toggle('hidden',!queue.busy && !queue.finished);
  const active=queue.active;
  const pct=active?.progress?.progress;
  const progress=active?.progress?.message ? ` · ${escapeHtml(active.progress.message)}` : Number.isFinite(pct)?` · ${Math.round(pct*100)}%`:'';
  $('queue-summary').textContent=queue.busy
    ? `${active?.obsolete?'正在结束上一项识别':active?'正在识别 1 个文件':'准备识别'} · 等待 ${queue.waiting.length} 个 · 已处理 ${queue.finished} 个`
    : `队列已完成 · 已处理 ${queue.finished} 个文件`;
  const items=[...(active?[`<li class="doing">${active.obsolete?'正在结束上一项识别，请稍候':'识别中：'+escapeHtml(active.progress?.file||active.name)+progress}</li>`]:[]),
    ...queue.waiting.map((job,i)=>`<li>等待 ${i+1}：${escapeHtml(job.name)}</li>`)];
  $('queue-files').innerHTML=items.join('');
  $('btn-cancel-waiting').disabled=!queue.waiting.length;
  $('btn-gen').disabled=queue.busy;
  $('btn-gen').title=queue.busy?'请等待队列全部处理完毕后导出':'';
}

// ———— 表格渲染与编辑 ————
const COLS = [
  ['dateISO', '开票日期', ''],
  ['seller', '销售方名称', 'name'],
  ['name', '项目名称', 'name'],
  ['spec', '规格型号', ''],
  ['unit', '单位', ''],
  ['qty', '数量', 'num'],
  ['price', '单价', 'num'],
  ['amount', '金额', 'num'],
  ['tax', '税额', 'num'],
];

function renderTable() {
  const tb = $('tbody');
  tb.innerHTML = '';
  const invalid=new Map(recordIssues(state.records).map(issue=>[issue.index,issue.fields]));
  state.records.forEach((r, i) => {
    const tr = document.createElement('tr');
    const rowNumber=document.createElement('td');rowNumber.textContent=String(i+1);rowNumber.title=r.src||'未标注来源';tr.appendChild(rowNumber);
    for (const [field, , cls] of COLS) {
      const td = document.createElement('td');
      td.className = cls;
      const inp = document.createElement('input');
      inp.value = r[field] ?? '';
      inp.title = inp.value;
      inp.dataset.idx = i;
      inp.dataset.field = field;
      inp.setAttribute('aria-label',`第 ${i+1} 行${COLS.find(c=>c[0]===field)[1]}`);
      const problem=invalid.get(i)?.find(f=>f.key===field);
      if(problem){inp.classList.add('invalid-number');inp.setAttribute('aria-invalid','true');inp.placeholder='待核对';inp.title=`${r.src||'未标注来源'} · 第 ${i+1} 行 · ${problem.label}${problem.reason}`;}
      if (field === 'dateISO') inp.placeholder = 'YYYY-MM-DD';
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const tdT = document.createElement('td');
    tdT.className = 'num';
    const total = recordTotal(r);
    tdT.innerHTML = `<input value="${total === null ? '' : total.toFixed(2)}" readonly tabindex="-1">`;
    tr.appendChild(tdT);
    const tdD = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'rowdel';
    del.title = '删除此行';
    del.textContent = '✕';
    del.addEventListener('click', () => { state.records.splice(i, 1); renderAll(); });
    tdD.appendChild(del);
    tr.appendChild(tdD);
    tb.appendChild(tr);
  });
}

$('tbody').addEventListener('input', (e) => {
  const inp = e.target;
  if (!inp.dataset || inp.dataset.field === undefined) return;
  const r = state.records[+inp.dataset.idx];
  const field = inp.dataset.field;
  if (['qty', 'price', 'amount', 'tax'].includes(field)) {
    const v = inp.value.trim();
    r[field] = v === '' ? null : (toNum(v.normalize('NFKC')) ?? v);
  } else {
    r[field] = inp.value.trim();
  }
  const problem=recordIssues([r])[0]?.fields.find(f=>f.key===field);
  inp.classList.toggle('invalid-number',!!problem);
  if(problem){inp.setAttribute('aria-invalid','true');inp.title=problem.label+problem.reason;}
  else{inp.removeAttribute('aria-invalid');inp.title=inp.value;}
  const total=recordTotal(r);
  inp.closest('tr').querySelector('input[readonly]').value=total===null?'':total.toFixed(2);
  renderStats();renderGroups();
});

// ———— 汇总渲染 ————
function currentRows() {
  return state.records.map((r) => {
    const amount = r.amount ?? null;
    const tax = r.tax;
    const total = recordTotal(r);
    return {
      ...r, amount, tax, total,
      priceIncl: r.qty ? (total === null ? null : total / r.qty) : r.price,
    };
  });
}

function renderStats() {
  const rows = currentRows();
  const issues=recordIssues(state.records);
  const sellers = new Set(rows.map((r) => r.seller).filter(Boolean));
  const sum = rows.reduce((s, r) => s + (r.total || 0), 0);
  $('stats').innerHTML = [
    `📄 ${state.logs.length} 个文件`,
    `明细 ${rows.length} 行`,
    `供货单位 ${sellers.size} 家`,
    `${issues.length?'已确认金额':'价税合计'} <b>¥${sum.toFixed(2)}</b>${issues.length?` · ${issues.length} 行待核对`:''}`,
  ].map((t) => `<span class="chip">${t}</span>`).join('');

  const warns = [];
  for (const l of state.logs) for (const w of l.warnings || []) warns.push(`【${l.src}】${w}`);
  for (const r of state.records) {
    if (!r.seller) warns.push(`有明细缺少销售方名称，请补填`);
  }
  const wb = $('warnings');
  if (warns.length) {
    wb.classList.remove('hidden');
    wb.innerHTML = '⚠ ' + [...new Set(warns)].map(escapeHtml).join('<br>⚠ ');
  } else {wb.classList.add('hidden');wb.textContent='';}

  const errors=$('export-errors');
  errors.classList.toggle('hidden',!issues.length);
  errors.innerHTML=issues.length ? `<b>有 ${issues.length} 行数据需要核对，补齐前不能导出。点击下方提示可定位。</b>`+issues.map(issue=>
    `<button type="button" class="issue-link" data-index="${issue.index}" data-field="${issue.fields[0].key}">【${escapeHtml(issue.source)}】来源第 ${issue.sourceRow} 条（表格第 ${issue.index+1} 行）${escapeHtml(issue.name)}：${issue.fields.map(f=>f.label+f.reason).join('、')}</button>`).join('') : '';

  const gl = $('filelog');
  if (state.logs.length) {
    gl.classList.remove('hidden');
    gl.innerHTML = state.logs.map((l) => {
      const cls = l.ok ? 'ok' : 'bad';
      return `<div class="${cls}">${l.ok ? '✓' : '✗'} ${escapeHtml(l.src)} · ${escapeHtml(l.message || '')}${(l.warnings || []).length ? ' · ⚠' + l.warnings.map(escapeHtml).join('；') : ''}</div>`;
    }).join('');
  } else {gl.classList.add('hidden');gl.textContent='';}
}

function renderGroups() {
  const rows = currentRows();
  const opts = readOpts();
  const groups = buildGroups(rows, opts);
  const issues=recordIssues(state.records);
  const incomplete=seller=>issues.filter(issue=>(state.records[issue.index].seller||'未填供货单位').trim()===seller).length;
  $('groups').innerHTML = groups.map((g) => `
    <div class="gcard">
      <b>${escapeHtml(g.seller)}</b>
      <div class="m">明细 ${g.count} 行 · 入库日期 ${g.date || '—'}</div>
      <div>${incomplete(g.seller)?'已确认金额':'小计'}（${opts.pricing==='excl'?'不含税':'含税'}）<b style="display:inline">¥${g.subtotal.toFixed(2)}</b>${incomplete(g.seller)?` · ${incomplete(g.seller)} 行待核对`:''}</div>
    </div>`).join('') || '<p class="hint">暂无数据</p>';
  const total = groups.reduce((s, g) => s + g.subtotal, 0);
  $('totaline').innerHTML = groups.length
    ? `共 <b>${groups.length}</b> 张入库单 · ${issues.length?'已确认合计':'合计'} <b>¥${total.toFixed(2)}</b>${issues.length?` · 另有 ${issues.length} 行待核对`:''}`
    : '';
}

function renderAll() { renderTable(); renderStats(); renderGroups(); }

function focusIssue(index,field) {
  const input=$('tbody').querySelector(`input[data-idx="${index}"][data-field="${field}"]`);
  input?.scrollIntoView({block:'center',inline:'center'});input?.focus({preventScroll:true});
}
$('export-errors').addEventListener('click',event=>{
  const button=event.target.closest('button[data-index]');
  if(button)focusIssue(Number(button.dataset.index),button.dataset.field);
});

// ———— 设置 ————
function readOpts() {
  const sort = $('opt-sort').value;
  return {
    pricing: $('opt-pricing').value,
    mode: $('opt-mode').value,
    perSheet: Number($('opt-persheet').value),
    minRows: Math.max(1, Number($('opt-minrows').value) || 12),
    sheetNaming: $('opt-sheetname').value,
    acceptId: $('opt-acceptid').value.trim(),
    tpl: {
      title: $('opt-title').value.trim() || TPL.title,
      nameLabel: $('opt-namelabel').value.trim() || TPL.nameLabel,
    },
    sort,
  };
}

document.querySelectorAll('#sec-settings select, #sec-settings input').forEach((el) => {
  el.addEventListener('change', renderGroups);
});

// ———— 生成下载 ————
$('btn-gen').addEventListener('click', async () => {
  if(importQueue.snapshot().busy){toast('请等待队列全部处理完毕后导出');return;}
  const issues=recordIssues(state.records);
  if (issues.length) {
    const first=issues[0];
    focusIssue(first.index,first.fields[0].key);
    toast(`共 ${issues.length} 行待核对，已定位第 ${first.index+1} 行：${first.fields.map(f=>f.label+f.reason).join('、')}`);
    return;
  }
  const rows = currentRows().filter((r) => r.name || r.total !== null);
  if (!rows.length) { toast('没有可生成的明细，请先上传发票'); return; }
  const opts = readOpts();
  let groups = buildGroups(rows, opts);
  if (opts.sort === 'name') {
    groups = groups.sort((a, b) => a.seller.localeCompare(b.seller, 'zh'));
  }
  try {
    if (opts.mode === 'files') {
      const files = await buildIndividualFiles(groups, opts);
      const zip = new globalThis.JSZip();
      for (const f of files) zip.file(f.filename, f.buffer);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });
      download(new Blob([buf]), '入库单输出.zip');
      toast(`已生成 ${files.length} 个入库单（zip）`);
    } else {
      const wb = buildWorkbook(groups, opts);
      const buf = await wb.xlsx.writeBuffer();
      download(new Blob([buf]), '入库单汇总.xlsx');
      toast(`已生成 入库单汇总.xlsx（${groups.length} 张单）`);
    }
  } catch (e) {
    console.error(e);
    toast('生成失败：' + (e.message || e));
  }
});

function download(blob, name) {
  // 桌面版（Electron）走系统“另存为”对话框
  if (window.desktop && window.desktop.saveFile) {
    blob.arrayBuffer().then((buf) => window.desktop.saveFile(name, new Uint8Array(buf)));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ———— 杂项 ————
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

renderAll();
