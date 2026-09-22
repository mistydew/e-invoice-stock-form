// 通用工具函数（纯函数，Node 与浏览器通用）

/** 全角/半角字符串显示宽度（CJK 按 2 计） */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  return w;
}

/** 字符串转数字（去掉 ¥￥, 空格；空/非法返回 null） */
export function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[¥￥,\s，]/g, '').trim();
  if (!t) return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 是否纯数字（含负号、小数、百分号、货币符号） */
export function isNumericToken(s) {
  return /^[-+]?[¥￥]?\s*[\d,]*\.?\d+\s*%?$/.test(String(s ?? '').trim()) && /\d/.test(String(s));
}

/** 各种日期写法 → 'YYYY-MM-DD'；解析失败返回 null */
export function parseDate(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → 入库日期格式 'YYYYMMDD'（与模板一致的文本） */
export function toCompactDate(iso) {
  return String(iso ?? '').replace(/-/g, '');
}

/** 取多个日期中最近的一个 */
export function latestDate(dates) {
  const arr = dates.filter(Boolean).sort();
  return arr.length ? arr[arr.length - 1] : null;
}

/** 数字保留 2 位（用于展示与合计） */
export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 文件名非法字符清理 */
export function sanitizeFilename(name) {
  return String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

/** Sheet 名清理（Excel 上限 31 字符，去掉非法字符） */
export function sanitizeSheetName(name) {
  let s = String(name ?? '').replace(/[\\/*?:[\]]/g, ' ').trim();
  if (s.length > 31) s = s.slice(0, 31);
  return s || 'Sheet';
}

/**
 * 估算合并/换行后行高（模拟 Excel 自动调整行高的效果）。
 * 与基准文件一致：单行 21~24，明细行 33.75 / 45 / 60 …
 * @param {Array<{text:string,width:number}>} cells 列宽(Excel字符宽)
 */
export function estimateRowHeight(cells) {
  let lines = 1;
  for (const { text, width } of cells) {
    if (!text) continue;
    // Excel 列宽≈每行可容纳的半角字符数；中文按 2 算
    const per = Math.max(4, width);
    const w = displayWidth(text);
    lines = Math.max(lines, Math.ceil(w / per));
  }
  return Math.min(96, Math.max(15, lines * 14.25 + 3.75));
}
