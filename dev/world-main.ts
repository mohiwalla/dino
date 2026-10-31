// Dev harness for src/render/world.ts: a fake snapshot driver, the reference cameras and
// placeholder T-Rex / cacti so scale, shadows and fog can be judged.
//
// Query params:
//   view=cinematic|side|chase   camera framing (default cinematic)
//   night=0..1                  night amount (default 0); cycle=1 animates day <-> night
//   moon=0..6                   moon phase
//   dist=N                      starting distance
//   speed=N                     starting speed (accelerates to 13 like Chrome); static=1 freezes
//   cam=x,y,z&look=x,y,z&fov=N  custom camera
//   placeholders=0              hide the T-Rex / cacti
// window.__dev exposes setDistance / setNight / setPhase / setView for screenshot scripts.

import * as THREE from 'three';
import { PALETTE, RUNNER, SIM } from '../src/config';
import type { GameSnapshot } from '../src/types';
import { VoxelGrid, buildVoxelGeometry } from '../src/render/voxel';
import { createWorld } from '../src/render/world';

const params = new URLSearchParams(location.search);
const num = (key: string, def: number) => (params.has(key) ? Number(params.get(key)) : def);
const vec = (key: string) => params.get(key)?.split(',').map(Number) as Vec | undefined;

type Vec = [number, number, number];
type View = 'cinematic' | 'side' | 'chase';
const VIEWS: Record<View, { fov: number; pos: Vec; look: Vec }> = {
  cinematic: { fov: 40, pos: [-70, 95, 300], look: [170, 20, 0] },
  side: { fov: 14, pos: [230, 45, 1150], look: [230, 45, 0] },
  chase: { fov: 58, pos: [-120, 70, 0], look: [260, 25, 0] },
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1, 8000);

function setView(view: View): void {
  const v = VIEWS[view] ?? VIEWS.cinematic;
  const pos = vec('cam') ?? v.pos;
  const look = vec('look') ?? v.look;
  camera.fov = num('fov', v.fov);
  camera.position.set(...pos);
  camera.lookAt(...look);
  camera.updateProjectionMatrix();
}
setView((params.get('view') ?? 'cinematic') as View);

const world = createWorld(scene, renderer);

// ─── Placeholders ──────────────────────────────────────────────────────────────────────────

const inkMat = new THREE.MeshLambertMaterial({ color: PALETTE.day.ink, vertexColors: true });
const inkDay = new THREE.Color(PALETTE.day.ink);
const inkNight = new THREE.Color(PALETTE.night.ink);

function dinoGeometry(): THREE.BufferGeometry {
  const g = new VoxelGrid(44, 47, 16);
  g.fillBox(22, 31, 3, 44, 47, 13, 1); // head
  g.fillBox(22, 27, 4, 36, 31, 12, 1); // jaw
  g.fillBox(26, 41, 3, 28, 43, 13, 0); // eye
  g.fillBox(10, 12, 2, 30, 33, 14, 1); // body
  g.fillBox(30, 20, 5, 35, 23, 11, 1); // arm
  g.fillBox(0, 18, 5, 10, 28, 11, 1); // tail
  g.fillBox(0, 26, 6, 3, 34, 10, 1); // tail tip
  g.fillBox(12, 0, 3, 16, 12, 7, 1); // leg
  g.fillBox(22, 0, 9, 26, 12, 13, 1); // leg
  g.fillBox(16, 0, 3, 19, 2, 7, 1); // foot
  g.fillBox(26, 0, 9, 29, 2, 13, 1); // foot
  return buildVoxelGeometry(g);
}

function cactusGeometry(w: number, h: number): THREE.BufferGeometry {
  const g = new VoxelGrid(w, h, 9);
  const t0 = Math.floor(w * 0.36);
  const t1 = Math.ceil(w * 0.64);
  g.fillBox(t0, 0, 1, t1, h, 8, 1);
  const a = Math.floor(h * 0.3);
  g.fillBox(0, a, 3, 4, Math.floor(h * 0.75), 6, 1);
  g.fillBox(4, a, 3, t0, a + 3, 6, 1);
  const b = Math.floor(h * 0.42);
  g.fillBox(w - 4, b, 3, w, Math.floor(h * 0.85), 6, 1);
  g.fillBox(t1, b, 3, w - 4, b + 3, 6, 1);
  return buildVoxelGeometry(g);
}

const placeholders = new THREE.Group();
placeholders.visible = params.get('placeholders') !== '0';
scene.add(placeholders);
const trex = new THREE.Mesh(dinoGeometry(), inkMat);
trex.castShadow = trex.receiveShadow = true;
placeholders.add(trex);

const smallGeo = cactusGeometry(17, 35);
const largeGeo = cactusGeometry(25, 50);
const cacti = [
  { at: 260, n: 1, geo: smallGeo, w: 17 },
  { at: 640, n: 2, geo: largeGeo, w: 25 },
  { at: 980, n: 3, geo: smallGeo, w: 17 },
  { at: 1250, n: 1, geo: largeGeo, w: 25 },
].map((c) => {
  const group = new THREE.Group();
  for (let i = 0; i < c.n; i++) {
    const m = new THREE.Mesh(c.geo, inkMat);
    m.castShadow = m.receiveShadow = true;
    m.position.x = i * c.w;
    group.add(m);
  }
  placeholders.add(group);
  return { ...c, group };
});
const WRAP = RUNNER.SPAWN_X - RUNNER.DESPAWN_X;

// ─── Fake sim ──────────────────────────────────────────────────────────────────────────────

function snapshot(): GameSnapshot {
  return {
    phase: 'playing',
    frame: 0,
    runFrames: 0,
    speed: 0,
    distance: 0,
    score: 0,
    highScore: 0,
    scoreFlash: false,
    canRestart: false,
    night: 0,
    moonPhase: 3,
    trex: { x: 0, y: 0, width: 44, height: 47, status: 'running', frame: 'run1', vy: 0, speedDrop: false },
    obstacles: [],
  };
}

const prev = snapshot();
const curr = snapshot();
curr.distance = prev.distance = num('dist', 0);
curr.speed = num('speed', 6);
curr.night = prev.night = num('night', 0);
curr.moonPhase = prev.moonPhase = num('moon', 3);
let running = params.get('static') !== '1';
const cycle = params.get('cycle') === '1';

function step(): void {
  Object.assign(prev, { distance: curr.distance, night: curr.night, frame: curr.frame });
  curr.frame++;
  if (running) {
    curr.speed = Math.min(RUNNER.MAX_SPEED, curr.speed + RUNNER.ACCELERATION);
    curr.distance += curr.speed;
  }
  if (cycle) curr.night = 0.5 - 0.5 * Math.cos((curr.frame / 600) * Math.PI);
}

function placeCacti(distance: number): void {
  for (const c of cacti) {
    const x = RUNNER.DESPAWN_X + ((((c.at - distance - RUNNER.DESPAWN_X) % WRAP) + WRAP) % WRAP);
    c.group.position.x = x;
  }
}

declare global {
  interface Window {
    __dev: {
      setDistance(d: number): void;
      setNight(n: number): void;
      setPhase(p: number): void;
      setView(v: View): void;
      freeze(on: boolean): void;
      info(): Record<string, number>;
      counts(): Record<string, number>;
      sample(points: [number, number][]): string[];
    };
  }
}

window.__dev = {
  setDistance(d) {
    prev.distance = curr.distance = d;
  },
  setNight(n) {
    prev.night = curr.night = n;
  },
  setPhase(p) {
    prev.moonPhase = curr.moonPhase = p;
  },
  setView,
  freeze(on) {
    running = !on;
  },
  sample(points) {
    // Render now and read back before the buffer is presented. Points are CSS px from top-left.
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const dpr = renderer.getPixelRatio();
    return points.map(([x, y]) => {
      gl.readPixels(Math.round(x * dpr), Math.round(gl.drawingBufferHeight - y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    });
  },
  counts() {
    const out: Record<string, number> = {};
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) out[o.name] = o.count;
    });
    return out;
  },
  info() {
    const fog = scene.fog as THREE.Fog;
    return { distance: curr.distance, night: curr.night, fogNear: fog.near, fogFar: fog.far, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  },
};

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const info = document.getElementById('info')!;
let acc = 0;
let last = performance.now();
let frames = 0;
let fpsT = last;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(250, now - last);
  last = now;
  acc += dt;
  let steps = 0;
  while (acc >= SIM.STEP_MS && steps < SIM.MAX_STEPS_PER_FRAME) {
    step();
    acc -= SIM.STEP_MS;
    steps++;
  }
  if (steps === SIM.MAX_STEPS_PER_FRAME) acc = 0;
  const alpha = acc / SIM.STEP_MS;
  world.update(prev, curr, alpha, dt);
  const d = curr.distance < prev.distance ? curr.distance : prev.distance + (curr.distance - prev.distance) * alpha;
  placeCacti(d);
  const n = prev.night + (curr.night - prev.night) * alpha;
  inkMat.color.lerpColors(inkDay, inkNight, n);
  renderer.render(scene, camera);
  frames++;
  if (now - fpsT > 1000) {
    info.textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps  d=${Math.round(curr.distance)}  calls=${renderer.info.render.calls}`;
    frames = 0;
    fpsT = now;
  }
});
