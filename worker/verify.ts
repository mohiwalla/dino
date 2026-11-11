// Decides whether a finished run counts. The score always comes from replaying the inputs;
// on top of that, the server's own clock must agree with the step count, and the play must
// not look like the built-in autopilot or any other bot.

import { SIM } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { checkInputs, replayRun, type RunSpec } from '../src/sim/replay';
import { STEPS } from '../src/sim/steps';
import type { GameSim } from '../src/types';

/** [server ms, steps recorded by then]. The first beat is the run's start, [startedAt, 0]. */
export type Beat = readonly [number, number];

export interface RunRecord extends RunSpec {
  /** The game speed multiplier it was played at: steps came that much faster in real time. */
  multiplier?: number;
  steps: number;
  inputs: readonly number[];
  beats: readonly Beat[];
}

/**
 * The numbers a verdict was decided on, stored with the run for admins. Each bot check is
 * [same, of]: how many of the run's jumps (holds, drops) came out the same, out of how many.
 */
export interface RunChecks {
  /** The furthest the run fell behind the server clock (ms, before any allowance), and its pauses. */
  lagMs?: number;
  pauses?: number;
  jumps?: number;
  autopilotJumps?: number;
  sameTiming?: [number, number];
  sameHold?: [number, number];
  sameDrop?: [number, number];
}

export type Verdict =
  | { status: 'ok'; score: number; checks: RunChecks }
  | { status: 'review'; score: number; flags: string[]; checks: RunChecks }
  | { status: 'rejected'; flags: string[]; checks: RunChecks };

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

/**
 * Bots that read the game state play like clockwork. Each check is a share of the run that
 * comes out the same: `limit` flags it alone, and two checks past `near` flag it together.
 * Measured on the team's runs (Nov 2026): people reach at most 0.46 / 0.39 / 0.40, the
 * scripted runs 0.62-0.85 on timing.
 */
interface Sameness {
  label: (same: number, of: number) => string;
  limit: number;
  near: number;
}

/** Jumps within a step of the run's median time-to-obstacle. */
export const SAME_TIMING: Sameness = { label: (n, of) => `${n} of ${of} jumps at the same distance`, limit: 0.55, near: 0.45 };
/** Jump holds of the run's most common length. */
export const SAME_HOLD: Sameness = { label: (n, of) => `${n} of ${of} jump holds the same length`, limit: 0.5, near: 0.4 };
/** Mid-air ducks of the run's most common length. */
export const SAME_DROP: Sameness = { label: (n, of) => `${n} of ${of} mid-air ducks the same length`, limit: 0.7, near: 0.5 };

/**
 * Checks the beats the browser sent during the run against the steps it claimed at each.
 * Pauses show up as beats where no steps passed (the browser beats on pause and on resume);
 * the clock is only compared over stretches of play between them. At a speed `multiplier` each
 * step takes that much less real time.
 */
export function checkTiming(
  beats: readonly Beat[],
  steps: number,
  multiplier = 1,
): { rejected: string[]; review: string[]; lagMs: number; pauses: number } {
  const rejected: string[] = [];
  const review: string[] = [];
  if (beats.length < 2 || beats[beats.length - 1][1] !== steps) {
    rejected.push('missing beats');
    return { rejected, review, lagMs: 0, pauses: 0 };
  }
  let anchor = beats[0];
  let pauses = 0;
  let inPause = false;
  let worstSlowMs = 0;
  let lagMs = 0;
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
    const played = ((s - anchor[1]) * SIM.STEP_MS) / multiplier;
    const elapsed = t - anchor[0];
    if (played > elapsed + FAST_SLACK_MS) {
      rejected.push(`played ${Math.round(played / 1000)}s in ${Math.round(elapsed / 1000)}s of real time`);
      break;
    }
    worstSlowMs = Math.max(worstSlowMs, elapsed - played - played * SLOW_RATE);
    lagMs = Math.max(lagMs, elapsed - played);
  }
  if (worstSlowMs > SLOW_SLACK_MS) review.push(`ran ${(worstSlowMs / 1000).toFixed(1)}s slower than real time`);
  if (pauses > MAX_PAUSES) review.push(`paused ${pauses} times`);
  return { rejected, review, lagMs: Math.round(lagMs), pauses };
}

export function verifyRun(run: RunRecord): Verdict {
  const malformed = checkInputs(run.inputs, run.steps);
  if (malformed) return { status: 'rejected', flags: [malformed], checks: {} };
  const timing = checkTiming(run.beats, run.steps, run.multiplier ?? 1);
  const checks: RunChecks = { lagMs: timing.lagMs, pauses: timing.pauses };
  if (timing.rejected.length > 0) return { status: 'rejected', flags: timing.rejected, checks };

  // The autopilot is stateless and keeps asking to jump until it does, so a jump only counts
  // as its own when it lands on the first step of that: asked now, not on the step before.
  const presses = pressSteps(run.inputs);
  let askedBefore = false;
  let jumps = 0;
  let autopilotJumps = 0;
  const holds: number[] = [];
  let hold = -1;
  const drops: number[] = [];
  let drop = -1;
  /** Steps until the next obstacle reached the dino, at each jump. */
  const timings: number[] = [];
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
    const s = sim.getSnapshot();
    if (drop >= 0) {
      if (input.duckHeld) drop++;
      else {
        drops.push(drop);
        drop = -1;
      }
    } else if (input.duckHeld && s.phase === 'playing' && s.trex.status === 'jumping') drop = 1;
    if (!input.jumpPressed || input.duckHeld) return;
    if (s.phase !== 'playing' || s.trex.status !== 'running' || s.obstacles.length === 0) return;
    jumps++;
    if (asked && !wasAsked) autopilotJumps++;
    hold = input.jumpHeld ? 1 : 0;
    const front = s.trex.x + s.trex.width;
    const next = Math.min(...s.obstacles.filter((o) => o.x + o.width > s.trex.x).map((o) => o.x));
    if (Number.isFinite(next)) timings.push((next - front) / s.speed);
  });
  if (!result.ok) return { status: 'rejected', flags: [result.reason], checks };

  const flags = timing.review;
  if (jumps >= MIN_JUMPS && autopilotJumps / jumps >= AUTOPILOT_MATCH) {
    flags.push(`${autopilotJumps} of ${jumps} jumps on the autopilot's exact step`);
  }
  const median = timings.length > 0 ? [...timings].sort((a, b) => a - b)[timings.length >> 1] : 0;
  const sameness: [Sameness, number, number][] = [
    [SAME_TIMING, timings.filter((t) => Math.abs(t - median) <= 1).length, timings.length],
    [SAME_HOLD, mostCommon(holds), holds.length],
    [SAME_DROP, mostCommon(drops), drops.length],
  ];
  const judged = sameness.filter(([, , of]) => of >= MIN_JUMPS);
  const past = (key: 'limit' | 'near') => judged.filter(([check, same, of]) => same / of >= check[key]);
  const flagged = past('limit').length > 0 ? past('limit') : past('near').length >= 2 ? past('near') : [];
  for (const [check, same, of] of flagged) flags.push(check.label(same, of));
  Object.assign(checks, {
    jumps,
    autopilotJumps,
    sameTiming: [sameness[0][1], sameness[0][2]],
    sameHold: [sameness[1][1], sameness[1][2]],
    sameDrop: [sameness[2][1], sameness[2][2]],
  });
  return flags.length > 0 ? { status: 'review', score: result.score, flags, checks } : { status: 'ok', score: result.score, checks };
}

/** Steps whose input has jumpPressed set. */
function pressSteps(inputs: readonly number[]): Set<number> {
  const steps = new Set<number>();
  for (let i = 0; i < inputs.length; i += 2) if (inputs[i + 1] & 1) steps.add(inputs[i]);
  return steps;
}

/** How many of the values equal the most common one. */
function mostCommon(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}
