// Chrome's clouds as puffy voxel clouds in the sky behind the lane. They drift with a slow
// parallax (Chrome's BG_CLOUD_SPEED, slower for deeper ones), wrap around a window wider than
// any camera sees, and are re-rolled (height, size, shape) on every wrap. They ignore the
// scene fog and use their own haze instead, so the side camera (far away) still sees them.

import * as THREE from 'three';
import { CLOUD_VARIANTS, cloudGeometry } from './world-shapes';
import { hash, setHazed, smoothstep } from './world-util';

const COUNT = 11;
/** Chrome Cloud: BG_CLOUD_SPEED is 0.2 of the ground speed. */
const BG_CLOUD_SPEED = 0.2;
const X_MIN = -700;
const X_MAX = 2500;
const SPAN = X_MAX - X_MIN;
const Z_NEAR = -150;
const Z_FAR = -700;
const SEED = 907;

export interface WorldClouds {
  /** `scroll`: forward motion in ground px; `cloud`/`sky`: current palette colours (linear). */
  update(scroll: number, cloud: THREE.Color, sky: THREE.Color): void;
  dispose(): void;
}

interface CloudSlot {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  /** 0 = nearest layer, 1 = deepest. */
  depth: number;
  home: number;
  parallax: number;
  wrap: number;
  baseHaze: number;
}

export function createClouds(scene: THREE.Scene): WorldClouds {
  const root = new THREE.Group();
  root.name = 'world.clouds';
  scene.add(root);
  const geometries = Array.from({ length: CLOUD_VARIANTS }, (_, v) => cloudGeometry(v));

  const slots: CloudSlot[] = [];
  for (let i = 0; i < COUNT; i++) {
    // Interleave depths so neighbours along x sit at different distances.
    const depth = ((i * 7) % COUNT) / (COUNT - 1);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false });
    const mesh = new THREE.Mesh(geometries[0], material);
    mesh.name = `world.cloud${i}`;
    mesh.position.z = Z_NEAR + (Z_FAR - Z_NEAR) * depth;
    root.add(mesh);
    slots.push({
      mesh,
      depth,
      home: X_MIN + (SPAN * (i + 0.2 + 0.6 * hash(i, 1, SEED))) / COUNT,
      parallax: BG_CLOUD_SPEED * (1 - 0.55 * depth),
      wrap: Number.NaN,
      baseHaze: 0.04 + 0.26 * depth,
    });
  }

  /** A new look for a cloud each time it wraps around: shape, size, facing and height. */
  function reroll(slot: CloudSlot, index: number): void {
    const { mesh, depth, wrap } = slot;
    mesh.geometry = geometries[Math.floor(hash(index, wrap * 16, SEED) * CLOUD_VARIANTS)];
    mesh.scale.setScalar(1.3 + 0.9 * depth + hash(index, wrap * 16 + 1, SEED) * (0.5 + 0.8 * depth));
    mesh.rotation.y = hash(index, wrap * 16 + 2, SEED) < 0.5 ? 0 : Math.PI;
    mesh.position.y = 115 + 45 * depth + hash(index, wrap * 16 + 3, SEED) * (55 + 95 * depth);
  }

  return {
    update(scroll, cloud, sky) {
      for (let i = 0; i < COUNT; i++) {
        const slot = slots[i];
        const raw = slot.home - scroll * slot.parallax - X_MIN;
        const wrap = Math.floor(raw / SPAN);
        if (wrap !== slot.wrap) {
          slot.wrap = wrap;
          reroll(slot, i);
        }
        const width = 46 * slot.mesh.scale.x;
        // Rotated clouds extend to -x from their origin; keep x as the left edge either way.
        const left = X_MIN + (raw - wrap * SPAN);
        slot.mesh.position.x = slot.mesh.rotation.y === 0 ? left : left + width;
        const edge = smoothstep(X_MIN, X_MIN + 350, left) * smoothstep(X_MAX, X_MAX - 1000, left);
        setHazed(slot.mesh.material, cloud, sky, 1 - (1 - slot.baseHaze) * edge, 0.5);
      }
    },
    dispose() {
      root.removeFromParent();
      for (const s of slots) s.mesh.material.dispose();
      for (const g of geometries) g.dispose();
    },
  };
}
