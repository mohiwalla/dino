import './style.css';
import * as THREE from 'three';
import { createSfx } from './audio/sfx';
import { MULTIPLIERS, PALETTE, SIM, STORAGE_KEYS } from './config';
import { createInput } from './input/input';
import { createCameraRig } from './render/camera';
import { createEntities } from './render/entities';
import { CROWN_HEIGHT, CROWN_WIDTH } from './render/entities-trex';
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
  type CrownSpot,
  type GameEvent,
  type GameMode,
  type GameSim,
  type GameSnapshot,
  type HudContext,
  type InputFrame,
  type Settings,
  type UiAction,
} from './types';
import { createHud } from './ui/hud';

/** A single rendered frame never feeds more than this much time to the accumulator. */
const MAX_FRAME_MS = 250;
/** Weight of the newest frame in the smoothed FPS meter. */
const FPS_SMOOTHING = 0.05;
/** How long the light <-> dark theme cross-fade takes. */
const THEME_FADE_MS = 600;
/** How far in front of the camera the crown rests by the board (scene px). */
const CROWN_REST_DISTANCE = 60;
/** Resuming counts down 3, 2, 1 at this pace before the run moves again. */
const RESUME_COUNT = 3;
const RESUME_STEP_MS = 700;
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

/** The saved game speed multiplier, if it is still one of MULTIPLIERS. */
function readMultiplier(): number {
  const saved = Number(readStorage(STORAGE_KEYS.multiplier));
  return MULTIPLIERS.includes(saved) ? saved : 1;
}

/** The saved mode; 'classic' is regular's old name, and 'nsfw' was a mode before it was a toggle. */
function readMode(): GameMode {
  const saved = readStorage(STORAGE_KEYS.mode);
  return saved === 'funny' || saved === 'nsfw' ? 'funny' : 'regular';
}

/** A saved on/off setting; `before` is its value for players who picked a mode before it was split out. */
function readToggle(key: string, before: boolean): boolean {
  const saved = readStorage(key);
  return saved === null ? before : saved === '1';
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
  /** While a resume counts down: when (performance.now()) the run moves again. */
  let resumeAt: number | null = null;
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
  const settings: Settings = {
    volume: sfx.volume,
    muted: sfx.muted,
    ranked: readStorage(STORAGE_KEYS.ranked) !== '0',
    showBoard: readStorage(STORAGE_KEYS.showBoard) !== '0',
    multiplier: readMultiplier(),
    mode: readMode(),
    // Funny and NSFW modes used to fart; NSFW mode also had the NSFW clips (with the safe ones).
    farts: readToggle(STORAGE_KEYS.farts, readStorage(STORAGE_KEYS.mode) === 'funny' || readStorage(STORAGE_KEYS.mode) === 'nsfw'),
    nsfw: readToggle(STORAGE_KEYS.nsfw, readStorage(STORAGE_KEYS.mode) === 'nsfw'),
    dayNight: readStorage(STORAGE_KEYS.dayNight) !== '0',
  };
  /** The player is #1 on the team board, so the T-Rex wears the crown on the title screen. */
  let first = false;
  /** Celebrating on this game-over screen: the crown flew in from the board and stays till the next run. */
  let crownedNow = false;
  /** A celebration wants the crown flown in as soon as the board is showing. */
  let crownDue = false;
  /** The crown is on show (as last told to the T-Rex). */
  let crownOn = false;

  /**
   * Where the crown rests by the board's first place: as tall as the row's letters, standing on
   * their baseline just left of the row, as a point in the scene a little in front of the camera
   * (so no scenery can hide it) with the matching scale, and fading with the board. Asked every
   * frame: the camera moves (the swoop out of the title close-up). Null while the board is away.
   */
  function crownSpot(): CrownSpot | null {
    const rest = hud.crownRest();
    if (!rest) return null;
    const camera = rig.camera;
    camera.updateMatrixWorld();
    const x = rest.right - (rest.height * CROWN_WIDTH) / CROWN_HEIGHT / 2;
    const dir = new THREE.Vector3((x / window.innerWidth) * 2 - 1, -(rest.baseline / window.innerHeight) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
    const worldPerPx = (2 * CROWN_REST_DISTANCE * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / window.innerHeight;
    return { point: camera.position.clone().addScaledVector(dir, CROWN_REST_DISTANCE), scale: (rest.height * worldPerPx) / CROWN_HEIGHT, opacity: rest.opacity };
  }
  /** The multiplier the current run plays at: the setting as the run started, or a replay's own. */
  let pace = settings.multiplier;
  /** While the config panel is open the game is frozen and gameplay input is dropped. */
  let configOpen = false;
  /**
   * The star prompt: asked after the second game of a visit; if put off, asked once more when a
   * ranked run puts the player in the top 3. `starAsk` is unset until asked, then 'later' or 'done'.
   */
  let starAsk = readStorage(STORAGE_KEYS.starPrompt);
  /** ?star opens it at once, whatever was answered before (for trying it out). */
  let starOpen = params.has('star');
  /** Waiting to open on the next game-over screen. */
  let starDue = false;
  let gamesThisVisit = 0;
  let celebratedBest: BoardView['newBest'] = null;
  const hudCtx: HudContext = { cameraMode: rig.mode, settings, configOpen, starOpen, dark, touch: input.touch, fps: null, resumeIn: null };
  applyPageTheme(dark);
  entities.setDebug(debug);
  applyFun();

  /** Funny mode's crash, the farts setting's jumps, and the clips either of them plays. */
  function applyFun(): void {
    const funny = settings.mode === 'funny';
    entities.setFunny(funny);
    entities.setFarts(farting());
    rig.setFunny(funny);
    if (funny) sfx.preloadFunny(settings.nsfw);
  }

  /** Farts are a funny-mode option, like NSFW: the setting only counts in funny mode. */
  function farting(): boolean {
    return settings.mode === 'funny' && settings.farts;
  }

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
    multiplier: () => settings.multiplier,
    rankable: () => settings.ranked && !replayId && !autoplay && seed === null && !debug,
    onRank: (rank) => {
      if (starAsk === 'later' && rank <= 3) starDue = true;
    },
    onAdmin: () => exposeDebugHooks(),
    onView: (view) => {
      board = view;
      showBoard();
      first = view.account === 'signedIn' && view.entries[0]?.me === true;
      if (view.newBest && view.newBest !== celebratedBest) {
        celebratedBest = view.newBest;
        celebrate();
      }
    },
  });

  function loadReplay(id: string): void {
    api
      .run(id)
      .then((run) => {
        sim = createRunSim(run);
        pace = run.multiplier ?? 1;
        const cursor = createInputCursor(run.inputs);
        replay = { next: () => cursor.next(), left: run.steps };
        curr = prev = sim.getSnapshot();
        const name = run.name.toUpperCase();
        replayLabel = { note: `REPLAY · ${name} · ${run.score ?? 0}`, live: `REPLAY · ${name}` };
        showBoard();
      })
      .catch((err: unknown) => {
        replayLabel = { note: err instanceof ApiError && err.status === 401 ? 'SIGN IN TO WATCH REPLAYS' : 'REPLAY NOT FOUND', live: '' };
        showBoard();
      });
  }

  function applySettings(change: Partial<Settings>): void {
    Object.assign(settings, change);
    if (change.muted !== undefined) sfx.setMuted(change.muted);
    if (change.volume !== undefined) {
      sfx.setVolume(change.volume);
      sfx.play('jump'); // hear the new level
    }
    if (change.ranked !== undefined) {
      writeStorage(STORAGE_KEYS.ranked, change.ranked ? '1' : '0');
      if (!change.ranked) ranked.forfeit();
    }
    if (change.showBoard !== undefined) writeStorage(STORAGE_KEYS.showBoard, change.showBoard ? '1' : '0');
    // From the next run on: a run keeps the pace it started at (the server holds it to that).
    if (change.multiplier !== undefined) writeStorage(STORAGE_KEYS.multiplier, String(change.multiplier));
    if (change.mode !== undefined) writeStorage(STORAGE_KEYS.mode, change.mode);
    if (change.farts !== undefined) writeStorage(STORAGE_KEYS.farts, change.farts ? '1' : '0');
    if (change.nsfw !== undefined) writeStorage(STORAGE_KEYS.nsfw, change.nsfw ? '1' : '0');
    if (change.dayNight !== undefined) writeStorage(STORAGE_KEYS.dayNight, change.dayNight ? '1' : '0');
    if (change.mode !== undefined || change.farts !== undefined || change.nsfw !== undefined) applyFun();
  }

  /** Opening the panel mid-run pauses it; the player resumes from the pause screen. */
  function toggleConfig(): void {
    configOpen = !configOpen;
    resumeAt = null;
    if (configOpen && curr.phase === 'playing') {
      sim.pause();
      ranked.paused();
      curr = prev = sim.getSnapshot();
    }
    acc = 0;
  }

  /** LATER the first time puts it off till the top 3; any answer after that, or a star, is final. */
  function answerStar(later: boolean): void {
    starAsk = later && starAsk === null ? 'later' : 'done';
    writeStorage(STORAGE_KEYS.starPrompt, starAsk);
    starOpen = false;
  }

  /** Pausing is instant; resuming counts down first, and pausing again cancels the count. */
  /** Confetti, a happy T-Rex and a fanfare (cutting a funny crash clip short), for a rank up or an unranked new best. */
  function celebrate(): void {
    hud.celebrate();
    entities.celebrate();
    rig.celebrate();
    sfx.stopFunny();
    sfx.play('victory');
    // The crown flies from the board onto the dancing T-Rex (once the board is up: an unranked best
    // celebrates at the crash itself), and back when the next run starts.
    if (!replay && !crownedNow) crownDue = true;
  }

  function togglePause(): void {
    if (curr.phase === 'playing') {
      sim.pause();
      ranked.paused();
      curr = prev = sim.getSnapshot();
    } else if (curr.phase === 'paused') {
      resumeAt = resumeAt === null ? performance.now() + RESUME_COUNT * RESUME_STEP_MS : null;
    }
  }

  function resume(): void {
    resumeAt = null;
    sim.resume();
    ranked.resumed();
    curr = prev = sim.getSnapshot();
    acc = 0;
  }

  function onAction(action: UiAction): void {
    switch (action) {
      case 'toggleCamera':
        setCameraMode(CAMERA_MODES[(CAMERA_MODES.indexOf(rig.mode) + 1) % CAMERA_MODES.length]);
        break;
      case 'toggleMute':
        applySettings({ muted: !settings.muted });
        break;
      case 'toggleTheme':
        toggleTheme();
        break;
      case 'togglePause':
      case 'escape':
        // Escape / P close the star prompt (as LATER) or the config panel first. Once a resume
        // is counting down, only Escape calls it off; P and the pause button wait for it.
        if (starOpen) answerStar(true);
        else if (configOpen) toggleConfig();
        else if (resumeAt === null || action === 'escape') togglePause();
        break;
      case 'toggleConfig':
        if (!starOpen) toggleConfig();
        break;
      case 'starLater':
      case 'starDone':
        answerStar(action === 'starLater');
        break;
      case 'signOut':
        void ranked.signOut();
        break;
      case 'deleteStats':
        // Back to the board, to watch the stats go.
        if (configOpen) toggleConfig();
        void ranked.deleteStats().then((deleted) => {
          if (!deleted) return;
          // This browser's own best (HI) goes too.
          sim.setHighScore(0);
          writeStorage(STORAGE_KEYS.highScore, '0');
          curr = sim.getSnapshot();
        });
        break;
      case 'toggleDebug':
        debug = !debug;
        entities.setDebug(debug);
        if (debug) ranked.forfeit();
        break;
    }
  }

  /**
   * A run pauses whenever the page is hidden or loses focus (a resume count stops too), and
   * stays paused when the player comes back: they resume it themselves, with the countdown.
   */
  function onAway(): void {
    if (document.visibilityState !== 'hidden' && document.hasFocus()) return;
    resumeAt = null;
    if (curr.phase === 'playing') {
      sim.pause();
      ranked.paused();
      curr = prev = sim.getSnapshot();
    }
    acc = 0;
  }

  function collect(events: readonly GameEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      frameEvents.push(e);
      if (e.type === 'jump') sfx.play(farting() ? 'fart' : 'jump');
      else if (e.type === 'start' || e.type === 'restart') {
        sfx.stopFunny();
        if (!replay) pace = settings.multiplier;
        // The crown, if it was on the T-Rex, flies to the board.
        if (crownOn) {
          // The board stays a moment to catch it.
          hud.lingerBoard(1300);
          entities.flyCrown('out', crownSpot);
          crownOn = false;
        }
        crownedNow = false;
        crownDue = false;
        // A HUD button left focused (say, the gear after closing settings) loses its ring once play starts.
        if (document.activeElement instanceof HTMLElement && hudRoot.contains(document.activeElement)) document.activeElement.blur();
      }
      else if (e.type === 'milestone') sfx.play('milestone');
      else if (e.type === 'crash') {
        // A win gets the fanfare instead of the crash sound. An unranked run beating the last best
        // is one now; a ranked run is one if it beats the player's board best (or is their first),
        // and its party waits for the server's rank.
        const localWin = !replay && !autoplay && e.newHighScore && prev.highScore > 0 && !ranked.lastRunRanked;
        const boardBest = board?.entries.find((b) => b.me)?.score ?? null;
        const rankedWin = ranked.lastRunRanked && (boardBest === null || e.score > boardBest);
        if (!localWin && !rankedWin) sfx.play(settings.mode === 'funny' ? 'slide' : 'crash');
        // Funny crashes move to the clip's hits; it starts now, and the T-Rex hears the crash next.
        entities.setCrashBeats(settings.mode === 'funny' && !localWin && !rankedWin ? sfx.crashBeats : []);
        if (!replay) writeStorage(STORAGE_KEYS.highScore, String(curr.highScore));
        if (localWin) celebrate();
        if (!replay && !autoplay && ++gamesThisVisit === 2 && starAsk === null) starDue = true;
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

  /** While paused nothing steps; P / Escape (UiAction) or a tap / Space resumes. Presses during the countdown are dropped. */
  function pollPaused(): void {
    const frame = input.sample();
    if ((frame.jumpPressed || frame.restartPressed) && resumeAt === null) togglePause();
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
    // With the cycle off the sim's night is ignored, leaving just the theme.
    Object.assign(shownPrev, prev).night = themedNight(settings.dayNight ? prev.night : 0, darkBlend);
    Object.assign(shownCurr, curr).night = themedNight(settings.dayNight ? curr.night : 0, darkBlend);
    models.setNight(shownCurr.night);
    // The T-Rex wears the crown on the title screen if it is #1, and on a game-over screen it is
    // celebrating on; otherwise the crown rests by the board.
    crownOn = !replay && ((first && curr.phase === 'title') || (crownedNow && curr.phase === 'crashed'));
    entities.setCrown(crownOn);
    // The crown rests by the board's first place unless the leader's T-Rex is wearing it.
    entities.setBoardCrown(crownOn ? null : crownSpot);
    world.update(shownPrev, shownCurr, alpha, dtMs);
    entities.update(shownPrev, shownCurr, alpha, dtMs);
    rig.update(shownCurr, entities.trex, dtMs);
    hudCtx.cameraMode = rig.mode;
    hudCtx.configOpen = configOpen;
    hudCtx.starOpen = starOpen;
    hudCtx.dark = dark;
    hudCtx.touch = input.touch;
    hudCtx.fps = debug ? fps : null;
    hudCtx.resumeIn = resumeAt === null ? null : Math.max(1, Math.ceil((resumeAt - performance.now()) / RESUME_STEP_MS));
    hud.update(shownCurr, hudCtx);
    if (crownDue && curr.phase === 'crashed' && hud.crownRest()) {
      crownDue = false;
      crownedNow = true;
      crownOn = true;
      entities.setCrown(true);
      entities.flyCrown('in', crownSpot);
    }
    // Last, with the camera moved and the board laid out: the board's crown sits just in front of the camera.
    entities.placeCrowns(dtMs);
    renderer.render(scene, rig.camera);
  }

  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
    last = now;
    if (dt > 0) fps += (1000 / dt - fps) * FPS_SMOOTHING;
    // The star prompt waits for the game-over screen to settle (and for no other panel).
    if (starDue && curr.phase === 'crashed' && curr.canRestart && !configOpen && !replay) {
      starDue = false;
      starOpen = true;
    }
    if (frozen) acc = 0;
    else if (configOpen || starOpen) {
      acc = 0;
      input.sample(); // drop presses made while a panel is open
    } else if (curr.phase === 'paused') {
      acc = 0;
      pollPaused();
      if (resumeAt !== null && now >= resumeAt) resume();
    } else {
      // The multiplier speeds real time up or down; the sim still takes the same fixed steps.
      acc += dt * pace;
      let steps = 0;
      while (acc >= SIM.STEP_MS && steps < SIM.MAX_STEPS_PER_FRAME * Math.ceil(pace)) {
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
  hud.onSettings(applySettings);
  const unlock = (): void => sfx.unlock();
  window.addEventListener('keydown', unlock, { once: true, capture: true });
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('visibilitychange', onAway);
  window.addEventListener('blur', onAway);
  window.addEventListener('focus', onAway);
  window.addEventListener('resize', resize);
  resize();

  /**
   * window.__dino, for scripts/ and debugging. It hands out the game state a bot needs, so the
   * live site only gives it to admins; dev servers and local previews always get it.
   */
  function exposeDebugHooks(): void {
    Object.assign(window, {
      __dino: {
        getSnapshot: () => sim.getSnapshot(),
        advance,
        setAutoplay: (on: boolean) => {
          autoplay = on;
          if (on) ranked.forfeit();
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
  }
  if (import.meta.env.DEV || location.hostname === 'localhost' || location.hostname === '127.0.0.1') exposeDebugHooks();

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
