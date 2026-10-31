// Small 2D helpers shared by the model sculptors: part-labelled bitmaps (see sprites.ts),
// part masks, distance fields and run lengths.

import { parseBitmap, type Bitmap, type VoxelGrid } from './voxel';
import { PART_LEGEND } from './sprites';

/** A part-labelled sprite as a y-up bitmap of part ids (0 = empty). */
export function parseParts(rows: readonly string[]): Bitmap {
  return parseBitmap(rows, PART_LEGEND);
}

/** A copy of `bmp` that keeps only the pixels whose part is in `parts`. */
export function maskParts(bmp: Bitmap, parts: readonly number[]): Bitmap {
  return { w: bmp.w, h: bmp.h, px: bmp.px.map((row) => row.map((v) => (parts.includes(v) ? v : 0))) };
}

/** Chessboard distance from every pixel to the nearest pixel whose part is in `parts`. */
export function distanceToParts(bmp: Bitmap, parts: readonly number[]): number[][] {
  const { w, h, px } = bmp;
  const INF = 1 << 20;
  const d = px.map((row) => row.map((v) => (parts.includes(v) ? 0 : INF)));
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? INF : d[y][x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) d[y][x] = Math.min(d[y][x], 1 + Math.min(at(x - 1, y), at(x, y - 1), at(x - 1, y - 1), at(x + 1, y - 1)));
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) d[y][x] = Math.min(d[y][x], 1 + Math.min(at(x + 1, y), at(x, y + 1), at(x + 1, y + 1), at(x - 1, y + 1)));
  return d;
}

export interface Run {
  /** Pixels in the run. */
  len: number;
  /** Centre of the run in pixel-edge coordinates (a run over pixels 2..4 has centre 3.5). */
  centre: number;
}

/** The run of pixels with the same part as (x, y) through it, along x (a row) or y (a column). */
export function runThrough(bmp: Bitmap, x: number, y: number, axis: 'x' | 'y'): Run {
  const part = bmp.px[y][x];
  const same = (i: number) => {
    const [px, py] = axis === 'x' ? [i, y] : [x, i];
    return px >= 0 && py >= 0 && px < bmp.w && py < bmp.h && bmp.px[py][px] === part;
  };
  const start = axis === 'x' ? x : y;
  let lo = start;
  let hi = start;
  while (same(lo - 1)) lo--;
  while (same(hi + 1)) hi++;
  return { len: hi - lo + 1, centre: (lo + hi + 1) / 2 };
}

/** Topmost row (y-up) holding any pixel of `part`, or -1. */
export function topRow(bmp: Bitmap, part: number): number {
  for (let y = bmp.h - 1; y >= 0; y--) if (bmp.px[y].includes(part)) return y;
  return -1;
}

/** Table lookup clamped to the last entry: profile([0, 5, 7], 9) === 7. */
export function profile(table: readonly number[], i: number): number {
  return table[Math.min(i, table.length - 1)];
}

/** Fill voxels (x, y, z0..z1-1). */
export function fillColumn(grid: VoxelGrid, x: number, y: number, z0: number, z1: number, slot: number): void {
  for (let z = z0; z < z1; z++) grid.set(x, y, z, slot);
}
