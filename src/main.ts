import './style.css';
import * as THREE from 'three';
import { createSfx } from './audio/sfx';
import { PALETTE, SIM, STORAGE_KEYS } from './config';
import { createInput } from './input/input';
import { createCameraRig } from './render/camera';
import { createEntities } from './render/entities';
import { createModelLibrary } from './render/models';
import { createWorld } from './render/world';
import { api, ApiError } from './net/api';
import { createRanked } from './net/ranked';
import { autopilot } from './sim/autopilot';
import { createGameSim } from './sim/game';
import { createInputCursor, createRunSim } from './sim/replay';
import { mulberry32 } from './sim/rng';
import {
  CAMERA_MODES,
  type BoardView,
  type CameraMode,
  type GameEvent,
  type GameSim,
  type GameSnapshot,
  type HudContext,
  type InputFrame,
  type UiAction,
} from './types';
import { createHud } from './ui/hud';

/** A single rendered frame never feeds more than this much time to the accumulator. */
const MAX_FRAME_MS = 250;
/** Weight of the newest frame in the smoothed FPS meter. */
const FPS_SMOOTHING = 0.05;
/** How long the light <-> dark theme cross-fade takes. */
const THEME_FADE_MS = 600;
const NO_INPUT: InputFrame = Object.freeze({ jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false });

const params = new URLSearchParams(location.search);

function isCameraMode(value: string | null): value is CameraMode {
  return value !== null && (CAMERA_MODES as readonly string[]).includes(value);
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / disabled storage: settings just don't persist.
  }
}

function initialCameraMode(): CameraMode {
  const fromQuery = params.get('cam');
  if (isCameraMode(fromQuery)) return fromQuery;
  const stored = readStorage(STORAGE_KEYS.cameraMode);
  return isCameraMode(stored) ? stored : 'cinematic';
}

/** ?theme=dark|light, else the saved choice, else the OS preference. */
function initialDark(): boolean {
  const choice = params.get('theme') ?? readStorage(STORAGE_KEYS.theme);
  if (choice === 'dark' || choice === 'light') return choice === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Dark mode starts from Chrome's inverted palette, so the sim's night cycle flips it back to
 * light: the shown night is `night XOR dark`, blended smoothly for the fades in between.
 */
function themedNight(night: number, dark: number): number {
  return night + dark - 2 * night * dark;
}

/** Page chrome (behind the canvas, the mobile browser bar) follows the theme. */
function applyPageTheme(dark: boolean): void {
  const bg = dark ? PALETTE.night.bg : PALETTE.day.bg;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.style.background = bg;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

function createRenderer(app: HTMLElement, hudRoot: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  app.insertBefore(renderer.domElement, hudRoot);
  return renderer;
}

function main(): void {
  const app = document.getElementById('app') as HTMLElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;
  const renderer = createRenderer(app, hudRoot);
  const scene = new THREE.Scene();
  const models = createModelLibrary();
  const world = createWorld(scene, renderer);
  const entities = createEntities(scene, models);
  const rig = createCameraRig(initialCameraMode());
  const hud = createHud(hudRoot);
  const sfx = createSfx();
  const input = createInput();

  const seed = params.get('seed');
  const mobile = window.matchMedia('(pointer: coarse)').matches;
  let sim: GameSim = createGameSim({
    random: seed !== null && Number.isFinite(Number(seed)) ? mulberry32(Number(seed)) : undefined,
    highScore: Number(readStorage(STORAGE_KEYS.highScore)) || 0,
    mobile,
  });

  let autoplay = params.get('autoplay') === '1';
  /** ?replay=<run id>: plays a stored leaderboard run back (src/sim/replay.ts). */
  const replayId = params.get('replay');
  let replay: { next(): InputFrame; left: number } | null = null;
  /** What the replay shows in place of the leaderboard's lines, once it has loaded (or failed). */
  let replayLabel: Pick<BoardView, 'note' | 'live'> | null = replayId ? { note: 'LOADING REPLAY', live: '' } : null;
  let board: BoardView | null = null;
  let debug = params.get('debug') === '1';
  /** Test hook: stop real-time stepping while rendering continues (the camera still settles). */
  let frozen = false;
  /** True when we paused because the tab was hidden; only then does visibility resume. */
  let autoPaused = false;
  let fps = 60;
  let acc = 0;
  let last = performance.now();
  let prev: GameSnapshot = sim.getSnapshot();
  let curr: GameSnapshot = prev;
  const frameEvents: GameEvent[] = [];
  let dark = initialDark();
  /** 0 = light, 1 = dark; eases toward `dark` so a toggle cross-fades instead of snapping. */
  let darkBlend = dark ? 1 : 0;
  /** What the renderers and HUD see: the sim snapshots with `night` remapped for the theme. */
  const shownPrev: GameSnapshot = { ...curr };
  const shownCurr: GameSnapshot = { ...curr };
  const hudCtx: HudContext = { cameraMode: rig.mode, muted: sfx.muted, dark, touch: input.touch, fps: null };
  applyPageTheme(dark);
  entities.setDebug(debug);

  function resize(): void {
    renderer.setSize(window.innerWidth, window.innerHeight);
    rig.resize(window.innerWidth, window.innerHeight);
  }

  function setCameraMode(mode: CameraMode): void {
    rig.setMode(mode);
    writeStorage(STORAGE_KEYS.cameraMode, mode);
  }

  function toggleTheme(): void {
    dark = !dark;
    writeStorage(STORAGE_KEYS.theme, dark ? 'dark' : 'light');
    applyPageTheme(dark);
  }

  function showBoard(): void {
    if (board) hud.setBoard(replayLabel ? { ...board, ...replayLabel } : board);
  }

  const ranked = createRanked({
    sim: () => sim,
    mobile,
    blocker: () => (replayId ? 'REPLAY' : autoplay ? 'AUTOPILOT' : seed !== null ? 'FIXED SEED' : debug ? 'DEBUG VIEW' : null),
    onView: (view) => {
      board = view;
      showBoard();
    },
  });

  function loadReplay(id: string): void {
    api
      .run(id)
      .then((run) => {
        sim = createRunSim(run);
        const cursor = createInputCursor(run.inputs);
        replay = { next: () => cursor.next(), left: run.steps };
        curr = prev = sim.getSnapshot();
        replayLabel = { note: `REPLAY · ${run.name} · ${run.score ?? 0}`, live: `REPLAY · ${run.name}` };
        showBoard();
      })
      .catch((err: unknown) => {
        replayLabel = { note: err instanceof ApiError && err.status === 401 ? 'SIGN IN TO WATCH REPLAYS' : 'REPLAY NOT FOUND', live: '' };
        showBoard();
      });
  }

  function togglePause(): void {
    if (curr.phase === 'playing') {
      sim.pause();
      ranked.paused();
    } else if (curr.phase === 'paused') {
      sim.resume();
      ranked.resumed();
    } else return;
    autoPaused = false;
    curr = prev = sim.getSnapshot();
  }

  function onAction(action: UiAction): void {
    switch (action) {
      case 'toggleCamera':
        setCameraMode(CAMERA_MODES[(CAMERA_MODES.indexOf(rig.mode) + 1) % CAMERA_MODES.length]);
        break;
      case 'toggleMute':
        sfx.setMuted(!sfx.muted);
        break;
      case 'toggleTheme':
        toggleTheme();
        break;
      case 'togglePause':
        togglePause();
        break;
      case 'toggleDebug':
        debug = !debug;
        entities.setDebug(debug);
        if (debug) ranked.forfeit('DEBUG VIEW');
        break;
      case 'signIn':
        location.href = api.loginUrl(location.pathname + location.search);
        break;
    }
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (curr.phase !== 'playing') return;
      sim.pause();
      ranked.paused();
      autoPaused = true;
    } else if (autoPaused) {
      sim.resume();
      ranked.resumed();
      autoPaused = false;
    } else return;
    curr = prev = sim.getSnapshot();
    acc = 0;
  }

  function collect(events: readonly GameEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      frameEvents.push(e);
      if (e.type === 'jump') sfx.play('jump');
      else if (e.type === 'milestone') sfx.play('milestone');
      else if (e.type === 'crash') {
        sfx.play('crash');
        if (!replay) writeStorage(STORAGE_KEYS.highScore, String(curr.highScore));
      }
    }
  }

  function nextInput(manual: InputFrame | null): InputFrame {
    if (replay && replay.left > 0) {
      replay.left--;
      input.sample(); // drop the player's presses while the replay plays
      return replay.next();
    }
    if (replayLabel?.note === 'LOADING REPLAY') return NO_INPUT;
    return autoplay ? autopilot(curr) : (manual ?? input.sample());
  }

  function step(manual: InputFrame | null): void {
    const frame = nextInput(manual);
    const advances = curr.phase !== 'paused';
    const events = sim.step(frame);
    if (advances) ranked.stepped(frame, events);
    prev = curr;
    curr = sim.getSnapshot();
    collect(events);
  }

  /** While paused nothing steps; P / Escape (UiAction) or a tap / Space resumes. */
  function pollPaused(): void {
    const frame = input.sample();
    if (frame.jumpPressed || frame.restartPressed) togglePause();
  }

  function dispatch(): void {
    if (frameEvents.length === 0) return;
    world.handleEvents(frameEvents);
    entities.handleEvents(frameEvents);
    rig.handleEvents(frameEvents);
    hud.handleEvents(frameEvents);
    frameEvents.length = 0;
  }

  function present(alpha: number, dtMs: number): void {
    dispatch();
    const target = dark ? 1 : 0;
    darkBlend += Math.sign(target - darkBlend) * Math.min(Math.abs(target - darkBlend), dtMs / THEME_FADE_MS);
    Object.assign(shownPrev, prev).night = themedNight(prev.night, darkBlend);
    Object.assign(shownCurr, curr).night = themedNight(curr.night, darkBlend);
    models.setNight(shownCurr.night);
    world.update(shownPrev, shownCurr, alpha, dtMs);
    entities.update(shownPrev, shownCurr, alpha, dtMs);
    rig.update(shownCurr, entities.trex, dtMs);
    hudCtx.cameraMode = rig.mode;
    hudCtx.muted = sfx.muted;
    hudCtx.dark = dark;
    hudCtx.touch = input.touch;
    hudCtx.fps = debug ? fps : null;
    hud.update(shownCurr, hudCtx);
    renderer.render(scene, rig.camera);
  }

  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
    last = now;
    if (dt > 0) fps += (1000 / dt - fps) * FPS_SMOOTHING;
    if (frozen) acc = 0;
    else if (curr.phase === 'paused') {
      acc = 0;
      pollPaused();
    } else {
      acc += dt;
      let steps = 0;
      while (acc >= SIM.STEP_MS && steps < SIM.MAX_STEPS_PER_FRAME) {
        step(null);
        acc -= SIM.STEP_MS;
        steps++;
      }
      if (acc >= SIM.STEP_MS) acc = 0;
    }
    present(frozen ? 1 : acc / SIM.STEP_MS, dt);
  }

  function advance(n: number, manual?: InputFrame): GameSnapshot {
    for (let i = 0; i < n; i++) step(manual ?? NO_INPUT);
    acc = 0;
    present(1, SIM.STEP_MS);
    return curr;
  }

  input.onAction(onAction);
  hud.onAction(onAction);
  const unlock = (): void => sfx.unlock();
  window.addEventListener('keydown', unlock, { once: true, capture: true });
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', resize);
  resize();

  Object.assign(window, {
    __dino: {
      getSnapshot: () => sim.getSnapshot(),
      advance,
      setAutoplay: (on: boolean) => {
        autoplay = on;
        if (on) ranked.forfeit('AUTOPILOT');
      },
      setCameraMode,
      setDark: (on: boolean) => on !== dark && toggleTheme(),
      freeze: (on: boolean) => (frozen = on),
      get info() {
        return { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, geometries: renderer.info.memory.geometries };
      },
      get fps() {
        return fps;
      },
    },
  });

  if (replayId) loadReplay(replayId);
  present(0, 0);
  requestAnimationFrame(frame);
}

/** Offline support (production builds only; a service worker would fight Vite's dev server). */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err: unknown) => console.warn('Service worker registration failed', err));
  });
}

main();
registerServiceWorker();
