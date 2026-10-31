// A small scripted stand-in for src/sim/game.ts so the entities/camera dev page can show
// specific situations (jumps, ducks, pterodactyls, crashes) deterministically. Chrome-like
// physics, simplified spawning, a built-in autopilot that can be switched off to crash.

import { OBSTACLES, RUNNER, SIM, TREX } from '../src/config';
import type { Box, GameEvent, GameSnapshot, InputFrame, ObstacleKind, ObstacleSnapshot } from '../src/types';

export type Scene = 'run' | 'ptero' | 'duck' | 'crash' | 'cacti';

export interface FakeSimOptions {
  scene: Scene;
  speed: number;
  night: number;
  /** Steps after the start with no obstacles. */
  clearSteps: number;
}

export interface FakeSim {
  getSnapshot(): GameSnapshot;
  step(input: InputFrame): GameEvent[];
  autopilot(s: GameSnapshot): InputFrame;
  /** Stop dodging: the T-Rex runs into the next obstacle. */
  autopilotOn: boolean;
  pause(): void;
  resume(): void;
}

const RUN_STEPS = Math.round(TREX.RUN_FRAME_MS / SIM.STEP_MS);
const DUCK_STEPS = Math.round(TREX.DUCK_FRAME_MS / SIM.STEP_MS);
const FLAP_STEPS = Math.round(OBSTACLES.pterodactyl.frameMs / SIM.STEP_MS);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function flipBoxes(src: readonly Box[], height: number): Box[] {
  return src.map((b) => ({ x: b.x, y: height - b.y - b.h, w: b.w, h: b.h }));
}

function obstacleBoxes(kind: ObstacleKind, size: number): Box[] {
  const t = OBSTACLES[kind];
  const boxes = flipBoxes(t.collision, t.height);
  if (size > 1 && boxes.length === 3) {
    boxes[1].w = t.width * size - boxes[0].w - boxes[2].w;
    boxes[2].x = t.width * size - boxes[2].w;
  }
  return boxes;
}

function hits(s: GameSnapshot, o: ObstacleSnapshot): boolean {
  const t = s.trex;
  const ducking = t.status === 'ducking';
  const tb = flipBoxes(ducking ? TREX.COLLISION_DUCKING : TREX.COLLISION_RUNNING, TREX.HEIGHT);
  for (const a of tb)
    for (const b of o.collisionBoxes) {
      const ax = t.x + a.x;
      const ay = t.y + a.y;
      const bx = o.x + b.x;
      const by = o.y + b.y;
      if (ax < bx + b.w && bx < ax + a.w && ay < by + b.h && by < ay + a.h) return true;
    }
  return false;
}

export function createFakeSim(opts: FakeSimOptions): FakeSim {
  const random = rng(7);
  let nextId = 1;
  let runStep = 0;
  let paused = false;
  let crashStep = 0;
  let spawned = 0;
  const s: GameSnapshot = {
    phase: 'title',
    frame: 0,
    runFrames: 0,
    speed: opts.speed,
    distance: 0,
    score: 0,
    highScore: 1234,
    scoreFlash: false,
    canRestart: false,
    night: opts.night,
    moonPhase: 0,
    trex: { x: TREX.START_X, y: 0, width: TREX.WIDTH, height: TREX.HEIGHT, status: 'waiting', frame: 'idle', vy: 0, speedDrop: false },
    obstacles: [],
  };

  function pickKind(): { kind: ObstacleKind; size: number; y: number } {
    const scene = opts.scene;
    const pteroYs = OBSTACLES.pterodactyl.yUp;
    if (scene === 'duck') return { kind: 'pterodactyl', size: 1, y: 25 };
    if (scene === 'ptero') return { kind: 'pterodactyl', size: 1, y: pteroYs[spawned % pteroYs.length] };
    const roll = random();
    if (scene === 'run' && roll < 0.25) return { kind: 'pterodactyl', size: 1, y: pteroYs[Math.floor(random() * 3)] };
    const kind: ObstacleKind = random() < 0.5 ? 'cactusSmall' : 'cactusLarge';
    return { kind, size: 1 + Math.floor(random() * RUNNER.MAX_OBSTACLE_LENGTH), y: 0 };
  }

  function spawn(): void {
    const { kind, size, y } = pickKind();
    const t = OBSTACLES[kind];
    const o: ObstacleSnapshot = {
      id: nextId++,
      kind,
      size,
      variants: Array.from({ length: size }, (_, i) => (kind === 'pterodactyl' ? 0 : (nextId + i) % 3)),
      x: RUNNER.SPAWN_X,
      y,
      width: t.width * size,
      height: t.height,
      frame: 0,
      collisionBoxes: obstacleBoxes(kind, size),
    };
    spawned++;
    s.obstacles.push(o);
  }

  function maybeSpawn(events: GameEvent[]): void {
    if (s.runFrames < opts.clearSteps) return;
    const last = s.obstacles[s.obstacles.length - 1];
    const gap = 260 + s.speed * 28 + random() * 160;
    if (!last || last.x + last.width + gap < RUNNER.SPAWN_X) {
      spawn();
      const o = s.obstacles[s.obstacles.length - 1];
      events.push({ type: 'spawn', id: o.id, kind: o.kind });
    }
  }

  function startJump(events: GameEvent[]): void {
    const t = s.trex;
    t.status = 'jumping';
    t.frame = 'jump';
    t.vy = TREX.INITIAL_JUMP_VELOCITY + s.speed / 10;
    t.speedDrop = false;
    t.width = TREX.WIDTH;
    t.height = TREX.HEIGHT;
    events.push({ type: 'jump' });
  }

  function updateTrex(input: InputFrame, events: GameEvent[]): void {
    const t = s.trex;
    if (t.status === 'jumping') {
      if (input.duckHeld && !t.speedDrop) {
        t.speedDrop = true;
        t.vy = -1;
      }
      t.y += t.vy;
      t.vy -= TREX.GRAVITY * (t.speedDrop ? TREX.SPEED_DROP_COEFFICIENT : 1);
      const endJump = t.y >= TREX.MAX_JUMP_HEIGHT || (!input.jumpHeld && t.y >= TREX.MIN_JUMP_HEIGHT);
      if (endJump && t.vy > TREX.DROP_VELOCITY) t.vy = TREX.DROP_VELOCITY;
      if (t.y <= 0) {
        t.y = 0;
        t.vy = 0;
        t.status = 'running';
        t.frame = 'run1';
        t.speedDrop = false;
        events.push({ type: 'land' });
      }
      return;
    }
    if (input.jumpPressed) return startJump(events);
    const duck = input.duckHeld;
    if (duck && t.status !== 'ducking') events.push({ type: 'duck' });
    t.status = duck ? 'ducking' : 'running';
    t.width = duck ? TREX.WIDTH_DUCK : TREX.WIDTH;
    t.height = duck ? TREX.HEIGHT_DUCK : TREX.HEIGHT;
    t.frame = duck
      ? Math.floor(runStep / DUCK_STEPS) % 2 ? 'duck2' : 'duck1'
      : Math.floor(runStep / RUN_STEPS) % 2 ? 'run2' : 'run1';
  }

  function updateObstacles(events: GameEvent[]): void {
    for (const o of s.obstacles) {
      o.x -= s.speed + (o.kind === 'pterodactyl' ? OBSTACLES.pterodactyl.speedOffset : 0);
      if (o.kind === 'pterodactyl') o.frame = Math.floor(s.frame / FLAP_STEPS) % 2 ? 1 : 0;
    }
    for (let i = s.obstacles.length - 1; i >= 0; i--) {
      const o = s.obstacles[i];
      if (o.x + o.width < RUNNER.DESPAWN_X) {
        s.obstacles.splice(i, 1);
        events.push({ type: 'despawn', id: o.id });
      }
    }
    maybeSpawn(events);
  }

  function restart(events: GameEvent[]): void {
    s.phase = 'playing';
    s.runFrames = 0;
    s.speed = opts.speed;
    s.distance = 0;
    s.obstacles.length = 0;
    s.trex = { x: TREX.START_X, y: 0, width: TREX.WIDTH, height: TREX.HEIGHT, status: 'running', frame: 'run1', vy: 0, speedDrop: false };
    events.push({ type: 'restart' });
  }

  function stepPlaying(input: InputFrame, events: GameEvent[]): void {
    s.runFrames++;
    runStep++;
    s.speed = Math.min(RUNNER.MAX_SPEED, s.speed + RUNNER.ACCELERATION);
    s.distance += s.speed;
    s.score = Math.round(s.distance * 0.025);
    updateTrex(input, events);
    updateObstacles(events);
    for (const o of s.obstacles) {
      if (!hits(s, o)) continue;
      s.phase = 'crashed';
      s.trex.status = 'crashed';
      s.trex.frame = 'crashed';
      s.trex.width = TREX.WIDTH;
      s.trex.height = TREX.HEIGHT;
      crashStep = s.frame;
      events.push({ type: 'crash', score: s.score, newHighScore: false });
      break;
    }
  }

  const sim: FakeSim = {
    autopilotOn: opts.scene !== 'crash',

    getSnapshot: () => structuredClone(s),

    step(input) {
      const events: GameEvent[] = [];
      if (paused) return events;
      s.frame++;
      if (s.phase === 'title') {
        s.trex.frame = s.frame % 240 < 20 ? 'blink' : 'idle';
        if (input.jumpPressed) {
          s.phase = 'playing';
          events.push({ type: 'start' });
          startJump(events);
        }
      } else if (s.phase === 'playing') {
        stepPlaying(input, events);
      } else if (s.phase === 'crashed') {
        s.canRestart = s.frame - crashStep > RUNNER.GAMEOVER_CLEAR_TIME / SIM.STEP_MS;
        if (s.canRestart && (input.jumpPressed || input.restartPressed)) restart(events);
      }
      return events;
    },

    autopilot(snap) {
      const idle: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
      if (snap.phase !== 'playing' || !sim.autopilotOn) return idle;
      const t = snap.trex;
      const next = snap.obstacles.find((o) => o.x + o.width > t.x);
      if (!next) return idle;
      const gap = next.x - (t.x + TREX.WIDTH);
      if (next.kind === 'pterodactyl' && next.y >= 50) return idle;
      if (next.kind === 'pterodactyl' && next.y >= 25) return { ...idle, duckHeld: gap < snap.speed * 14 && gap > -next.width };
      const lead = snap.speed * 7 + next.width * 0.3;
      if (t.status !== 'jumping' && gap < lead && gap > 0) return { ...idle, jumpPressed: true, jumpHeld: true };
      return { ...idle, jumpHeld: t.status === 'jumping' };
    },

    pause() {
      if (s.phase === 'playing') {
        paused = true;
        s.phase = 'paused';
      }
    },

    resume() {
      if (paused) {
        paused = false;
        s.phase = 'playing';
      }
    },
  };
  return sim;
}
