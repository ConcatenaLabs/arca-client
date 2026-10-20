'use strict';
// Draws build/icon.png (512x512): the app's mark, a box with two shelves, in
// the app's accent on a dark rounded square. Pure Node (a zlib PNG encoder).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const BG = [0x10, 0x12, 0x14];
const RIM = [0x2a, 0x2f, 0x35];
const ACCENT = [0x6f, 0xc3, 0xb2];

// Coverage of a pixel by a shape, 4x4 supersampled.
function cover(x, y, inside) {
  let n = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) n++;
  return n / 16;
}
function roundRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x1 - r, x));
    const cy = Math.max(y0 + r, Math.min(y1 - r, y));
    return Math.hypot(x - cx, y - cy) <= r;
  };
}
const tile = roundRect(0, 0, S, S, 104);
const tileInner = roundRect(6, 6, S - 6, S - 6, 98);
const boxOuter = roundRect(120, 120, 392, 392, 46);
const boxInner = roundRect(146, 146, 366, 366, 24);
const shelf1 = roundRect(176, 222, 336, 246, 12);
const shelf2 = roundRect(176, 286, 336, 310, 12);
const mark = (x, y) => (boxOuter(x, y) && !boxInner(x, y)) || shelf1(x, y) || shelf2(x, y);

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    const a = cover(x, y, tile);
    const inner = cover(x, y, tileInner);
    const m = cover(x, y, mark);
    const base = RIM.map((c, k) => c * (1 - inner) + BG[k] * inner);
    const px = base.map((c, k) => Math.round(c * (1 - m) + ACCENT[k] * m));
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2]; raw[o + 3] = Math.round(a * 255);
  }
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log(`wrote build/icon.png (${png.length} bytes)`);
