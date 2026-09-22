// 发票解析核心：把 PDF/OFD 的文本块或 OCR 纯文本解析成结构化发票数据。
// 纯函数模块，Node 与浏览器通用（方便离线测试）。
import { toNum, parseDate, round2 } from './utils.js';

const NUM_RE = /^[-+]?[¥￥]?\s*[\d,]*\.?\d+\s*%?$/;
const NUM_PLAIN = /^[-+]?[\d,]*\.?\d+$/;

/**
 * 解析带坐标的文本块（pdf.js getTextContent / OFD TextCode）。
 * items: [{x, y, w, str}]  x/y 为页面坐标（pdf 坐标系 y 向上）。
 */
export function parseInvoiceItems(items) {
  const clean = items
    .filter((it) => it && it.str && it.str.trim())
    .map((it) => ({ x: it.x || 0, y: it.y || 0, w: it.w || 0, str: String(it.str) }));
  if (!clean.length) return emptyInvoice('空白文档');

  // 视觉阅读顺序：自上而下、自左而右
  clean.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const bandInfo = detectBands(clean);
  if (!bandInfo) return emptyInvoice('未找到明细表头（可能不是发票，或为扫描件/图片）');

  // 表头上方：发票号码 / 开票日期 / 购销方名称
  const above = clean.filter((it) => it.y > bandInfo.headerY + 3);
  const number = matchFirst(above, /发票号码\s*[：:]\s*(\d{8,20})/);
  const dateISO = parseDate(joinText(above).match(/开票日期\s*[：:]\s*([\d\s年月日\/\-.]+)/)?.[1]);
  const names = partyNames(above);

  // 明细区（到合计/价税合计行为止）
  const cutY = totalsCutY(clean, bandInfo.headerY);
  const detailItems = clean.filter((it) => it.y <= bandInfo.headerY - 2 && it.y > cutY);
  const rows = parseDetailBlocks(detailItems, bandInfo);

  const sumAmount = round2(rows.reduce((s, r) => s + (r.amount || 0), 0));
  const sumTax = round2(rows.reduce((s, r) => s + (r.tax || 0), 0));
  const totalWithTax = findTotalWithTax(clean, rows.length ? round2(sumAmount + sumTax) : null);

  const warnings = [];
  if (totalWithTax !== null && rows.length && Math.abs(round2(sumAmount + sumTax) - totalWithTax) > 0.01) {
    warnings.push(`明细合计 ${round2(sumAmount + sumTax)} 与价税合计 ${totalWithTax} 不一致，请核对`);
  }
  if (!rows.length) warnings.push('未识别出明细行，请手动补录');
  if (!names.seller) warnings.push('未识别出销售方名称');
  if (!dateISO) warnings.push('未识别出开票日期');

  return { number: number || null, dateISO, seller: names.seller, buyer: names.buyer, rows, totalWithTax, sumAmount, sumTax, warnings };
}

/** OCR/纯文本路径：按行 + 行尾数字列解析（无坐标信息，尽力识别） */
export function parseInvoicePlainText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return emptyInvoice('空白文本');

  const number = matchFirst(lines, /发票号码\s*[：:]\s*(\d{8,20})/);
  const dateISO = parseDate((lines.find((l) => /开票日期/.test(l)) || '').replace(/.*开票日期\s*[：:]\s*/, ''));
  const seller = sellerFromText(lines);

  const rows = [];
  for (const line of lines) {
    if (/合计|价税合计|小写|大写|开票人|收款人|复核/.test(line)) continue;
    const row = parseDetailLine(line);
    if (row) rows.push(row);
  }

  const sumAmount = round2(rows.reduce((s, r) => s + (r.amount || 0), 0));
  const sumTax = round2(rows.reduce((s, r) => s + (r.tax || 0), 0));
  const totalWithTax = findTotalWithTax(lines.map((str) => ({ x: 0, y: 0, w: 0, str })), rows.length ? round2(sumAmount + sumTax) : null);
  const warnings = [];
  if (totalWithTax !== null && rows.length && Math.abs(round2(sumAmount + sumTax) - totalWithTax) > 0.01) {
    warnings.push(`明细合计 ${round2(sumAmount + sumTax)} 与价税合计 ${totalWithTax} 不一致，请核对`);
  }
  if (!rows.length) warnings.push('未识别出明细行（OCR 结果可能不完整），请手动补录');
  return { number: number || null, dateISO, seller, buyer: null, rows, totalWithTax, sumAmount, sumTax, warnings };
}

/** 解析单行纯文本明细（OCR 用）：*分类*品名 [规格] [单位] 数量 单价 金额 税率 税额 */
export function parseDetailLine(line) {
  const src = String(line || '').trim();
  if (!src || !/[一-龥]/.test(src)) return null;
  const tokens = src.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const nums = [];
  for (let i = tokens.length - 1; i >= 0 && nums.length < 6; i--) {
    const t = tokens[i];
    if (/^(免税|不征税|\*{1,3}|—|--)$/.test(t)) { nums.unshift({ i, rate: t }); continue; }
    if (/^\d+(\.\d+)?%$/.test(t)) { nums.unshift({ i, rate: t }); continue; }
    if (NUM_RE.test(t) && /\d/.test(t)) { nums.unshift({ i, v: toNum(t) }); continue; }
    break;
  }
  if (!nums.some((n) => n.v !== undefined)) return null;

  let qty = null; let price = null; let amount = null; let tax = 0; let rate = null;
  const vals = nums.filter((n) => n.v !== undefined);
  const rateTok = nums.find((n) => n.rate);
  if (rateTok) rate = rateTok.rate;
  const neg = vals.some((n) => n.v < 0);

  if (vals.length >= 4) {
    [qty, price, amount, tax] = vals.map((n) => n.v);
  } else if (vals.length === 3) {
    if (neg) { [amount, tax] = vals.map((n) => n.v); } else { [qty, price, amount] = vals.map((n) => n.v); }
  } else if (vals.length === 2) {
    if (neg || vals[1].v < 0) [amount, tax] = vals.map((n) => n.v);
    else [qty, amount] = vals.map((n) => n.v);
  } else {
    [amount] = vals.map((n) => n.v);
  }

  const head = tokens.slice(0, nums[0].i);
  if (!head.length) return null;
  const unitSet = new Set(['个', '只', '件', '台', '套', '米', '吨', '千克', '克', '斤', '升', '毫升', '张', '块', '根', '条', '卷', '包', '箱', '盒', '支', '把', '片', '枚', '组', '批', '次', '双', '副', '桶', '袋', '罐', '瓶', '册', '本', '对']);
  let unit = '';
  let nameEnd = head.length;
  if (head.length > 1 && (unitSet.has(head[head.length - 1]) || /^[A-Za-z]{1,4}$/.test(head[head.length - 1]))) {
    unit = head[head.length - 1];
    nameEnd = head.length - 1;
  }
  const name = head.slice(0, nameEnd).join(' ');
  if (!name) return null;
  return mkRow(name, '', unit, qty, price, amount, rate, tax);
}

/**
 * 折扣行合并：京东系发票的折扣行（负数、无数量单价）并入上一条明细，
 * 与纸质入库单口径一致（按净额入库）。discount:'merge' 合并 | 'keep' 保留负数行。
 */
export function foldDiscountRows(rows, discount = 'merge') {
  if (discount !== 'merge') return rows.slice();
  const out = [];
  for (const r of rows) {
    const isDiscount = (r.amount ?? 0) < 0 && r.qty === null && r.price === null;
    if (isDiscount && out.length) {
      // 优先并入品名相同/相似的明细行（多商品+折扣时避免并错），找不到再退回上一行
      let target = out[out.length - 1];
      const rn = normName(r.name);
      let bestScore = 0;
      for (let i = out.length - 1; i >= 0; i--) {
        const n = normName(out[i].name);
        if (!n || !rn) continue;
        if (rn === n || rn.includes(n) || n.includes(rn)) { target = out[i]; bestScore = 2; break; }
        const s = diceSimilarity(rn, n);
        if (s > bestScore && s >= 0.55) { bestScore = s; target = out[i]; }
      }
      target.amount = round2((target.amount || 0) + (r.amount || 0));
      target.tax = round2((target.tax || 0) + (r.tax || 0));
      target.total = round2(target.amount + target.tax);
      // 单价 = 税费和折扣都算进去的单价（含税折后单价 = 价税合计净额 ÷ 数量）
      if (target.qty) {
        const p = Number((target.total / target.qty).toFixed(8));
        target.price = p;
        target.priceIncl = p;
      }
    } else {
      out.push(r);
    }
  }
  return out;
}

function normName(s) {
  return String(s || '').replace(/[*\s（）()【】]/g, '');
}

/** 二元组相似度（0~1），用于折扣行模糊匹配品名 */
function diceSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a); const gb = grams(b);
  let inter = 0;
  for (const [g, c] of ga) inter += Math.min(c, gb.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** 发票明细行对象（内部统一结构） */
export function mkRow(name, spec, unit, qty, price, amount, rate, tax) {
  const t = round2(tax || 0);
  const a = amount === null || amount === undefined ? null : round2(amount);
  const total = a === null ? null : round2(a + t);
  return {
    name: String(name || '').trim(),
    spec: String(spec || '').trim(),
    unit: String(unit || '').trim(),
    qty: qty ?? null,
    price: price ?? null,
    amount: a,
    rate: rate || null,
    tax: t,
    total,
    priceIncl: qty ? (total === null ? null : total / qty) : null,
  };
}

/** 从已整理的明细表（二维数组，首行表头）导入。兼容发票明细/入库单两种列名。 */
export function rowsFromTableMatrix(matrix) {
  if (!matrix || !matrix.length) return [];
  let headerRow = 0;
  for (let i = 0; i < Math.min(matrix.length, 8); i++) {
    const row = matrix[i].map((c) => String(c ?? ''));
    if (row.some((c) => /名称|耗材|元器件/.test(c)) && row.some((c) => /数量/.test(c))) { headerRow = i; break; }
  }
  const header = matrix[headerRow].map((c) => String(c ?? '').trim());
  const find = (...pats) => header.findIndex((h) => pats.some((p) => p.test(h)));
  const idx = {
    date: find(/日期/),
    seller: find(/销售方|供货|供应|供应商/),
    name: find(/项目名称|耗材|元器件|品名|商品|名称/),
    spec: find(/规格/),
    unit: find(/单位/),
    qty: find(/数量/),
    price: find(/单价/),
    amount: find(/金额(?!.*税)|金额/),
    tax: find(/税额/),
    total: find(/价税合计|含税/),
    invoiceNo: find(/发票号码|发票号/),
  };
  if (idx.name < 0) return [];
  const rows = [];
  for (let i = headerRow + 1; i < matrix.length; i++) {
    const r = matrix[i];
    const get = (k) => (idx[k] >= 0 ? r[idx[k]] : null);
    const name = String(get('name') ?? '').trim();
    const amount = toNum(get('amount'));
    const tax = toNum(get('tax'));
    const total = toNum(get('total'));
    if (!name && amount === null) continue;
    const qty = toNum(get('qty'));
    rows.push(mkRow(name, String(get('spec') ?? '').trim(), String(get('unit') ?? '').trim(),
      qty, toNum(get('price')), amount, null,
      tax ?? (total !== null && amount !== null ? round2(total - amount) : 0)));
    const rec = rows[rows.length - 1];
    rec.dateISO = parseDate(get('date'));
    rec.seller = String(get('seller') ?? '').trim() || null;
    rec.invoiceNo = String(get('invoiceNo') ?? '').trim() || null;
    if (rec.price === null && qty && rec.amount !== null) rec.price = rec.amount / qty;
    if (rec.priceIncl === null && qty && rec.total !== null) rec.priceIncl = rec.total / qty;
  }
  return rows;
}

// —————— 内部实现 ——————

function emptyInvoice(reason) {
  return { number: null, dateISO: null, seller: null, buyer: null, rows: [], totalWithTax: null, sumAmount: 0, sumTax: 0, warnings: [reason] };
}

function joinText(items) {
  return items.map((it) => it.str).join(' ');
}

function matchFirst(items, re) {
  const m = joinText(items).match(re);
  return m ? m[1].replace(/\s/g, '') : null;
}

/** 同行（y±2）片段合并：间隔>1px 补空格；换行直接拼接（与基准文件一致） */
function joinNameParts(parts) {
  let out = '';
  let prev = null;
  for (const p of parts) {
    if (!prev) { out = p.str; prev = p; continue; }
    const sameLine = Math.abs(p.y - prev.y) <= 2;
    const gap = p.x - (prev.x + (prev.w || 0));
    if (sameLine) out += gap > 1 ? ' ' + p.str : p.str;
    else out += p.str;
    prev = p;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** 价税合计（小写）：取与“（小写）”标签最近的金额；hint（明细合计）一致的候选优先 */
function findTotalWithTax(items, hint) {
  const s = joinText(items);
  const lm = s.match(/[（(]\s*小写\s*[)）]/);
  if (!lm) return null;
  const idx = lm.index;
  const cands = [];
  for (const m of s.matchAll(/[¥￥]\s*([+-]?\d[\d,]*\.?\d+)/g)) {
    cands.push({ v: toNum(m[1]), d: Math.abs(m.index - idx) });
  }
  for (const m of s.matchAll(/([+-]?\d[\d,]*\.?\d+)/g)) {
    const before = s.slice(Math.max(0, m.index - 8), m.index);
    if (/单\s*号|号\s*码|订\s*单/.test(before)) continue;
    cands.push({ v: toNum(m[1]), d: Math.abs(m.index - idx) });
  }
  const valid = cands.filter((c) => c.v !== null && c.d <= 40);
  if (!valid.length) return null;
  if (hint !== null && hint !== undefined) {
    const match = valid.filter((c) => Math.abs(c.v - hint) <= 0.02).sort((a, b) => a.d - b.d);
    if (match.length) return match[0].v;
  }
  valid.sort((a, b) => a.d - b.d);
  return valid[0].v;
}

/** 购买方/销售方名称：行内“名称：”分组，购买方在左、销售方在右 */
function partyNames(items) {
  const rowMap = new Map();
  for (const it of items) {
    const y = Math.round(it.y / 3) * 3;
    if (!rowMap.has(y)) rowMap.set(y, []);
    rowMap.get(y).push(it);
  }
  const found = [];
  for (const [y, list] of rowMap) {
    list.sort((a, b) => a.x - b.x);
    for (let i = 0; i < list.length; i++) {
      // 自 i 起拼出“名称：”模式（可能被拆成 名 / 称 / : 多块）
      let acc = ''; let colonAt = -1;
      for (let j = i; j < Math.min(i + 4, list.length); j++) {
        acc += list[j].str;
        if (/名\s*称\s*[：:]/.test(acc)) { colonAt = j; break; }
        if (!/^名?\s*称?\s*[：:]?$/.test(acc.trim())) break;
      }
      if (colonAt < 0) continue;
      // 取冒号后的取值片段（间距 ≤40px 视为同一值）
      const valParts = [];
      let prevEnd = null;
      let stop = colonAt + 1;
      for (let j = colonAt + 1; j < list.length; j++) {
        const it = list[j];
        if (prevEnd !== null && it.x - prevEnd > 40) break;
        if (/^名\s*称/.test(it.str) || /统一社会信用代码|纳税人识别号/.test(it.str)) break;
        valParts.push(it);
        prevEnd = it.x + (it.w || 0);
        stop = j + 1;
      }
      const value = joinNameParts(valParts);
      if (value.length >= 2) found.push({ x: list[i].x, y, value });
      i = Math.max(i, stop - 1); // 继续找同组右侧的“销售方名称”
    }
  }
  if (!found.length) return { buyer: null, seller: null };
  const byX = [...found].sort((a, b) => a.x - b.x);
  return { buyer: byX[0].value, seller: byX[byX.length - 1].value };
}

function sellerFromText(lines) {
  const all = lines.join(' ');
  const m = all.match(/销\s*售\s*方[\s\S]{0,40}?名\s*称\s*[：:]\s*([^\s：:（(]{2,40})/);
  if (m) return m[1];
  const names = [...all.matchAll(/名\s*称\s*[：:]\s*([一-龥A-Za-z0-9（）()·]{2,40})/g)].map((x) => x[1]);
  return names.length ? names[names.length - 1] : null;
}

/** 表头行 → 各列横向区间（以表头文字起始 x 为边界） */
export function detectBands(items) {
  const LABELS = [
    ['name', /^项\s*目\s*名\s*称/],
    ['spec', /^规\s*格\s*型\s*号/],
    ['unit', /^单\s*位/],
    ['qty', /^数\s*量/],
    ['price', /^单\s*价/],
    ['amount', /^金\s*额/],
    ['rate', /^税\s*率|^\/*征\s*收\s*率/],
    ['tax', /^税\s*额/],
  ];
  for (const it of items) {
    const row = items.filter((r) => Math.abs(r.y - it.y) <= 3).sort((a, b) => a.x - b.x);
    const line = row.map((r) => r.str).join('').replace(/\s/g, '');
    if (!/项目名称/.test(line) || !/金额/.test(line)) continue;

    // 每个片段都可能是标签起点（“单”+“位” 两个片段拼出“单位”），
    // 逐起点累积相邻片段做前缀匹配，避免相邻标签粘连串位
    const xs = {};
    for (let i = 0; i < row.length; i++) {
      let acc = '';
      for (let j = i; j < Math.min(i + 4, row.length); j++) {
        if (j > i && row[j].x - (row[j - 1].x + (row[j - 1].w || 0)) > 40) break;
        acc += row[j].str.replace(/\s/g, '');
        for (const [key, re] of LABELS) {
          if (xs[key] === undefined && re.test(acc)) { xs[key] = row[i].x; break; }
        }
      }
    }
    if (xs.name === undefined || xs.amount === undefined) continue;

    const order = ['name', 'spec', 'unit', 'qty', 'price', 'amount', 'rate', 'tax']
      .filter((k) => xs[k] !== undefined)
      .sort((a, b) => xs[a] - xs[b]);
    const bands = order.map((k, i) => ({
      key: k,
      lo: xs[k],
      hi: i + 1 < order.length ? xs[order[i + 1]] : Infinity,
    }));
    return { bands, headerY: Math.max(...row.map((r) => r.y)), xs };
  }
  return null;
}

/** 归列：数字（右对齐）按右缘，文本按左缘；与列标签起点 ±2px 对齐的优先归该列 */
export function bandOf(item, bands, numeric) {
  for (const b of bands) {
    if (Math.abs(item.x - b.lo) <= 2) return b.key;
  }
  const right = item.x + (item.w || 0);
  const center = item.x + (item.w || 0) / 2;
  const edges = numeric ? [right, center, item.x] : [item.x, center, right];
  for (const edge of edges) {
    for (const b of bands) {
      const hi = b.hi === Infinity ? Infinity : b.hi + 4;
      if (edge >= b.lo - 25 && edge < hi) return b.key;
    }
  }
  let best = bands[0].key; let bestD = Infinity;
  for (const b of bands) {
    const d = Math.min(Math.abs(right - b.lo), Math.abs(item.x - b.lo));
    if (d < bestD) { bestD = d; best = b.key; }
  }
  return best;
}

/**
 * 合计区上沿 y：把纵向 20px 内的片段聚成“视觉行簇”（兼容 备/注 这类拆行标签），
 * 命中 合计/大写/小写/备注/订单号/纯¥金额 的行簇即截断明细区。
 */
function totalsCutY(items, headerY) {
  const region = items.filter((it) => it.y <= headerY - 2).sort((a, b) => b.y - a.y);
  let cluster = [];
  let minY = Infinity;
  const test = () => {
    if (!cluster.length) return false;
    const text = cluster.map((r) => r.str).join('').replace(/\s/g, '');
    const raw = cluster.map((r) => r.str).join(' ').trim();
    const hasStar = cluster.some((r) => /^\*/.test(r.str.trim()));
    if (!hasStar && /价\s*税\s*合\s*计|[（(]大\s*写|[（(]小\s*写|备\s*注|开\s*票\s*人|收\s*款\s*人|复\s*核|订\s*单\s*号|合\s*计/.test(text)) {
      return true;
    }
    return /^([¥￥]\s*[\d,.]+\s*)+$/.test(raw);
  };
  for (const it of region) {
    if (cluster.length && it.y < minY - 20) {
      if (test()) return Math.max(...cluster.map((r) => r.y)) + 8;
      cluster = [];
      minY = Infinity;
    }
    cluster.push(it);
    minY = Math.min(minY, it.y);
  }
  if (test()) return Math.max(...cluster.map((r) => r.y)) + 8;
  return -Infinity;
}

function parseDetailBlocks(items, bandInfo) {
  const { bands } = bandInfo;
  const hasStars = items.some((it) => /^\*/.test(it.str.trim()));
  const rows = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const r = mkRow(
      joinNameParts(cur.name), joinNameParts(cur.spec), joinNameParts(cur.unit),
      firstNum(cur.qty), firstNum(cur.price), firstNum(cur.amount),
      cur.rate[0] ? cur.rate[0].str.trim() : null, firstNum(cur.tax),
    );
    if (r.name || r.amount !== null) rows.push(r);
    cur = null;
  };
  const blank = () => ({ name: [], spec: [], unit: [], qty: [], price: [], amount: [], rate: [], tax: [] });

  for (const it of items) {
    const t = it.str.trim();
    const numeric = NUM_RE.test(t) && /\d/.test(t);
    const key = bandOf(it, bands, numeric);

    // 新明细块：品名列以 * 分类简称开头；无 * 的发票退回“已有数字又来品名”规则
    const isNameText = key === 'name' && !numeric;
    const startsBlock = cur === null
      || (isNameText && /^\*/.test(t) && (cur.name.length || cur.amount.length || cur.qty.length))
      || (isNameText && !hasStars && cur.amount.length && cur.name.length);
    if (startsBlock) { flush(); cur = blank(); }

    // 各列均存文本块对象，避免数字/文本混型
    if (key === 'rate') cur.rate.push(it);
    else if (isNameText || (key === 'spec' && !numeric) || (key === 'unit' && !numeric)) (cur[key] ||= []).push(it);
    else if (numeric) (cur[key] ||= []).push(it);
    else if (key === 'name') cur.name.push(it);
    else if (key === 'tax') cur.tax.push(it);
  }
  flush();
  return rows;
}

function firstNum(list) {
  for (const it of list) { const n = toNum(it.str); if (n !== null) return n; }
  return list.length ? 0 : null; // “***” 等免税占位按 0
}
