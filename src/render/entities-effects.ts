// Gameplay effects built on the particle pool: running dust, a landing puff and the crash
// burst. Events only raise flags; emission happens in update() where the T-Rex's
// interpolated position is known.

import * as THREE from 'three';
import { SIM } from '../config';
import type { GameSnapshot, TrexFrame } from '../types';
import { BURST, createParticles, WORLD } from './entities-particles';

const CAPACITY = 256;
/** Dust is kicked up on every DUST_EVERY-th foot change of the run / duck cycle. */
const DUST_EVERY = 2;
const DUST_GRAVITY = 380;
const PUFF_COUNT = 12;
const BURST_COUNT = 26;
const BURST_GRAVITY = 1500;

function isStride(frame: TrexFrame): boolean {
  return frame === 'run1' || frame === 'run2' || frame === 'duck1' || frame === 'duck2';
}

/** mulberry32: a tiny allocation-free PRNG, seeded so effects look the same run to run. */
function createRandom(seed: number): (lo: number, hi: number) => number {
  let s = seed >>> 0;
  return (lo, hi) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return lo + (((t ^ (t >>> 14)) >>> 0) / 4294967296) * (hi - lo);
  };
}

export interface Effects {
  readonly mesh: THREE.InstancedMesh;
  /** `trex` is the T-Rex root's interpolated position; `dtMs` is 0 while paused. */
  update(curr: GameSnapshot, trex: THREE.Vector3, dtMs: number): void;
  land(): void;
  crash(): void;
  restart(): void;
  dispose(): void;
}

export function createEffects(material: THREE.Material): Effects {
  const particles = createParticles(material, CAPACITY);
  const rand = createRandom(0x7e3a);
  let lastFrame: TrexFrame = 'idle';
  let strides = 0;
  let pendingLand = false;
  let pendingCrash = false;

  function dust(curr: GameSnapshot, p: THREE.Vector3): void {
    const n = rand(0, 1) < 0.4 ? 2 : 1;
    const footX = p.x + curr.trex.width * 0.28;
    for (let i = 0; i < n; i++) {
      particles.emit(
        footX + rand(-3, 3), 1, rand(-6, 6),
        rand(-50, -10), rand(45, 110), rand(-25, 25),
        rand(1.2, 2.2), rand(0.3, 0.5), DUST_GRAVITY, WORLD,
      );
    }
  }

  function puff(curr: GameSnapshot, p: THREE.Vector3): void {
    const cx = p.x + curr.trex.width * 0.5;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const a = (i / PUFF_COUNT) * Math.PI * 2 + rand(-0.2, 0.2);
      const v = rand(50, 95);
      particles.emit(
        cx + Math.cos(a) * 9, 1, Math.sin(a) * 6,
        Math.cos(a) * v, rand(30, 75), Math.sin(a) * v * 0.8,
        rand(1.3, 2.3), rand(0.35, 0.55), DUST_GRAVITY, WORLD,
      );
    }
  }

  function burst(curr: GameSnapshot, p: THREE.Vector3): void {
    const cx = p.x + curr.trex.width * 0.8;
    const cy = p.y + curr.trex.height * 0.55;
    for (let i = 0; i < BURST_COUNT; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(70, 200);
      particles.emit(
        cx + rand(-4, 4), cy + rand(-8, 8), rand(-5, 5),
        Math.cos(a) * v - 25, rand(150, 360), Math.sin(a) * v * 0.6,
        rand(1.3, 3), rand(1.2, 1.8), BURST_GRAVITY, BURST,
      );
    }
  }

  return {
    mesh: particles.mesh,

    update(curr, trex, dtMs) {
      if (dtMs > 0) {
        const t = curr.trex;
        const grounded = curr.phase === 'playing' && t.y <= 0;
        if (t.frame !== lastFrame && isStride(t.frame) && grounded && ++strides % DUST_EVERY === 0) dust(curr, trex);
        if (pendingLand) puff(curr, trex);
        if (pendingCrash) burst(curr, trex);
        pendingLand = pendingCrash = false;
        lastFrame = t.frame;
      }
      const scroll = (curr.speed * 1000) / SIM.STEP_MS;
      particles.update(dtMs / 1000, curr.phase === 'playing' ? scroll : 0, curr.phase === 'crashed');
    },

    land() {
      pendingLand = true;
    },

    crash() {
      pendingCrash = true;
    },

    restart() {
      particles.settleBursts();
    },

    dispose() {
      particles.dispose();
    },
  };
}
