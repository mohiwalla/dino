// Sculpts a cactus sprite into round voxel tubes. Every row of the trunk becomes a disc as
// wide as the sprite's trunk. Each arm is an upright tube joined to the trunk by an elbow
// tube; the arm swings out of the side plane by shearing it in Z with its distance from the
// trunk, so the arms branch out in depth while the side view still projects onto the sprite.

import { SLOT } from '../config';
import { VoxelGrid, type Bitmap } from './voxel';
import { PART } from './sprites';
import { parseParts, runThrough } from './models-sculpt';

const DEPTH = 41;
/** Index of the voxel centred on z = 0 (DEPTH is odd so discs centre on a voxel). */
const MID = (DEPTH - 1) / 2;

export interface CactusArms {
  /** Z offset per pixel the left arm reaches out from the trunk (tan of its angle to the side plane). */
  left: number;
  right: number;
}

interface Trunk {
  centre: number;
  radius: number;
}

/** An arm's upright tube: the columns that hold most of the arm, and its Z offset. */
interface Upright {
  x0: number;
  x1: number;
  centre: number;
  z: number;
}

export function sculptCactus(rows: readonly string[], arms: CactusArms): VoxelGrid {
  const parts = parseParts(rows);
  const trunk = measureTrunk(parts);
  const uprights = new Map<number, Upright>([
    [PART.LEFT_ARM, measureUpright(parts, PART.LEFT_ARM, trunk, arms.left)],
    [PART.RIGHT_ARM, measureUpright(parts, PART.RIGHT_ARM, trunk, arms.right)],
  ]);
  const grid = new VoxelGrid(parts.w, parts.h, DEPTH);
  for (let y = 0; y < parts.h; y++)
    for (let x = 0; x < parts.w; x++) {
      const part = parts.px[y][x];
      const upright = uprights.get(part);
      if (part === PART.BODY) {
        const run = runThrough(parts, x, y, 'x');
        fillDisc(grid, x, y, run.len / 2, x + 0.5 - run.centre, 0);
      } else if (upright) {
        const shear = part === PART.LEFT_ARM ? arms.left : arms.right;
        fillArm(grid, parts, trunk, upright, shear, x, y);
      }
    }
  return grid;
}

/** The trunk's most common row: its centre and radius in pixels. */
function measureTrunk(parts: Bitmap): Trunk {
  const counts = new Map<string, number>();
  let best: Trunk = { centre: parts.w / 2, radius: 0 };
  let bestCount = 0;
  for (let y = 0; y < parts.h; y++) {
    const x = parts.px[y].indexOf(PART.BODY);
    if (x < 0) continue;
    const run = runThrough(parts, x, y, 'x');
    const key = `${run.centre}:${run.len}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      best = { centre: run.centre, radius: run.len / 2 };
    }
  }
  return best;
}

/** The upright is every column holding at least half as many arm pixels as the fullest one. */
function measureUpright(parts: Bitmap, part: number, trunk: Trunk, shear: number): Upright {
  const counts = Array.from({ length: parts.w }, (_, x) => parts.px.reduce((n, row) => n + (row[x] === part ? 1 : 0), 0));
  const most = Math.max(...counts);
  const cols = counts.flatMap((n, x) => (most > 0 && n * 2 >= most ? [x] : []));
  const x0 = cols.length ? cols[0] : 0;
  const x1 = cols.length ? cols[cols.length - 1] + 1 : 0;
  const centre = (x0 + x1) / 2;
  return { x0, x1, centre, z: shear * reach(centre, trunk) };
}

/** How far a point (pixel-edge x) is outside the trunk's surface. */
function reach(x: number, trunk: Trunk): number {
  return Math.max(0, Math.abs(x - trunk.centre) - trunk.radius);
}

function fillArm(grid: VoxelGrid, parts: Bitmap, trunk: Trunk, upright: Upright, shear: number, x: number, y: number): void {
  if (x >= upright.x0 && x < upright.x1) {
    // Upright tube: a vertical cylinder on the upright's columns, narrowing into its rounded tip.
    const across = runThrough(parts, x, y, 'x');
    const tip = across.len < upright.x1 - upright.x0;
    fillDisc(grid, x, y, tip ? across.len / 2 : (upright.x1 - upright.x0) / 2, x + 0.5 - (tip ? across.centre : upright.centre), upright.z);
    return;
  }
  // Elbow tube: as tall as the arm is here, running diagonally in XZ from the trunk to the
  // upright. A column cuts the slanted tube obliquely, so its section is stretched in Z.
  const along = runThrough(parts, x, y, 'y');
  const z = shear * reach(x + 0.5, trunk);
  const zClamped = Math.abs(z) > Math.abs(upright.z) ? upright.z : z;
  fillDisc(grid, x, y, along.len / 2, y + 0.5 - along.centre, zClamped, Math.hypot(1, shear));
}

/**
 * Fill the voxels of column (x, y) that fall inside a tube's circular section of `radius`,
 * where `offset` is the pixel's distance from the tube axis within the sprite plane, `zCentre`
 * the axis' z offset from the mid-plane and `zStretch` widens the section in Z.
 */
function fillDisc(grid: VoxelGrid, x: number, y: number, radius: number, offset: number, zCentre: number, zStretch = 1): void {
  const halfChord = zStretch * Math.sqrt(Math.max(0, radius * radius - offset * offset));
  const z0 = Math.ceil(zCentre - halfChord - 1e-6);
  const z1 = Math.floor(zCentre + halfChord + 1e-6);
  for (let z = z0; z <= z1; z++) grid.set(x, y, MID + z, SLOT.INK);
  // A pixel at the very rim of a thin tube can miss every voxel centre; keep the silhouette whole.
  if (z0 > z1) grid.set(x, y, MID + Math.round(zCentre), SLOT.INK);
}
