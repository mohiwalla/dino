// Tiny ink voxels: one InstancedMesh with struct-of-arrays state and swap-remove on death,
// so emitting and simulating never allocate. Units are px and seconds.

import * as THREE from 'three';
import { buildVoxelGeometry, VoxelGrid } from './voxel';

/** Lies on the ground: scrolls with the world and freezes while crashed. */
export const WORLD = 0;
/** Crash debris: keeps flying while the world is frozen and does not scroll. */
export const BURST = 1;
export type ParticleKind = typeof WORLD | typeof BURST;

const DRAG = 2.2;
const BOUNCE = 0.3;
const GROUND_FRICTION = 0.55;
/** Particles shrink away over the last part of their life. */
const FADE_FROM = 0.5;
const POP_IN = 0.04;

export interface Particles {
  readonly mesh: THREE.InstancedMesh;
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, gravity: number, kind: ParticleKind): void;
  /** `scroll` is the ground speed in px/s; `frozen` holds WORLD particles in place. */
  update(dt: number, scroll: number, frozen: boolean): void;
  /** Turn crash debris into ground particles so it scrolls away once the run restarts. */
  settleBursts(): void;
  dispose(): void;
}

export function createParticles(material: THREE.Material, capacity: number): Particles {
  const cube = new VoxelGrid(1, 1, 1);
  cube.set(0, 0, 0, 1);
  // Unit cube with an all-white colour attribute, so `vertexColors` materials render it as-is.
  const geometry = buildVoxelGeometry(cube, { origin: 'center', ao: false });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.count = 0;
  mesh.name = 'particles';

  const px = new Float32Array(capacity);
  const py = new Float32Array(capacity);
  const pz = new Float32Array(capacity);
  const vx = new Float32Array(capacity);
  const vy = new Float32Array(capacity);
  const vz = new Float32Array(capacity);
  const rx = new Float32Array(capacity);
  const rz = new Float32Array(capacity);
  const wx = new Float32Array(capacity);
  const wz = new Float32Array(capacity);
  const age = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const size = new Float32Array(capacity);
  const grav = new Float32Array(capacity);
  const kind = new Uint8Array(capacity);
  const fields = [px, py, pz, vx, vy, vz, rx, rz, wx, wz, age, life, size, grav, kind];
  let alive = 0;

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();

  function kill(i: number): void {
    const last = --alive;
    for (let f = 0; f < fields.length; f++) fields[f][i] = fields[f][last];
  }

  function integrate(i: number, dt: number, scroll: number, drag: number): void {
    vy[i] -= grav[i] * dt;
    vx[i] *= drag;
    vz[i] *= drag;
    px[i] += (vx[i] - (kind[i] === WORLD ? scroll : 0)) * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
    rx[i] += wx[i] * dt;
    rz[i] += wz[i] * dt;
    const half = size[i] * 0.5;
    if (py[i] < half) {
      py[i] = half;
      vy[i] = vy[i] < -30 ? -vy[i] * BOUNCE : 0;
      vx[i] *= GROUND_FRICTION;
      vz[i] *= GROUND_FRICTION;
      wx[i] *= GROUND_FRICTION;
      wz[i] *= GROUND_FRICTION;
    }
  }

  function writeMatrix(i: number): void {
    const t = age[i] / life[i];
    const fade = t < FADE_FROM ? 1 : 1 - THREE.MathUtils.smoothstep(t, FADE_FROM, 1);
    const s = size[i] * fade * Math.min(1, age[i] / POP_IN + 0.3);
    // Shrink toward the ground contact point rather than the centre.
    pos.set(px[i], Math.max(s * 0.5, py[i] - (size[i] - s) * 0.5), pz[i]);
    quat.setFromEuler(euler.set(rx[i], 0, rz[i]));
    scale.set(s, s, s);
    mesh.setMatrixAt(i, m.compose(pos, quat, scale));
  }

  return {
    mesh,

    emit(x, y, z, svx, svy, svz, s, l, g, k) {
      if (alive >= capacity) return;
      const i = alive++;
      px[i] = x;
      py[i] = y;
      pz[i] = z;
      vx[i] = svx;
      vy[i] = svy;
      vz[i] = svz;
      rx[i] = 0;
      rz[i] = 0;
      wx[i] = svz * 0.05;
      wz[i] = -svx * 0.05;
      age[i] = 0;
      life[i] = l;
      size[i] = s;
      grav[i] = g;
      kind[i] = k;
    },

    update(dt, scroll, frozen) {
      const drag = Math.exp(-DRAG * dt);
      for (let i = 0; i < alive; ) {
        if (dt > 0 && !(frozen && kind[i] === WORLD)) {
          age[i] += dt;
          if (age[i] >= life[i]) {
            kill(i);
            continue;
          }
          integrate(i, dt, scroll, drag);
        }
        writeMatrix(i);
        i++;
      }
      mesh.count = alive;
      mesh.instanceMatrix.needsUpdate = true;
    },

    settleBursts() {
      for (let i = 0; i < alive; i++) kind[i] = WORLD;
    },

    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
    },
  };
}
