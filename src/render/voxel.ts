// Pixel art -> voxels -> BufferGeometry. Every model in the game (T-Rex, cacti, pterodactyl,
// clouds, moon, pebbles...) is a VoxelGrid meshed here, so they share one look: face-culled
// cubes with Minecraft-style per-vertex ambient occlusion baked into grayscale vertex colours.
//
// Materials colour the geometry: each voxel stores a material slot (1..255), and the mesh has
// one geometry group per slot with materialIndex = slot - 1. Use materials with
// `vertexColors: true` so the baked AO multiplies the material colour.

import * as THREE from 'three';

/** Dense voxel grid. 0 = empty, 1..255 = material slot. */
export class VoxelGrid {
  readonly data: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    readonly d: number,
  ) {
    this.data = new Uint8Array(w * h * d);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.w && y < this.h && z < this.d;
  }

  /** Out-of-bounds reads are empty. */
  get(x: number, y: number, z: number): number {
    return this.inBounds(x, y, z) ? this.data[x + this.w * (y + this.h * z)] : 0;
  }

  /** Out-of-bounds writes are ignored. */
  set(x: number, y: number, z: number, slot: number): void {
    if (this.inBounds(x, y, z)) this.data[x + this.w * (y + this.h * z)] = slot;
  }

  /** Fill the half-open box [x0, x1) x [y0, y1) x [z0, z1). */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, slot: number): void {
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, z, slot);
  }

  /** Copy every non-empty voxel of `src` into this grid, offset by (ox, oy, oz). */
  paste(src: VoxelGrid, ox: number, oy: number, oz: number): void {
    for (let z = 0; z < src.d; z++)
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const v = src.get(x, y, z);
          if (v) this.set(x + ox, y + oy, z + oz, v);
        }
  }

  clone(): VoxelGrid {
    const g = new VoxelGrid(this.w, this.h, this.d);
    g.data.set(this.data);
    return g;
  }

  count(): number {
    let n = 0;
    for (const v of this.data) if (v) n++;
    return n;
  }
}

/** A 2D pixel-art image, y-up: px[y][x], row 0 is the BOTTOM row. 0 = empty. */
export interface Bitmap {
  w: number;
  h: number;
  px: number[][];
}

/**
 * Parse pixel-art rows written top row first (as you would draw them in source) into a
 * y-up Bitmap. `legend` maps characters to material slots; any character not in the legend
 * (e.g. '.' or ' ') is empty. Rows may have different lengths; width is the longest row.
 */
export function parseBitmap(rows: readonly string[], legend: Readonly<Record<string, number>>): Bitmap {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const px: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row = rows[h - 1 - y];
    const out: number[] = [];
    for (let x = 0; x < w; x++) out.push(legend[row[x] ?? ''] ?? 0);
    px.push(out);
  }
  return { w, h, px };
}

/**
 * For every filled pixel, the chessboard distance to the nearest empty pixel or the image
 * border (1 = on the silhouette's edge). Empty pixels get 0. Useful for "pillow" depth.
 */
export function distanceToEdge(bmp: Bitmap): number[][] {
  const { w, h, px } = bmp;
  const INF = 1 << 20;
  const dist = px.map((row) => row.map((v) => (v ? INF : 0)));
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : dist[y][x]);
  // Two-pass chamfer transform with unit cost in 8 directions.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (dist[y][x]) dist[y][x] = Math.min(dist[y][x], 1 + Math.min(at(x - 1, y), at(x, y - 1), at(x - 1, y - 1), at(x + 1, y - 1)));
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--)
      if (dist[y][x]) dist[y][x] = Math.min(dist[y][x], 1 + Math.min(at(x + 1, y), at(x, y + 1), at(x + 1, y + 1), at(x - 1, y + 1)));
  return dist;
}

/** Returns the half-open z range [z0, z1) to fill for a pixel, in voxel coords within [0, depth). */
export type ZRangeFn = (x: number, y: number, slot: number, edgeDist: number) => readonly [number, number];

/** Same thickness everywhere: a straight extrusion through the full depth. */
export const flatZRange =
  (depth: number): ZRangeFn =>
  () =>
    [0, depth];

/**
 * "Pillow" profile: thickness = minThickness + gain * (edgeDist - 1), capped at depth,
 * centred in the grid. Gives pixel art a rounded, sculpted body instead of a cookie-cutter slab.
 */
export function pillowZRange(depth: number, minThickness: number, gain: number): ZRangeFn {
  return (_x, _y, _slot, edgeDist) => {
    const t = Math.min(depth, Math.round(minThickness + gain * Math.max(0, edgeDist - 1)));
    const z0 = Math.floor((depth - t) / 2);
    return [z0, z0 + t];
  };
}

/** Extrude a bitmap into a new grid of the given depth using a per-pixel z range. */
export function extrudeBitmap(bmp: Bitmap, depth: number, zRange: ZRangeFn = flatZRange(depth)): VoxelGrid {
  const grid = new VoxelGrid(bmp.w, bmp.h, depth);
  const dist = distanceToEdge(bmp);
  for (let y = 0; y < bmp.h; y++)
    for (let x = 0; x < bmp.w; x++) {
      const slot = bmp.px[y][x];
      if (!slot) continue;
      const [z0, z1] = zRange(x, y, slot, dist[y][x]);
      for (let z = Math.max(0, z0); z < Math.min(depth, z1); z++) grid.set(x, y, z, slot);
    }
  return grid;
}

export interface VoxelGeometryOptions {
  /** World units per voxel. Default 1 (one voxel per sprite pixel). */
  voxelSize?: number;
  /**
   * 'base' (default): x in [0, w], y in [0, h], z centred on 0 — matches sim boxes.
   * 'center': centred on the origin in all three axes.
   */
  origin?: 'base' | 'center';
  /** Bake ambient occlusion into vertex colours. Default true. */
  ao?: boolean;
  /** 0 = no darkening, 1 = full AO curve. Default 0.55. */
  aoStrength?: number;
}

// Per face: normal, the face's corner origin (in voxel-local 0/1 coords) and two edge axes
// du, dv with du x dv == normal, so (o, o+du, o+du+dv, o+dv) is counter-clockwise from outside.
type Vec3 = readonly [number, number, number];
const FACES: readonly { n: Vec3; o: Vec3; du: Vec3; dv: Vec3 }[] = [
  { n: [1, 0, 0], o: [1, 0, 0], du: [0, 1, 0], dv: [0, 0, 1] },
  { n: [-1, 0, 0], o: [0, 0, 0], du: [0, 0, 1], dv: [0, 1, 0] },
  { n: [0, 1, 0], o: [0, 1, 0], du: [0, 0, 1], dv: [1, 0, 0] },
  { n: [0, -1, 0], o: [0, 0, 0], du: [1, 0, 0], dv: [0, 0, 1] },
  { n: [0, 0, 1], o: [0, 0, 1], du: [1, 0, 0], dv: [0, 1, 0] },
  { n: [0, 0, -1], o: [0, 0, 0], du: [0, 1, 0], dv: [1, 0, 0] },
];
// Corner order a, b, c, d as (u, v) steps along du / dv.
const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
// Brightness for 0..3 unoccluded neighbours.
const AO_CURVE = [0.45, 0.65, 0.83, 1];

/**
 * Mesh a grid into an indexed, face-culled BufferGeometry with position, normal and color
 * attributes and one group per material slot (materialIndex = slot - 1, groups sorted by slot).
 */
export function buildVoxelGeometry(grid: VoxelGrid, opts: VoxelGeometryOptions = {}): THREE.BufferGeometry {
  const s = opts.voxelSize ?? 1;
  const useAo = opts.ao ?? true;
  const aoStrength = opts.aoStrength ?? 0.55;
  const ox = opts.origin === 'center' ? -grid.w / 2 : 0;
  const oy = opts.origin === 'center' ? -grid.h / 2 : 0;
  const oz = -grid.d / 2;

  // Quads bucketed by slot so each slot becomes one contiguous index range (= one group).
  const buckets = new Map<number, { pos: number[]; nor: number[]; col: number[]; ao: number[] }>();
  const solid = (x: number, y: number, z: number) => (grid.get(x, y, z) ? 1 : 0);

  for (let z = 0; z < grid.d; z++)
    for (let y = 0; y < grid.h; y++)
      for (let x = 0; x < grid.w; x++) {
        const slot = grid.get(x, y, z);
        if (!slot) continue;
        for (const f of FACES) {
          const nx = x + f.n[0];
          const ny = y + f.n[1];
          const nz = z + f.n[2];
          if (solid(nx, ny, nz)) continue;

          let b = buckets.get(slot);
          if (!b) buckets.set(slot, (b = { pos: [], nor: [], col: [], ao: [] }));

          for (const [cu, cv] of CORNERS) {
            let shade = 1;
            if (useAo) {
              const su = cu ? 1 : -1;
              const sv = cv ? 1 : -1;
              const s1 = solid(nx + su * f.du[0], ny + su * f.du[1], nz + su * f.du[2]);
              const s2 = solid(nx + sv * f.dv[0], ny + sv * f.dv[1], nz + sv * f.dv[2]);
              const c = solid(nx + su * f.du[0] + sv * f.dv[0], ny + su * f.du[1] + sv * f.dv[1], nz + su * f.du[2] + sv * f.dv[2]);
              const level = s1 && s2 ? 0 : 3 - (s1 + s2 + c);
              b.ao.push(level);
              shade = 1 - aoStrength * (1 - AO_CURVE[level]);
            } else {
              b.ao.push(3);
            }
            const px = x + f.o[0] + cu * f.du[0] + cv * f.dv[0];
            const py = y + f.o[1] + cu * f.du[1] + cv * f.dv[1];
            const pz = z + f.o[2] + cu * f.du[2] + cv * f.dv[2];
            b.pos.push((px + ox) * s, (py + oy) * s, (pz + oz) * s);
            b.nor.push(f.n[0], f.n[1], f.n[2]);
            b.col.push(shade, shade, shade);
          }
        }
      }

  const slots = [...buckets.keys()].sort((a, b) => a - b);
  let vertexCount = 0;
  for (const b of buckets.values()) vertexCount += b.pos.length / 3;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = vertexCount > 65535 ? new Uint32Array(vertexCount * 1.5) : new Uint16Array(vertexCount * 1.5);
  const geometry = new THREE.BufferGeometry();

  let vert = 0;
  let idx = 0;
  for (const slot of slots) {
    const b = buckets.get(slot)!;
    positions.set(b.pos, vert * 3);
    normals.set(b.nor, vert * 3);
    colors.set(b.col, vert * 3);
    const start = idx;
    const quads = b.pos.length / 12;
    for (let q = 0; q < quads; q++) {
      const i = vert + q * 4;
      const a = q * 4;
      // Split along the brighter diagonal so a dark corner stays in its own triangle.
      const tri =
        b.ao[a] + b.ao[a + 2] < b.ao[a + 1] + b.ao[a + 3]
          ? [i + 1, i + 2, i + 3, i + 1, i + 3, i]
          : [i, i + 1, i + 2, i, i + 2, i + 3];
      indices.set(tri, idx);
      idx += 6;
    }
    vert += quads * 4;
    geometry.addGroup(start, idx - start, slot - 1);
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
