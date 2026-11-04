import { describe, expect, test } from 'bun:test';
import { RUNNER, TREX } from '../src/config';
import { createGameSim } from '../src/sim/game';
import { mulberry32 } from '../src/sim/rng';
import type { GameEvent, GameSim, InputFrame } from '../src/types';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const PRESS: InputFrame = { ...NONE, jumpPressed: true, jumpHeld: true };
const TAP: InputFrame = { ...NONE, jumpPressed: true };
const HOLD: InputFrame = { ...NONE, jumpHeld: true };
const DUCK: InputFrame = { ...NONE, duckHeld: true };

/** T-Rex events only: obstacles start spawning (and despawning) while these tests run. */
function types(events: GameEvent[]): string[] {
  return events.map((e) => e.type).filter((t) => t !== 'spawn' && t !== 'despawn');
}

/** Lengths of consecutive runs of equal values. */
function runLengths(values: string[]): { value: string; length: number }[] {
  const runs: { value: string; length: number }[] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.length++;
    else runs.push({ value, length: 1 });
  }
  return runs;
}

/** Steps `input` until the T-Rex lands; returns the apex and the number of steps in the air. */
function flyUntilLanded(sim: GameSim, input: InputFrame): { apex: number; steps: number } {
  let apex = sim.getSnapshot().trex.y;
  let steps = 0;
  while (sim.getSnapshot().trex.status === 'jumping') {
    sim.step(input);
    steps++;
    apex = Math.max(apex, sim.getSnapshot().trex.y);
    if (steps > 200) throw new Error('never landed');
  }
  return { apex, steps };
}

/** A sim that has started and finished its first (held) jump: running on the ground at ~speed 6. */
function runningSim(): GameSim {
  const sim = createGameSim({ random: mulberry32(1) });
  sim.step(PRESS);
  flyUntilLanded(sim, HOLD);
  return sim;
}

describe('jump', () => {
  // The task's sanity targets (~84 held, ~50 tapped) are the continuous-time estimates
  // MAX_JUMP_HEIGHT + DROP_VELOCITY^2 / (2 GRAVITY) = 83.8 and 30 + 20.8 = 50.8. Chrome integrates
  // per frame and clamps on the first frame *above* the threshold (held: y = 68.0, vy 5.8 -> 5;
  // tapped: y = 38.8, vy 8.2 -> 5), so the exact per-frame apexes are 91.4 and 62.2; Chrome's
  // own rounded integration also peaks at 91 px for a held jump.
  test('held jump at speed 6 peaks at 91.4 px (continuous estimate ~84)', () => {
    const sim = createGameSim({ random: mulberry32(1) });
    const events = sim.step(PRESS);
    expect(types(events)).toEqual(['start', 'jump']);
    const first = sim.getSnapshot();
    expect(first.phase).toBe('playing');
    expect(first.trex.y).toBeCloseTo(TREX.INITIAL_JUMP_VELOCITY + RUNNER.SPEED / 10, 10);
    const { apex } = flyUntilLanded(sim, HOLD);
    expect(apex).toBeCloseTo(91.4, 6);
    expect(apex).toBeGreaterThan(TREX.MAX_JUMP_HEIGHT + TREX.DROP_VELOCITY ** 2 / (2 * TREX.GRAVITY));
    expect(apex).toBeLessThan(84 + 8);
  });

  test('a jump released immediately peaks at 62.2 px (continuous estimate ~50)', () => {
    const sim = createGameSim({ random: mulberry32(1) });
    sim.step(TAP);
    const { apex } = flyUntilLanded(sim, NONE);
    expect(apex).toBeCloseTo(62.2, 6);
    expect(apex).toBeGreaterThan(TREX.MIN_JUMP_HEIGHT + TREX.DROP_VELOCITY ** 2 / (2 * TREX.GRAVITY));
    expect(apex).toBeLessThan(TREX.MAX_JUMP_HEIGHT);
  });

  test('releasing later gives a jump between the two', () => {
    const sim = createGameSim({ random: mulberry32(1) });
    sim.step(PRESS);
    for (let i = 0; i < 5; i++) sim.step(HOLD);
    const { apex } = flyUntilLanded(sim, NONE);
    expect(apex).toBeGreaterThan(62.2);
    expect(apex).toBeLessThan(91.4);
  });

  test('landing emits land, zeroes y / vy and returns to running', () => {
    const sim = createGameSim({ random: mulberry32(1) });
    sim.step(PRESS);
    const seen: string[] = [];
    while (sim.getSnapshot().trex.status === 'jumping') seen.push(...types(sim.step(HOLD)));
    expect(seen).toEqual(['land']);
    const t = sim.getSnapshot().trex;
    expect(t).toMatchObject({ y: 0, vy: 0, status: 'running', speedDrop: false, x: TREX.START_X });
    expect([t.width, t.height]).toEqual([TREX.WIDTH, TREX.HEIGHT]);
  });

  test('jump velocity grows with speed', () => {
    const sim = runningSim();
    const speed = sim.getSnapshot().speed;
    expect(types(sim.step(PRESS))).toEqual(['jump']);
    expect(sim.getSnapshot().trex.y).toBeCloseTo(TREX.INITIAL_JUMP_VELOCITY + speed / 10, 10);
  });

  test('jump is ignored while airborne', () => {
    const sim = createGameSim({ random: mulberry32(1) });
    sim.step(PRESS);
    const before = sim.getSnapshot().trex.vy;
    expect(types(sim.step(PRESS))).toEqual([]);
    expect(sim.getSnapshot().trex.vy).toBeCloseTo(before - TREX.GRAVITY, 10);
  });
});

describe('duck and speed drop', () => {
  test('ducking on the ground uses the duck box and duck frames', () => {
    const sim = runningSim();
    expect(types(sim.step(DUCK))).toEqual(['duck']);
    let t = sim.getSnapshot().trex;
    expect(t).toMatchObject({ status: 'ducking', width: TREX.WIDTH_DUCK, height: TREX.HEIGHT_DUCK, frame: 'duck1' });
    const frames: string[] = [t.frame];
    for (let i = 0; i < 40; i++) {
      expect(types(sim.step(DUCK))).toEqual([]);
      frames.push(sim.getSnapshot().trex.frame);
    }
    // DUCK_FRAME_MS = 125 ms = 7.5 steps -> the frame changes every 8 steps (Chrome's timer >= msPerFrame).
    const runs = runLengths(frames);
    // The step that enters ducking already ticks the frame timer, as in Chrome.
    expect(runs[0]).toEqual({ value: 'duck1', length: 7 });
    expect(runs.slice(1, -1).map((r) => r.length)).toEqual([8, 8, 8, 8]);
    expect(runs.map((r) => r.value).slice(0, 3)).toEqual(['duck1', 'duck2', 'duck1']);
    sim.step(NONE);
    t = sim.getSnapshot().trex;
    expect(t).toMatchObject({ status: 'running', width: TREX.WIDTH, height: TREX.HEIGHT });
  });

  test('a ducking T-Rex cannot jump; releasing duck and pressing jump together jumps', () => {
    const sim = runningSim();
    sim.step(DUCK);
    expect(types(sim.step({ ...DUCK, jumpPressed: true, jumpHeld: true }))).toEqual([]);
    expect(sim.getSnapshot().trex.status).toBe('ducking');
    expect(types(sim.step(PRESS))).toEqual(['jump']);
    expect(sim.getSnapshot().trex.status).toBe('jumping');
  });

  test('duck in the air speed-drops once per press and lands ducking', () => {
    const sim = runningSim();
    sim.step(PRESS);
    for (let i = 0; i < 9; i++) sim.step(HOLD);
    const before = sim.getSnapshot().trex;
    expect(before.vy).toBeGreaterThan(0);
    sim.step(DUCK);
    const dropped = sim.getSnapshot().trex;
    expect(dropped.speedDrop).toBe(true);
    expect(dropped.y).toBeCloseTo(before.y - 1, 10);
    expect(dropped.vy).toBeCloseTo(-1 - TREX.GRAVITY * TREX.SPEED_DROP_COEFFICIENT, 10);
    sim.step(DUCK);
    const held = sim.getSnapshot().trex;
    expect(held.y).toBeCloseTo(dropped.y + dropped.vy, 10);
    expect(held.vy).toBeCloseTo(dropped.vy - TREX.GRAVITY * TREX.SPEED_DROP_COEFFICIENT, 10);
    const seen: string[] = [];
    while (sim.getSnapshot().trex.status === 'jumping') seen.push(...types(sim.step(DUCK)));
    expect(seen).toEqual(['land', 'duck']);
    expect(sim.getSnapshot().trex).toMatchObject({ status: 'ducking', speedDrop: false, y: 0 });
  });

  test('a speed drop lands much sooner than a normal fall', () => {
    const normal = runningSim();
    normal.step(PRESS);
    const normalSteps = flyUntilLanded(normal, HOLD).steps;
    const dropped = runningSim();
    dropped.step(PRESS);
    for (let i = 0; i < 10; i++) dropped.step(HOLD);
    const dropSteps = 10 + flyUntilLanded(dropped, DUCK).steps;
    expect(dropSteps).toBeLessThan(normalSteps - 8);
  });

  test('releasing duck mid-drop clears speedDrop and restores normal gravity', () => {
    const sim = runningSim();
    sim.step(PRESS);
    for (let i = 0; i < 12; i++) sim.step(HOLD);
    sim.step(DUCK);
    expect(sim.getSnapshot().trex.speedDrop).toBe(true);
    const before = sim.getSnapshot().trex;
    sim.step(NONE);
    const after = sim.getSnapshot().trex;
    expect(after.speedDrop).toBe(false);
    expect(after.vy).toBeCloseTo(before.vy - TREX.GRAVITY, 10);
    // Pressing again re-triggers the drop (vy back to -1 before gravity).
    sim.step(DUCK);
    expect(sim.getSnapshot().trex.vy).toBeCloseTo(-1 - TREX.GRAVITY * TREX.SPEED_DROP_COEFFICIENT, 10);
  });
});

describe('frames', () => {
  test('running alternates run1/run2 every RUN_FRAME_MS (5 steps)', () => {
    const sim = runningSim();
    const frames: string[] = [];
    for (let i = 0; i < 40; i++) {
      sim.step(NONE);
      frames.push(sim.getSnapshot().trex.frame);
    }
    const runs = runLengths(frames);
    expect(runs.slice(1, -1).map((r) => r.length)).toEqual(runs.slice(1, -1).map(() => 5));
    expect(runs.length).toBeGreaterThanOrEqual(8);
    expect(new Set(frames)).toEqual(new Set(['run1', 'run2']));
  });

  test('airborne frame is jump', () => {
    const sim = createGameSim({ random: mulberry32(3) });
    sim.step(PRESS);
    expect(sim.getSnapshot().trex.frame).toBe('jump');
  });

  test('title screen idles and blinks for BLINK_DURATION_MS after a random wait < BLINK_TIMING', () => {
    const sim = createGameSim({ random: mulberry32(7) });
    const frames: string[] = [];
    for (let i = 0; i < 20000; i++) {
      sim.step(NONE);
      const s = sim.getSnapshot();
      expect(s.phase).toBe('title');
      expect(s.trex.status).toBe('waiting');
      expect(s.runFrames).toBe(0);
      expect(s.frame).toBe(i + 1);
      frames.push(s.trex.frame);
    }
    const runs = runLengths(frames).slice(1, -1);
    const blinks = runs.filter((r) => r.value === 'blink');
    const idles = runs.filter((r) => r.value === 'idle');
    expect(blinks.length).toBeGreaterThan(5);
    for (const b of blinks) expect(b.length).toBe(20);
    for (const r of idles) expect(r.length).toBeLessThanOrEqual(TREX.BLINK_TIMING / (1000 / 60) + 1);
    expect(new Set(frames)).toEqual(new Set(['idle', 'blink']));
  });
});
