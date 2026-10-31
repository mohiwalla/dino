// The T-Rex view: a mesh whose geometry follows the sim frame, wrapped in a pivot at the
// bottom-centre of the sprite box for a little juice (squash & stretch, speed lean, crash
// recoil). Rotations stay under a few degrees and scaling happens about the feet, so the
// silhouette never strays more than a pixel or two from the sim's collision box.

import * as THREE from 'three';
import { RUNNER } from '../config';
import type { GameSnapshot, ModelLibrary, TrexFrame } from '../types';

/** Squash & stretch limit, as a fraction of the model's height. */
const MAX_SQUASH = 0.08;
/** Spring velocities (1/s) kicked in by events; peak ≈ impulse / omega. */
const JUMP_STRETCH = 1.5;
const LAND_SQUASH = -1.9;
const CRASH_SQUASH = -1.2;
const SQUASH_OMEGA = 24;
const SQUASH_ZETA = 0.42;
/** Forward lean (radians) at MAX_SPEED. Negative z rotation tips the head toward +X. */
const MAX_LEAN = 0.055;
const LEAN_RATE = 3;
/** Crash recoil: the T-Rex rocks back and settles at a slight backward tilt. */
const CRASH_TILT = 0.06;
const CRASH_KICK = 2.4;
const TILT_OMEGA = 18;
const TILT_ZETA = 0.35;

interface Spring {
  x: number;
  v: number;
}

/** Semi-implicit damped spring toward `target`, sub-stepped so large frames stay stable. */
function stepSpring(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (-omega * omega * (s.x - target) - 2 * zeta * omega * s.v) * h;
    s.x += s.v * h;
  }
}

export interface TrexView {
  readonly root: THREE.Group;
  /** `dtMs` is 0 while paused; `fresh` means a restart happened between prev and curr. */
  update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number, fresh: boolean): void;
  jump(): void;
  land(): void;
  crash(): void;
  restart(): void;
  dispose(): void;
}

export function createTrexView(models: ModelLibrary): TrexView {
  const root = new THREE.Group();
  root.name = 'trex';
  const pivot = new THREE.Group();
  let frame: TrexFrame = 'idle';
  const mesh = new THREE.Mesh(models.trex(frame), models.materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  pivot.add(mesh);
  root.add(pivot);

  const squash: Spring = { x: 0, v: 0 };
  const tilt: Spring = { x: 0, v: 0 };
  let lean = 0;
  let crashed = false;

  function setFrame(next: TrexFrame): void {
    if (next === frame) return;
    frame = next;
    mesh.geometry = models.trex(next);
  }

  function updateJuice(curr: GameSnapshot, dt: number): void {
    const playing = curr.phase === 'playing';
    stepSpring(squash, 0, SQUASH_OMEGA, SQUASH_ZETA, dt);
    squash.x = THREE.MathUtils.clamp(squash.x, -MAX_SQUASH, MAX_SQUASH);
    stepSpring(tilt, crashed ? CRASH_TILT : 0, TILT_OMEGA, TILT_ZETA, dt);

    const speedT = THREE.MathUtils.clamp((curr.speed - RUNNER.SPEED) / (RUNNER.MAX_SPEED - RUNNER.SPEED), 0, 1);
    const leanTarget = playing ? -MAX_LEAN * speedT * speedT : 0;
    lean += (leanTarget - lean) * (1 - Math.exp(-LEAN_RATE * dt));
  }

  return {
    root,

    update(prev, curr, alpha, dtMs, fresh) {
      const a = fresh ? 1 : alpha;
      const t0 = prev.trex;
      const t1 = curr.trex;
      root.position.set(t0.x + (t1.x - t0.x) * a, t0.y + (t1.y - t0.y) * a, 0);
      setFrame(t1.frame);

      if (dtMs > 0) updateJuice(curr, dtMs / 1000);
      const halfW = t1.width / 2;
      pivot.position.x = halfW;
      mesh.position.x = -halfW;
      const s = squash.x;
      pivot.scale.set(1 - s * 0.5, 1 + s, 1 - s * 0.5);
      pivot.rotation.z = lean + tilt.x;
    },

    jump() {
      squash.v += JUMP_STRETCH;
    },

    land() {
      squash.v += LAND_SQUASH;
    },

    crash() {
      crashed = true;
      squash.v += CRASH_SQUASH;
      tilt.v += CRASH_KICK;
    },

    restart() {
      crashed = false;
    },

    dispose() {
      root.removeFromParent();
    },
  };
}
