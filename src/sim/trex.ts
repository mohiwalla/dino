// Chrome's Trex: jump physics, ducking, speed drop and animation frames, y-up and unrounded.
// The functions are pure state updates (no events) so the autopilot can replay them exactly.

import { TREX } from '../config';
import type { TrexFrame, TrexSnapshot, TrexStatus } from '../types';
import type { Random } from './rng';
import { STEPS } from './steps';

export interface Trex {
  /** Feet height above the ground. */
  y: number;
  /** px/step, + is up. */
  vy: number;
  status: TrexStatus;
  reachedMinHeight: boolean;
  speedDrop: boolean;
  frame: TrexFrame;
  /** Steps the current frame has been shown. */
  frameSteps: number;
  /** Idle steps before the next blink on the title screen. */
  blinkWait: number;
}

/** Bit flags returned by controlTrex / moveTrex; game.ts turns them into events. */
export const TREX_JUMPED = 1;
export const TREX_DUCKED = 2;
export const TREX_LANDED = 4;

const FIRST_FRAME: Record<TrexStatus, TrexFrame> = {
  waiting: 'idle',
  running: 'run1',
  jumping: 'jump',
  ducking: 'duck1',
  crashed: 'crashed',
};

export function createTrex(): Trex {
  return {
    y: 0,
    vy: 0,
    status: 'waiting',
    reachedMinHeight: false,
    speedDrop: false,
    frame: 'idle',
    frameSteps: 0,
    blinkWait: 0,
  };
}

export function setStatus(t: Trex, status: TrexStatus): void {
  t.status = status;
  t.frame = FIRST_FRAME[status];
  t.frameSteps = 0;
}

/** Back on the ground, standing still. */
export function resetTrex(t: Trex, status: 'waiting' | 'running', random: Random): void {
  t.y = 0;
  t.vy = 0;
  t.reachedMinHeight = false;
  t.speedDrop = false;
  setStatus(t, status);
  t.blinkWait = nextBlinkWait(random);
}

export function startJump(t: Trex, speed: number): void {
  setStatus(t, 'jumping');
  t.vy = TREX.INITIAL_JUMP_VELOCITY + speed / 10;
  t.reachedMinHeight = false;
  t.speedDrop = false;
}

function endJump(t: Trex): void {
  if (t.reachedMinHeight && t.vy > TREX.DROP_VELOCITY) t.vy = TREX.DROP_VELOCITY;
}

/**
 * One step of player intent, applied before the physics. Duck is resolved first, so a ducking
 * T-Rex cannot jump (Chrome ignores jump while ducking). Returns TREX_* flags.
 */
export function controlTrex(
  t: Trex,
  jumpPressed: boolean,
  jumpHeld: boolean,
  duckHeld: boolean,
  speed: number,
): number {
  let flags = 0;
  if (!duckHeld) {
    t.speedDrop = false;
    if (t.status === 'ducking') setStatus(t, 'running');
  } else if (t.status === 'running') {
    setStatus(t, 'ducking');
    flags |= TREX_DUCKED;
  } else if (t.status === 'jumping' && !t.speedDrop) {
    t.speedDrop = true;
    t.vy = -1;
  }
  if (jumpPressed && t.status === 'running') {
    startJump(t, speed);
    flags |= TREX_JUMPED;
  }
  if (t.status === 'jumping' && t.vy > 0 && !jumpHeld) endJump(t);
  return flags;
}

/** Chrome Trex.updateJump for one step. Landing with duck held goes straight to ducking. */
export function moveTrex(t: Trex, duckHeld: boolean): number {
  if (t.status !== 'jumping') return 0;
  t.y += t.vy;
  t.vy -= TREX.GRAVITY * (t.speedDrop ? TREX.SPEED_DROP_COEFFICIENT : 1);
  if (t.y > TREX.MIN_JUMP_HEIGHT || t.speedDrop) t.reachedMinHeight = true;
  if (t.y > TREX.MAX_JUMP_HEIGHT || t.speedDrop) endJump(t);
  if (t.y > 0) return 0;
  t.y = 0;
  t.vy = 0;
  t.speedDrop = false;
  if (duckHeld) {
    setStatus(t, 'ducking');
    return TREX_LANDED | TREX_DUCKED;
  }
  setStatus(t, 'running');
  return TREX_LANDED;
}

export function crashTrex(t: Trex): void {
  t.vy = 0;
  t.speedDrop = false;
  setStatus(t, 'crashed');
}

/** Advances the frame timer: run / duck cycles, and idle blinking while waiting. */
export function animateTrex(t: Trex, random: Random): void {
  t.frameSteps++;
  if (t.status === 'running') cycleFrames(t, 'run1', 'run2', STEPS.RUN_FRAME);
  else if (t.status === 'ducking') cycleFrames(t, 'duck1', 'duck2', STEPS.DUCK_FRAME);
  else if (t.status === 'waiting') blink(t, random);
}

function cycleFrames(t: Trex, a: TrexFrame, b: TrexFrame, steps: number): void {
  if (t.frameSteps < steps) return;
  t.frame = t.frame === a ? b : a;
  t.frameSteps = 0;
}

function blink(t: Trex, random: Random): void {
  if (t.frame === 'blink') {
    if (t.frameSteps < STEPS.BLINK) return;
    t.frame = 'idle';
    t.blinkWait = nextBlinkWait(random);
  } else {
    if (t.frameSteps < t.blinkWait) return;
    t.frame = 'blink';
  }
  t.frameSteps = 0;
}

function nextBlinkWait(random: Random): number {
  return Math.floor(random() * STEPS.BLINK_TIMING);
}

export function trexSnapshot(t: Trex): TrexSnapshot {
  const ducking = t.status === 'ducking';
  return {
    x: TREX.START_X,
    y: t.y,
    width: ducking ? TREX.WIDTH_DUCK : TREX.WIDTH,
    height: ducking ? TREX.HEIGHT_DUCK : TREX.HEIGHT,
    status: t.status,
    frame: t.frame,
    vy: t.vy,
    speedDrop: t.speedDrop,
  };
}
