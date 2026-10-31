// Sculpts the pterodactyl: a slim pillowed body and head from the sprite, plus two real wings
// that spread sideways in ±Z. Both frames share one wing planform (taken from the wings-up
// sprite, whose side view shows the whole wing) swept up or down from the shoulder, so the
// side view reads like Chrome's sprite and the chase camera sees a flapping creature.

import { OBSTACLES, SLOT } from '../config';
import { distanceToEdge, VoxelGrid, type Bitmap } from './voxel';
import { PART } from './sprites';
import { fillColumn, maskParts, parseParts, profile, topRow } from './models-sculpt';

const BOX_W = OBSTACLES.pterodactyl.width;
const BOX_H = OBSTACLES.pterodactyl.height;
/** Where the 42 x 36 ink box sits inside Chrome's 46 x 40 sprite box (x, y-up). */
const INK_X = 2;
const INK_Y = 2;

const DEPTH = 71;
const MID = (DEPTH - 1) / 2;
/** Half-depth (voxels either side of the centre voxel) by distance to the silhouette edge. */
const BODY_HALF = [0, 1, 2, 3];
const HEAD_HALF = [0, 1, 2, 2];
/** Beak and tail come to a point: half-depth <= POINT_TAPER * pixels from the tip. */
const POINT_TAPER = 0.5;

/** Wings start this far from the centre voxel; each 1 px rise or fall takes WING_TREAD voxels of span. */
const WING_ROOT = 2;
const WING_TREAD = 2;
const WING_THICK = 2;
/** Lowest layer of the wing tip, in sprite-box y-up px: Chrome's wing tips sit 2 px inside the box. */
const WING_TIP_Y_UP = 36;
const WING_TIP_Y_DOWN = 2;

interface Chord {
  y: number;
  x0: number;
  x1: number;
}

/** Sculpt one frame in Chrome's 46 x 40 box coordinates. `planform` is the wings-up sprite. */
export function sculptPterodactyl(rows: readonly string[], planform: readonly string[], wingsUp: boolean): VoxelGrid {
  const parts = parseParts(rows);
  const grid = new VoxelGrid(BOX_W, BOX_H, DEPTH);
  sculptBody(grid, parts);
  const [root, tip] = wingChords(parseParts(planform));
  // The raised wing rises from the back to the sprite's tip; the lowered one falls as far.
  const rise = WING_TIP_Y_UP - root.y;
  if (wingsUp) sculptWings(grid, root, tip, root.y, rise);
  else sculptWings(grid, root, tip, WING_TIP_Y_DOWN + rise, -rise);
  return grid;
}

function sculptBody(grid: VoxelGrid, parts: Bitmap): void {
  const edge = distanceToEdge(maskParts(parts, [PART.BODY, PART.HEAD]));
  for (let y = 0; y < parts.h; y++)
    for (let x = 0; x < parts.w; x++) {
      const part = parts.px[y][x];
      if (part !== PART.BODY && part !== PART.HEAD) continue;
      const table = part === PART.HEAD ? HEAD_HALF : BODY_HALF;
      const point = Math.floor(POINT_TAPER * Math.min(x, parts.w - 1 - x));
      const half = Math.min(profile(table, edge[y][x]), point);
      fillColumn(grid, x + INK_X, y + INK_Y, MID - half, MID + half + 1, SLOT.INK);
    }
}

/** Root (lowest) and tip (highest) wing rows of the wings-up sprite, in box coordinates. */
function wingChords(planform: Bitmap): [Chord, Chord] {
  const chordAt = (y: number): Chord => {
    const row = planform.px[y];
    return { y: y + INK_Y, x0: row.indexOf(PART.WING) + INK_X, x1: row.lastIndexOf(PART.WING) + 1 + INK_X };
  };
  let bottom = 0;
  while (!planform.px[bottom].includes(PART.WING)) bottom++;
  return [chordAt(bottom), chordAt(topRow(planform, PART.WING))];
}

/** A straight wing on each side: a 2 px thick staircase tapering from the root chord to the tip chord. */
function sculptWings(grid: VoxelGrid, root: Chord, tip: Chord, rootY: number, rise: number): void {
  const span = Math.abs(rise) * WING_TREAD;
  for (let i = 0; i < span; i++) {
    const t = i / (span - 1);
    const x0 = Math.round(root.x0 + (tip.x0 - root.x0) * t);
    const x1 = Math.max(x0 + 1, Math.round(root.x1 + (tip.x1 - root.x1) * t));
    const y = rootY + Math.sign(rise) * Math.floor((i + 1) / WING_TREAD);
    const z = WING_ROOT + i;
    grid.fillBox(x0, y, MID + z, x1, y + WING_THICK, MID + z + 1, SLOT.INK);
    grid.fillBox(x0, y, MID - z, x1, y + WING_THICK, MID - z + 1, SLOT.INK);
  }
}
