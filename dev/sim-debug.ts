// Side-view debug render of the sim driven by the autopilot: fine collision boxes, the T-Rex's
// recent trajectory (in ground space, so arcs line up with the obstacles they cleared), HUD values.
// URL params: ?seed=1&warm=0&mobile=1&paused=1. window.simDebug.advance(n) steps n frames.

import { autopilot } from '../src/sim/autopilot';
import { TREX_DUCKING_BOXES, TREX_RUNNING_BOXES } from '../src/sim/collision';
import { createGameSim } from '../src/sim/game';
import { mulberry32 } from '../src/sim/rng';
import type { GameEvent, GameSnapshot } from '../src/types';

const params = new URLSearchParams(location.search);
const sim = createGameSim({ random: mulberry32(Number(params.get('seed') ?? 1)), mobile: params.has('mobile') });
const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

const SCALE = 1.25;
const ORIGIN_X = 290;
const GROUND_Y = 560;
const TRAIL = 400;
const trail: { distance: number; y: number }[] = [];
const log: string[] = [];

function sx(x: number): number {
  return ORIGIN_X + x * SCALE;
}

function sy(y: number): number {
  return GROUND_Y - y * SCALE;
}

function box(x: number, y: number, w: number, h: number): void {
  ctx.strokeRect(sx(x), sy(y + h), w * SCALE, h * SCALE);
}

function advance(n: number): void {
  for (let i = 0; i < n; i++) {
    const s = sim.getSnapshot();
    record(sim.step(autopilot(s)), s);
    const after = sim.getSnapshot();
    trail.push({ distance: after.distance, y: after.trex.y });
    if (trail.length > TRAIL) trail.shift();
  }
}

function record(events: GameEvent[], s: GameSnapshot): void {
  for (const e of events) {
    if (e.type === 'spawn' || e.type === 'despawn' || e.type === 'jump' || e.type === 'land') continue;
    log.push(`${s.frame} ${JSON.stringify(e)}`);
    if (log.length > 8) log.shift();
  }
}

function draw(): void {
  const s = sim.getSnapshot();
  const night = s.night;
  const shade = Math.round(247 - night * 239);
  ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const ink = night > 0.5 ? '#acacac' : '#535353';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(0, sy(0) + 0.5);
  ctx.lineTo(canvas.width, sy(0) + 0.5);
  ctx.stroke();
  // Ground ticks every 50 px of ground, scrolling with distance (obstacles must stay glued to them).
  for (let gx = -Math.ceil((ORIGIN_X / SCALE + s.distance) / 50) * 50; sx(gx - s.distance) < canvas.width; gx += 50) {
    const x = sx(gx + Math.floor(s.distance / 50) * 50 - s.distance);
    ctx.fillRect(x, sy(0) + 4, 1, 4);
  }

  ctx.setLineDash([4, 4]);
  for (const y of [30, 63]) {
    ctx.beginPath();
    ctx.moveTo(0, sy(y));
    ctx.lineTo(160, sy(y));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.beginPath();
  trail.forEach((p, i) => {
    const x = sx(p.distance - s.distance + 22);
    if (i === 0) ctx.moveTo(x, sy(p.y));
    else ctx.lineTo(x, sy(p.y));
  });
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const o of s.obstacles) {
    ctx.globalAlpha = 0.25;
    box(o.x, o.y, o.width, o.height);
    ctx.globalAlpha = 1;
    for (const b of o.collisionBoxes) box(o.x + b.x, o.y + b.y, b.w, b.h);
    ctx.fillText(`${o.kind} x${o.size} #${o.id} f${o.frame}`, sx(o.x), sy(o.y + o.height) - 6);
  }

  const t = s.trex;
  ctx.globalAlpha = 0.25;
  box(t.x, t.y, t.width, t.height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = s.phase === 'crashed' ? '#d33' : ink;
  for (const b of t.status === 'ducking' ? TREX_DUCKING_BOXES : TREX_RUNNING_BOXES) box(t.x + b.x, t.y + b.y, b.w, b.h);

  ctx.fillStyle = ink;
  ctx.font = '13px monospace';
  const lines = [
    `phase ${s.phase}  frame ${s.frame}  run ${s.runFrames}  canRestart ${s.canRestart}`,
    `speed ${s.speed.toFixed(3)}  distance ${s.distance.toFixed(1)}  score ${String(s.score).padStart(5, '0')}${s.scoreFlash ? ' (hidden)' : ''}  hi ${s.highScore}`,
    `night ${s.night.toFixed(2)}  moon ${s.moonPhase}`,
    `trex ${t.status} ${t.frame} y ${t.y.toFixed(1)} vy ${t.vy.toFixed(2)} drop ${t.speedDrop}`,
    ...log,
  ];
  lines.forEach((l, i) => ctx.fillText(l, 16, 24 + i * 17));
}

let last = performance.now();
let acc = 0;
function frame(now: number): void {
  if (!params.has('paused')) {
    acc = Math.min(acc + now - last, 100);
    while (acc >= 1000 / 60) {
      advance(1);
      acc -= 1000 / 60;
    }
  }
  last = now;
  draw();
  requestAnimationFrame(frame);
}

advance(Number(params.get('warm') ?? 0));
requestAnimationFrame(frame);

declare global {
  interface Window {
    simDebug: { advance(n: number): void; snapshot(): GameSnapshot };
  }
}
window.simDebug = {
  advance: (n: number) => {
    advance(n);
    draw();
  },
  snapshot: () => sim.getSnapshot(),
};
