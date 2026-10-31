// Chrome's Horizon obstacle logic: spawning (type / size / gap rules), movement, despawning.
// RUNNER.SPAWN_X plays the role of Chrome's canvas width.

import { CACTUS_VARIANTS, OBSTACLES, RUNNER } from '../config';
import type { Box, GameEvent, ObstacleKind, ObstacleSnapshot } from '../types';
import { obstacleCollisionBoxes } from './collision';
import { randomInt, type Random } from './rng';
import { msToSteps } from './steps';

export const OBSTACLE_KINDS: readonly ObstacleKind[] = ['cactusSmall', 'cactusLarge', 'pterodactyl'];

export interface Obstacle {
  readonly id: number;
  readonly kind: ObstacleKind;
  readonly size: number;
  readonly variants: readonly number[];
  x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  frame: 0 | 1;
  frameSteps: number;
  /** Added to the ground speed (pterodactyls fly at speed +/- type.speedOffset). */
  readonly speedOffset: number;
  /** The next obstacle spawns once x + width + gap < SPAWN_X. */
  readonly gap: number;
  readonly collisionBoxes: readonly Box[];
}

export interface ObstacleField {
  readonly list: Obstacle[];
  /** Kinds of the latest spawns, newest first (Chrome's obstacleHistory). */
  readonly history: ObstacleKind[];
  /** Never reset, so ids stay unique for the sim's lifetime. */
  nextId: number;
}

const FRAME_STEPS: Record<ObstacleKind, number> = {
  cactusSmall: 0,
  cactusLarge: 0,
  pterodactyl: msToSteps(OBSTACLES.pterodactyl.frameMs),
};

export function createObstacleField(): ObstacleField {
  return { list: [], history: [], nextId: 1 };
}

/** Empties the field for a new run; every removed obstacle gets a despawn event. */
export function clearObstacles(field: ObstacleField, events: GameEvent[]): void {
  for (const o of field.list) events.push({ type: 'despawn', id: o.id });
  field.list.length = 0;
  field.history.length = 0;
}

/** Chrome Horizon.updateObstacles: move, drop the ones behind DESPAWN_X, then maybe spawn one. */
export function updateObstacles(
  field: ObstacleField,
  speed: number,
  random: Random,
  mobile: boolean,
  events: GameEvent[],
): void {
  for (const o of field.list) moveObstacle(o, speed);
  removeDespawned(field.list, events);
  const last = field.list[field.list.length - 1];
  if (last && last.x + last.width + last.gap >= RUNNER.SPAWN_X) return;
  const o = spawnObstacle(field, speed, random, mobile);
  field.list.push(o);
  events.push({ type: 'spawn', id: o.id, kind: o.kind });
}

function moveObstacle(o: Obstacle, speed: number): void {
  o.x -= speed + o.speedOffset;
  const frameSteps = FRAME_STEPS[o.kind];
  if (frameSteps === 0) return;
  o.frameSteps++;
  if (o.frameSteps >= frameSteps) {
    o.frame = o.frame === 0 ? 1 : 0;
    o.frameSteps = 0;
  }
}

function removeDespawned(list: Obstacle[], events: GameEvent[]): void {
  let kept = 0;
  for (const o of list) {
    if (o.x + o.width < RUNNER.DESPAWN_X) events.push({ type: 'despawn', id: o.id });
    else list[kept++] = o;
  }
  list.length = kept;
}

/** Chrome Horizon.addNewObstacle + Obstacle.init. Records the kind in the history. */
export function spawnObstacle(field: ObstacleField, speed: number, random: Random, mobile: boolean): Obstacle {
  const kind = pickKind(field.history, speed, random);
  const type = OBSTACLES[kind];
  let size = randomInt(random, 1, RUNNER.MAX_OBSTACLE_LENGTH);
  if (type.multipleSpeed > speed) size = 1;
  const width = type.width * size;
  const heights = mobile ? type.yUpMobile : type.yUp;
  const y = heights[randomInt(random, 0, heights.length - 1)];
  const speedOffset = type.speedOffset === 0 ? 0 : random() > 0.5 ? type.speedOffset : -type.speedOffset;
  const minGap = Math.round(width * speed + type.minGap * RUNNER.GAP_COEFFICIENT);
  const gap = randomInt(random, minGap, Math.round(minGap * RUNNER.MAX_GAP_COEFFICIENT));
  const variants = pickVariants(kind, size, random);

  field.history.unshift(kind);
  if (field.history.length > RUNNER.MAX_OBSTACLE_DUPLICATION) field.history.length = RUNNER.MAX_OBSTACLE_DUPLICATION;

  return {
    id: field.nextId++,
    kind,
    size,
    variants,
    x: RUNNER.SPAWN_X,
    y,
    width,
    height: type.height,
    frame: 0,
    frameSteps: 0,
    speedOffset,
    gap,
    collisionBoxes: obstacleCollisionBoxes(kind, size),
  };
}

function pickKind(history: readonly ObstacleKind[], speed: number, random: Random): ObstacleKind {
  for (;;) {
    const kind = OBSTACLE_KINDS[randomInt(random, 0, OBSTACLE_KINDS.length - 1)];
    if (!isDuplicate(history, kind) && speed >= OBSTACLES[kind].minSpeed) return kind;
  }
}

/** True if the last MAX_OBSTACLE_DUPLICATION spawns were all `kind`. */
export function isDuplicate(history: readonly ObstacleKind[], kind: ObstacleKind): boolean {
  if (history.length < RUNNER.MAX_OBSTACLE_DUPLICATION) return false;
  for (let i = 0; i < RUNNER.MAX_OBSTACLE_DUPLICATION; i++) {
    if (history[i] !== kind) return false;
  }
  return true;
}

function pickVariants(kind: ObstacleKind, size: number, random: Random): number[] {
  if (kind === 'pterodactyl') return [0];
  const variants: number[] = [];
  for (let i = 0; i < size; i++) variants.push(randomInt(random, 0, CACTUS_VARIANTS[kind] - 1));
  return variants;
}

export function obstacleSnapshot(o: Obstacle): ObstacleSnapshot {
  return {
    id: o.id,
    kind: o.kind,
    size: o.size,
    variants: o.variants.slice(),
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    frame: o.frame,
    collisionBoxes: o.collisionBoxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
  };
}
