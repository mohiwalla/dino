import { describe, expect, test } from 'bun:test';
import { RUNNER, SIM } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { createGameSim } from '../src/sim/game';
import { checkInputs, createInputCursor, createInputRecorder, replayRun, SIM_VERSION, type RunSpec } from '../src/sim/replay';
import { mulberry32 } from '../src/sim/rng';
import type { GameSim, InputFrame } from '../src/types';
import { checkTiming, verifyRun, type Beat } from '../worker/verify';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const PRESS: InputFrame = { ...NONE, jumpPressed: true, jumpHeld: true };
const RESTART: InputFrame = { ...NONE, restartPressed: true };

interface Recorded {
  spec: RunSpec;
  inputs: number[];
  steps: number;
  score: number;
}

type Player = (sim: GameSim, step: number) => InputFrame;

/** Plays the autopilot for `steps` steps, then nothing until the crash. */
const autopilotFor =
  (steps: number): Player =>
  (sim, step) =>
    step < steps ? autopilot(sim.getSnapshot()) : NONE;

/**
 * Plays one run the way the browser does: the run starts on `first`, the seed "arrives" a few
 * steps in, and every step's input is recorded until the crash.
 */
function playRun(sim: GameSim, first: InputFrame, seed: number, afterCrash: boolean, play: Player, mobile = false): Recorded {
  const recorder = createInputRecorder();
  sim.setObstacleRandom(null);
  let input = first;
  for (let step = 0; ; step++) {
    if (step === 12) sim.setObstacleRandom(mulberry32(seed));
    recorder.record(input);
    const crash = sim.step(input).find((e) => e.type === 'crash');
    if (crash?.type === 'crash') return { spec: { seed, mobile, afterCrash }, inputs: recorder.take(), steps: recorder.steps, score: crash.score };
    if (step > 200_000) throw new Error('never crashed');
    input = play(sim, step + 1);
  }
}

/** Beats every `everyMs` of real time for a run played at `rate` x real time. */
function beatsFor(steps: number, rate = 1, everyMs = 10_000, start = 1_000_000): Beat[] {
  const beats: Beat[] = [[start, 0]];
  const stepMs = SIM.STEP_MS / rate;
  for (let t = everyMs; t < steps * stepMs; t += everyMs) beats.push([start + t, Math.floor(t / stepMs)]);
  beats.push([start + steps * stepMs + 80, steps]);
  return beats;
}

describe('input log', () => {
  test('the cursor plays back exactly what the recorder saw', () => {
    const random = mulberry32(5);
    const frames: InputFrame[] = [];
    for (let i = 0; i < 500; i++) {
      const r = random();
      frames.push({ jumpPressed: r < 0.05, jumpHeld: r < 0.3, duckHeld: r > 0.9, restartPressed: false });
    }
    const recorder = createInputRecorder();
    const chunks: number[] = [];
    frames.forEach((f, i) => {
      recorder.record(f);
      if (i % 97 === 0) chunks.push(...recorder.take());
    });
    chunks.push(...recorder.take());
    expect(checkInputs(chunks, frames.length)).toBeNull();
    const cursor = createInputCursor(chunks);
    for (const f of frames) expect(cursor.next()).toEqual(f);
  });

  test('malformed logs are refused', () => {
    expect(checkInputs([], 10)).not.toBeNull();
    expect(checkInputs([1, 0], 10)).not.toBeNull();
    expect(checkInputs([0, 1, 0, 2], 10)).not.toBeNull();
    expect(checkInputs([0, 1, 10, 2], 10)).not.toBeNull();
    expect(checkInputs([0, 16], 10)).not.toBeNull();
    expect(checkInputs([0, 1, 'x'], 10)).not.toBeNull();
    expect(checkInputs([0, 3, 5, 0], 10)).toBeNull();
  });
});

describe('replay', () => {
  test('a run from the title screen replays to the same score', () => {
    const sim = createGameSim({ random: mulberry32(1) });
    const run = playRun(sim, PRESS, 1234, false, autopilotFor(2500));
    expect(run.score).toBeGreaterThan(100);
    expect(replayRun(run.spec, run.inputs, run.steps)).toEqual({ ok: true, score: run.score });
  });

  test('restarted runs replay too, whatever came before them', () => {
    const sim = createGameSim({ random: Math.random, mobile: true });
    playRun(sim, PRESS, 1, false, autopilotFor(900), true);
    for (let seed = 2; seed < 5; seed++) {
      while (!sim.getSnapshot().canRestart) sim.step(NONE);
      const run = playRun(sim, seed % 2 ? RESTART : PRESS, seed, true, autopilotFor(600 * seed), true);
      expect(replayRun(run.spec, run.inputs, run.steps)).toEqual({ ok: true, score: run.score });
    }
  });

  test('start-fast runs begin halfway to top speed and replay with the flag', () => {
    const sim = createGameSim({ startFast: true });
    const run = playRun(sim, PRESS, 55, false, autopilotFor(1200));
    const spec = { ...run.spec, fast: true };
    expect(replayRun(spec, run.inputs, run.steps)).toEqual({ ok: true, score: run.score });
    expect(replayRun(run.spec, run.inputs, run.steps)).not.toEqual({ ok: true, score: run.score });
    const fresh = createGameSim({ startFast: true });
    fresh.step(PRESS);
    expect(fresh.getSnapshot().speed).toBeCloseTo(RUNNER.FAST_START_SPEED, 2);
  });

  test('the seed decides the run', () => {
    const run = playRun(createGameSim(), PRESS, 77, false, autopilotFor(1500));
    const other = replayRun({ ...run.spec, seed: 78 }, run.inputs, run.steps);
    expect(other).not.toEqual({ ok: true, score: run.score });
  });

  test('a log has to start the run and end on its crash', () => {
    const run = playRun(createGameSim(), PRESS, 9, false, autopilotFor(1000));
    expect(replayRun(run.spec, run.inputs, run.steps - 1).ok).toBe(false);
    expect(replayRun(run.spec, [0, 0, ...run.inputs.slice(2)], run.steps).ok).toBe(false);
  });

  test(`SIM_VERSION (${SIM_VERSION}) matches the simulation`, () => {
    // These runs change whenever the simulation does. When this fails, bump SIM_VERSION in
    // src/sim/replay.ts (old recorded runs no longer replay), then update the numbers here.
    const fingerprint = [11, 22, 33].map((seed) => {
      const run = playRun(createGameSim({ mobile: seed === 22 }), PRESS, seed, false, autopilotFor(4000), seed === 22);
      let hash = 0;
      replayRun(run.spec, run.inputs, run.steps, (_step, _input, sim) => {
        const s = sim.getSnapshot();
        hash = (hash * 31 + Math.round(s.trex.y * 1e3) + Math.round(s.distance * 1e3)) >>> 0;
        for (const o of s.obstacles) hash = (hash * 31 + Math.round(o.x * 1e3) + o.y) >>> 0;
      });
      return [run.steps, run.score, hash];
    });
    expect(fingerprint).toEqual([
      [4037, 809, 221439167],
      [4029, 807, 1663453252],
      [4092, 823, 639513550],
    ]);
  });
});

describe('verification', () => {
  test('real-time beats pass', () => {
    expect(checkTiming(beatsFor(20_000), 20_000)).toMatchObject({ rejected: [], review: [] });
  });

  test('running ahead of the clock is rejected', () => {
    expect(checkTiming(beatsFor(20_000, 1.2), 20_000).rejected).not.toEqual([]);
    expect(checkTiming([[0, 0], [100, 20_000]], 20_000).rejected).not.toEqual([]);
  });

  test('a speed multiplier moves the clock the run is held to', () => {
    expect(checkTiming(beatsFor(20_000, 2), 20_000, 2)).toMatchObject({ rejected: [], review: [] });
    expect(checkTiming(beatsFor(20_000, 0.5), 20_000, 0.5)).toMatchObject({ rejected: [], review: [] });
    // Played at 3x while claiming 2x: too fast. Played at 1x while claiming 2x: slow motion.
    expect(checkTiming(beatsFor(20_000, 3), 20_000, 2).rejected).not.toEqual([]);
    expect(checkTiming(beatsFor(20_000, 1), 20_000, 2).review).not.toEqual([]);
  });

  test('slow motion is sent for review', () => {
    expect(checkTiming(beatsFor(20_000, 0.8), 20_000).review).not.toEqual([]);
    expect(checkTiming(beatsFor(20_000, 0.98), 20_000).review).toEqual([]);
  });

  test('pauses are free up to MAX_PAUSES, then reviewed', () => {
    const paused = (count: number): Beat[] => {
      const beats: Beat[] = [[0, 0]];
      let t = 0;
      let s = 0;
      for (let i = 0; i < count; i++) {
        t += 5000;
        s += 300;
        beats.push([t, s]);
        t += 60_000;
        beats.push([t, s]);
      }
      beats.push([t + 5000, s + 300]);
      return beats;
    };
    expect(checkTiming(paused(3), 3 * 300 + 300)).toMatchObject({ rejected: [], review: [] });
    expect(checkTiming(paused(4), 4 * 300 + 300).review).toEqual(['paused 4 times']);
  });

  test('paused time between a pause and its resume is not play', () => {
    // LUo52HE9COokNPN2: paused 3 steps in, resumed 9 s later, then played on in real time.
    const resumed = 1_000_000 + 9_000;
    const end = resumed + 187 * SIM.STEP_MS;
    expect(checkTiming([[1_000_000, 0], [1_000_300, 3, 'pause'], [resumed, 3, 'resume'], [end, 190, 'finish']], 190)).toMatchObject({ review: [], pauses: 1 });
    // The same run before beats said what they were: the pause upload was never sent.
    expect(checkTiming([[1_000_000, 0], [resumed, 3], [end, 190]], 190).review).toEqual([expect.stringContaining('slower than real time')]);
    // With kinds, a tick that repeats the step count is time that passed without play, not a pause.
    expect(checkTiming([[1_000_000, 0], [resumed, 3, 'tick'], [end, 190, 'finish']], 190)).toMatchObject({ pauses: 0, review: [expect.stringContaining('slower than real time')] });
  });

  test('a beat log that does not end on the run is rejected', () => {
    expect(checkTiming([[0, 0]], 10).rejected).not.toEqual([]);
    expect(checkTiming([[0, 0], [1000, 50]], 60).rejected).not.toEqual([]);
  });

  test('the server score is the replayed one, and the autopilot gets flagged', () => {
    const run = playRun(createGameSim(), PRESS, 4321, false, autopilotFor(3000));
    const verdict = verifyRun({ ...run.spec, steps: run.steps, inputs: run.inputs, beats: beatsFor(run.steps) });
    expect(verdict.status).toBe('review');
    if (verdict.status === 'review') {
      expect(verdict.score).toBe(run.score);
      expect(verdict.flags.join()).toContain("autopilot's exact step");
    }
  });

  test('a bot that jumps a step or two after the autopilot is flagged for its timing', () => {
    const random = mulberry32(8);
    let wait = -1;
    let holdLeft = 0;
    const lateJumper: Player = (sim, step) => {
      if (step > 3000) return NONE;
      const s = sim.getSnapshot();
      if (holdLeft > 0) {
        holdLeft--;
        return { ...NONE, jumpHeld: true };
      }
      if (wait < 0 && autopilot(s).jumpPressed) wait = Math.floor(random() * 3);
      if (wait === 0) {
        wait = -1;
        holdLeft = 4 + Math.floor(random() * 8);
        return PRESS;
      }
      if (wait > 0) wait--;
      return { ...autopilot(s), jumpPressed: false };
    };
    const run = playRun(createGameSim(), PRESS, 99, false, lateJumper);
    expect(run.score).toBeGreaterThan(400); // enough jumps for the bot checks to judge
    const verdict = verifyRun({ ...run.spec, steps: run.steps, inputs: run.inputs, beats: beatsFor(run.steps) });
    expect(verdict.status).toBe('review');
    if (verdict.status === 'review') expect(verdict.flags).toEqual([expect.stringContaining('jumps at the same distance')]);
  });

  test('a player who jumps a little early by eye, and holds as long as they like, is ok', () => {
    const random = mulberry32(8);
    const early = new Map<number, number>();
    let holdLeft = 0;
    const human: Player = (sim, step) => {
      if (step > 3000) return NONE;
      const s = sim.getSnapshot();
      if (holdLeft > 0) {
        holdLeft--;
        return { ...NONE, jumpHeld: true };
      }
      const next = s.obstacles.filter((o) => o.x + o.width > s.trex.x).sort((a, b) => a.x - b.x)[0];
      let jump = autopilot(s).jumpPressed;
      if (next && next.kind !== 'pterodactyl' && s.trex.status === 'running') {
        if (!early.has(next.id)) early.set(next.id, 10 + Math.floor(random() * 6));
        jump ||= (next.x - s.trex.x - s.trex.width) / s.speed <= early.get(next.id)!;
      }
      if (jump && s.trex.status === 'running') {
        holdLeft = 4 + Math.floor(random() * 9);
        return PRESS;
      }
      // Ducks like the autopilot, but starts a mid-air drop a few steps late.
      const ap = autopilot(s);
      if (s.trex.status === 'jumping' && ap.duckHeld && !s.trex.speedDrop && random() < 0.67) return NONE;
      return { ...ap, jumpPressed: false };
    };
    const run = playRun(createGameSim(), PRESS, 123, false, human);
    expect(run.score).toBeGreaterThan(400);
    const verdict = verifyRun({ ...run.spec, steps: run.steps, inputs: run.inputs, beats: beatsFor(run.steps) });
    expect(verdict).toMatchObject({ status: 'ok', score: run.score });
  });
});
