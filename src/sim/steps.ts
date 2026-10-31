// Chrome's millisecond timers expressed as whole fixed steps, so every duration in the sim is
// an exact integer count instead of an accumulating float.

import { NIGHT, OBSTACLES, RUNNER, SCORE, SIM, TREX } from '../config';

/** Steps until a timer advanced by SIM.STEP_MS per step satisfies Chrome's `timer >= ms`. */
export function msToSteps(ms: number): number {
  return Math.max(1, Math.ceil(ms / SIM.STEP_MS - 1e-6));
}

export const STEPS = {
  /** Obstacles appear once runFrames > CLEAR (Chrome: runningTime > CLEAR_TIME). */
  CLEAR: msToSteps(RUNNER.CLEAR_TIME),
  GAMEOVER_CLEAR: msToSteps(RUNNER.GAMEOVER_CLEAR_TIME),
  RUN_FRAME: msToSteps(TREX.RUN_FRAME_MS),
  DUCK_FRAME: msToSteps(TREX.DUCK_FRAME_MS),
  BLINK: msToSteps(TREX.BLINK_DURATION_MS),
  /** Not rounded: scaled by a random number in [0, 1) to pick the idle wait before a blink. */
  BLINK_TIMING: TREX.BLINK_TIMING / SIM.STEP_MS,
  PTERODACTYL_FRAME: msToSteps(OBSTACLES.pterodactyl.frameMs),
  FLASH: msToSteps(SCORE.FLASH_DURATION_MS),
  NIGHT: msToSteps(NIGHT.INVERT_FADE_DURATION),
  NIGHT_FADE: msToSteps(NIGHT.TRANSITION_MS),
} as const;
