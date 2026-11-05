// Chrome checkForCollision, in y-up world space. Chrome's boxes are sprite-local with y growing
// down from the sprite's top; every box here is converted once to y-up, bottom-left origin.

import { OBSTACLES, TREX, type ObstacleTypeConfig } from '../config';
import type { Box, ObstacleKind } from '../types';

interface ChromeBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function toYUp(box: ChromeBox, spriteHeight: number): Box {
  return { x: box.x, y: spriteHeight - box.y - box.h, w: box.w, h: box.h };
}

export const TREX_RUNNING_BOXES: readonly Box[] = TREX.COLLISION_RUNNING.map((b) => toYUp(b, TREX.HEIGHT));
/** Chrome measures the ducking box from the 47 px standing sprite's top, so convert with HEIGHT too. */
export const TREX_DUCKING_BOXES: readonly Box[] = TREX.COLLISION_DUCKING.map((b) => toYUp(b, TREX.HEIGHT));

/**
 * Fine boxes for a group of `size` obstacles, with Chrome's stretch of the middle box. Two
 * pterodactyls are a stacked pair: the second bird's boxes again, stackGap higher.
 */
export function obstacleCollisionBoxes(kind: ObstacleKind, size: number): Box[] {
  const type: ObstacleTypeConfig = OBSTACLES[kind];
  const boxes = type.collision.map((b) => toYUp(b, type.height));
  if (kind === 'pterodactyl' && size === 2) return [...boxes, ...boxes.map((b) => ({ ...b, y: b.y + (type.stackGap ?? 0) }))];
  if (size > 1 && boxes.length >= 3) {
    const width = type.width * size;
    boxes[1].w = width - boxes[0].w - boxes[2].w;
    boxes[2].x = width - boxes[2].w;
  }
  return boxes;
}

function overlaps(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * True if the T-Rex (feet at `trexY`, left edge TREX.START_X) touches the obstacle whose
 * bottom-left is (ox, oy). Outer boxes are inset by 1 px; the T-Rex's outer box is always the
 * standing one, exactly like Chrome. Chrome offsets both sides' fine boxes by the same 1 px
 * inset, which cancels out, so fine boxes are compared at their sprite origins.
 */
export function hitsObstacle(
  trexY: number,
  ducking: boolean,
  ox: number,
  oy: number,
  ow: number,
  oh: number,
  boxes: readonly Box[],
): boolean {
  const tx = TREX.START_X;
  if (!overlaps(tx + 1, trexY + 1, TREX.WIDTH - 2, TREX.HEIGHT - 2, ox + 1, oy + 1, ow - 2, oh - 2)) {
    return false;
  }
  const trexBoxes = ducking ? TREX_DUCKING_BOXES : TREX_RUNNING_BOXES;
  for (const t of trexBoxes) {
    for (const b of boxes) {
      if (overlaps(tx + t.x, trexY + t.y, t.w, t.h, ox + b.x, oy + b.y, b.w, b.h)) return true;
    }
  }
  return false;
}
