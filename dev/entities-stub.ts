// Stand-in ModelLibrary for the entities dev page while src/render/models.ts is in progress:
// blocky voxel silhouettes with the right sprite sizes and the real geometry conventions.

import * as THREE from 'three';
import { CACTUS_VARIANTS, OBSTACLES, PALETTE, SLOT, TREX } from '../src/config';
import type { ModelLibrary, TrexFrame } from '../src/types';
import { buildVoxelGeometry, VoxelGrid } from '../src/render/voxel';

const I = SLOT.INK;
const E = SLOT.EYE;

function standing(frame: TrexFrame): VoxelGrid {
  const g = new VoxelGrid(TREX.WIDTH, TREX.HEIGHT, 14);
  g.fillBox(22, 31, 3, 44, 47, 11, I); // head
  g.fillBox(30, 31, 3, 44, 33, 11, 0); // mouth gap
  g.fillBox(22, 31, 3, 34, 33, 11, I);
  g.fillBox(26, 41, 2, 29, 44, 3, frame === 'blink' ? I : E); // eyes
  g.fillBox(26, 41, 11, 29, 44, 12, frame === 'blink' ? I : E);
  g.fillBox(10, 12, 2, 30, 34, 12, I); // body
  g.fillBox(0, 18, 4, 10, 30, 10, I); // tail
  g.fillBox(0, 28, 5, 3, 34, 9, I);
  g.fillBox(30, 21, 3, 35, 25, 5, I); // arms
  g.fillBox(30, 21, 9, 35, 25, 11, I);
  const lift = frame === 'run1' ? 1 : frame === 'run2' ? 2 : 0;
  g.fillBox(12, lift === 1 ? 4 : 0, 3, 17, 12, 6, I); // legs
  g.fillBox(22, lift === 2 ? 4 : 0, 8, 27, 12, 11, I);
  if (frame === 'crashed') g.fillBox(25, 40, 1, 30, 45, 13, I);
  return g;
}

function ducking(frame: TrexFrame): VoxelGrid {
  const g = new VoxelGrid(TREX.WIDTH_DUCK, TREX.HEIGHT_DUCK, 14);
  g.fillBox(0, 12, 4, 40, 22, 10, I); // tail + body
  g.fillBox(8, 8, 2, 40, 22, 12, I);
  g.fillBox(38, 10, 3, 59, 25, 11, I); // head
  g.fillBox(50, 21, 2, 53, 24, 12, E);
  g.fillBox(14, frame === 'duck1' ? 0 : 3, 3, 19, 8, 6, I);
  g.fillBox(26, frame === 'duck2' ? 0 : 3, 8, 31, 8, 11, I);
  return g;
}

function cactus(kind: 'cactusSmall' | 'cactusLarge', variant: number): VoxelGrid {
  const { width: w, height: h } = OBSTACLES[kind];
  const g = new VoxelGrid(w, h, 9);
  const t0 = Math.floor(w / 2) - 2;
  g.fillBox(t0, 0, 2, t0 + 5, h, 7, I);
  const armY = Math.floor(h * (0.35 + variant * 0.08));
  g.fillBox(1, armY, 3, 4, armY + Math.floor(h * 0.35), 6, I);
  g.fillBox(1, armY, 3, t0, armY + 3, 6, I);
  g.fillBox(w - 4, armY + 4, 3, w - 1, armY + 4 + Math.floor(h * 0.3), 6, I);
  g.fillBox(t0 + 5, armY + 4, 3, w - 1, armY + 7, 6, I);
  return g;
}

function pterodactyl(frame: 0 | 1): VoxelGrid {
  const { width: w, height: h } = OBSTACLES.pterodactyl;
  const g = new VoxelGrid(w, h, 10);
  g.fillBox(0, 22, 4, 14, 26, 6, I); // beak
  g.fillBox(6, 20, 3, 16, 30, 7, I); // head
  g.fillBox(8, 26, 2, 10, 28, 3, E);
  g.fillBox(14, 18, 3, 46, 26, 7, I); // body + tail
  if (frame === 0) g.fillBox(16, 26, 1, 30, 40, 9, I);
  else g.fillBox(16, 2, 1, 30, 18, 9, I);
  return g;
}

export function createStubModels(): ModelLibrary {
  const materials = [
    new THREE.MeshLambertMaterial({ color: PALETTE.day.ink, vertexColors: true }),
    new THREE.MeshLambertMaterial({ color: PALETTE.day.eye, vertexColors: true }),
  ];
  const frames: TrexFrame[] = ['idle', 'blink', 'run1', 'run2', 'duck1', 'duck2', 'jump', 'crashed'];
  const trex = new Map(frames.map((f) => [f, buildVoxelGeometry(f.startsWith('duck') ? ducking(f) : standing(f))]));
  const cacti = new Map<string, THREE.BufferGeometry>();
  for (const kind of ['cactusSmall', 'cactusLarge'] as const)
    for (let v = 0; v < CACTUS_VARIANTS[kind]; v++) cacti.set(`${kind}${v}`, buildVoxelGeometry(cactus(kind, v)));
  const ptero = [buildVoxelGeometry(pterodactyl(0)), buildVoxelGeometry(pterodactyl(1))];
  const day = [new THREE.Color(PALETTE.day.ink), new THREE.Color(PALETTE.day.eye)];
  const night = [new THREE.Color(PALETTE.night.ink), new THREE.Color(PALETTE.night.eye)];

  return {
    materials,
    trex: (f) => trex.get(f)!,
    cactus: (kind, v) => cacti.get(`${kind}${v}`)!,
    pterodactyl: (f) => ptero[f],
    setNight(t) {
      materials.forEach((m, i) => m.color.lerpColors(day[i], night[i], t));
    },
    dispose() {
      for (const g of [...trex.values(), ...cacti.values(), ...ptero]) g.dispose();
      materials.forEach((m) => m.dispose());
    },
  };
}
