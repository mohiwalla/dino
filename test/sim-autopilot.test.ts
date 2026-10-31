import { describe, expect, test } from 'bun:test';
import { RUNNER } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { createGameSim } from '../src/sim/game';
import { mulberry32 } from '../src/sim/rng';
import type { GameSnapshot, InputFrame, ObstacleKind } from '../src/types';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const STEPS = 30000;

interface RunStats {
  crashes: number;
  score: number;
  maxSpeed: number;
  jumps: number;
  ducks: number;
  spawns: Record<ObstacleKind, number>;
  midPterodactylsDucked: number;
  midPterodactyls: number;
}

function run(seed: number, mobile: boolean): RunStats {
  const sim = createGameSim({ random: mulberry32(seed), mobile });
  const stats: RunStats = {
    crashes: 0,
    score: 0,
    maxSpeed: 0,
    jumps: 0,
    ducks: 0,
    spawns: { cactusSmall: 0, cactusLarge: 0, pterodactyl: 0 },
    midPterodactylsDucked: 0,
    midPterodactyls: 0,
  };
  const passing = new Map<number, boolean>();
  for (let i = 0; i < STEPS; i++) {
    const s = sim.getSnapshot();
    trackMidPterodactyls(s, passing, stats);
    for (const e of sim.step(autopilot(s))) {
      if (e.type === 'crash') stats.crashes++;
      else if (e.type === 'jump') stats.jumps++;
      else if (e.type === 'duck') stats.ducks++;
      else if (e.type === 'spawn') stats.spawns[e.kind]++;
    }
    stats.maxSpeed = Math.max(stats.maxSpeed, sim.getSnapshot().speed);
  }
  stats.score = sim.getSnapshot().score;
  return stats;
}

/** Records, for each mid-height pterodactyl, whether the T-Rex was ducking as it passed overhead. */
function trackMidPterodactyls(s: GameSnapshot, passing: Map<number, boolean>, stats: RunStats): void {
  for (const o of s.obstacles) {
    if (o.kind !== 'pterodactyl' || o.y !== 25 || passing.has(o.id)) continue;
    if (o.x < s.trex.x + s.trex.width && o.x + o.width > s.trex.x) {
      passing.set(o.id, true);
      stats.midPterodactyls++;
      if (s.trex.status === 'ducking') stats.midPterodactylsDucked++;
    }
  }
}

describe('autopilot', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    test(`survives ${STEPS} steps (seed ${seed})`, () => {
      const stats = run(seed, false);
      console.log(
        `seed ${seed}: score ${stats.score}, max speed ${stats.maxSpeed.toFixed(3)}, jumps ${stats.jumps}, ` +
          `ducks ${stats.ducks}, spawns ${JSON.stringify(stats.spawns)}, ` +
          `mid pterodactyls ducked ${stats.midPterodactylsDucked}/${stats.midPterodactyls}`,
      );
      expect(stats.crashes).toBe(0);
      expect(stats.maxSpeed).toBe(RUNNER.MAX_SPEED);
      expect(stats.score).toBeGreaterThan(9000);
      expect(stats.spawns.pterodactyl).toBeGreaterThan(50);
      expect(stats.midPterodactyls).toBeGreaterThan(10);
      expect(stats.midPterodactylsDucked).toBe(stats.midPterodactyls);
    });
  }

  for (const seed of [11, 12]) {
    test(`survives ${STEPS} steps on mobile (seed ${seed})`, () => {
      const stats = run(seed, true);
      console.log(`mobile seed ${seed}: score ${stats.score}, max speed ${stats.maxSpeed.toFixed(3)}, ducks ${stats.ducks}`);
      expect(stats.crashes).toBe(0);
      expect(stats.midPterodactyls).toBe(0);
    });
  }

  test('starts the game from the title screen and restarts once allowed', () => {
    const sim = createGameSim({ random: mulberry32(3) });
    expect(autopilot(sim.getSnapshot()).jumpPressed).toBe(true);
    sim.step(autopilot(sim.getSnapshot()));
    expect(sim.getSnapshot().phase).toBe('playing');
    while (sim.getSnapshot().phase === 'playing') sim.step(NONE);
    expect(sim.getSnapshot().phase).toBe('crashed');
    let waited = 0;
    while (!autopilot(sim.getSnapshot()).restartPressed) {
      sim.step(autopilot(sim.getSnapshot()));
      waited++;
    }
    expect(waited).toBe(45);
    expect(sim.getSnapshot().canRestart).toBe(true);
    sim.step(autopilot(sim.getSnapshot()));
    expect(sim.getSnapshot().phase).toBe('playing');
  });

  test('is stateless: the same snapshot always gives the same input', () => {
    const sim = createGameSim({ random: mulberry32(4) });
    for (let i = 0; i < 3000; i++) {
      const s = sim.getSnapshot();
      const a = autopilot(s);
      autopilot(createGameSim().getSnapshot());
      expect(autopilot(s)).toEqual(a);
      sim.step(a);
    }
  });
});
