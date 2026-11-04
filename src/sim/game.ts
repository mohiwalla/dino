// Chrome's Runner as a fixed-step simulation: phases, speed, distance, score, collisions, night.
// One step() is one Chrome animation frame (SIM.STEP_MS).

import { RUNNER } from '../config';
import type { GameEvent, GamePhase, GameSim, GameSimOptions, GameSnapshot, InputFrame } from '../types';
import { hitsObstacle } from './collision';
import type { Random } from './rng';
import { createNight, fadeNight, nightAmount, resetNight, updateNight } from './night';
import { clearObstacles, createObstacleField, obstacleSnapshot, updateObstacles } from './obstacles';
import {
  clampScore,
  flashHidden,
  milestoneCrossed,
  scoreForDistance,
  startFlash,
  stopFlash,
  tickFlash,
  type ScoreFlash,
} from './score';
import { STEPS } from './steps';
import {
  animateTrex,
  controlTrex,
  crashTrex,
  createTrex,
  moveTrex,
  resetTrex,
  startJump,
  trexSnapshot,
  TREX_DUCKED,
  TREX_JUMPED,
  TREX_LANDED,
} from './trex';

const START: GameEvent = { type: 'start' };
const RESTART: GameEvent = { type: 'restart' };
const JUMP: GameEvent = { type: 'jump' };
const LAND: GameEvent = { type: 'land' };
const DUCK: GameEvent = { type: 'duck' };

/** Returned by steps without events; frozen so a caller mutating it fails loudly. */
const NO_EVENTS = Object.freeze([]) as readonly GameEvent[] as GameEvent[];

export function createGameSim(opts: GameSimOptions = {}): GameSim {
  const random = opts.random ?? Math.random;
  const mobile = opts.mobile ?? false;
  const trex = createTrex();
  const field = createObstacleField();
  const night = createNight();
  const flash: ScoreFlash = { steps: -1 };
  const events: GameEvent[] = [];
  /** Obstacle RNG for the current run (a ranked run's server seed); null shares `random`. */
  let obstacleRandom: Random | null = null;

  let phase: GamePhase = opts.startCrashed ? 'crashed' : 'title';
  let frame = 0;
  let runFrames = 0;
  let speed: number = RUNNER.SPEED;
  let distance = 0;
  let score = 0;
  let highScore = clampScore(opts.highScore ?? 0);
  let crashSteps = opts.startCrashed ? STEPS.GAMEOVER_CLEAR : 0;

  resetTrex(trex, 'waiting', random);

  function step(input: InputFrame): GameEvent[] {
    if (phase === 'paused') return NO_EVENTS;
    events.length = 0;
    frame++;
    if (phase === 'title') stepTitle(input);
    else if (phase === 'crashed') stepCrashed(input);
    else stepPlaying(input, input.jumpPressed);
    return events.length === 0 ? NO_EVENTS : events.slice();
  }

  function stepTitle(input: InputFrame): void {
    if (!input.jumpPressed) {
      animateTrex(trex, random);
      return;
    }
    phase = 'playing';
    events.push(START, JUMP);
    startJump(trex, speed);
    stepPlaying(input, false);
  }

  function stepCrashed(input: InputFrame): void {
    if (crashSteps >= STEPS.GAMEOVER_CLEAR && (input.jumpPressed || input.restartPressed)) {
      restartRun();
      stepPlaying(input, false);
      return;
    }
    crashSteps++;
    fadeNight(night);
  }

  function restartRun(): void {
    phase = 'playing';
    events.push(RESTART);
    clearObstacles(field, events);
    runFrames = 0;
    speed = RUNNER.SPEED;
    distance = 0;
    score = 0;
    crashSteps = 0;
    stopFlash(flash);
    resetNight(night);
    resetTrex(trex, 'running', random);
  }

  function stepPlaying(input: InputFrame, jumpPressed: boolean): void {
    runFrames++;
    emitTrexFlags(controlTrex(trex, jumpPressed, input.jumpHeld, input.duckHeld, speed));
    emitTrexFlags(moveTrex(trex, input.duckHeld));
    if (runFrames > STEPS.CLEAR) updateObstacles(field, speed, obstacleRandom ?? random, mobile, events);
    distance += speed;
    const prevScore = score;
    score = scoreForDistance(distance);
    if (collides()) {
      crash();
      return;
    }
    speed = Math.min(RUNNER.MAX_SPEED, speed + RUNNER.ACCELERATION);
    tickFlash(flash);
    const milestone = milestoneCrossed(prevScore, score);
    if (milestone > 0) {
      startFlash(flash);
      events.push({ type: 'milestone', score: milestone });
    }
    updateNight(night, score, events);
    fadeNight(night);
    animateTrex(trex, random);
  }

  function emitTrexFlags(flags: number): void {
    if (flags & TREX_JUMPED) events.push(JUMP);
    if (flags & TREX_LANDED) events.push(LAND);
    if (flags & TREX_DUCKED) events.push(DUCK);
  }

  function collides(): boolean {
    const ducking = trex.status === 'ducking';
    for (const o of field.list) {
      if (hitsObstacle(trex.y, ducking, o.x, o.y, o.width, o.height, o.collisionBoxes)) return true;
    }
    return false;
  }

  function crash(): void {
    phase = 'crashed';
    crashSteps = 0;
    crashTrex(trex);
    stopFlash(flash);
    const newHighScore = score > highScore;
    if (newHighScore) highScore = score;
    events.push({ type: 'crash', score, newHighScore });
  }

  function getSnapshot(): GameSnapshot {
    return {
      phase,
      frame,
      runFrames,
      speed,
      distance,
      score,
      highScore,
      scoreFlash: flashHidden(flash),
      canRestart: phase === 'crashed' && crashSteps >= STEPS.GAMEOVER_CLEAR,
      night: nightAmount(night),
      moonPhase: night.moonPhase,
      trex: trexSnapshot(trex),
      obstacles: field.list.map(obstacleSnapshot),
    };
  }

  return {
    getSnapshot,
    step,
    pause() {
      if (phase === 'playing') phase = 'paused';
    },
    resume() {
      if (phase === 'paused') phase = 'playing';
    },
    setHighScore(value: number) {
      highScore = clampScore(value);
    },
    setObstacleRandom(r: Random | null) {
      obstacleRandom = r;
    },
  };
}
