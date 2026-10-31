// Dev harness for src/render/entities.ts + src/render/camera.ts.
// Query params: ?cam=cinematic|side|chase  ?debug=1  ?phase=title  ?scene=run|ptero|duck|crash|cacti
//               ?speed=6  ?night=0..1  ?sim=real (use src/sim if present)  ?warp=<steps>
// Keys: Space/Up jump (starts), Down duck, C camera, D debug, P pause, Enter restart.

import * as THREE from 'three';
import { PALETTE, SIM } from '../src/config';
import { createCameraRig } from '../src/render/camera';
import { framing, MODES } from '../src/render/camera-framing';
import { createEntities } from '../src/render/entities';
import type { CameraMode, GameEvent, GameSnapshot, InputFrame, ModelLibrary } from '../src/types';
import { CAMERA_MODES } from '../src/types';
import { createFakeSim, type Scene } from './entities-fakesim';
import { createStubModels } from './entities-stub';

interface SimLike {
  getSnapshot(): GameSnapshot;
  step(input: InputFrame): GameEvent[];
  pause(): void;
  resume(): void;
}

const params = new URLSearchParams(location.search);
const cam = (params.get('cam') ?? 'cinematic') as CameraMode;
const scene = (params.get('scene') ?? 'run') as Scene;
const holdTitle = params.get('phase') === 'title';

async function loadModels(): Promise<{ models: ModelLibrary; real: boolean }> {
  const mods = import.meta.glob<{ createModelLibrary: () => ModelLibrary }>('../src/render/models.ts');
  const load = mods['../src/render/models.ts'];
  if (load && params.get('models') !== 'stub') {
    try {
      return { models: (await load()).createModelLibrary(), real: true };
    } catch (err) {
      console.warn('models.ts failed, using stub', err);
    }
  }
  return { models: createStubModels(), real: false };
}

async function loadSim(): Promise<{ sim: SimLike; autopilot: (s: GameSnapshot) => InputFrame; fake: ReturnType<typeof createFakeSim> | null }> {
  if (params.get('sim') === 'real') {
    const game = import.meta.glob<{ createGameSim: () => SimLike }>('../src/sim/game.ts');
    const bot = import.meta.glob<{ autopilot: (s: GameSnapshot) => InputFrame }>('../src/sim/autopilot.ts');
    const g = game['../src/sim/game.ts'];
    const b = bot['../src/sim/autopilot.ts'];
    if (g && b) {
      const sim = (await g()).createGameSim();
      return { sim, autopilot: (await b()).autopilot, fake: null };
    }
    console.warn('src/sim not available, using the fake sim');
  }
  const fake = createFakeSim({
    scene,
    speed: Number(params.get('speed') ?? 6),
    night: Number(params.get('night') ?? 0),
    clearSteps: Number(params.get('clear') ?? 90),
  });
  return { sim: fake, autopilot: (s) => fake.autopilot(s), fake };
}

function setupScene(): { renderer: THREE.WebGLRenderer; scene3d: THREE.Scene; sun: THREE.DirectionalLight } {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene3d = new THREE.Scene();
  scene3d.background = new THREE.Color(PALETTE.day.bg);
  scene3d.add(new THREE.HemisphereLight('#ffffff', '#9c9c9c', 2.4));
  const sun = new THREE.DirectionalLight('#ffffff', 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -500;
  sc.right = 700;
  sc.top = 400;
  sc.bottom = -300;
  sc.near = 10;
  sc.far = 1200;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene3d.add(sun, sun.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 4000), new THREE.MeshLambertMaterial({ color: '#c9c9c9' }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.x = 1000;
  ground.receiveShadow = true;
  scene3d.add(ground);
  // Chrome's horizon line, as a reference strip behind the lane.
  const line = new THREE.Mesh(new THREE.BoxGeometry(8000, 0.4, 1), new THREE.MeshLambertMaterial({ color: PALETTE.day.ink }));
  line.position.set(1000, 0.2, -16);
  scene3d.add(line);
  return { renderer, scene3d, sun };
}

/** ?frame=tx,ty,yawDeg,pitchDeg,size,fov overrides the chosen mode's base framing (tuning aid). */
function applyFrameOverride(): void {
  const f = params.get('frame')?.split(',').map(Number);
  if (f?.length === 6) MODES[CAMERA_MODES.includes(cam) ? cam : 'cinematic'].base.set(framing(f[0], f[1], f[2], f[3], f[4], f[5]));
}

async function main(): Promise<void> {
  applyFrameOverride();
  const { renderer, scene3d, sun } = setupScene();
  const { models, real } = await loadModels();
  const { sim, autopilot, fake } = await loadSim();
  const entities = createEntities(scene3d, models);
  const rig = createCameraRig(CAMERA_MODES.includes(cam) ? cam : 'cinematic');
  let debug = params.get('debug') === '1';
  entities.setDebug(debug);

  const resize = (): void => {
    renderer.setSize(innerWidth, innerHeight);
    rig.resize(innerWidth, innerHeight);
  };
  addEventListener('resize', resize);
  resize();

  const keys = { jump: false, jumpEdge: false, duck: false, restart: false };
  let startRequested = !holdTitle;
  let hold = false;
  let prev = sim.getSnapshot();
  let curr = prev;
  const frameEvents: GameEvent[] = [];

  function input(): InputFrame {
    const bot = autopilot(curr);
    const frame: InputFrame = {
      jumpPressed: bot.jumpPressed || keys.jumpEdge || (curr.phase === 'title' && startRequested),
      jumpHeld: bot.jumpHeld || keys.jump,
      duckHeld: bot.duckHeld || keys.duck,
      restartPressed: keys.restart,
    };
    keys.jumpEdge = keys.restart = false;
    return frame;
  }

  function step(): void {
    const events = sim.step(input());
    prev = curr;
    curr = sim.getSnapshot();
    frameEvents.push(...events);
  }

  function present(alpha: number, dtMs: number): void {
    entities.handleEvents(frameEvents);
    rig.handleEvents(frameEvents);
    frameEvents.length = 0;
    entities.update(prev, curr, alpha, dtMs);
    rig.update(curr, entities.trex, dtMs);
    const p = entities.trex.position;
    sun.target.position.set(p.x + 170, 0, 0);
    sun.position.set(p.x + 170 - 150, 300, 220);
  }

  const warp = Number(params.get('warp') ?? 0);
  for (let i = 0; i < warp; i++) {
    step();
    present(1, SIM.STEP_MS);
  }

  let acc = 0;
  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min(250, now - last);
    last = now;
    if (!hold) {
      acc += dt;
      let n = 0;
      while (acc >= SIM.STEP_MS && n++ < SIM.MAX_STEPS_PER_FRAME) {
        step();
        acc -= SIM.STEP_MS;
      }
      if (n > SIM.MAX_STEPS_PER_FRAME) acc = 0;
    }
    present(hold ? 1 : acc / SIM.STEP_MS, dt);
    renderer.render(scene3d, rig.camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      if (!keys.jump) keys.jumpEdge = true;
      keys.jump = true;
      startRequested = true;
    } else if (e.code === 'ArrowDown') keys.duck = true;
    else if (e.code === 'Enter') keys.restart = true;
    else if (e.code === 'KeyC') rig.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(rig.mode) + 1) % CAMERA_MODES.length]);
    else if (e.code === 'KeyD' || e.code === 'Backquote') entities.setDebug((debug = !debug));
    else if (e.code === 'KeyP') (curr.phase === 'paused' ? sim.resume() : sim.pause());
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') keys.jump = false;
    else if (e.code === 'ArrowDown') keys.duck = false;
  });

  /** Fast-forward (stepping + updating, no rendering) until `pred` holds; then optionally freeze the sim. */
  function until(pred: (s: GameSnapshot) => boolean, max = 6000, freeze = true): boolean {
    for (let i = 0; i < max; i++) {
      if (pred(curr)) {
        hold = freeze;
        return true;
      }
      step();
      present(1, SIM.STEP_MS);
    }
    return false;
  }

  Object.assign(window, {
    __dev: {
      real,
      start: () => (startRequested = true),
      setMode: (m: CameraMode) => rig.setMode(m),
      crash: () => fake && (fake.autopilotOn = false),
      restart: () => (keys.restart = true),
      hold: (on: boolean) => (hold = on),
      until,
      snapshot: () => curr,
      camera: () => ({ pos: rig.camera.position.toArray(), fov: rig.camera.fov, mode: rig.mode }),
    },
  });
}

void main();
