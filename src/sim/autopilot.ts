// A stateless bot. Every call it replays the sim's own T-Rex and collision code a few dozen
// steps ahead (obstacle motion is deterministic; a pterodactyl's unknown +/- speedOffset is
// covered by checking both signs) and picks the input whose future is collision-free:
//  - on the ground it jumps JUMP_MARGIN steps before the last step that still clears the next
//    obstacle (or at the first clean step, if the window is narrower), and ducks under
//    mid-height pterodactyls;
//  - in the air it releases jump as early as the remaining arc stays clear, and speed-drops as
//    soon as the drop lands somewhere the following obstacle can still be jumped from.
// All scratch state is preallocated; nothing carries over between calls.

import { OBSTACLES, RUNNER, TREX } from '../config';
import type { Box, GameSnapshot, InputFrame } from '../types';
import { hitsObstacle, TREX_DUCKING_BOXES, TREX_RUNNING_BOXES } from './collision';
import { controlTrex, createTrex, moveTrex, setStatus, type Trex } from './trex';

const MAX_OBSTACLES = 16;
/** Ground steps scanned for the next collision before thinking about a jump. */
const JUMP_LOOKAHEAD = 20;
/** After a landing, a collision further away than this can always be jumped later. */
const VIABLE_LOOKAHEAD = 16;
const MAX_ROLLOUT = 160;
/** Jump hold lengths (steps) tried when planning: full hold, a tap, a medium hold. */
const HOLDS: readonly number[] = [Infinity, 1, 6];
/** Duck this many steps before a mid-height pterodactyl reaches the T-Rex. */
const DUCK_LEAD_STEPS = 2;
/** Jump this many steps before the last clean moment when the window allows (reads better on screen). */
const JUMP_MARGIN = 2;
/** With no clean jump left, jump anyway once the collision is this close. */
const PANIC_STEPS = 3;

const CLASS_JUMP = 0;
const CLASS_DUCK = 1;
const CLASS_OVERHEAD = 2;

const DUCK_TOP = topOf(TREX_DUCKING_BOXES);
const STAND_TOP = topOf(TREX_RUNNING_BOXES);
/** Obstacles whose right edge is behind this can no longer touch the T-Rex. */
const TREX_BACK = TREX.START_X + Math.min(leftOf(TREX_RUNNING_BOXES), leftOf(TREX_DUCKING_BOXES));

function topOf(boxes: readonly Box[]): number {
  return Math.max(...boxes.map((b) => b.y + b.h));
}

function leftOf(boxes: readonly Box[]): number {
  return Math.min(...boxes.map((b) => b.x));
}

/** The snapshot's obstacles that can still be hit, flattened once per call. */
const scene = {
  count: 0,
  hasPterodactyl: false,
  x: new Float64Array(MAX_OBSTACLES),
  y: new Float64Array(MAX_OBSTACLES),
  w: new Float64Array(MAX_OBSTACLES),
  h: new Float64Array(MAX_OBSTACLES),
  /** Fine-box extents relative to the obstacle's x. */
  left: new Float64Array(MAX_OBSTACLES),
  right: new Float64Array(MAX_OBSTACLES),
  cls: new Uint8Array(MAX_OBSTACLES),
  pterodactyl: new Uint8Array(MAX_OBSTACLES),
  boxes: new Array<readonly Box[]>(MAX_OBSTACLES).fill([]),
};

/** The bot's copy of the moving parts of the world. */
interface Model {
  readonly trex: Trex;
  speed: number;
  readonly x: Float64Array;
  /** Assumed speedOffset of each obstacle. */
  readonly v: Float64Array;
}

function createModel(): Model {
  return { trex: createTrex(), speed: 0, x: new Float64Array(MAX_OBSTACLES), v: new Float64Array(MAX_OBSTACLES) };
}

function copyModel(dst: Model, src: Model): void {
  Object.assign(dst.trex, src.trex);
  dst.speed = src.speed;
  dst.x.set(src.x);
  dst.v.set(src.v);
}

/** One model per pterodactyl speed-offset sign. */
const bases: readonly Model[] = [createModel(), createModel()];
const SCENARIO_SIGNS: readonly number[] = [1, -1];
/** Scratch per planning depth: [0] is the top-level plan, [1] the follow-up check after landing. */
const groundModels: readonly Model[] = [createModel(), createModel()];
const rolloutModels: readonly Model[] = [createModel(), createModel()];
const DEEPEST = 1;

/** Set by groundHit: scene index of the obstacle hit. */
let hitIndex = -1;

export function autopilot(s: GameSnapshot): InputFrame {
  if (s.phase === 'title') return input(true, true, false, false);
  if (s.phase === 'crashed') return input(false, false, false, s.canRestart);
  if (s.phase !== 'playing') return input(false, false, false, false);
  loadScene(s);
  for (let i = 0; i < scenarioCount(); i++) loadModel(bases[i], s, SCENARIO_SIGNS[i]);
  return s.trex.status === 'jumping' ? airborne(s) : grounded();
}

function input(jumpPressed: boolean, jumpHeld: boolean, duckHeld: boolean, restartPressed: boolean): InputFrame {
  return { jumpPressed, jumpHeld, duckHeld, restartPressed };
}

function scenarioCount(): number {
  return scene.hasPterodactyl ? 2 : 1;
}

// ─── Decisions ───────────────────────────────────────────────────────────────────────────

function grounded(): InputFrame {
  let hit = -1;
  let target = -1;
  for (let i = 0; i < scenarioCount(); i++) {
    copyModel(groundModels[0], bases[i]);
    const h = groundHit(groundModels[0], JUMP_LOOKAHEAD);
    if (h >= 0 && (hit < 0 || h < hit)) {
      hit = h;
      target = hitIndex;
    }
  }
  const duck = shouldDuck(bases[0]);
  if (hit < 0) return input(false, false, duck, false);
  const now = jumpQuality(0, target);
  if (now === 0 && hit > PANIC_STEPS) return input(false, false, duck, false);
  const later = jumpQuality(1 + JUMP_MARGIN, target);
  if (now > later || (now === 0 && later === 0)) return input(true, true, false, false);
  return input(false, false, duck, false);
}

function airborne(s: GameSnapshot): InputFrame {
  const drop = s.trex.speedDrop || (scene.count > 0 && airQuality(true, true) === 2);
  if (drop) return input(false, false, dropDuck(bases[0]), false);
  // Releasing only matters while the jump can still be clamped to DROP_VELOCITY.
  if (s.trex.vy <= TREX.DROP_VELOCITY) return input(false, false, false, false);
  const released = airQuality(true, false);
  if (released === 2) return input(false, false, false, false);
  return input(false, airQuality(false, false) >= released, false, false);
}

/** Best outcome over the hold options of jumping after `wait` ground steps (see clearQuality). */
function jumpQuality(wait: number, target: number): number {
  let best = 0;
  for (const hold of HOLDS) {
    let q = 2;
    for (let i = 0; i < scenarioCount() && q > 0; i++) q = Math.min(q, clearQuality(bases[i], wait, hold, target, 0));
    best = Math.max(best, q);
    if (best === 2) break;
  }
  return best;
}

/** Outcome of finishing the current jump with jump released and/or duck held, worst scenario. */
function airQuality(release: boolean, drop: boolean): number {
  let q = 2;
  for (let i = 0; i < scenarioCount() && q > 0; i++) {
    const m = rolloutModels[0];
    copyModel(m, bases[i]);
    if (!finishJump(m, !release, drop)) return 0;
    q = Math.min(q, viable(m, 1) ? 2 : 1);
  }
  return q;
}

// ─── Rollouts ────────────────────────────────────────────────────────────────────────────

/**
 * 0: jumping after `wait` steps with `hold` hits something before `target` is behind the T-Rex.
 * 1: it clears, but the next obstacle can no longer be jumped afterwards.
 * 2: it clears and the next obstacle is still jumpable (not checked at the deepest level).
 */
function clearQuality(from: Model, wait: number, hold: number, target: number, depth: number): number {
  const m = rolloutModels[depth];
  if (!jumpPast(from, m, wait, hold, target)) return 0;
  if (depth >= DEEPEST) return 2;
  return viable(m, depth + 1) ? 2 : 1;
}

/** From a grounded state: can the next obstacle within VIABLE_LOOKAHEAD steps still be jumped? */
function viable(from: Model, depth: number): boolean {
  const g = groundModels[depth];
  copyModel(g, from);
  const hit = groundHit(g, VIABLE_LOOKAHEAD);
  if (hit < 0) return true;
  const target = hitIndex;
  for (let wait = hit - 1; wait >= 0; wait--) {
    for (const hold of HOLDS) {
      if (clearQuality(from, wait, hold, target, depth) > 0) return true;
    }
  }
  return false;
}

/** Runs the ground policy (run, duck under mid pterodactyls); returns the 1-based step of the first hit or -1. */
function groundHit(m: Model, horizon: number): number {
  for (let k = 1; k <= horizon; k++) {
    const hit = modelStep(m, false, false, shouldDuck(m));
    if (hit >= 0) {
      hitIndex = hit;
      return k;
    }
  }
  return -1;
}

/** Wait, jump, hold for `hold` steps, land, and keep running until `target` is behind. */
function jumpPast(from: Model, m: Model, wait: number, hold: number, target: number): boolean {
  copyModel(m, from);
  for (let k = 0; k < wait; k++) {
    if (modelStep(m, false, false, shouldDuck(m)) >= 0) return false;
  }
  for (let k = 0; k < MAX_ROLLOUT; k++) {
    const landed = k > 0 && m.trex.status !== 'jumping';
    if (landed && m.x[target] + scene.right[target] <= TREX_BACK) return true;
    const hit = landed ? modelStep(m, false, false, shouldDuck(m)) : modelStep(m, k === 0, k < hold, false);
    if (hit >= 0) return false;
  }
  return false;
}

/** Continues an airborne T-Rex until it lands, holding jump and/or speed-dropping throughout. */
function finishJump(m: Model, jumpHeld: boolean, drop: boolean): boolean {
  for (let k = 0; k < MAX_ROLLOUT && m.trex.status === 'jumping'; k++) {
    if (modelStep(m, false, jumpHeld, drop && dropDuck(m)) >= 0) return false;
  }
  return m.trex.status !== 'jumping';
}

/**
 * Duck input while speed-dropping: let go on the landing step (the fall is unchanged) so the
 * T-Rex lands running instead of flashing one ducking frame, unless it should duck anyway.
 */
function dropDuck(m: Model): boolean {
  const vy = m.trex.speedDrop ? m.trex.vy : -1;
  return m.trex.y + vy > 0 || shouldDuck(m);
}

/** Ground policy: duck while a mid-height pterodactyl is about to pass or passing over. */
function shouldDuck(m: Model): boolean {
  const reach = TREX.START_X + TREX.WIDTH + DUCK_LEAD_STEPS * (m.speed + 1);
  for (let i = 0; i < scene.count; i++) {
    if (scene.cls[i] !== CLASS_DUCK) continue;
    if (m.x[i] + scene.left[i] < reach && m.x[i] + scene.right[i] > TREX.START_X) return true;
  }
  return false;
}

/** Mirrors game.ts stepPlaying for the parts that matter. Returns the index of the obstacle hit, or -1. */
function modelStep(m: Model, jumpPressed: boolean, jumpHeld: boolean, duckHeld: boolean): number {
  controlTrex(m.trex, jumpPressed, jumpHeld, duckHeld, m.speed);
  moveTrex(m.trex, duckHeld);
  const ducking = m.trex.status === 'ducking';
  let hit = -1;
  for (let i = 0; i < scene.count; i++) {
    m.x[i] -= m.speed + m.v[i];
    if (hit < 0 && hitsObstacle(m.trex.y, ducking, m.x[i], scene.y[i], scene.w[i], scene.h[i], scene.boxes[i])) {
      hit = i;
    }
  }
  m.speed = Math.min(RUNNER.MAX_SPEED, m.speed + RUNNER.ACCELERATION);
  return hit;
}

// ─── Loading ─────────────────────────────────────────────────────────────────────────────

function loadScene(s: GameSnapshot): void {
  scene.count = 0;
  scene.hasPterodactyl = false;
  for (const o of s.obstacles) {
    if (scene.count === MAX_OBSTACLES) break;
    let left = Infinity;
    let right = -Infinity;
    let bottom = Infinity;
    for (const b of o.collisionBoxes) {
      left = Math.min(left, b.x);
      right = Math.max(right, b.x + b.w);
      bottom = Math.min(bottom, o.y + b.y);
    }
    if (o.x + right <= TREX_BACK) continue;
    const i = scene.count++;
    scene.x[i] = o.x;
    scene.y[i] = o.y;
    scene.w[i] = o.width;
    scene.h[i] = o.height;
    scene.left[i] = left;
    scene.right[i] = right;
    scene.cls[i] = bottom >= STAND_TOP ? CLASS_OVERHEAD : bottom >= DUCK_TOP ? CLASS_DUCK : CLASS_JUMP;
    scene.pterodactyl[i] = o.kind === 'pterodactyl' ? 1 : 0;
    scene.boxes[i] = o.collisionBoxes;
    if (o.kind === 'pterodactyl') scene.hasPterodactyl = true;
  }
}

function loadModel(m: Model, s: GameSnapshot, sign: number): void {
  const t = m.trex;
  setStatus(t, s.trex.status === 'ducking' || s.trex.status === 'jumping' ? s.trex.status : 'running');
  t.y = s.trex.y;
  t.vy = s.trex.vy;
  t.speedDrop = s.trex.speedDrop;
  // Not in the snapshot: while rising y only grows, and every jump's apex is above MIN_JUMP_HEIGHT.
  t.reachedMinHeight = s.trex.speedDrop || s.trex.y > TREX.MIN_JUMP_HEIGHT || s.trex.vy <= 0;
  m.speed = s.speed;
  for (let i = 0; i < scene.count; i++) {
    m.x[i] = scene.x[i];
    m.v[i] = scene.pterodactyl[i] ? sign * OBSTACLES.pterodactyl.speedOffset : 0;
  }
}
