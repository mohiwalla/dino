// Ranked runs as data: a run is its server seed plus the input of every step, and replaying
// that through a fresh sim reproduces it exactly. The browser records, the leaderboard server
// (worker/) replays to compute the score itself, and ?replay= plays a stored run back.
//
// A run starts with the step that emits 'start' (from the title screen) or 'restart' (from a
// game-over screen) and ends with the step that emits 'crash'. Paused time has no steps, so
// it is not in the log.

import type { GameSim, InputFrame } from '../types';
import { createGameSim } from './game';
import { mulberry32 } from './rng';

/**
 * Bump whenever a change to src/sim or the gameplay constants in src/config.ts changes how a
 * run plays out. The server refuses runs recorded by a different version, because their
 * replay would no longer match. test/sim-replay.test.ts fails until this is bumped.
 */
export const SIM_VERSION = 3;

export interface RunSpec {
  /** Seeds the run's obstacle RNG (mulberry32). */
  seed: number;
  mobile: boolean;
  /** The run was a restart from a game-over screen (no automatic first jump). */
  afterCrash: boolean;
  /** Started at RUNNER.FAST_START_SPEED. Optional: runs recorded before it existed are normal. */
  fast?: boolean;
  /** The SIM_VERSION it was recorded under, if not the current one (older runs replay by their rules). */
  simVersion?: number;
}

const JUMP_PRESSED = 1;
const JUMP_HELD = 2;
const DUCK_HELD = 4;
const RESTART_PRESSED = 8;
const MAX_BITS = 15;

export function inputBits(f: InputFrame): number {
  return (
    (f.jumpPressed ? JUMP_PRESSED : 0) |
    (f.jumpHeld ? JUMP_HELD : 0) |
    (f.duckHeld ? DUCK_HELD : 0) |
    (f.restartPressed ? RESTART_PRESSED : 0)
  );
}

const FRAMES: readonly InputFrame[] = Array.from({ length: MAX_BITS + 1 }, (_, b) =>
  Object.freeze({
    jumpPressed: (b & JUMP_PRESSED) !== 0,
    jumpHeld: (b & JUMP_HELD) !== 0,
    duckHeld: (b & DUCK_HELD) !== 0,
    restartPressed: (b & RESTART_PRESSED) !== 0,
  }),
);

export function bitsInput(bits: number): InputFrame {
  return FRAMES[bits & MAX_BITS];
}

/**
 * Records a run's input as change points: a flat [step, bits, step, bits, ...] list where each
 * bits value holds from its step until the next entry. take() hands out the entries recorded
 * since the last take(), so the log can be uploaded in chunks while the run is going.
 */
export interface InputRecorder {
  record(f: InputFrame): void;
  /** Steps recorded so far. */
  readonly steps: number;
  take(): number[];
}

export function createInputRecorder(): InputRecorder {
  let steps = 0;
  let last = -1;
  let pending: number[] = [];
  return {
    record(f) {
      const bits = inputBits(f);
      if (bits !== last) pending.push(steps, bits);
      last = bits;
      steps++;
    },
    get steps() {
      return steps;
    },
    take() {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

/** Steps through a change-point log one InputFrame at a time. */
export function createInputCursor(inputs: readonly number[]): { next(): InputFrame } {
  let step = 0;
  let i = 0;
  let bits = 0;
  return {
    next() {
      while (i < inputs.length && inputs[i] <= step) {
        bits = inputs[i + 1];
        i += 2;
      }
      step++;
      return bitsInput(bits);
    },
  };
}

/** Why a log is malformed, or null if it is a well-formed change-point list for `steps` steps. */
export function checkInputs(inputs: unknown, steps: number): string | null {
  if (!Array.isArray(inputs) || inputs.length % 2 !== 0) return 'inputs must be [step, bits] pairs';
  if (inputs.length === 0 || inputs[0] !== 0) return 'inputs must start at step 0';
  let prev = -1;
  for (let i = 0; i < inputs.length; i += 2) {
    const step = inputs[i];
    const bits = inputs[i + 1];
    if (!Number.isInteger(step) || step <= prev || step >= steps) return 'input steps must increase within the run';
    if (!Number.isInteger(bits) || bits < 0 || bits > MAX_BITS) return 'input bits out of range';
    prev = step;
  }
  return null;
}

/** The sim a run is replayed in, before its first step. */
export function createRunSim(spec: RunSpec): GameSim {
  // Cosmetic randomness (title-screen blinks) never affects a run, so any fixed seed works.
  const sim = createGameSim({
    random: mulberry32(0),
    mobile: spec.mobile,
    startCrashed: spec.afterCrash,
    startFast: spec.fast === true,
    // Version 3 brought the 80/20 birds and the stacked pairs; older runs keep Chrome's rules.
    classicObstacles: (spec.simVersion ?? SIM_VERSION) < 3,
  });
  sim.setObstacleRandom(mulberry32(spec.seed));
  return sim;
}

export type ReplayResult = { ok: true; score: number } | { ok: false; reason: string };

/**
 * Replays `steps` steps of a well-formed log (see checkInputs). The run must start on step 0
 * and crash on its last step. `visit` sees every step's input with the sim just before it.
 */
export function replayRun(
  spec: RunSpec,
  inputs: readonly number[],
  steps: number,
  visit?: (step: number, input: InputFrame, sim: GameSim) => void,
): ReplayResult {
  const sim = createRunSim(spec);
  const cursor = createInputCursor(inputs);
  for (let i = 0; i < steps; i++) {
    const input = cursor.next();
    visit?.(i, input, sim);
    const events = sim.step(input);
    if (i === 0 && !events.some((e) => e.type === (spec.afterCrash ? 'restart' : 'start'))) {
      return { ok: false, reason: 'the first step does not start the run' };
    }
    const crash = events.find((e) => e.type === 'crash');
    if (crash?.type === 'crash') {
      return i === steps - 1 ? { ok: true, score: crash.score } : { ok: false, reason: 'the run crashed early' };
    }
  }
  return { ok: false, reason: 'the run never crashed' };
}
