import { describe, expect, test } from 'bun:test';
import { NIGHT, RUNNER, SCORE, TREX } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { createGameSim } from '../src/sim/game';
import { createNight, nightAmount, updateNight } from '../src/sim/night';
import { mulberry32 } from '../src/sim/rng';
import { milestoneCrossed, scoreForDistance } from '../src/sim/score';
import type { GameEvent, GameSim, GameSnapshot, InputFrame } from '../src/types';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const PRESS: InputFrame = { ...NONE, jumpPressed: true, jumpHeld: true };
const RESTART: InputFrame = { ...NONE, restartPressed: true };
const STEP_MS = 1000 / 60;

function types(events: GameEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Starts a run and steps with no input until the T-Rex runs into the first obstacle. */
function crashedSim(seed = 3): { sim: GameSim; crash: Extract<GameEvent, { type: 'crash' }> } {
  const sim = createGameSim({ random: mulberry32(seed) });
  sim.step(PRESS);
  for (let i = 0; i < 2000; i++) {
    const crash = sim.step(NONE).find((e) => e.type === 'crash');
    if (crash?.type === 'crash') return { sim, crash };
  }
  throw new Error('never crashed');
}

/** Lets the autopilot play until `until` returns true for a step's events. */
function playUntil(sim: GameSim, until: (events: GameEvent[], s: GameSnapshot) => boolean, max = 100000): void {
  for (let i = 0; i < max; i++) {
    const events = sim.step(autopilot(sim.getSnapshot()));
    expect(types(events)).not.toContain('crash');
    if (until(events, sim.getSnapshot())) return;
  }
  throw new Error('condition never reached');
}

describe('crash and restart', () => {
  test('crash freezes the world and records the high score', () => {
    const { sim, crash } = crashedSim();
    const s = sim.getSnapshot();
    expect(s.phase).toBe('crashed');
    expect(s.trex.status).toBe('crashed');
    expect(s.trex.frame).toBe('crashed');
    expect(s.canRestart).toBe(false);
    expect(s.scoreFlash).toBe(false);
    expect(crash).toEqual({ type: 'crash', score: s.score, newHighScore: true });
    expect(s.highScore).toBe(s.score);
    for (let i = 0; i < 30; i++) expect(sim.step(NONE)).toEqual([]);
    const later = sim.getSnapshot();
    expect(later.obstacles).toEqual(s.obstacles);
    expect([later.distance, later.speed, later.runFrames, later.score]).toEqual([s.distance, s.speed, s.runFrames, s.score]);
    expect(later.trex).toEqual(s.trex);
    expect(later.frame).toBe(s.frame + 30);
  });

  test('restart is ignored (not queued) until GAMEOVER_CLEAR_TIME, then resets the run', () => {
    const { sim } = crashedSim();
    const clearSteps = Math.round(RUNNER.GAMEOVER_CLEAR_TIME / STEP_MS);
    expect(clearSteps).toBe(45);
    for (let i = 1; i < clearSteps; i++) {
      const input = i % 2 === 0 ? PRESS : RESTART;
      expect(sim.step(input)).toEqual([]);
      expect(sim.getSnapshot()).toMatchObject({ phase: 'crashed', canRestart: false });
    }
    // The 45th step after the crash: a press here was made while canRestart was still false.
    expect(sim.step(PRESS)).toEqual([]);
    expect(sim.getSnapshot()).toMatchObject({ phase: 'crashed', canRestart: true });
    // Earlier presses were not queued.
    expect(sim.step(NONE)).toEqual([]);
    expect(sim.getSnapshot().phase).toBe('crashed');

    const before = sim.getSnapshot();
    const events = sim.step(RESTART);
    expect(events[0]).toEqual({ type: 'restart' });
    expect(types(events).slice(1)).toEqual(before.obstacles.map(() => 'despawn'));
    const s = sim.getSnapshot();
    expect(s.phase).toBe('playing');
    expect(s.runFrames).toBe(1);
    expect(s.distance).toBe(RUNNER.SPEED);
    expect(s.speed).toBeCloseTo(RUNNER.SPEED + RUNNER.ACCELERATION, 12);
    expect(s.score).toBe(0);
    expect(s.obstacles).toEqual([]);
    expect(s.canRestart).toBe(false);
    expect(s.night).toBe(0);
    expect(s.highScore).toBe(before.highScore);
    expect(s.trex).toMatchObject({ y: 0, vy: 0, status: 'running', speedDrop: false });
  });

  test('jump also restarts, without jumping; ids stay unique across runs', () => {
    const { sim } = crashedSim(8);
    const firstIds = sim.getSnapshot().obstacles.map((o) => o.id);
    for (let i = 0; i < 45; i++) sim.step(NONE);
    expect(types(sim.step(PRESS))).toEqual(['restart', ...firstIds.map(() => 'despawn')]);
    expect(sim.getSnapshot().trex.status).toBe('running');
    while (sim.getSnapshot().obstacles.length === 0) sim.step(NONE);
    const next = sim.getSnapshot().obstacles[0].id;
    expect(next).toBeGreaterThan(Math.max(...firstIds));
  });

  test('a lower score is not a new high score', () => {
    const { sim } = crashedSim(3);
    sim.setHighScore(99999);
    for (let i = 0; i < 45; i++) sim.step(NONE);
    sim.step(RESTART);
    let crash: GameEvent | undefined;
    while (!crash) crash = sim.step(NONE).find((e) => e.type === 'crash');
    expect(crash).toMatchObject({ newHighScore: false });
    expect(sim.getSnapshot().highScore).toBe(99999);
  });

  test('highScore option and setHighScore', () => {
    const sim = createGameSim({ highScore: 1234 });
    expect(sim.getSnapshot().highScore).toBe(1234);
    sim.setHighScore(42);
    expect(sim.getSnapshot().highScore).toBe(42);
  });
});

describe('score', () => {
  test('score = min(99999, round(ceil(distance) * COEFFICIENT))', () => {
    expect(scoreForDistance(0)).toBe(0);
    expect(scoreForDistance(19.01)).toBe(1);
    expect(scoreForDistance(4000)).toBe(100);
    expect(scoreForDistance(1e9)).toBe(99999);
    expect(milestoneCrossed(99, 100)).toBe(100);
    expect(milestoneCrossed(100, 100)).toBe(0);
    expect(milestoneCrossed(199, 200)).toBe(200);
  });

  test('speed accelerates per step, distance and score follow it', () => {
    const sim = createGameSim({ random: mulberry32(2) });
    let prev = sim.getSnapshot();
    expect(prev.speed).toBe(RUNNER.SPEED);
    for (let i = 0; i < 3000; i++) {
      sim.step(autopilot(prev));
      const s = sim.getSnapshot();
      expect(s.distance - prev.distance).toBeCloseTo(prev.phase === 'title' ? RUNNER.SPEED : prev.speed, 9);
      expect(s.speed - prev.speed).toBeCloseTo(prev.speed < RUNNER.MAX_SPEED ? RUNNER.ACCELERATION : 0, 9);
      expect(s.score).toBe(Math.min(99999, Math.round(Math.ceil(s.distance) * SCORE.COEFFICIENT)));
      expect(s.runFrames).toBe(i + 1);
      prev = s;
    }
  });

  test('each multiple of ACHIEVEMENT_DISTANCE emits one milestone and blinks the score 3 times', () => {
    const sim = createGameSim({ random: mulberry32(6) });
    const milestones: number[] = [];
    playUntil(sim, (events) => {
      for (const e of events) if (e.type === 'milestone') milestones.push(e.score);
      return milestones.length === 1;
    });
    expect(milestones).toEqual([100]);
    expect(sim.getSnapshot().score).toBe(100);
    const flashSteps = Math.round(SCORE.FLASH_DURATION_MS / STEP_MS);
    expect(flashSteps).toBe(15);
    const flashes = [sim.getSnapshot().scoreFlash];
    for (let i = 0; i < 150; i++) {
      sim.step(autopilot(sim.getSnapshot()));
      flashes.push(sim.getSnapshot().scoreFlash);
    }
    const expected = flashes.map((_, i) => i < flashSteps * 2 * SCORE.FLASH_ITERATIONS && Math.floor(i / flashSteps) % 2 === 0);
    expect(flashes).toEqual(expected);
    playUntil(sim, (events) => {
      for (const e of events) if (e.type === 'milestone') milestones.push(e.score);
      return milestones.length === 4;
    });
    expect(milestones).toEqual([100, 200, 300, 400]);
  });
});

describe('night', () => {
  test('starts at 700, fades over TRANSITION_MS, ends after INVERT_FADE_DURATION, advances the moon', () => {
    const sim = createGameSim({ random: mulberry32(10) });
    playUntil(sim, (events) => types(events).includes('nightStart'));
    let s = sim.getSnapshot();
    expect(s.score).toBe(NIGHT.INVERT_DISTANCE);
    expect(s.moonPhase).toBe(1);
    const fadeSteps = Math.round(NIGHT.TRANSITION_MS / STEP_MS);
    const nightSteps = Math.round(NIGHT.INVERT_FADE_DURATION / STEP_MS);
    expect(s.night).toBeCloseTo(1 / fadeSteps, 12);
    let steps = 0;
    playUntil(sim, (events, snap) => {
      steps++;
      expect(types(events)).not.toContain('nightStart');
      if (types(events).includes('nightEnd')) return true;
      if (steps < fadeSteps) expect(snap.night).toBeCloseTo((steps + 1) / fadeSteps, 12);
      else expect(snap.night).toBe(1);
      return false;
    });
    expect(steps).toBe(nightSteps);
    s = sim.getSnapshot();
    expect(s.night).toBeCloseTo(1 - 1 / fadeSteps, 12);
    expect(s.moonPhase).toBe(1);
    for (let i = 0; i < fadeSteps; i++) sim.step(autopilot(sim.getSnapshot()));
    expect(sim.getSnapshot().night).toBe(0);
    playUntil(sim, (events) => types(events).includes('nightStart'));
    s = sim.getSnapshot();
    expect(s.score).toBe(NIGHT.INVERT_DISTANCE * 2);
    expect(s.moonPhase).toBe(2);
  });

  test('one score value cannot start night twice; the moon phase wraps', () => {
    const n = createNight();
    const events: GameEvent[] = [];
    updateNight(n, NIGHT.INVERT_DISTANCE, events);
    expect(types(events)).toEqual(['nightStart']);
    n.active = false;
    updateNight(n, NIGHT.INVERT_DISTANCE, events);
    expect(types(events)).toEqual(['nightStart']);
    updateNight(n, 0, events);
    updateNight(n, 1, events);
    expect(n.active).toBe(false);
    for (let i = 2; i <= NIGHT.MOON_PHASES; i++) {
      n.active = false;
      updateNight(n, NIGHT.INVERT_DISTANCE * i, events);
    }
    expect(n.moonPhase).toBe(0);
    expect(nightAmount(n)).toBe(0);
  });

  test('restart snaps back to day', () => {
    const sim = createGameSim({ random: mulberry32(10) });
    playUntil(sim, (events) => types(events).includes('nightStart'));
    for (let i = 0; i < 200; i++) sim.step(autopilot(sim.getSnapshot()));
    expect(sim.getSnapshot().night).toBe(1);
    let crashed = false;
    for (let i = 0; i < 3000 && !crashed; i++) crashed = types(sim.step(NONE)).includes('crash');
    expect(crashed).toBe(true);
    for (let i = 0; i < 45; i++) sim.step(NONE);
    sim.step(RESTART);
    const s = sim.getSnapshot();
    expect(s.night).toBe(0);
    expect(s.moonPhase).toBe(0);
  });
});

describe('pause and resume', () => {
  test('only pauses a running game; a paused sim does nothing', () => {
    const sim = createGameSim({ random: mulberry32(5) });
    sim.pause();
    expect(sim.getSnapshot().phase).toBe('title');
    sim.step(PRESS);
    for (let i = 0; i < 100; i++) sim.step(NONE);
    sim.resume();
    expect(sim.getSnapshot().phase).toBe('playing');
    sim.pause();
    const paused = sim.getSnapshot();
    expect(paused.phase).toBe('paused');
    for (let i = 0; i < 50; i++) expect(sim.step(i % 2 ? PRESS : RESTART)).toEqual([]);
    expect(sim.getSnapshot()).toEqual(paused);
    sim.resume();
    expect(sim.getSnapshot()).toEqual({ ...paused, phase: 'playing' });
    sim.step(NONE);
    const s = sim.getSnapshot();
    expect(s.frame).toBe(paused.frame + 1);
    expect(s.runFrames).toBe(paused.runFrames + 1);
  });

  test('pause is a no-op once crashed', () => {
    const { sim } = crashedSim();
    sim.pause();
    expect(sim.getSnapshot().phase).toBe('crashed');
    sim.resume();
    expect(sim.getSnapshot().phase).toBe('crashed');
  });
});

describe('snapshots', () => {
  test('getSnapshot returns a deep copy that later steps and edits cannot touch', () => {
    const sim = createGameSim({ random: mulberry32(14) });
    sim.step(PRESS);
    while (sim.getSnapshot().obstacles.length === 0) sim.step(NONE);
    const a = sim.getSnapshot();
    const frozen = structuredClone(a);
    const b = sim.getSnapshot();
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b.trex).not.toBe(a.trex);
    expect(b.obstacles).not.toBe(a.obstacles);
    expect(b.obstacles[0]).not.toBe(a.obstacles[0]);
    expect(b.obstacles[0].variants).not.toBe(a.obstacles[0].variants);
    expect(b.obstacles[0].collisionBoxes[0]).not.toBe(a.obstacles[0].collisionBoxes[0]);

    sim.step(NONE);
    expect(a).toEqual(frozen);

    a.trex.y = 999;
    a.obstacles[0].x = -999;
    a.obstacles[0].variants[0] = 99;
    a.obstacles[0].collisionBoxes[0].w = 999;
    a.obstacles.length = 0;
    const c = sim.getSnapshot();
    expect(c.trex.y).not.toBe(999);
    // A later step may have spawned more, but the frozen ones are untouched.
    expect(c.obstacles.length).toBeGreaterThanOrEqual(frozen.obstacles.length);
    expect(c.obstacles[0].variants).toEqual(frozen.obstacles[0].variants);
    expect(c.obstacles[0].collisionBoxes).toEqual(frozen.obstacles[0].collisionBoxes);
    expect(c.obstacles[0].x).toBeLessThan(frozen.obstacles[0].x);
  });

  test('initial snapshot', () => {
    const s = createGameSim({ random: mulberry32(1) }).getSnapshot();
    expect(s).toMatchObject({
      phase: 'title',
      frame: 0,
      runFrames: 0,
      speed: RUNNER.SPEED,
      distance: 0,
      score: 0,
      highScore: 0,
      scoreFlash: false,
      canRestart: false,
      night: 0,
      moonPhase: 0,
      obstacles: [],
    });
    expect(s.trex).toEqual({
      x: TREX.START_X,
      y: 0,
      width: TREX.WIDTH,
      height: TREX.HEIGHT,
      status: 'waiting',
      frame: 'idle',
      vy: 0,
      speedDrop: false,
    });
  });
});
