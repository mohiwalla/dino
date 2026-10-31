// Chrome DistanceMeter: score from distance, achievement milestones and the score blink.

import { SCORE } from '../config';
import { STEPS } from './steps';

export const MAX_SCORE = 10 ** SCORE.MAX_DIGITS - 1;

const FLASH_TOTAL_STEPS = STEPS.FLASH * 2 * SCORE.FLASH_ITERATIONS;

export function scoreForDistance(distance: number): number {
  return Math.min(MAX_SCORE, Math.round(Math.ceil(distance) * SCORE.COEFFICIENT));
}

export function clampScore(score: number): number {
  return Number.isFinite(score) ? Math.min(MAX_SCORE, Math.max(0, Math.round(score))) : 0;
}

/** The multiple of ACHIEVEMENT_DISTANCE crossed going from `prev` to `next`, or 0. */
export function milestoneCrossed(prev: number, next: number): number {
  const reached = Math.floor(next / SCORE.ACHIEVEMENT_DISTANCE);
  return reached > Math.floor(prev / SCORE.ACHIEVEMENT_DISTANCE) ? reached * SCORE.ACHIEVEMENT_DISTANCE : 0;
}

/** Steps since the current blink started, or -1 when not blinking. */
export interface ScoreFlash {
  steps: number;
}

export function startFlash(f: ScoreFlash): void {
  f.steps = 0;
}

export function stopFlash(f: ScoreFlash): void {
  f.steps = -1;
}

export function tickFlash(f: ScoreFlash): void {
  if (f.steps < 0) return;
  f.steps++;
  if (f.steps >= FLASH_TOTAL_STEPS) f.steps = -1;
}

/** Hidden for FLASH steps, shown for FLASH steps, FLASH_ITERATIONS times. */
export function flashHidden(f: ScoreFlash): boolean {
  return f.steps >= 0 && Math.floor(f.steps / STEPS.FLASH) % 2 === 0;
}
