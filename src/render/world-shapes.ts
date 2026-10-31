// Voxel geometries for the environment: clouds, ground bits, horizon line bumps, mesas, moon
// and stars. All built once with the shared mesher (src/render/voxel.ts), single material slot.

import type * as THREE from 'three';
import { NIGHT } from '../config';
import { type Bitmap, VoxelGrid, buildVoxelGeometry, extrudeBitmap, parseBitmap, pillowZRange } from './voxel';

const S = 1;
const LEGEND = { '#': S };

type Disc = readonly [cx: number, cy: number, r: number];
type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

/** A filled, y-up bitmap: every pixel whose centre lies inside a disc or rect is set. */
function blobBitmap(w: number, h: number, discs: readonly Disc[], rects: readonly Rect[] = []): Bitmap {
  const px: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const inDisc = discs.some(([dx, dy, r]) => (cx - dx) ** 2 + (cy - dy) ** 2 <= r * r);
      const inRect = rects.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1);
      row.push(inDisc || inRect ? S : 0);
    }
    px.push(row);
  }
  return { w, h, px };
}

// Chrome's cloud sprite is 46 x 14: a flat-bottomed outline with a tall bump left of centre.
const CLOUD_SHAPES: readonly { discs: readonly Disc[]; rects: readonly Rect[] }[] = [
  {
    rects: [[4, 0, 42, 4.5]],
    discs: [
      [4.5, 4, 4],
      [41.5, 3.5, 3.5],
      [11.5, 5.5, 5],
      [21, 6.5, 7.6],
      [31.5, 5, 5],
    ],
  },
  {
    rects: [[5, 0, 41, 4]],
    discs: [
      [6, 4, 4.3],
      [40, 3.6, 3.8],
      [16, 6.8, 6.6],
      [27.5, 6, 6],
      [35.5, 4.6, 4.4],
    ],
  },
  {
    rects: [[3, 0, 43, 3.5]],
    discs: [
      [3.8, 3.2, 3.4],
      [42.3, 3, 3.2],
      [12, 4.8, 4.6],
      [24.5, 7.2, 6.8],
      [35, 5.6, 4.8],
    ],
  },
];

export const CLOUD_VARIANTS = CLOUD_SHAPES.length;

/** A puffy pillow-extruded cloud, base at y = 0, x in [0, 46], z centred. */
export function cloudGeometry(variant: number): THREE.BufferGeometry {
  const { discs, rects } = CLOUD_SHAPES[variant % CLOUD_SHAPES.length];
  const bmp = blobBitmap(46, 14, discs, rects);
  return buildVoxelGeometry(extrudeBitmap(bmp, 16, pillowZRange(16, 5, 2)), { aoStrength: 0.4 });
}

/** One unit voxel: x in [0, 1], y in [0, 1], z in [-0.5, 0.5]. Scaled per instance into dashes and lines. */
export function unitVoxelGeometry(): THREE.BufferGeometry {
  const g = new VoxelGrid(1, 1, 1);
  g.set(0, 0, 0, S);
  return buildVoxelGeometry(g);
}

/** Tiny lumps: a 2x2 footprint with a knob, and a 3x2 one with a ridge. */
export function pebbleGeometry(variant: number): THREE.BufferGeometry {
  const g = new VoxelGrid(3, 2, 2);
  if (variant % 2 === 0) {
    g.fillBox(0, 0, 0, 2, 1, 2, S);
    g.set(0, 1, 1, S);
  } else {
    g.fillBox(0, 0, 0, 3, 1, 2, S);
    g.fillBox(1, 1, 0, 3, 2, 1, S);
  }
  return buildVoxelGeometry(g, { origin: 'base' });
}

/** A low stepped rock, 5 x 3 x 4 voxels. */
export function rockGeometry(): THREE.BufferGeometry {
  const g = new VoxelGrid(5, 3, 4);
  g.fillBox(0, 0, 0, 5, 1, 4, S);
  g.fillBox(0, 1, 1, 4, 2, 4, S);
  g.fillBox(1, 2, 1, 3, 3, 3, S);
  g.set(4, 1, 0, 0);
  return buildVoxelGeometry(g);
}

/** A long low dune ridge: three stepped tiers. */
export function duneGeometry(): THREE.BufferGeometry {
  const g = new VoxelGrid(22, 3, 8);
  g.fillBox(0, 0, 1, 22, 1, 8, S);
  g.fillBox(2, 0, 0, 18, 1, 1, S);
  g.fillBox(3, 1, 2, 19, 2, 7, S);
  g.fillBox(7, 2, 3, 14, 3, 6, S);
  return buildVoxelGeometry(g, { voxelSize: 2.5, aoStrength: 0.35 });
}

// Chrome's horizon sprite has little 1-2 px rises along the ground line.
const BUMPS: readonly (readonly string[])[] = [
  ['..##..', '######'],
  ['...###...', '.#######.', '#########'],
  ['####'],
];

export const BUMP_VARIANTS = BUMPS.length;

/** A rise on the horizon line, `depth` voxels deep (matches the line), base at y = 0. */
export function bumpGeometry(variant: number, depth: number): THREE.BufferGeometry {
  return buildVoxelGeometry(extrudeBitmap(parseBitmap(BUMPS[variant % BUMPS.length], LEGEND), depth), { aoStrength: 0.3 });
}

const MESAS: readonly (readonly string[])[] = [
  [
    '......##########..........',
    '.....############.........',
    '.....############...####..',
    '....##############.######.',
    '...######################.',
    '.########################',
    '##########################',
  ],
  [
    '..........########......',
    '.........##########.....',
    '........############....',
    '.######.############....',
    '#######################.',
    '########################',
  ],
  [
    '....#######.....',
    '...#########....',
    '..###########...',
    '.##############.',
    '################',
  ],
];

export const MESA_VARIANTS = MESAS.length;

/** A distant flat-topped mesa built from chunky voxels. */
export function mesaGeometry(variant: number): THREE.BufferGeometry {
  const bmp = parseBitmap(MESAS[variant % MESAS.length], LEGEND);
  return buildVoxelGeometry(extrudeBitmap(bmp, 6, pillowZRange(6, 3, 2)), { voxelSize: 6, aoStrength: 0.35 });
}

/**
 * The moon for a Chrome moon phase in [0, NIGHT.MOON_PHASES): the middle phase is full; the
 * others are crescents that thicken toward it, lit side flipping across the full moon.
 * Centred on the origin, `radius` voxels.
 */
export function moonGeometry(phase: number, radius: number, voxelSize: number): THREE.BufferGeometry {
  const full = (NIGHT.MOON_PHASES - 1) / 2;
  const k = phase - full;
  const size = radius * 2 + 1;
  const rz = Math.round(radius * 0.6);
  const depth = rz * 2 + 1;
  const g = new VoxelGrid(size, size, depth);
  const c = radius;
  // Carve offset as a fraction of the diameter: thinner crescents further from full.
  const offset = k === 0 ? 0 : Math.sign(k) * (2 * radius + 1) * (0.28 + 0.22 * (full - Math.abs(k)));
  const r2 = (radius + 0.35) ** 2;
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = x - c;
        const dy = y - c;
        const dz = (z - rz) * (radius / rz);
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (k !== 0 && (dx - offset) ** 2 + dy * dy <= r2) continue;
        g.set(x, y, z, S);
      }
  carveCraters(g, c, rz);
  return buildVoxelGeometry(g, { voxelSize, origin: 'center', aoStrength: 0.7 });
}

// A few shallow dents on the moon's camera-facing side (+Z), in voxel offsets from the centre.
const CRATERS: readonly Disc[] = [
  [-3.5, 3, 2.2],
  [3, -2.5, 1.7],
  [-1, -5.5, 1.4],
  [5, 4.5, 1.3],
];

function carveCraters(g: VoxelGrid, c: number, rz: number): void {
  for (const [cx, cy, r] of CRATERS)
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        if ((x - c - cx) ** 2 + (y - c - cy) ** 2 > r * r) continue;
        // Remove the front-most voxel of the column.
        for (let z = g.d - 1; z >= rz; z--)
          if (g.get(x, y, z)) {
            g.set(x, y, z, 0);
            break;
          }
      }
}

/** A small 3D plus-shaped sparkle centred on the origin. */
export function starGeometry(voxelSize: number): THREE.BufferGeometry {
  const g = new VoxelGrid(3, 3, 3);
  g.set(1, 1, 1, S);
  g.set(0, 1, 1, S);
  g.set(2, 1, 1, S);
  g.set(1, 0, 1, S);
  g.set(1, 2, 1, S);
  g.set(1, 1, 0, S);
  g.set(1, 1, 2, S);
  return buildVoxelGeometry(g, { voxelSize, origin: 'center', ao: false });
}
