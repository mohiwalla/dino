// Hash-placed decorations that scroll with the ground. The ground is split into cells along X
// ("ground space" = world x + scroll); every cell's contents are a pure function of its index,
// so an item always sits at the same ground position and nothing jumps or visibly repeats.
// Each frame only the cells inside the view window are written into one InstancedMesh.

import * as THREE from 'three';
import { hash, smoothstep, writeInstance } from './world-util';

/** Where one item goes. `u` is the position inside its cell in [0, 1). */
export interface Placement {
  u: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
}

/** Random numbers for one (cell, slot) item; `get(salt)` is stable across frames. */
export class ItemRandom {
  cell = 0;
  slot = 0;

  constructor(private readonly seed: number) {}

  get(salt: number): number {
    return hash(this.cell, this.slot * 64 + salt, this.seed);
  }

  range(salt: number, lo: number, hi: number): number {
    return lo + (hi - lo) * this.get(salt);
  }
}

export interface ScatterSpec {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  seed: number;
  /** Cell length along X, in ground units. */
  cell: number;
  /** Candidate items per cell. */
  perCell: number;
  /** View window in world x; items outside are not drawn. */
  xMin: number;
  xMax: number;
  /** Ground units scrolled per unit of distance (1 = the ground itself). */
  parallax?: number;
  /** Sink items into the ground (y scale -> 0) within this many units of the window edges. */
  edgeSink?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Fill `out` for an item, or return false for an empty slot. */
  place(rnd: ItemRandom, out: Placement): boolean;
}

export interface ScatterLayer {
  readonly mesh: THREE.InstancedMesh;
  /** `scroll`: forward motion in ground px. */
  update(scroll: number): void;
  dispose(): void;
}

export function createScatterLayer(spec: ScatterSpec): ScatterLayer {
  const parallax = spec.parallax ?? 1;
  const capacity = (Math.ceil((spec.xMax - spec.xMin) / spec.cell) + 2) * spec.perCell;
  const mesh = new THREE.InstancedMesh(spec.geometry, spec.material, capacity);
  mesh.name = `world.${spec.name}`;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Instances move every frame; a cached bounding sphere would go stale.
  mesh.frustumCulled = false;
  mesh.castShadow = spec.castShadow ?? false;
  mesh.receiveShadow = spec.receiveShadow ?? false;
  mesh.count = 0;

  const rnd = new ItemRandom(spec.seed);
  const p: Placement = { u: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, yaw: 0 };
  const arr = mesh.instanceMatrix.array as Float32Array;
  let lastScroll = Number.NaN;

  function update(groundScroll: number): void {
    const scroll = groundScroll * parallax;
    if (scroll === lastScroll) return;
    lastScroll = scroll;
    const first = Math.floor((scroll + spec.xMin) / spec.cell);
    const last = Math.floor((scroll + spec.xMax) / spec.cell);
    let n = 0;
    for (let c = first; c <= last && n < capacity; c++) {
      rnd.cell = c;
      for (let k = 0; k < spec.perCell; k++) {
        rnd.slot = k;
        if (!spec.place(rnd, p)) continue;
        const x = (c + p.u) * spec.cell - scroll;
        if (x < spec.xMin || x > spec.xMax) continue;
        const sink = spec.edgeSink ? smoothstep(spec.xMin, spec.xMin + spec.edgeSink, x) * smoothstep(spec.xMax, spec.xMax - spec.edgeSink, x) : 1;
        if (sink <= 0) continue;
        writeInstance(arr, n++, x, p.y, p.z, p.sx, p.sy * sink, p.sz, p.yaw);
        if (n >= capacity) break;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    mesh,
    update,
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
    },
  };
}
