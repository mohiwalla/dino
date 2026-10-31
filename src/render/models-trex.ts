// Sculpts a T-Rex sprite into voxels. The body and head are "pillowed" (thicker away from
// the silhouette's edge) so they read as rounded masses from any angle; arms and legs are
// narrow slabs on either side of the mid-plane so the legs alternate left/right in 3D.
// From the side (looking down -Z) the voxels project exactly onto the sprite.

import { SLOT } from '../config';
import { distanceToEdge, VoxelGrid } from './voxel';
import { PART } from './sprites';
import { distanceToParts, fillColumn, maskParts, parseParts, profile } from './models-sculpt';

const DEPTH = 24;
const MID = DEPTH / 2;

// Chrome draws the T-Rex in 2 x 2 px blocks, so the depth profile steps once per block
// (2 px) rather than per pixel, which keeps the side faces broad and the bevels crisp.

/** Half-depth (voxels each side of the mid-plane) by block distance to the body/head edge; index 1 = outer block. */
const BODY_HALF = [0, 8, 10, 12];
const HEAD_HALF = [0, 6, 7];
/** The body thins toward the tail tip at x = 0: half-depth TAIL_HALF there, + 2 every TAIL_STEP px. */
const TAIL_HALF = 2;
const TAIL_STEP = 3;
/** Below the head the half-depth grows by NECK_STEP per block, so the neck flares into the body. */
const NECK_STEP = 2;
/** Both arms are slabs at |z - MID| in [ARM_Z0, ARM_Z1), just proud of the chest. */
const ARM_Z0 = 7;
const ARM_Z1 = 9;
/** Legs are slabs at |z - MID| in [LEG_Z0, LEG_Z1): back leg on -Z (far side), front leg on +Z. */
const LEG_Z0 = 5;
const LEG_Z1 = 9;

/** Distance in 2 px blocks: 1-2 px -> 1, 3-4 px -> 2, ... */
const blocks = (px: number) => Math.ceil(px / 2);

export function sculptTrex(rows: readonly string[]): VoxelGrid {
  const parts = parseParts(rows);
  const edge = distanceToEdge(maskParts(parts, [PART.BODY, PART.HEAD, PART.EYE]));
  const toHead = distanceToParts(parts, [PART.HEAD, PART.EYE]);
  const headMax = profile(HEAD_HALF, Infinity);
  const grid = new VoxelGrid(parts.w, parts.h, DEPTH);

  for (let y = 0; y < parts.h; y++)
    for (let x = 0; x < parts.w; x++) {
      const part = parts.px[y][x];
      switch (part) {
        case PART.BODY: {
          const tail = TAIL_HALF + 2 * Math.floor(x / TAIL_STEP);
          const neck = headMax + NECK_STEP * Math.floor(toHead[y][x] / 2);
          const half = Math.min(profile(BODY_HALF, blocks(edge[y][x])), tail, neck);
          fillColumn(grid, x, y, MID - half, MID + half, SLOT.INK);
          break;
        }
        case PART.HEAD:
        case PART.EYE: {
          const half = profile(HEAD_HALF, blocks(edge[y][x]));
          fillColumn(grid, x, y, MID - half, MID + half, SLOT.INK);
          if (part === PART.EYE) {
            grid.set(x, y, MID - half, SLOT.EYE);
            grid.set(x, y, MID + half - 1, SLOT.EYE);
          }
          break;
        }
        case PART.ARM:
          fillColumn(grid, x, y, MID + ARM_Z0, MID + ARM_Z1, SLOT.INK);
          fillColumn(grid, x, y, MID - ARM_Z1, MID - ARM_Z0, SLOT.INK);
          break;
        case PART.BACK_LEG:
          fillColumn(grid, x, y, MID - LEG_Z1, MID - LEG_Z0, SLOT.INK);
          break;
        case PART.FRONT_LEG:
          fillColumn(grid, x, y, MID + LEG_Z0, MID + LEG_Z1, SLOT.INK);
          break;
      }
    }
  return grid;
}
