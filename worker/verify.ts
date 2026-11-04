// Decides whether a finished run counts. The score always comes from replaying the inputs;
// on top of that, the server's own clock must agree with the step count, and the play must
// not look like the built-in autopilot.

import { SIM } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { checkInputs, replayRun, type RunSpec } from '../src/sim/replay';
import { STEPS } from '../src/sim/steps';
import type { GameSim } from '../src/types';

/** [server ms, steps recorded by then]. The first beat is the run's start, [startedAt, 0]. */
export type Beat = readonly [number, number];

export interface RunRecord extends RunSpec {
  steps: number;
  inputs: readonly number[];
  beats: readonly Beat[];
}

export type Verdict =
  | { status: 'ok'; score: number }
  | { status: 'review'; score: number; flags: string[] }
  | { status: 'rejected'; flags: string[] };

/**
 * Steps may run ahead of the server clock by this much: the run starts in the browser before
 * the server hears about it, and its seed only has to arrive before the first obstacle.
 */
export const FAST_SLACK_MS = STEPS.CLEAR * SIM.STEP_MS + 1000;
/** Steps may lag the clock by this much plus SLOW_RATE (network jitter, dropped frames). */
export const SLOW_SLACK_MS = 2500;
export const SLOW_RATE = 0.05;
export const MAX_PAUSES = 3;
/** Bot checks only judge runs with at least this many jumps. */
export const MIN_JUMPS = 25;
/** Share of jumps on the exact step the autopilot would have jumped that marks a bot. */
export const AUTOPILOT_MATCH = 0.6;
/** Jump holds (in steps) with less spread than this are machine-made. */
export const MIN_HOLD_SPREAD = 0.5;

/**
 * Checks the beats the browser sent during the run against the steps it claimed at each.
 * Pauses show up as beats where no steps passed (the browser beats on pause and on resume);
 * the clock is only compared over stretches of play between them.
 */
export function checkTiming(beats: readonly Beat[], steps: number): { rejected: string[]; review: string[] } {
  const rejected: string[] = [];
  const review: string[] = [];
  if (beats.length < 2 || beats[beats.length - 1][1] !== steps) {
    rejected.push('missing beats');
    return { rejected, review };
  }
  let anchor = beats[0];
  let pauses = 0;
  let inPause = false;
  let worstSlowMs = 0;
  for (let k = 1; k < beats.length; k++) {
    const [t, s] = beats[k];
    const [tPrev, sPrev] = beats[k - 1];
    if (s < sPrev || t < tPrev) {
      rejected.push('beats out of order');
      break;
    }
    if (s === sPrev) {
      if (!inPause) pauses++;
      inPause = true;
      anchor = beats[k];
      continue;
    }
    inPause = false;
    const played = (s - anchor[1]) * SIM.STEP_MS;
    const elapsed = t - anchor[0];
    if (played > elapsed + FAST_SLACK_MS) {
      rejected.push(`played ${Math.round(played / 1000)}s in ${Math.round(elapsed / 1000)}s of real time`);
      break;
    }
    worstSlowMs = Math.max(worstSlowMs, elapsed - played - played * SLOW_RATE);
  }
  if (worstSlowMs > SLOW_SLACK_MS) review.push(`ran ${(worstSlowMs / 1000).toFixed(1)}s slower than real time`);
  if (pauses > MAX_PAUSES) review.push(`paused ${pauses} times`);
  return { rejected, review };
}

export function verifyRun(run: RunRecord): Verdict {
  const malformed = checkInputs(run.inputs, run.steps);
  if (malformed) return { status: 'rejected', flags: [malformed] };
  const timing = checkTiming(run.beats, run.steps);
  if (timing.rejected.length > 0) return { status: 'rejected', flags: timing.rejected };

  // The autopilot is stateless and keeps asking to jump until it does, so a jump only counts
  // as its own when it lands on the first step of that: asked now, not on the step before.
  const presses = pressSteps(run.inputs);
  let askedBefore = false;
  let jumps = 0;
  let autopilotJumps = 0;
  const holds: number[] = [];
  let hold = -1;
  const asks = (sim: GameSim): boolean => {
    const s = sim.getSnapshot();
    return s.phase === 'playing' && s.trex.status === 'running' && autopilot(s).jumpPressed;
  };
  const result = replayRun(run, run.inputs, run.steps, (step, input, sim) => {
    // Only needed on press steps and the steps just before them.
    const asked = presses.has(step) || presses.has(step + 1) ? asks(sim) : false;
    const wasAsked = askedBefore;
    askedBefore = asked;
    if (hold >= 0) {
      if (input.jumpHeld) hold++;
      else {
        holds.push(hold);
        hold = -1;
      }
    }
    if (!input.jumpPressed || input.duckHeld) return;
    const s = sim.getSnapshot();
    if (s.phase !== 'playing' || s.trex.status !== 'running' || s.obstacles.length === 0) return;
    jumps++;
    if (asked && !wasAsked) autopilotJumps++;
    hold = input.jumpHeld ? 1 : 0;
  });
  if (!result.ok) return { status: 'rejected', flags: [result.reason] };

  const flags = timing.review;
  if (jumps >= MIN_JUMPS && autopilotJumps / jumps >= AUTOPILOT_MATCH) {
    flags.push(`${autopilotJumps} of ${jumps} jumps on the autopilot's exact step`);
  }
  if (holds.length >= MIN_JUMPS && spread(holds) < MIN_HOLD_SPREAD) flags.push('jump holds are all the same length');
  return flags.length > 0 ? { status: 'review', score: result.score, flags } : { status: 'ok', score: result.score };
}

/** Steps whose input has jumpPressed set. */
function pressSteps(inputs: readonly number[]): Set<number> {
  const steps = new Set<number>();
  for (let i = 0; i < inputs.length; i += 2) if (inputs[i + 1] & 1) steps.add(inputs[i]);
  return steps;
}

/** Standard deviation. */
function spread(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}
