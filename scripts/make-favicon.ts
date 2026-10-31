// Renders public/favicon.ico (16, 32, 48 and 64 px) from the T-Rex idle sprite: the ink dino on
// a light rounded tile, so it reads on both light and dark browser tabs.
//
//   bun scripts/make-favicon.ts

import { writeFileSync } from 'node:fs';
import { PALETTE } from '../src/config';
import { TREX_SPRITES } from '../src/render/sprites';

const SIZES = [16, 32, 48, 64];
/** Fraction of the tile the dino's longer side fills. */
const FILL = 0.8;
/** Corner radius as a fraction of the tile. */
const RADIUS = 0.22;

const rows = TREX_SPRITES.idle;
const srcH = rows.length;
const srcW = Math.max(...rows.map((r) => r.length));
const ink = (x: number, y: number): boolean => {
  const c = rows[y]?.[x];
  return c !== undefined && c !== '.' && c !== 'o';
};

const hex = (s: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
const BG = hex(PALETTE.day.bg);
const INK = hex(PALETTE.day.ink);
const SS = 8; // supersamples per axis

/** RGBA pixels, top row first. */
function render(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const scale = (size * FILL) / Math.max(srcW, srcH);
  const ox = (size - srcW * scale) / 2;
  const oy = (size - srcH * scale) / 2;
  const r = size * RADIUS;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let dino = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          const cx = Math.min(Math.max(x, r), size - r);
          const cy = Math.min(Math.max(y, r), size - r);
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          tile++;
          if (ink(Math.floor((x - ox) / scale), Math.floor((y - oy) / scale))) dino++;
        }
      const a = tile / (SS * SS);
      const t = tile ? dino / tile : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(BG[c] + (INK[c] - BG[c]) * t);
      out[i + 3] = Math.round(a * 255);
    }
  return out;
}

/** ICO image entry: a BITMAPINFOHEADER DIB, 32-bit BGRA bottom-up, plus a 1-bit AND mask. */
function dib(size: number, rgba: Uint8Array): Buffer {
  const maskStride = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // colour + mask heights
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(size * size * 4 + maskStride * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[o++] = rgba[i + 2];
      buf[o++] = rgba[i + 1];
      buf[o++] = rgba[i];
      buf[o++] = rgba[i + 3];
    }
  for (let y = size - 1; y >= 0; y--, o += maskStride)
    for (let x = 0; x < size; x++) if (rgba[(y * size + x) * 4 + 3] === 0) buf[o + (x >> 3)] |= 0x80 >> (x & 7);
  return buf;
}

const images = SIZES.map((s) => dib(s, render(s)));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((img, n) => {
  const e = 6 + n * 16;
  const s = SIZES[n];
  header[e] = s >= 256 ? 0 : s;
  header[e + 1] = s >= 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(img.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync(new URL('../public/favicon.ico', import.meta.url), Buffer.concat([header, ...images]));
console.log(`public/favicon.ico: ${SIZES.join(', ')} px, ${offset} bytes`);
