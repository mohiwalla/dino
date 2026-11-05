// The voxel model library: every gameplay sprite sculpted (models-*.ts), meshed once with
// baked AO, and stretched from its Chrome ink box onto its sim box so that a mesh placed at
// (snapshot.x, snapshot.y, 0) covers exactly the sim's sprite box.

import * as THREE from 'three';
import { CACTUS_VARIANTS, OBSTACLES, PALETTE, SLOT, TREX } from '../config';
import type { ModelLibrary, TrexFrame } from '../types';
import { buildVoxelGeometry, type VoxelGrid } from './voxel';
import { CACTUS_LARGE_SPRITES, CACTUS_SMALL_SPRITES, PTERODACTYL_SPRITES, TREX_SPRITES } from './sprites';
import { sculptTrex } from './models-trex';
import { sculptCactus, type CactusArms } from './models-cactus';
import { sculptPterodactyl } from './models-ptero';

type CactusKind = 'cactusSmall' | 'cactusLarge';

const TREX_FRAMES: readonly TrexFrame[] = ['idle', 'blink', 'run1', 'run2', 'jump', 'crashed', 'duck1', 'duck2', 'happy'];

/**
 * Per-variant arm swing out of the side plane: Z offset per px of reach (+ = toward the
 * default camera). Left arms only swing back, so none points straight at the cinematic camera.
 */
const CACTUS_ARMS: Readonly<Record<CactusKind, readonly CactusArms[]>> = {
  cactusSmall: [
    { left: -1.5, right: 1.3 },
    { left: -0.5, right: -1.4 },
    { left: -1.1, right: 0.5 },
  ],
  cactusLarge: [
    { left: -1.2, right: 1.2 },
    { left: -0.5, right: -1.3 },
    { left: -1.6, right: 0.6 },
  ],
};

const CACTUS_SPRITES: Readonly<Record<CactusKind, readonly (readonly string[])[]>> = {
  cactusSmall: CACTUS_SMALL_SPRITES,
  cactusLarge: CACTUS_LARGE_SPRITES,
};

/** Mesh a grid whose [0, w] x [0, h] is the ink box, scaled by (sx, sy, sz) about the origin. */
function meshScaled(grid: VoxelGrid, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  return buildVoxelGeometry(grid).scale(sx, sy, sz);
}

function buildTrex(): Record<TrexFrame, THREE.BufferGeometry> {
  const stand = TREX_SPRITES.idle;
  const duck = TREX_SPRITES.duck1;
  const sx = TREX.WIDTH / stand[0].length;
  const sy = TREX.HEIGHT / stand.length;
  // Ducking keeps the standing pixel size vertically and in depth; only x stretches to WIDTH_DUCK.
  const sxDuck = TREX.WIDTH_DUCK / duck[0].length;
  const byBitmap = new Map<readonly string[], THREE.BufferGeometry>();
  const out = {} as Record<TrexFrame, THREE.BufferGeometry>;
  for (const frame of TREX_FRAMES) {
    const rows = TREX_SPRITES[frame];
    let geo = byBitmap.get(rows);
    if (!geo) {
      const ducking = frame === 'duck1' || frame === 'duck2';
      geo = meshScaled(sculptTrex(rows), ducking ? sxDuck : sx, sy, sx);
      byBitmap.set(rows, geo);
    }
    out[frame] = geo;
  }
  return out;
}

function buildCacti(kind: CactusKind): THREE.BufferGeometry[] {
  const { width, height } = OBSTACLES[kind];
  return CACTUS_SPRITES[kind].slice(0, CACTUS_VARIANTS[kind]).map((rows, i) => {
    const sx = width / rows[0].length;
    return meshScaled(sculptCactus(rows, CACTUS_ARMS[kind][i]), sx, height / rows.length, sx);
  });
}

function buildPterodactyl(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const { width, height } = OBSTACLES.pterodactyl;
  const [up, down] = PTERODACTYL_SPRITES;
  // Stretch the ink (2 px in from each side) to the full box width, scaling about the box centre.
  const s = width / up[0].length;
  const fit = (geo: THREE.BufferGeometry) => geo.translate(-width / 2, -height / 2, 0).scale(s, s, s).translate(width / 2, height / 2, 0);
  return [fit(buildVoxelGeometry(sculptPterodactyl(up, up, true))), fit(buildVoxelGeometry(sculptPterodactyl(down, up, false)))];
}

interface Swatch {
  material: THREE.MeshLambertMaterial;
  /** sRGB components, so the blend matches Chrome's CSS invert() fade. */
  day: THREE.RGB;
  night: THREE.RGB;
}

function createSwatch(name: string, day: string, night: string): Swatch {
  const srgb = (hex: string) => new THREE.Color(hex).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const material = new THREE.MeshLambertMaterial({ name, color: day, vertexColors: true });
  return { material, day: srgb(day), night: srgb(night) };
}

export function createModelLibrary(): ModelLibrary {
  const swatches: Swatch[] = [];
  swatches[SLOT.INK - 1] = createSwatch('voxel-ink', PALETTE.day.ink, PALETTE.night.ink);
  swatches[SLOT.EYE - 1] = createSwatch('voxel-eye', PALETTE.day.eye, PALETTE.night.eye);
  const materials = swatches.map((s) => s.material);

  const trex = buildTrex();
  const cacti: Record<CactusKind, THREE.BufferGeometry[]> = { cactusSmall: buildCacti('cactusSmall'), cactusLarge: buildCacti('cactusLarge') };
  const pterodactyl = buildPterodactyl();

  return {
    materials,
    trex: (frame) => trex[frame],
    cactus: (kind, variant) => {
      const list = cacti[kind];
      return list[((Math.floor(variant) % list.length) + list.length) % list.length];
    },
    pterodactyl: (frame) => pterodactyl[frame],
    setNight(amount) {
      const t = Math.min(1, Math.max(0, amount));
      for (const { material, day, night } of swatches)
        material.color.setRGB(day.r + (night.r - day.r) * t, day.g + (night.g - day.g) * t, day.b + (night.b - day.b) * t, THREE.SRGBColorSpace);
    },
    dispose() {
      const all = new Set([...Object.values(trex), ...cacti.cactusSmall, ...cacti.cactusLarge, ...pterodactyl]);
      for (const geo of all) geo.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
