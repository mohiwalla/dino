// Obstacle meshes, pooled and keyed by snapshot id. A view is a Group at the interpolated
// sim position holding up to MAX_OBSTACLE_LENGTH meshes (one per cactus, or one pterodactyl).
// Views that leave the snapshot go back to the free list, hidden but still in the scene.

import * as THREE from 'three';
import { OBSTACLES, RUNNER } from '../config';
import type { GameSnapshot, ModelLibrary, ObstacleKind, ObstacleSnapshot } from '../types';

/** Spawn-in duration; each cactus of a group starts a little after its neighbour. */
const SPAWN_MS = 250;
const SPAWN_STAGGER_MS = 45;
/** Max per-cactus depth offset, px. */
const Z_JITTER = 4;
/** Pterodactyl bob: ±BOB_PX over one wing-flap cycle (two frames), in sim steps. */
const BOB_PX = 1;
const BOB_PERIOD_STEPS = 20;

interface ObstacleView {
  id: number;
  kind: ObstacleKind;
  size: number;
  /** Pterodactyl wing frame currently on the mesh, -1 for cacti. */
  frame: number;
  /** ms since the view was claimed; drives the spawn-in. */
  age: number;
  seen: boolean;
  readonly group: THREE.Group;
  readonly meshes: THREE.Mesh[];
}

/** Integer hash -> [0, 1). Deterministic per obstacle id, so a group looks the same every frame. */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Depth offset of cactus `i` in group `id`: neighbours alternate front/back by 1..Z_JITTER px. */
function cactusZ(id: number, i: number): number {
  const side = hash01(id * 5) < 0.5 ? -1 : 1;
  const alt = i % 2 === 0 ? 1 : -1;
  return side * alt * Math.round(1 + hash01(id * 5 + i + 1) * (Z_JITTER - 1));
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeOutBack(t: number): number {
  const c = 1.6;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

function findById(list: readonly ObstacleSnapshot[], id: number): ObstacleSnapshot | undefined {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return undefined;
}

/** Interpolated x of obstacle `o` (from `curr`). Falls back to curr when it is new or after a restart. */
export function obstacleX(prev: GameSnapshot, o: ObstacleSnapshot, alpha: number, fresh: boolean): number {
  const p = fresh ? undefined : findById(prev.obstacles, o.id);
  return p ? p.x + (o.x - p.x) * alpha : o.x;
}

export interface ObstaclePool {
  readonly root: THREE.Group;
  /** `dtMs` is 0 while paused. */
  update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number, fresh: boolean): void;
  dispose(): void;
}

export function createObstaclePool(models: ModelLibrary): ObstaclePool {
  const root = new THREE.Group();
  root.name = 'obstacles';
  const active: ObstacleView[] = [];
  const free: ObstacleView[] = [];

  function createView(): ObstacleView {
    const group = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < RUNNER.MAX_OBSTACLE_LENGTH; i++) {
      const mesh = new THREE.Mesh(models.cactus('cactusSmall', 0), models.materials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    root.add(group);
    return { id: -1, kind: 'cactusSmall', size: 1, frame: -1, age: 0, seen: false, group, meshes };
  }

  function claim(o: ObstacleSnapshot): ObstacleView {
    const v = free.pop() ?? createView();
    v.id = o.id;
    v.kind = o.kind;
    v.size = o.size;
    v.frame = -1;
    v.age = 0;
    v.group.visible = true;
    for (let i = 0; i < v.meshes.length; i++) {
      const mesh = v.meshes[i];
      mesh.visible = i < o.size;
      mesh.scale.set(1, 1, 1);
      mesh.position.set(0, 0, 0);
      if (i >= o.size || o.kind === 'pterodactyl') continue;
      mesh.geometry = models.cactus(o.kind, o.variants[i] ?? 0);
      mesh.position.set(i * OBSTACLES[o.kind].width, 0, cactusZ(o.id, i));
    }
    active.push(v);
    return v;
  }

  function release(index: number): void {
    const v = active[index];
    v.group.visible = false;
    v.id = -1;
    active[index] = active[active.length - 1];
    active.pop();
    free.push(v);
  }

  function find(id: number): ObstacleView | undefined {
    for (let i = 0; i < active.length; i++) if (active[i].id === id) return active[i];
    return undefined;
  }

  /** Cacti rise out of the ground one after another. */
  function poseCacti(v: ObstacleView): void {
    const h = OBSTACLES[v.kind].height;
    for (let i = 0; i < v.size; i++) {
      const t = THREE.MathUtils.clamp((v.age - i * SPAWN_STAGGER_MS) / SPAWN_MS, 0, 1);
      v.meshes[i].position.y = -(h + 1) * (1 - easeOutCubic(t));
    }
  }

  /** Pterodactyls flap (geometry swap) and pop in, scaling about their centre. */
  function posePterodactyl(v: ObstacleView, o: ObstacleSnapshot): void {
    const mesh = v.meshes[0];
    if (o.frame !== v.frame) {
      v.frame = o.frame;
      mesh.geometry = models.pterodactyl(o.frame);
    }
    const s = Math.max(0.001, easeOutBack(THREE.MathUtils.clamp(v.age / SPAWN_MS, 0, 1)));
    const { width, height } = OBSTACLES.pterodactyl;
    mesh.scale.setScalar(s);
    mesh.position.set((width / 2) * (1 - s), (height / 2) * (1 - s), 0);
  }

  return {
    root,

    update(prev, curr, alpha, dtMs, fresh) {
      for (let i = 0; i < active.length; i++) active[i].seen = false;
      const simTime = curr.frame + alpha;

      for (let k = 0; k < curr.obstacles.length; k++) {
        const o = curr.obstacles[k];
        const v = find(o.id) ?? claim(o);
        v.seen = true;
        v.age += dtMs;
        let y = o.y;
        if (o.kind === 'pterodactyl') {
          posePterodactyl(v, o);
          y += BOB_PX * Math.sin(((simTime + o.id * 7) / BOB_PERIOD_STEPS) * Math.PI * 2);
        } else {
          poseCacti(v);
        }
        v.group.position.set(obstacleX(prev, o, alpha, fresh), y, 0);
      }

      for (let i = active.length - 1; i >= 0; i--) if (!active[i].seen) release(i);
    },

    dispose() {
      root.removeFromParent();
      active.length = 0;
      free.length = 0;
    },
  };
}
