// 人民币大写转换：输出与模板公式 TEXT(...,"[DBNum2][$-804]G/通用格式…") 完全一致。
// 形如“人民币：壹仟玖佰玖拾柒元壹角玖分”“人民币：伍元肆角”“人民币：壹佰元整”。

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNITS = ['', '拾', '佰', '仟'];

/** 4 位一组的中文数字（DBNum2 通用格式风格，如 3068 → 叁仟零陆拾捌） */
function fourDigits(n) {
  let s = '';
  let started = false;
  let pendingZero = false;
  const d = [Math.floor(n / 1000) % 10, Math.floor(n / 100) % 10, Math.floor(n / 10) % 10, n % 10];
  for (let i = 0; i < 4; i++) {
    const v = d[i];
    if (v === 0) {
      if (started) pendingZero = true;
    } else {
      if (pendingZero) s += '零';
      s += DIGITS[v] + UNITS[3 - i];
      started = true;
      pendingZero = false;
    }
  }
  return s;
}

function intPart(n) {
  if (n === 0) return '零';
  const yi = Math.floor(n / 1e8);
  const wan = Math.floor(n / 1e4) % 1e4;
  const ge = n % 1e4;
  let s = '';
  if (yi) s += fourDigits(yi) + '亿';
  if (wan) {
    if (yi && wan < 1000) s += '零';
    s += fourDigits(wan) + '万';
  }
  if (ge) {
    if ((yi || wan) && ge < 1000) s += '零';
    s += fourDigits(ge);
  }
  return s;
}

/**
 * 金额 → 大写。示例：1997.19 → “人民币：壹仟玖佰玖拾柒元壹角玖分”
 * 5.4 → “人民币：伍元肆角”；100 → “人民币：壹佰元整”
 */
export function numberToChineseCurrency(value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  const neg = n < 0;
  const abs = Math.abs(n);
  const cents = Math.round(abs * 100);
  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor(cents / 10) % 10;
  const fen = cents % 10;
  let s = intPart(yuan) + '元';
  if (jiao === 0 && fen === 0) {
    s += '整';
  } else {
    s += (jiao ? DIGITS[jiao] + '角' : '零角');
    s += (fen ? DIGITS[fen] + '分' : '零分');
    s = s.replace('零角', '零').replace('零分', '');
  }
  return (neg ? '负' : '') + '人民币：' + s;
}
