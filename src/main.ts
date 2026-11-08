import './style.css';
import * as THREE from 'three';
import { createSfx } from './audio/sfx';
import { revealPage } from './curtain';
import { MULTIPLIERS, PALETTE, SIM, STORAGE_KEYS } from './config';
import { createInput } from './input/input';
import { createCameraRig } from './render/camera';
import { createEntities } from './render/entities';
import { CROWN_HEIGHT, CROWN_WIDTH } from './render/entities-trex';
import { createModelLibrary } from './render/models';
import { createWorld } from './render/world';
import { api, ApiError, type StoredRun } from './net/api';
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
  type LookState,
  type RunLook,
  type Settings,
  type UiAction,
} from './types';
import { createHud } from './ui/hud';
import { urlSetting } from './url-settings';

/** A single rendered frame never feeds more than this much time to the accumulator. */
const MAX_FRAME_MS = 250;
/** Weight of the newest frame in the smoothed FPS meter. */
const FPS_SMOOTHING = 0.05;
/** How long the light <-> dark theme cross-fade takes. */
const THEME_FADE_MS = 600;
/** Camera orbit speed, radians per CSS px dragged. */
const ORBIT_PER_PX = 0.006;
/** On menus, how long a first finger waits for a second before it counts as a tap. */
const TOUCH_GESTURE_MS = 80;
/** How far in front of the camera the crown rests by the board (scene px). */
const CROWN_REST_DISTANCE = 60;
/** Resuming counts down 3, 2, 1 at this pace before the run moves again. */
const RESUME_COUNT = 3;
const RESUME_STEP_MS = 700;
/** How a replay of a run from before looks were saved looks: the game's defaults. */
const DEFAULT_LOOK: LookState = { mode: 'regular', farts: false, nsfw: false, dayNight: true, dark: false, camera: { mode: CAMERA_MODES[0], custom: false, yaw: 0, pitch: 0 } };
/** Camera drags are noted at most this often (steps) in a run's look; the replay eases between. */
const LOOK_CAMERA_STEPS = 4;
/** A replay opens on its player's first screen this long (ms), and waits at most REPLAY_CLIP_WAIT_MS for its crash clip. */
const REPLAY_OPEN_MS = 900;
const REPLAY_CLIP_WAIT_MS = 3000;
/** And a run notes at most this many look changes. */
const MAX_LOOK_CHANGES = 2000;
const NO_INPUT: InputFrame = Object.freeze({ jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false });

const params = new URLSearchParams(location.search);

function isCameraMode(value: string | null): value is CameraMode {
  return value !== null && (CAMERA_MODES as readonly string[]).includes(value);
}

/** A saved value, or this visit's ?setting= in its place (src/url-settings.ts). */
function readStorage(key: string): string | null {
  const fromUrl = urlSetting(key);
  if (fromUrl !== null) return fromUrl;
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
  /** The replayed run's look (null: an old run, shown with the defaults), and whether its player cheered it. */
  let replayLook: RunLook | null = null;
  let replayCheered = false;
  /** The look the replay shows now, and the next of its changes to apply. */
  let replayState: LookState | null = null;
  let replayChange = 0;
  /** The stored run being replayed, kept to watch it again. */
  let replayRun: StoredRun | null = null;
  /** Until when (performance.now()) the replay shows its opening screen, and may wait for its crash clip to load. */
  let replayOpen = 0;
  let replayHold = 0;
  /** The board's line once the replay has played out: with the run's score. */
  let replayEnd = '';
  /** Steps since the current run started: when a look change happened (recorded, and replayed). */
  let runStep = 0;
  /** The look being recorded for this run: as it started, its changes since, and the latest; null when not recording. */
  let lookStart: LookState | null = null;
  let lookChanges: [number, Partial<LookState>][] = [];
  let lookLast: LookState | null = null;
  let lookCameraStep = 0;
  /** The high score on screen as this run started, and the seed of its fart sounds (RunLook). */
  let runHi = 0;
  let runFx = 0;
  /** The T-Rex wore the crown as this run started (RunLook.crown). */
  let runCrown = false;
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
    boardPeriod: readStorage(STORAGE_KEYS.boardPeriod) === 'week' ? 'week' : 'all',
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
  const hudCtx: HudContext = { cameraMode: rig.mode, cameraCustom: false, settings, configOpen, starOpen, dark, touch: input.touch, fps: null, resumeIn: null, replay: 'off', mode: look().mode };
  applyPageTheme(dark);
  entities.setDebug(debug);
  applyFun();

  /**
   * The settings that change how a run looks and sounds. A replay keeps its player's (from the
   * run's RunLook), whatever the viewer picks; only the sound level and mute are the viewer's.
   */
  function look(): Pick<Settings, 'mode' | 'farts' | 'nsfw' | 'dayNight'> {
    return replayId ? (replayState ?? DEFAULT_LOOK) : settings;
  }

  /** The player's look right now. */
  function lookState(): LookState {
    const v = rig.view;
    const round = (a: number) => Math.round(a * 1e4) / 1e4;
    return { mode: settings.mode, farts: settings.farts, nsfw: settings.nsfw, dayNight: settings.dayNight, dark, camera: { ...v, yaw: round(v.yaw), pitch: round(v.pitch) } };
  }

  /** Notes what changed in the player's look since last noted (camera drags at most every few steps, unless `final`). */
  function recordLook(final = false): void {
    if (!lookLast || lookChanges.length >= MAX_LOOK_CHANGES) return;
    const now = lookState();
    const change: Partial<LookState> = {};
    for (const key of ['mode', 'farts', 'nsfw', 'dayNight', 'dark'] as const) if (now[key] !== lookLast[key]) Object.assign(change, { [key]: now[key] });
    const [a, b] = [now.camera, lookLast.camera];
    const switched = a.mode !== b.mode || a.custom !== b.custom;
    const turned = a.yaw !== b.yaw || a.pitch !== b.pitch;
    if (switched || (turned && (final || runStep - lookCameraStep >= LOOK_CAMERA_STEPS))) {
      change.camera = a;
      lookCameraStep = runStep;
    }
    if (Object.keys(change).length === 0) return;
    lookChanges.push([runStep, change]);
    lookLast = { ...lookLast, ...change };
  }

  /** What a ranked run saves for its replay: the player's look over the run and what came up at random. */
  function runLook(): RunLook {
    return { ...(lookStart ?? lookState()), changes: lookChanges, hi: runHi, crown: runCrown, fx: runFx, clip: sfx.crashClip, line: hud.crashLine, move: entities.crashMove };
  }

  /** A replay shows its player's look: settings, theme and camera. */
  function showLook(state: LookState): void {
    const before = replayState;
    replayState = state;
    if (state.dark !== dark) {
      dark = state.dark;
      applyPageTheme(dark);
    }
    rig.setView(state.camera);
    if (!before || before.mode !== state.mode || before.farts !== state.farts || before.nsfw !== state.nsfw) applyFun();
  }

  /** Funny mode's crash, the farts setting's jumps, and the clips either of them plays. */
  function applyFun(): void {
    const funny = look().mode === 'funny';
    entities.setFunny(funny);
    entities.setFarts(farting());
    rig.setFunny(funny);
    if (funny) sfx.preloadFunny(look().nsfw);
  }

  /** Farts are a funny-mode option, like NSFW: the setting only counts in funny mode. */
  function farting(): boolean {
    return look().mode === 'funny' && look().farts;
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
    look: runLook,
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
        replayRun = run;
        playReplay(run);
      })
      .catch((err: unknown) => {
        replayLabel = { note: err instanceof ApiError && err.status === 401 ? 'SIGN IN TO WATCH REPLAYS' : 'REPLAY NOT FOUND', live: '' };
        showBoard();
      });
  }

  /** The replay again from its start: the scene resets as for a restart, then the run plays out. */
  function watchAgain(run: StoredRun): void {
    sfx.stopFunny();
    frameEvents.push({ type: 'restart' });
    playReplay(run);
  }

  /** Plays the stored run from its start: on load, and again when the viewer asks to watch it again. */
  function playReplay(run: StoredRun): void {
    sim = createRunSim(run);
    pace = run.multiplier ?? 1;
    const cursor = createInputCursor(run.inputs);
    replay = { next: () => cursor.next(), left: run.steps };
    replayCheered = run.cheered;
    replayChange = 0;
    // Shown exactly as its player saw it: their look from the start (or the defaults, for a run from
    // before looks were saved), their high score, and their crash clip, line and move.
    const l = run.look;
    replayLook = l && { ...l, camera: l.camera ?? DEFAULT_LOOK.camera, changes: l.changes ?? [] };
    const { mode, farts, nsfw, dayNight, dark: lookDark, camera } = replayLook ?? DEFAULT_LOOK;
    showLook({ mode, farts, nsfw, dayNight, dark: lookDark, camera });
    darkBlend = dark ? 1 : 0;
    if (replayLook) {
      sim.setHighScore(replayLook.hi ?? 0);
      entities.setCrashMove(replayLook.move);
      hud.setCrashLine(replayLook.line);
      // The crash sounds as it did: the clip its player heard, or the synthesised sound if none had loaded
      // yet (never a random one). The mode that counts is the one at the crash, after any changes.
      const atCrash = replayLook.changes.reduce<LookState>((s, [, change]) => ({ ...s, ...change }), replayLook);
      if (atCrash.mode === 'funny' && !run.cheered) sfx.queueCrash(replayLook.clip ?? '');
    }
    replayOpen = performance.now() + REPLAY_OPEN_MS;
    replayHold = performance.now() + REPLAY_CLIP_WAIT_MS;
    curr = prev = sim.getSnapshot();
    const name = run.name.toUpperCase();
    // The score shows once the replay has played out, not before.
    replayLabel = { note: `REPLAY · ${name}`, live: `REPLAY · ${name}` };
    replayEnd = `REPLAY · ${name} · ${run.score ?? 0}`;
    showBoard();
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
    if (change.boardPeriod !== undefined) writeStorage(STORAGE_KEYS.boardPeriod, change.boardPeriod);
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
    if (!crownedNow) crownDue = true;
  }

  function togglePause(): void {
    if (curr.phase === 'playing') {
      sim.pause();
      ranked.paused();
      curr = prev = sim.getSnapshot();
    } else if (curr.phase === 'paused') {
      // A replay has nothing to get ready for: it picks up at once.
      if (replayId) resume();
      else resumeAt = resumeAt === null ? performance.now() + RESUME_COUNT * RESUME_STEP_MS : null;
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
        if (replayId) break; // a replay keeps its player's camera
        rig.cycle();
        if (!rig.custom) writeStorage(STORAGE_KEYS.cameraMode, rig.mode);
        break;
      case 'toggleMute':
        applySettings({ muted: !settings.muted });
        break;
      case 'toggleTheme':
        if (!replayId) toggleTheme(); // and their theme
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
        runStep = 0;
        runFx = replayId ? (replayLook?.fx ?? 0) : Math.floor(Math.random() * 2 ** 32);
        sfx.seedFarts(runFx);
        if (!replayId) {
          runHi = prev.highScore;
          runCrown = crownOn;
          lookStart = lookLast = lookState();
          lookChanges = [];
          lookCameraStep = 0;
        }
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
        // The look stops being recorded with the run.
        recordLook(true);
        lookLast = null;
        // A win gets the fanfare instead of the crash sound. An unranked run beating the last best
        // is one now; a ranked run is one if it beats the player's board best (or is their first),
        // and its party waits for the server's rank.
        // A replay cheers where its player did.
        const localWin = replay ? replayCheered : !autoplay && e.newHighScore && prev.highScore > 0 && !ranked.lastRunRanked;
        const boardBest = board?.entries.find((b) => b.me)?.score ?? null;
        const rankedWin = !replay && ranked.lastRunRanked && (boardBest === null || e.score > boardBest);
        if (!localWin && !rankedWin) sfx.play(look().mode === 'funny' ? 'slide' : 'crash');
        // Funny crashes move to the clip's hits; it starts now, and the T-Rex hears the crash next.
        entities.setCrashBeats(look().mode === 'funny' && !localWin && !rankedWin ? sfx.crashBeats : []);
        if (!replay) writeStorage(STORAGE_KEYS.highScore, String(curr.highScore));
        if (localWin) celebrate();
        if (!replay && !autoplay && ++gamesThisVisit === 2 && starAsk === null) starDue = true;
      }
    }
  }

  function nextInput(manual: InputFrame | null): InputFrame {
    if (replayId) {
      // A replay plays by itself; the viewer's presses are dropped, except that once it has played out
      // (and the game-over screen settles, as for a restart) one watches it again from the start.
      const press = input.sample();
      if (!replay) return NO_INPUT;
      // It opens on the player's first screen for a moment (with their crown, if they wore it), and waits
      // (briefly) for the crash clip to load, so a short run doesn't crash before it can play.
      const now = performance.now();
      if (replay.left === replayRun?.steps && (now < replayOpen || (!sfx.crashReady && now < replayHold))) return NO_INPUT;
      if (replay.left > 0) {
        replay.left--;
        return replay.next();
      }
      if (replayRun && curr.phase === 'crashed' && curr.canRestart && (press.jumpPressed || press.restartPressed)) watchAgain(replayRun);
      return NO_INPUT;
    }
    return autoplay ? autopilot(curr) : (manual ?? input.sample());
  }

  function step(manual: InputFrame | null): void {
    const frame = nextInput(manual);
    const advances = curr.phase !== 'paused';
    const events = sim.step(frame);
    // A replay is not a run of the viewer's: the ranked tracker would also reseed its course.
    if (advances && !replayId) ranked.stepped(frame, events);
    prev = curr;
    curr = sim.getSnapshot();
    collect(events);
    if (advances) runStep++;
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
    // A ranked run notes the player's look as it changes; a replay shows those changes at the same steps.
    recordLook();
    const changes = replayLook?.changes ?? [];
    while (replay && replayState && replayChange < changes.length && changes[replayChange][0] <= runStep) showLook({ ...replayState, ...changes[replayChange++][1] });
    const target = dark ? 1 : 0;
    darkBlend += Math.sign(target - darkBlend) * Math.min(Math.abs(target - darkBlend), dtMs / THEME_FADE_MS);
    // With the cycle off the sim's night is ignored, leaving just the theme.
    Object.assign(shownPrev, prev).night = themedNight(look().dayNight ? prev.night : 0, darkBlend);
    Object.assign(shownCurr, curr).night = themedNight(look().dayNight ? curr.night : 0, darkBlend);
    models.setNight(shownCurr.night);
    // The T-Rex wears the crown on the title screen if it is #1, and on a game-over screen it is
    // celebrating on; otherwise the crown rests by the board.
    // A replay shows its player's crown: on the T-Rex until the run starts (it then flies off to the board,
    // as above), and flown back in if they celebrated at the crash.
    const wearing = replayId ? replay !== null && replay.left === replayRun?.steps && replayLook?.crown === true : first && curr.phase === 'title';
    crownOn = wearing || (crownedNow && curr.phase === 'crashed');
    entities.setCrown(crownOn);
    // The crown rests by the board's first place unless the leader's T-Rex is wearing it.
    entities.setBoardCrown(crownOn ? null : crownSpot);
    world.update(shownPrev, shownCurr, alpha, dtMs);
    entities.update(shownPrev, shownCurr, alpha, dtMs);
    rig.update(shownCurr, entities.trex, dtMs);
    hudCtx.cameraMode = rig.mode;
    hudCtx.cameraCustom = rig.custom;
    hudCtx.configOpen = configOpen;
    hudCtx.starOpen = starOpen;
    hudCtx.dark = dark;
    hudCtx.touch = input.touch;
    hudCtx.fps = debug ? fps : null;
    const loading = replayLabel?.note === 'LOADING REPLAY';
    hudCtx.replay = !replayId ? 'off' : !replay ? (loading ? 'loading' : 'over') : replay.left > 0 ? 'playing' : 'over';
    if (replay && hudCtx.replay === 'over' && replayLabel && replayEnd && replayLabel.note !== replayEnd) {
      replayLabel = { ...replayLabel, note: replayEnd };
      showBoard();
    }
    hudCtx.mode = look().mode;
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
    // On menus a first finger waits a moment for a second (a two-finger orbit); in a run, taps are instant.
    input.setGestureWindow(curr.phase === 'playing' ? 0 : TOUCH_GESTURE_MS);
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

  // Middle-drag, Ctrl/Cmd + Shift + drag or two fingers orbit the camera, like Blender.
  input.onOrbit((dx, dy) => {
    if (!replayId) rig.orbit(-dx * ORBIT_PER_PX, dy * ORBIT_PER_PX);
  });

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
  // Arrived from another page under its curtain: it lifts once the game has drawn a couple of frames.
  requestAnimationFrame(() => requestAnimationFrame(revealPage));
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
