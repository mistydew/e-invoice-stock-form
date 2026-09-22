// 生成 electron/icon.ico（内嵌 256×256 PNG，4 倍超采样抗锯齿）
// 图案：蓝色圆角底 + 白色单据 + 橙色入库箱 + 白色胶带
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = 1024; // 4x 超采样
const N = 256;

const px = new Float32Array(S * S * 4); // rgba 0..255

function blend(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  const oa = px[i + 3] / 255;
  const outA = na + oa * (1 - na);
  if (outA <= 0) return;
  px[i] = (r * na + px[i] * oa * (1 - na)) / outA;
  px[i + 1] = (g * na + px[i + 1] * oa * (1 - na)) / outA;
  px[i + 2] = (b * na + px[i + 2] * oa * (1 - na)) / outA;
  px[i + 3] = outA * 255;
}

function fillRoundedRect(x0, y0, x1, y1, rad, r, g, b) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // 到圆角矩形内部的距离场
      const cx = Math.max(x0 + rad, Math.min(x1 - rad, x));
      const cy = Math.max(y0 + rad, Math.min(y1 - rad, y));
      const d = Math.hypot(x - cx, y - cy);
      const cov = Math.min(1, Math.max(0, rad - d + 0.5));
      if (cov > 0) blend(x, y, r, g, b, 255 * cov);
    }
  }
}

// 背景圆角方块
fillRoundedRect(0, 0, S, S, 192, 30, 58, 138);
// 白色单据
fillRoundedRect(185, 150, 560, 685, 24, 255, 255, 255);
// 灰色文字线
fillRoundedRect(245, 235, 500, 275, 16, 148, 163, 184);
fillRoundedRect(245, 325, 500, 365, 16, 148, 163, 184);
fillRoundedRect(245, 415, 415, 455, 16, 148, 163, 184);
// 橙色入库箱
fillRoundedRect(415, 555, 860, 855, 32, 245, 158, 11);
// 白色胶带
fillRoundedRect(385, 665, 895, 745, 12, 255, 255, 255);

// 4x4 盒式降采样 → 256×256
const out = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const i = ((y * 4 + dy) * S + (x * 4 + dx)) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
      }
    }
    const o = (y * N + x) * 4;
    out[o] = Math.round(r / 16);
    out[o + 1] = Math.round(g / 16);
    out[o + 2] = Math.round(b / 16);
    out[o + 3] = Math.round(a / 16);
  }
}

// —— PNG 编码 ——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  out.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// —— ICO 封装（PNG 条目：256 / 48 / 32） ——
function makePng(rgba, size) {
  const i2 = Buffer.alloc(13);
  i2.writeUInt32BE(size, 0);
  i2.writeUInt32BE(size, 4);
  i2[8] = 8; i2[9] = 6;
  const raw2 = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw2, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', i2),
    chunk('IDAT', zlib.deflateSync(raw2, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function downscale(src, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = Math.floor(y * ratio); sy < Math.min(srcSize, (y + 1) * ratio); sy++) {
        for (let sx = Math.floor(x * ratio); sx < Math.min(srcSize, (x + 1) * ratio); sx++) {
          const i = (sy * srcSize + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * dstSize + x) * 4;
      dst[o] = Math.round(r / n); dst[o + 1] = Math.round(g / n);
      dst[o + 2] = Math.round(b / n); dst[o + 3] = Math.round(a / n);
    }
  }
  return dst;
}

const entries = [
  { size: 256, png: makePng(out, 256) },
  { size: 48, png: makePng(downscale(out, 256, 48), 48) },
  { size: 32, png: makePng(downscale(out, 256, 32), 32) },
];
const dir = Buffer.alloc(6 + 16 * entries.length);
dir.writeUInt16LE(0, 0);            // reserved
dir.writeUInt16LE(1, 2);            // type: icon
dir.writeUInt16LE(entries.length, 4); // 条目数
let offset = 6 + 16 * entries.length;
entries.forEach((e, i) => {
  const p = 6 + 16 * i;
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, p);     // width
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1); // height
  dir.writeUInt8(0, p + 2);   // 调色板色数
  dir.writeUInt8(0, p + 3);   // reserved
  dir.writeUInt16LE(1, p + 4);   // planes
  dir.writeUInt16LE(32, p + 6);  // bpp
  dir.writeUInt32LE(e.png.length, p + 8);
  dir.writeUInt32LE(offset, p + 12);
  offset += e.png.length;
});
const ico = Buffer.concat([dir, ...entries.map((e) => e.png)]);

const outFile = path.join(__dirname, '..', 'electron', 'icon.ico');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, ico);
console.log('已生成', outFile, ico.length, 'bytes');
