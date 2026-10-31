// Chrome NightMode: every INVERT_DISTANCE points the scene goes dark for INVERT_FADE_DURATION.

import { NIGHT } from '../config';
import type { GameEvent } from '../types';
import { STEPS } from './steps';

export interface Night {
  active: boolean;
  /** Playing steps since night started. */
  activeSteps: number;
  /** 0..STEPS.NIGHT_FADE; night amount = fadeSteps / STEPS.NIGHT_FADE. */
  fadeSteps: number;
  moonPhase: number;
  /** Score that last started a night, so one score value cannot start it twice. */
  lastTrigger: number;
}

const NIGHT_START: GameEvent = { type: 'nightStart' };
const NIGHT_END: GameEvent = { type: 'nightEnd' };

export function createNight(): Night {
  return { active: false, activeSteps: 0, fadeSteps: 0, moonPhase: 0, lastTrigger: -1 };
}

/** Straight back to day, like Chrome's NightMode.reset on restart. */
export function resetNight(n: Night): void {
  n.active = false;
  n.activeSteps = 0;
  n.fadeSteps = 0;
  n.moonPhase = 0;
  n.lastTrigger = -1;
}

/** One playing step of Chrome's invert timer, after the score has been updated. */
export function updateNight(n: Night, score: number, events: GameEvent[]): void {
  if (n.active) {
    n.activeSteps++;
    if (n.activeSteps < STEPS.NIGHT) return;
    n.active = false;
    events.push(NIGHT_END);
    return;
  }
  if (score <= 0 || score % NIGHT.INVERT_DISTANCE !== 0 || score === n.lastTrigger) return;
  n.active = true;
  n.activeSteps = 0;
  n.lastTrigger = score;
  n.moonPhase = (n.moonPhase + 1) % NIGHT.MOON_PHASES;
  events.push(NIGHT_START);
}

/** Linear day <-> night blend toward the current target. */
export function fadeNight(n: Night): void {
  if (n.active) n.fadeSteps = Math.min(STEPS.NIGHT_FADE, n.fadeSteps + 1);
  else n.fadeSteps = Math.max(0, n.fadeSteps - 1);
}

export function nightAmount(n: Night): number {
  return n.fadeSteps / STEPS.NIGHT_FADE;
}
