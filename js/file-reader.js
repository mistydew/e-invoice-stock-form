// 文件读取与识别调度：PDF / OFD / 图片(OCR) / ZIP / XLSX / CSV → 结构化发票记录
// 仅浏览器环境（依赖全局 pdfjsLib / JSZip / ExcelJS / Tesseract 动态加载）
import { parseInvoiceItems, parseInvoicePlainText, rowsFromTableMatrix, foldDiscountRows } from './invoice-parser.js';

const TESSERACT_SOURCES = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
];

/** 批量读取文件（含 zip 解包）。返回 [{src, ok, records, warnings, message}] */
export async function readFiles(fileList, opts = {}) {
  const out = [];
  for (const f of fileList) {
    await handleEntry({ name: f.name, file: f }, '', out, opts);
  }
  return out;
}

async function handleEntry(entry, prefix, out, opts) {
  const name = (prefix ? prefix + '/' : '') + entry.name;
  const lower = entry.name.toLowerCase();
  try {
    if (lower.endsWith('.zip')) {
      const buf = entry.file ? await entry.file.arrayBuffer() : entry.buffer;
      const zip = await globalThis.JSZip.loadAsync(buf);
      const entries = [];
      for (const [path, z] of Object.entries(zip.files)) {
        if (z.dir) continue;
        const base = path.split('/').pop();
        if (/^(~\$|\._)/.test(base)) continue;
        entries.push({ name: path, buffer: await z.async('arraybuffer') });
      }
      // 同 zip 内按文件名排序，保证顺序稳定
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      for (const e of entries) await handleEntry(e, name, out, opts);
      return;
    }

    const buffer = entry.file ? await entry.file.arrayBuffer() : entry.buffer;
    let result;
    if (lower.endsWith('.pdf')) result = await readPdf(buffer, name, opts);
    else if (lower.endsWith('.ofd')) result = await readOfd(buffer, name, opts);
    else if (/\.(png|jpe?g|webp|bmp|gif)$/.test(lower)) result = await readImage(buffer, name, opts);
    else if (/\.xlsx?$/.test(lower)) result = await readXlsx(buffer, name);
    else if (lower.endsWith('.csv')) result = await readCsv(buffer, name);
    else {
      out.push({ src: name, ok: false, records: [], warnings: [], message: '不支持的文件类型' });
      return;
    }
    out.push({ src: name, ...result });
  } catch (e) {
    out.push({ src: name, ok: false, records: [], warnings: [], message: '读取失败: ' + (e.message || e) });
  }
}

// —— PDF：文本层抽取；无文本层（扫描件/路径字）自动转 OCR ——
export async function readPdf(buffer, name, opts = {}) {
  const pdfjsLib = globalThis.pdfjsLib;
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const items = [];
  let textLen = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      items.push({ x: it.transform[4], y: it.transform[5] + p * 2000, w: it.width || 0, str: it.str });
      textLen += it.str.trim().length;
    }
  }
  let inv = parseInvoiceItems(items);
  if (!inv.rows.length && textLen < 80 && opts.ocr !== false) {
    // 文本层为空/过少 → 渲染页面 OCR
    opts.onProgress?.({ file: name, stage: 'ocr' });
    let text = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const canvas = await renderPage(page);
      text += (await ocrCanvas(canvas, opts.onProgress, name)) + '\n';
    }
    inv = parseInvoicePlainText(text);
  }
  return toResult(inv, name, opts);
}

// —— OFD：解包 Content.xml 取 TextCode 坐标文本 ——
export async function readOfd(buffer, name, opts = {}) {
  const zip = await globalThis.JSZip.loadAsync(buffer);
  const items = [];
  let pageNum = 0;
  const paths = Object.keys(zip.files)
    .filter((p) => /Content\.xml$/i.test(p) && /Pages/i.test(p))
    .sort();
  for (const p of paths) {
    pageNum++;
    const xml = await zip.files[p].async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const nodes = doc.getElementsByTagName('*');
    for (const n of nodes) {
      if (!/:?TextCode$/.test(n.tagName)) continue;
      const t = (n.textContent || '').trim();
      if (!t) continue;
      // OFD 的 Y 向下为正，翻转成类似 PDF 的坐标系
      items.push({ x: Number(n.getAttribute('X') || 0), y: -Number(n.getAttribute('Y') || 0) + pageNum * 2000, w: Number(n.getAttribute('DeltaX') || 0), str: t });
    }
  }
  let inv = parseInvoiceItems(items);
  if (!inv.rows.length && opts.ocr !== false) {
    inv = parseInvoicePlainText(items.map((i) => i.str).join('\n'));
  }
  return toResult(inv, name, opts);
}

// —— 图片：OCR ——
export async function readImage(buffer, name, opts = {}) {
  const blob = new Blob([buffer]);
  const text = await ocrBlob(blob, opts.onProgress, name);
  return toResult(parseInvoicePlainText(text), name, opts);
}

// —— XLSX：任意明细表导入（发票明细/入库单明细均可） ——
export async function readXlsx(buffer, name) {
  const wb = new globalThis.ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let rows = [];
  for (const ws of wb.worksheets) {
    const matrix = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const arr = [];
      row.eachCell({ includeEmpty: true }, (c, i) => {
        let v = c.value;
        if (v && typeof v === 'object') v = v.result ?? v.text ?? '';
        arr[i - 1] = v;
      });
      matrix.push(arr);
    });
    rows = rows.concat(rowsFromTableMatrix(matrix).map((r) => ({ ...r, sheet: ws.name })));
  }
  return {
    ok: rows.length > 0,
    records: rows,
    warnings: rows.length ? [] : ['未识别出明细列（需包含 名称/数量 等表头）'],
    message: `表格导入 ${rows.length} 行`,
  };
}

export async function readCsv(buffer, name) {
  const text = new TextDecoder('utf-8').decode(buffer);
  const matrix = text.split(/\r?\n/).filter(Boolean).map((l) => l.split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
  const rows = rowsFromTableMatrix(matrix);
  return {
    ok: rows.length > 0,
    records: rows,
    warnings: rows.length ? [] : ['未识别出明细列'],
    message: `CSV 导入 ${rows.length} 行`,
  };
}

// —— OCR（懒加载 tesseract.js，首次需下载中文识别模型） ——
let tesseractLoading = null;
async function loadTesseract() {
  if (globalThis.Tesseract) return globalThis.Tesseract;
  if (!tesseractLoading) {
    tesseractLoading = (async () => {
      for (const src of TESSERACT_SOURCES) {
        try {
          await loadScript(src);
          if (globalThis.Tesseract) return globalThis.Tesseract;
        } catch (e) { /* 尝试下一个源 */ }
      }
      throw new Error('OCR 组件加载失败（需要联网）');
    })();
  }
  return tesseractLoading;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('load fail: ' + src)); };
    document.head.appendChild(s);
  });
}

export async function ocrBlob(blob, onProgress, name) {
  const T = await loadTesseract();
  const worker = await T.createWorker('chi_sim+eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.({ file: name, stage: 'ocr', progress: m.progress });
    },
  });
  try {
    const { data } = await worker.recognize(blob);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

async function renderPage(page) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

function ocrCanvas(canvas, onProgress, name) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      try { resolve(await ocrBlob(blob, onProgress, name)); } catch (e) { reject(e); }
    }, 'image/png');
  });
}

function toResult(inv, name, opts = {}) {
  const rows = foldDiscountRows(inv.rows, opts.fold === false ? 'keep' : 'merge');
  const records = rows.map((r) => ({
    ...r,
    dateISO: inv.dateISO,
    seller: inv.seller,
    invoiceNo: inv.number,
    src: name,
  }));
  return {
    ok: records.length > 0 && !!inv.seller,
    records,
    warnings: inv.warnings || [],
    message: `${records.length} 行`,
  };
}
