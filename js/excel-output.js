// 入库单 Excel 生成：1:1 复刻《入库单汇总.xlsx》版式（标题/信息行/12 行明细/合计含大写/签字行）。
// 依赖全局 ExcelJS（lib/exceljs.min.js UMD）；Node 测试时注入 globalThis.ExcelJS。
import { round2, toCompactDate, sanitizeFilename, sanitizeSheetName, latestDate } from './utils.js';
import { numberToChineseCurrency } from './rmb.js';

/** 版式常量（与基准文件逐格一致） */
export const TPL = {
  title: '浙江工业大学信息工程学院学生创新活动耗材 入库单',
  nameLabel: '耗材名称',
  headers: ['序号', '耗材名称', '规格型号', '单位', '数量', '单价（元)', '金额（元)'],
  colWidths: [6.775, 32.125, 13.75, 9, 9.38333333333333, 9, 10.25],
  minRows: 12,
  supplierLabel: '供货\n单位',
  dateLabel: '入库日期',
  noLabel: '入库单号',
  totalLabel: '合计（含税）',
  capLabel: '（大写）',
  lowLabel: '（小写）',
  signA: '制表：',
  signB: '（学生1手写签名）',
  signC: '采购：（学生2手写签名）',
  signE: '入库验收：',
  signF: '04409',
  fonts: {
    title: { name: '黑体', size: 12, charset: 134 },
    label: { name: '宋体', size: 10, bold: true, charset: 134 },
    supplier: { name: '宋体', size: 8, charset: 134 },
    meta: { name: '宋体', size: 9, charset: 134 },
    head: { name: '宋体', size: 10, bold: true, charset: 134 },
    idx: { name: 'Times New Roman', size: 9 },
    name: { name: '宋体', size: 9, charset: 134 },
    spec: { name: '宋体', size: 9, charset: 134 },
    unit: { name: '宋体', size: 9, charset: 134 },
    qty: { name: '宋体', size: 10, charset: 134 },
    num: { name: 'Times New Roman', size: 10 },
    totalLabel: { name: '宋体', size: 8, charset: 134 },
    total: { name: '宋体', size: 10, charset: 134 },
    sign: { name: '宋体', size: 10, charset: 134 },
    signSmall: { name: '宋体', size: 6, charset: 134 },
    signNum: { name: 'Times New Roman', size: 10 },
  },
  numFmt: '0.00_ ',
  textFmt: '@',
};

const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const LEFT = { horizontal: 'left', vertical: 'middle', wrapText: true };
const THIN = { style: 'thin' };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * 把明细行按供货单位分组，得到入库单数据。
 * rows: [{dateISO, seller, name, spec, unit, qty, price, amount, tax, total, priceIncl}]
 * opts.pricing: 'incl'（含税，默认，单价=价税合计/数量）| 'excl'（不含税）
 * opts.discount: 'merge'（折扣并入，默认）| 'keep'（保留负数行）
 */
export function buildGroups(rows, opts = {}) {
  const pricing = opts.pricing || 'incl';
  const groups = new Map();
  for (const r of rows) {
    const key = (r.seller || '未填供货单位').trim();
    if (!groups.has(key)) groups.set(key, []);
    const money = pricing === 'incl' ? r.total : r.amount;
    let price = null;
    if (r.qty) {
      const raw = pricing === 'incl' ? (r.total ?? 0) / r.qty : (r.amount ?? 0) / r.qty;
      price = Number(raw.toPrecision(15)); // 与基准一致的 15 位有效数字
    } else {
      price = pricing === 'incl' ? (r.priceIncl ?? null) : (r.price ?? null);
    }
    groups.get(key).push({
      name: r.name, spec: r.spec, unit: r.unit, qty: r.qty ?? null,
      price: price ?? null, money: money ?? null,
    });
  }
  return [...groups.entries()].map(([seller, items]) => ({
    seller,
    items,
    date: latestDate(rows.filter((r) => (r.seller || '未填供货单位').trim() === seller).map((r) => r.dateISO)),
    subtotal: round2(items.reduce((s, it) => s + (it.money || 0), 0)),
    count: items.length,
  }));
}

/** 排布：明细超过模板行数的单独占一个 sheet，其余每 sheet 两张（末张奇数单独一张） */
export function packSheets(groups, opts = {}) {
  const minRows = opts.minRows || TPL.minRows;
  const big = groups.filter((g) => g.count > minRows);
  const small = groups.filter((g) => g.count <= minRows);
  const sheets = [];
  for (const g of big) sheets.push({ forms: [g] });
  for (let i = 0; i < small.length; i += opts.perSheet === 1 ? 1 : 2) {
    sheets.push({ forms: small.slice(i, i + (opts.perSheet === 1 ? 1 : 2)) });
  }
  const naming = opts.sheetNaming || 'index';
  sheets.forEach((s, i) => {
    s.name = naming === 'supplier'
      ? sanitizeSheetName(s.forms.map((f) => f.seller).join('&'))
      : sanitizeSheetName(String(i));
  });
  return sheets;
}

/** 生成完整工作簿（单文件多 sheet 模式） */
export function buildWorkbook(groups, opts = {}) {
  const ExcelJS = globalThis.ExcelJS;
  const wb = new ExcelJS.Workbook();
  const sheets = packSheets(groups, opts);
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    setupColumns(ws);
    let start = 1;
    s.forms.forEach((g, i) => {
      start = writeForm(ws, start, g, opts) + (i < s.forms.length - 1 ? 2 : 0);
    });
  }
  return wb;
}

/** 生成「每供货单位一个文件」的数组：[{filename, buffer}] */
export async function buildIndividualFiles(groups, opts = {}) {
  const ExcelJS = globalThis.ExcelJS;
  const out = [];
  for (const g of groups) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('0');
    setupColumns(ws);
    writeForm(ws, 1, g, opts);
    const buf = await wb.xlsx.writeBuffer();
    out.push({ filename: sanitizeFilename(`${g.seller}-入库单`) + '.xlsx', buffer: buf });
  }
  return out;
}

// —————— 内部实现 ——————

function setupColumns(ws) {
  TPL.colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function cellStyle(cell, { font, align = CENTER, border = BOX, numFmt }) {
  cell.font = { ...font };
  cell.alignment = { ...align };
  cell.border = { ...border };
  if (numFmt) cell.numFmt = numFmt;
}

/**
 * 写入一张入库单。返回占用的最后一行行号。
 * 行结构（N=max(明细数, minRows)）：标题 / 信息 / 表头 / N 明细 / 合计 / 空 / 签字 / 尾(A:B合并)
 */
function writeForm(ws, start, group, opts = {}) {
  const t = { ...TPL, ...(opts.tpl || {}) };
  const minRows = opts.minRows || t.minRows;
  const count = Math.max(group.items.length, minRows);
  const rTitle = start;
  const rInfo = start + 1;
  const rHead = start + 2;
  const rFirst = start + 3;
  const rLast = rFirst + count - 1;
  const rTotal = rLast + 1;
  const rBlank = rTotal + 1;
  const rSign = rBlank + 1;
  const rTail = rSign + 1;

  // 标题
  ws.mergeCells(rTitle, 1, rTitle, 7);
  const cTitle = ws.getCell(rTitle, 1);
  cTitle.value = t.title;
  cellStyle(cTitle, { font: t.fonts.title, border: {} });

  // 信息行：供货单位 | 入库日期 | 入库单号
  const cA = ws.getCell(rInfo, 1);
  cA.value = t.supplierLabel;
  cellStyle(cA, { font: t.fonts.label });
  ws.mergeCells(rInfo, 2, rInfo, 3);
  const cB = ws.getCell(rInfo, 2);
  cB.value = group.seller;
  cellStyle(cB, { font: t.fonts.supplier, align: LEFT });
  const cD = ws.getCell(rInfo, 4);
  cD.value = t.dateLabel;
  cellStyle(cD, { font: t.fonts.label });
  const cE = ws.getCell(rInfo, 5);
  const dateText = toCompactDate(group.date) || '';
  cE.value = dateText;
  cellStyle(cE, { font: t.fonts.meta, numFmt: t.textFmt });
  const cF = ws.getCell(rInfo, 6);
  cF.value = t.noLabel;
  cellStyle(cF, { font: t.fonts.label });
  const cG = ws.getCell(rInfo, 7);
  cG.value = {
    formula: `E${rInfo}&TEXT(RANDBETWEEN(10,99),0)`,
    result: dateText ? dateText + String(10 + Math.floor(Math.random() * 90)) : '',
  };
  cellStyle(cG, { font: t.fonts.meta });

  // 表头
  t.headers.forEach((h, i) => {
    const c = ws.getCell(rHead, i + 1);
    c.value = i === 1 ? t.nameLabel : h;
    cellStyle(c, { font: t.fonts.head });
  });

  // 明细
  for (let i = 0; i < count; i++) {
    const item = group.items[i] || null;
    const r = rFirst + i;
    const cIdx = ws.getCell(r, 1);
    cIdx.value = i + 1;
    cellStyle(cIdx, { font: t.fonts.idx });

    const cName = ws.getCell(r, 2);
    cName.value = item ? item.name : null;
    cellStyle(cName, { font: t.fonts.name, align: LEFT });

    const cSpec = ws.getCell(r, 3);
    cSpec.value = item && item.spec ? item.spec : null;
    cellStyle(cSpec, { font: t.fonts.spec });

    const cUnit = ws.getCell(r, 4);
    cUnit.value = item && item.unit ? item.unit : null;
    cellStyle(cUnit, { font: t.fonts.unit });

    const cQty = ws.getCell(r, 5);
    cQty.value = item && item.qty !== null ? item.qty : null;
    cellStyle(cQty, { font: t.fonts.qty });

    const cPrice = ws.getCell(r, 6);
    cPrice.value = item && item.price !== null ? item.price : null;
    cellStyle(cPrice, { font: t.fonts.num, numFmt: t.numFmt });

    const cAmt = ws.getCell(r, 7);
    if (item && item.qty !== null && item.price !== null) {
      cAmt.value = { formula: `E${r}*F${r}`, result: round2(item.qty * item.price) };
    } else if (item && item.money !== null) {
      cAmt.value = round2(item.money); // 无数量单价的行（如折扣行）直接写金额
    } else {
      cAmt.value = null;
    }
    cellStyle(cAmt, { font: t.fonts.num, numFmt: t.numFmt });
  }

  // 合计（含税）：（大写）DBNum2 公式 + （小写）SUM
  const cT = ws.getCell(rTotal, 1);
  cT.value = t.totalLabel;
  cellStyle(cT, { font: t.fonts.totalLabel });
  const cCapL = ws.getCell(rTotal, 2);
  cCapL.value = t.capLabel;
  cellStyle(cCapL, { font: t.fonts.total });
  ws.mergeCells(rTotal, 3, rTotal, 5);
  const cCap = ws.getCell(rTotal, 3);
  const capFormula = `"人民币："&SUBSTITUTE(SUBSTITUTE(TEXT(INT(G${rTotal}),"[DBNum2][$-804]G/通用格式元"&IF(INT(G${rTotal})=G${rTotal},"整",""))&TEXT(MID(G${rTotal},FIND(".",G${rTotal}&".0")+1,1),"[DBNum2][$-804]G/通用格式角")&TEXT(MID(G${rTotal},FIND(".",G${rTotal}&".0")+2,1),"[DBNum2][$-804]G/通用格式分"),"零角","零"),"零分","")`;
  const sum = round2(Array.from({ length: count }, (_, i) => {
    const it = group.items[i];
    return it && it.money !== null ? it.money : 0;
  }).reduce((a, b) => a + b, 0));
  cCap.value = { formula: capFormula, result: numberToChineseCurrency(sum) };
  cellStyle(cCap, { font: t.fonts.total });
  const cLowL = ws.getCell(rTotal, 6);
  cLowL.value = t.lowLabel;
  cellStyle(cLowL, { font: t.fonts.total });
  const cSum = ws.getCell(rTotal, 7);
  cSum.value = { formula: `SUM(G${rFirst}:G${rLast})`, result: sum };
  cellStyle(cSum, { font: t.fonts.total, numFmt: t.numFmt });

  // 签字行（无边框）
  const cSignA = ws.getCell(rSign, 1);
  cSignA.value = t.signA;
  cellStyle(cSignA, { font: t.fonts.sign, align: { vertical: 'middle', wrapText: true }, border: {} });
  const cSignB = ws.getCell(rSign, 2);
  cSignB.value = t.signB;
  cellStyle(cSignB, { font: t.fonts.signSmall, align: { horizontal: 'left', vertical: 'middle', wrapText: true }, border: {} });
  const cSignC = ws.getCell(rSign, 3);
  cSignC.value = t.signC;
  cellStyle(cSignC, { font: t.fonts.sign, align: { vertical: 'middle', wrapText: true }, border: {} });
  const cSignE = ws.getCell(rSign, 5);
  cSignE.value = t.signE;
  cellStyle(cSignE, { font: t.fonts.sign, align: { vertical: 'middle', wrapText: true }, border: {} });
  const cSignF = ws.getCell(rSign, 6);
  cSignF.value = opts.acceptId ?? t.signF;
  cellStyle(cSignF, { font: t.fonts.signNum, align: { vertical: 'middle', wrapText: true }, border: {} });

  // 尾行（与基准一致：A:B 合并的空行）
  ws.mergeCells(rTail, 1, rTail, 2);

  return rTail;
}
