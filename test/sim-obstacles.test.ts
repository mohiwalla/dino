import { describe, expect, test } from 'bun:test';
import { CACTUS_VARIANTS, OBSTACLES, RUNNER } from '../src/config';
import { hitsObstacle, obstacleCollisionBoxes, TREX_DUCKING_BOXES, TREX_RUNNING_BOXES } from '../src/sim/collision';
import { createGameSim } from '../src/sim/game';
import {
  createObstacleField,
  gapSpeedScale,
  isDuplicate,
  spawnObstacle,
  updateObstacles,
  type Obstacle,
} from '../src/sim/obstacles';
import { mulberry32 } from '../src/sim/rng';
import type { GameEvent, InputFrame, ObstacleKind } from '../src/types';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const PRESS: InputFrame = { ...NONE, jumpPressed: true, jumpHeld: true };

describe('spawning', () => {
  test('no obstacles until the run has lasted CLEAR_TIME', () => {
    const sim = createGameSim({ random: mulberry32(11) });
    sim.step(PRESS);
    const clearSteps = Math.round(RUNNER.CLEAR_TIME / (1000 / 60));
    for (let i = 1; i < clearSteps; i++) {
      expect(sim.step(PRESS).some((e) => e.type === 'spawn')).toBe(false);
    }
    const s = sim.getSnapshot();
    expect(s.runFrames).toBe(clearSteps);
    expect(s.obstacles).toEqual([]);
    const events = sim.step(NONE);
    const spawn = events.find((e) => e.type === 'spawn');
    expect(spawn).toBeDefined();
    const after = sim.getSnapshot();
    expect(after.obstacles.length).toBe(1);
    // A run's first obstacle comes in closer than the rest.
    expect(after.obstacles[0].x).toBe(RUNNER.FIRST_SPAWN_X);
  });

  const SPEEDS = [6, 6.99, 7, 8.49, 8.5, 10, 13];
  for (const speed of SPEEDS) {
    test(`Chrome's type / size / gap / duplication rules hold over 4000 spawns at speed ${speed} (classic runs)`, () => {
      const random = mulberry32(Math.round(speed * 1000));
      const field = createObstacleField(true);
      const kinds: ObstacleKind[] = [];
      const sizes = new Map<ObstacleKind, Set<number>>();
      const variants = new Set<number>();
      const offsets = new Set<number>();
      let prevId = 0;
      for (let i = 0; i < 4000; i++) {
        const o = spawnObstacle(field, speed, random, false);
        const type = OBSTACLES[o.kind];
        expect(o.id).toBeGreaterThan(prevId);
        prevId = o.id;
        expect(speed).toBeGreaterThanOrEqual(type.minSpeed);
        expect(o.size).toBeGreaterThanOrEqual(1);
        expect(o.size).toBeLessThanOrEqual(RUNNER.MAX_OBSTACLE_LENGTH);
        if (type.multipleSpeed > speed) expect(o.size).toBe(1);
        expect(o.width).toBe(type.width * o.size);
        expect(o.height).toBe(type.height);
        expect(o.x).toBe(RUNNER.SPAWN_X);
        const minGap = Math.round(o.width * speed * gapSpeedScale(speed) + type.minGap * RUNNER.GAP_COEFFICIENT);
        expect(Number.isInteger(o.gap)).toBe(true);
        expect(o.gap).toBeGreaterThanOrEqual(minGap);
        expect(o.gap).toBeLessThanOrEqual(Math.round(minGap * RUNNER.MAX_GAP_COEFFICIENT));
        expect(o.variants.length).toBe(o.size);
        if (o.kind === 'pterodactyl') {
          expect(o.variants).toEqual([0]);
          expect(Math.abs(o.speedOffset)).toBe(type.speedOffset);
          offsets.add(o.speedOffset);
        } else {
          for (const v of o.variants) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(CACTUS_VARIANTS[o.kind]);
            variants.add(v);
          }
          expect(o.speedOffset).toBe(0);
        }
        kinds.push(o.kind);
        if (!sizes.has(o.kind)) sizes.set(o.kind, new Set());
        sizes.get(o.kind)?.add(o.size);
      }
      // Never more than MAX_OBSTACLE_DUPLICATION of a kind in a row.
      let streak = 1;
      for (let i = 1; i < kinds.length; i++) {
        streak = kinds[i] === kinds[i - 1] ? streak + 1 : 1;
        expect(streak).toBeLessThanOrEqual(RUNNER.MAX_OBSTACLE_DUPLICATION);
      }
      // Every allowed kind, size and variant actually shows up.
      const allowed = (Object.keys(OBSTACLES) as ObstacleKind[]).filter((k) => speed >= OBSTACLES[k].minSpeed);
      expect(new Set(kinds)).toEqual(new Set(allowed));
      for (const kind of allowed) {
        const expected = OBSTACLES[kind].multipleSpeed > speed ? [1] : [1, 2, 3];
        expect(sizes.get(kind)).toEqual(new Set(expected));
      }
      expect(variants).toEqual(new Set([0, 1, 2]));
      if (allowed.includes('pterodactyl')) {
        expect(offsets).toEqual(new Set([OBSTACLES.pterodactyl.speedOffset, -OBSTACLES.pterodactyl.speedOffset]));
      }
    });
  }

  test('duplicate check looks at the last MAX_OBSTACLE_DUPLICATION kinds', () => {
    expect(isDuplicate([], 'cactusSmall')).toBe(false);
    expect(isDuplicate(['cactusSmall'], 'cactusSmall')).toBe(false);
    expect(isDuplicate(['cactusSmall', 'cactusLarge'], 'cactusSmall')).toBe(false);
    expect(isDuplicate(['cactusSmall', 'cactusSmall'], 'cactusSmall')).toBe(true);
    expect(isDuplicate(['cactusSmall', 'cactusSmall'], 'cactusLarge')).toBe(false);
  });

  test('the next obstacle spawns on the first step the last one is gap px clear of SPAWN_X', () => {
    const random = mulberry32(5);
    const field = createObstacleField();
    const events: GameEvent[] = [];
    let speed = 9;
    let spawns = 0;
    for (let step = 0; step < 20000; step++) {
      const last: Obstacle | undefined = field.list[field.list.length - 1];
      const lastRight = last ? last.x - (speed + last.speedOffset) + last.width + last.gap : 0;
      events.length = 0;
      updateObstacles(field, speed, random, false, events);
      const spawned = events.some((e) => e.type === 'spawn');
      if (last && field.list.includes(last)) expect(spawned).toBe(lastRight < RUNNER.SPAWN_X);
      if (spawned) spawns++;
      for (const o of field.list) expect(o.x + o.width).toBeGreaterThanOrEqual(RUNNER.DESPAWN_X);
      speed = Math.min(RUNNER.MAX_SPEED, speed + RUNNER.ACCELERATION);
    }
    expect(spawns).toBeGreaterThan(100);
  });

  test('pterodactyl heights: desktop uses yUp, mobile only yUpMobile', () => {
    for (const mobile of [false, true]) {
      const random = mulberry32(mobile ? 2 : 1);
      const field = createObstacleField();
      const heights = new Set<number>();
      for (let i = 0; i < 3000; i++) {
        const o = spawnObstacle(field, 10, random, mobile);
        if (o.kind === 'pterodactyl') heights.add(o.y);
        else expect(o.y).toBe(0);
      }
      const expected = mobile ? OBSTACLES.pterodactyl.yUpMobile : OBSTACLES.pterodactyl.yUp;
      expect(heights).toEqual(new Set(expected));
    }
  });
});

describe('movement', () => {
  test('obstacles move by speed (+ pterodactyl offset) each step, unfloored, in step with distance', () => {
    const sim = createGameSim({ random: mulberry32(4) });
    sim.step(PRESS);
    let prev = sim.getSnapshot();
    let checked = 0;
    const ids = new Set<number>();
    for (let i = 0; i < 400 && prev.phase === 'playing'; i++) {
      const events = sim.step(NONE);
      const curr = sim.getSnapshot();
      expect(curr.distance - prev.distance).toBeCloseTo(prev.speed, 9);
      for (const o of curr.obstacles) {
        const before = prev.obstacles.find((p) => p.id === o.id);
        if (!before) {
          expect(events).toContainEqual({ type: 'spawn', id: o.id, kind: o.kind });
          expect(ids.has(o.id)).toBe(false);
          ids.add(o.id);
          continue;
        }
        expect(before.x - o.x).toBeCloseTo(prev.speed, 9);
        checked++;
      }
      prev = curr;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test('pterodactyl wings flap every frameMs (10 steps) and it flies at speed +/- speedOffset', () => {
    const random = mulberry32(9);
    const field = createObstacleField();
    let ptero: Obstacle | undefined;
    while (!ptero) {
      const o = spawnObstacle(field, 10, random, false);
      if (o.kind === 'pterodactyl') ptero = o;
    }
    field.list.push(ptero);
    const frames: number[] = [];
    const events: GameEvent[] = [];
    for (let i = 0; i < 30; i++) {
      const x = ptero.x;
      updateObstacles(field, 10, random, false, events);
      expect(x - ptero.x).toBeCloseTo(10 + ptero.speedOffset, 9);
      frames.push(ptero.frame);
    }
    expect(frames.join('')).toBe('000000000111111111100000000001');
  });
});

describe('collision boxes', () => {
  test('Chrome y-down boxes become y-up (yUp = spriteHeight - y - h)', () => {
    expect(obstacleCollisionBoxes('cactusSmall', 1)).toEqual([
      { x: 0, y: 1, w: 5, h: 27 },
      { x: 4, y: 1, w: 6, h: 34 },
      { x: 10, y: 17, w: 7, h: 14 },
    ]);
    expect(TREX_DUCKING_BOXES).toEqual([{ x: 1, y: 4, w: 55, h: 25 }]);
    expect(TREX_RUNNING_BOXES[0]).toEqual({ x: 22, y: 31, w: 17, h: 16 });
  });

  test('groups stretch the middle box and move the last one to the right edge', () => {
    const boxes = obstacleCollisionBoxes('cactusLarge', 3);
    const width = OBSTACLES.cactusLarge.width * 3;
    expect(boxes[1].w).toBe(width - boxes[0].w - boxes[2].w);
    expect(boxes[2].x).toBe(width - boxes[2].w);
    expect(boxes[0]).toEqual({ x: 0, y: 0, w: 7, h: 38 });
  });

  test('snapshots expose the y-up collision boxes', () => {
    const sim = createGameSim({ random: mulberry32(12) });
    sim.step(PRESS);
    while (sim.getSnapshot().obstacles.length === 0) sim.step(NONE);
    const o = sim.getSnapshot().obstacles[0];
    expect(o.collisionBoxes).toEqual(obstacleCollisionBoxes(o.kind, o.size));
  });
});

describe('collision', () => {
  /** Sweeps an obstacle past the T-Rex; true if any position collides. */
  function sweep(kind: ObstacleKind, size: number, y: number, trexY: number, ducking: boolean): boolean {
    const type = OBSTACLES[kind];
    const boxes = obstacleCollisionBoxes(kind, size);
    for (let x = 120; x > -100; x -= 0.25) {
      if (hitsObstacle(trexY, ducking, x, y, type.width * size, type.height, boxes)) return true;
    }
    return false;
  }

  test('mid pterodactyl (y 25) hits a running T-Rex but clears a ducking one', () => {
    expect(sweep('pterodactyl', 1, 25, 0, false)).toBe(true);
    expect(sweep('pterodactyl', 1, 25, 0, true)).toBe(false);
  });

  test('high pterodactyl (y 50) clears a running T-Rex but hits one mid-jump', () => {
    expect(sweep('pterodactyl', 1, 50, 0, false)).toBe(false);
    expect(sweep('pterodactyl', 1, 50, 0, true)).toBe(false);
    expect(sweep('pterodactyl', 1, 50, 30, false)).toBe(true);
  });

  test('ground pterodactyl (y 0) must be jumped', () => {
    expect(sweep('pterodactyl', 1, 0, 0, false)).toBe(true);
    expect(sweep('pterodactyl', 1, 0, 0, true)).toBe(true);
    expect(sweep('pterodactyl', 1, 0, 30, false)).toBe(false);
  });

  test('cacti hit running and ducking T-Rexes and are cleared above their top', () => {
    for (const kind of ['cactusSmall', 'cactusLarge'] as const) {
      for (const size of [1, 2, 3]) {
        expect(sweep(kind, size, 0, 0, false)).toBe(true);
        expect(sweep(kind, size, 0, 0, true)).toBe(true);
        expect(sweep(kind, size, 0, OBSTACLES[kind].height, false)).toBe(false);
      }
    }
  });

  test('the outer test uses the standing box even when ducking (Chrome quirk)', () => {
    const boxes = obstacleCollisionBoxes('cactusSmall', 1);
    // The duck fine box reaches x = 56, but the 1 px-inset standing outer box ends at x = 43.
    expect(hitsObstacle(0, true, 44, 0, 17, 35, boxes)).toBe(false);
    expect(hitsObstacle(0, true, 40, 0, 17, 35, boxes)).toBe(true);
  });

  test('a T-Rex that never jumps crashes into the first obstacle', () => {
    const sim = createGameSim({ random: mulberry32(21) });
    sim.step(PRESS);
    let crash: GameEvent | undefined;
    for (let i = 0; i < 1000 && !crash; i++) crash = sim.step(NONE).find((e) => e.type === 'crash');
    expect(crash).toBeDefined();
    const s = sim.getSnapshot();
    expect(s.phase).toBe('crashed');
    const o = s.obstacles[0];
    expect(hitsObstacle(s.trex.y, false, o.x, o.y, o.width, o.height, o.collisionBoxes)).toBe(true);
  });
});

describe('spawning (SIM_VERSION 3 on)', () => {
  test('one obstacle in five is a pterodactyl, from the start of a run', () => {
    for (const speed of [6, 9, 13]) {
      const random = mulberry32(Math.round(speed * 77));
      const field = createObstacleField();
      let birds = 0;
      const N = 20000;
      for (let i = 0; i < N; i++) if (spawnObstacle(field, speed, random, false).kind === 'pterodactyl') birds++;
      expect(birds / N).toBeGreaterThan(0.18);
      expect(birds / N).toBeLessThan(0.22);
    }
  });

  test('a pterodactyl at stackY is a stacked pair that only ducking clears', () => {
    const type = OBSTACLES.pterodactyl;
    const random = mulberry32(5);
    const field = createObstacleField();
    let pairs = 0;
    for (let i = 0; i < 4000; i++) {
      const o = spawnObstacle(field, 9, random, false);
      if (o.kind !== 'pterodactyl') continue;
      expect(o.size).toBe(o.y === type.stackY ? 2 : 1);
      if (o.size !== 2) continue;
      pairs++;
      expect(o.width).toBe(type.width);
      expect(o.height).toBe(type.height + type.stackGap);
      expect(o.collisionBoxes.length).toBe(2 * type.collision.length);
      // Standing it hits the lower bird; ducking passes under; jumping at any height a jump reaches hits a bird.
      expect(hitsObstacle(0, false, 0, o.y, o.width, o.height, o.collisionBoxes)).toBe(true);
      expect(hitsObstacle(0, true, 0, o.y, o.width, o.height, o.collisionBoxes)).toBe(false);
      for (let y = 1; y <= 70; y++) expect(hitsObstacle(y, false, 0, o.y, o.width, o.height, o.collisionBoxes)).toBe(true);
    }
    expect(pairs).toBeGreaterThan(0);
  });

  test('no stacked pairs on mobile (no duck button there)', () => {
    const random = mulberry32(6);
    const field = createObstacleField();
    for (let i = 0; i < 2000; i++) {
      const o = spawnObstacle(field, 9, random, true);
      if (o.kind === 'pterodactyl') expect(o.size).toBe(1);
    }
  });
});
