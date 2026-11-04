// Shared contracts between the game's modules. Every module implements exactly the factory
// and interface listed for it here; main.ts wires them together.
//
// ─── Coordinate conventions ──────────────────────────────────────────────────────────────
// • 1 world unit == 1 Chrome sprite pixel ("px"). Nothing is scaled: the T-Rex is 44 x 47 units.
// • +X is the direction of travel. The T-Rex stays at x = TREX.START_X; obstacles spawn at
//   RUNNER.SPAWN_X and move toward -X. Decorations scroll by the sim's `distance`.
// • +Y is up. The ground is the plane y = 0.
// • Z is depth. The running lane is centred on z = 0. The default camera sits on +Z looking
//   toward -Z, so +X is screen-right, exactly like Chrome.
// • All boxes in snapshots are y-up with (x, y) = bottom-left corner.
// • Time: the sim advances in fixed steps of SIM.STEP_MS (1000 / 60 ms) == one Chrome frame.
//   Rendering interpolates between the previous and current snapshot with `alpha` in [0, 1).

import type * as THREE from 'three';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ─── Simulation (src/sim) ────────────────────────────────────────────────────────────────

export type TrexFrame = 'idle' | 'blink' | 'run1' | 'run2' | 'duck1' | 'duck2' | 'jump' | 'crashed';

export type TrexStatus = 'waiting' | 'running' | 'jumping' | 'ducking' | 'crashed';

export interface TrexSnapshot {
  /** Bottom-left of the current sprite box. y is the height of the feet above the ground. */
  x: number;
  y: number;
  /** Current sprite box: TREX.WIDTH x HEIGHT standing, TREX.WIDTH_DUCK x HEIGHT_DUCK ducking. */
  width: number;
  height: number;
  status: TrexStatus;
  /** Which model frame to draw this step. */
  frame: TrexFrame;
  /** Vertical velocity in px/frame, + is up. 0 when grounded. */
  vy: number;
  speedDrop: boolean;
}

export type ObstacleKind = 'cactusSmall' | 'cactusLarge' | 'pterodactyl';

export interface ObstacleSnapshot {
  /** Unique for the page's lifetime; renderers key their mesh pools on it. */
  id: number;
  kind: ObstacleKind;
  /** Cacti side by side (1..3). Always 1 for pterodactyls. */
  size: number;
  /** One model variant per cactus in the group (length === size), each in [0, CACTUS_VARIANTS[kind]). [0] for pterodactyls. */
  variants: number[];
  /** Bottom-left of the whole group's box. Cactus i of a group starts at x + i * OBSTACLES[kind].width. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pterodactyl wing frame; always 0 for cacti. */
  frame: 0 | 1;
  /** Fine collision boxes relative to (x, y), y-up. For debug drawing. */
  collisionBoxes: Box[];
}

/**
 * title    – before the first run: T-Rex idles and blinks, waiting for jump.
 * playing  – running.
 * crashed  – game over; restart is accepted once `canRestart` is true.
 * paused   – the tab was hidden mid-run (sim.pause()); nothing advances until sim.resume().
 */
export type GamePhase = 'title' | 'playing' | 'crashed' | 'paused';

export interface GameSnapshot {
  phase: GamePhase;
  /** Steps since the sim was created. Monotonic, never reset; does not advance while paused. */
  frame: number;
  /** Steps since the current run started (0 on the title screen). */
  runFrames: number;
  /** Speed in px/frame. */
  speed: number;
  /** Total px the ground has scrolled this run. Drives decoration scrolling. */
  distance: number;
  score: number;
  highScore: number;
  /** True while the 100-point achievement blink has the score digits hidden. */
  scoreFlash: boolean;
  /** True in the crashed phase once GAMEOVER_CLEAR_TIME has passed. */
  canRestart: boolean;
  /** 0 = day, 1 = full night. Fades over NIGHT.TRANSITION_MS. */
  night: number;
  /** Moon phase index in [0, NIGHT.MOON_PHASES); advances each time night starts. */
  moonPhase: number;
  trex: TrexSnapshot;
  obstacles: ObstacleSnapshot[];
}

export type GameEvent =
  | { type: 'start' }
  | { type: 'restart' }
  | { type: 'jump' }
  | { type: 'land' }
  | { type: 'duck' }
  | { type: 'milestone'; score: number }
  | { type: 'crash'; score: number; newHighScore: boolean }
  | { type: 'nightStart' }
  | { type: 'nightEnd' }
  | { type: 'spawn'; id: number; kind: ObstacleKind }
  | { type: 'despawn'; id: number };

/** One step's worth of player intent, produced by the input module. */
export interface InputFrame {
  /** Jump went down since the previous step (edge). Starts a run on the title screen. */
  jumpPressed: boolean;
  /** Jump is currently held. While a jump is rising and this is false, the jump is cut short (once MIN_JUMP_HEIGHT is reached). */
  jumpHeld: boolean;
  /** Duck is held: ducks on the ground, speed-drops in the air. */
  duckHeld: boolean;
  /** Enter / tap on the game-over screen (edge). jumpPressed also restarts. */
  restartPressed: boolean;
}

export interface GameSim {
  /** A fresh deep copy; safe to keep across steps. */
  getSnapshot(): GameSnapshot;
  /** Advance exactly one fixed step. Returns the events that happened during it. */
  step(input: InputFrame): GameEvent[];
  /** Freeze a run (tab hidden). No-op outside the playing phase. */
  pause(): void;
  resume(): void;
  setHighScore(score: number): void;
  /**
   * RNG for obstacle spawns from now on; null goes back to the shared `random`. Obstacles are
   * the only randomness a run uses, so a run seeded here before its first spawn (runFrames <=
   * STEPS.CLEAR) can be replayed exactly from its inputs (src/sim/replay.ts).
   */
  setObstacleRandom(random: (() => number) | null): void;
  /** Runs started from now on begin at RUNNER.FAST_START_SPEED instead of RUNNER.SPEED. */
  setStartFast(on: boolean): void;
}

export interface GameSimOptions {
  /** RNG in [0, 1). Defaults to Math.random. Tests pass a seeded one. */
  random?: () => number;
  highScore?: number;
  /** Touch device: pterodactyls only use OBSTACLES.pterodactyl.yUpMobile heights. */
  mobile?: boolean;
  /** Start on a game-over screen that accepts a restart at once (replays of restarted runs). */
  startCrashed?: boolean;
  /** Runs begin at RUNNER.FAST_START_SPEED (see GameSim.setStartFast). */
  startFast?: boolean;
}

// Factory: src/sim/game.ts      export function createGameSim(opts?: GameSimOptions): GameSim
// Bot:     src/sim/autopilot.ts export function autopilot(s: GameSnapshot): InputFrame
//          (a stateless bot that clears obstacles; used by ?autoplay and by tests)

// ─── Input (src/input) ───────────────────────────────────────────────────────────────────

/** Non-gameplay actions, routed by main.ts. */
export type UiAction = 'toggleCamera' | 'toggleMute' | 'togglePause' | 'toggleDebug' | 'toggleTheme' | 'toggleConfig' | 'signOut';

/** regular: Chrome's runner. funny: farts, flops and meme crash clips. nsfw: funny with the NSFW crash clips too. */
export type GameMode = 'regular' | 'funny' | 'nsfw';

/** Everything the config panel edits. main.ts owns and persists it. */
export interface Settings {
  /** Sound effects volume, 0..1. */
  volume: number;
  muted: boolean;
  /** Submit runs to the team leaderboard while signed in. */
  ranked: boolean;
  /** Runs begin halfway to top speed. Ranked as usual, tagged on the board. */
  startFast: boolean;
  /** Show the team board on the title and game-over screens. */
  showBoard: boolean;
  mode: GameMode;
}

export interface InputController {
  /**
   * Called once per sim step. Edge flags (jumpPressed, restartPressed) are reported by the
   * first sample() after the press and then cleared, so a press is never lost or doubled
   * no matter how many steps run per rendered frame (including zero).
   */
  sample(): InputFrame;
  /** Subscribe to UiActions (keys C / M / D / P / Escape / backquote). Returns an unsubscribe fn. */
  onAction(cb: (action: UiAction) => void): () => void;
  /** True if the most recent input came from a touch screen (hints switch from "Space" to "Tap"). */
  readonly touch: boolean;
  dispose(): void;
}

// Factory: src/input/input.ts   export function createInput(): InputController
// Listens on window. Pointer/touch presses on elements marked [data-ui] (HUD buttons) are
// ignored for gameplay; everything else on the page is the play surface.

// ─── Audio (src/audio) ───────────────────────────────────────────────────────────────────

/** fart and slide are funny mode's jump and crash (src/audio/funny.ts). */
export type SfxName = 'jump' | 'milestone' | 'crash' | 'fart' | 'slide';

export interface Sfx {
  play(name: SfxName): void;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  /** 0..1. */
  readonly volume: number;
  setVolume(volume: number): void;
  /** Resume the AudioContext; call from a user gesture. Safe to call repeatedly. */
  unlock(): void;
  /** Fetch funny mode's recorded clips ahead of the first jump; `nsfw` picks the crash clip set. */
  preloadFunny(nsfw: boolean): void;
  /** Cut funny mode's crash clip short (a new run started). */
  stopFunny(): void;
}

// Factory: src/audio/sfx.ts     export function createSfx(): Sfx  (persists mute and volume in localStorage)

// ─── Rendering (src/render) ──────────────────────────────────────────────────────────────

/**
 * Voxel geometries for every gameplay sprite, built once at startup.
 * Geometry conventions (see src/render/voxel.ts):
 *   • x spans [0, width], y spans [0, height] (feet / base on y = 0), z is centred on 0;
 *     so placing a mesh at (snapshot.x, snapshot.y, 0) lines it up with the sim box.
 *   • One geometry group per material slot; render with `new THREE.Mesh(geometry, models.materials)`.
 */
export interface ModelLibrary {
  /** Shared material array; index = voxel slot - 1 (SLOT.INK, SLOT.EYE, ...). */
  readonly materials: THREE.Material[];
  trex(frame: TrexFrame): THREE.BufferGeometry;
  cactus(kind: 'cactusSmall' | 'cactusLarge', variant: number): THREE.BufferGeometry;
  pterodactyl(frame: 0 | 1): THREE.BufferGeometry;
  /** Lerp the shared materials between PALETTE.day and PALETTE.night. */
  setNight(amount: number): void;
  dispose(): void;
}

// Factory: src/render/models.ts export function createModelLibrary(): ModelLibrary

/** Sky, fog, lights + shadows, ground, scrolling ground details, clouds, moon and stars. */
export interface World {
  /** Interpolate `prev` -> `curr` by `alpha`; `dtMs` is real time since the last rendered frame. */
  update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number): void;
  handleEvents(events: GameEvent[]): void;
  dispose(): void;
}

// Factory: src/render/world.ts  export function createWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): World

/** The T-Rex, the obstacle pool, and small effects (dust, landing puffs, crash). */
export interface Entities {
  /** The T-Rex's root object (its position is the interpolated sim position). The camera follows it. */
  readonly trex: THREE.Object3D;
  update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number): void;
  handleEvents(events: GameEvent[]): void;
  /** Draw sim collision boxes as wireframes. */
  setDebug(on: boolean): void;
  /** Funny mode: fart clouds on jumps, a spin-and-flop crash. Cosmetic only. */
  setFunny(on: boolean): void;
  dispose(): void;
}

// Factory: src/render/entities.ts export function createEntities(scene: THREE.Scene, models: ModelLibrary): Entities

/**
 * cinematic – default: three-quarter view from the side and slightly behind and above.
 * side      – the classic 2D Chrome framing: square-on side view, low FOV, far away.
 * chase     – over-the-shoulder behind the T-Rex looking down the track (+X).
 */
export type CameraMode = 'cinematic' | 'side' | 'chase';

export const CAMERA_MODES: readonly CameraMode[] = ['cinematic', 'side', 'chase'];

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly mode: CameraMode;
  /** Smoothly transitions to the new mode. */
  setMode(mode: CameraMode): void;
  /** Funny mode: after a crash the camera closes in on the T-Rex's face. */
  setFunny(on: boolean): void;
  resize(width: number, height: number): void;
  update(curr: GameSnapshot, trex: THREE.Object3D, dtMs: number): void;
  handleEvents(events: GameEvent[]): void;
}

// Factory: src/render/camera.ts export function createCameraRig(initialMode: CameraMode): CameraRig

// ─── HUD (src/ui) ────────────────────────────────────────────────────────────────────────

export interface HudContext {
  cameraMode: CameraMode;
  settings: Readonly<Settings>;
  /** The config panel is open. */
  configOpen: boolean;
  /** Dark theme on. The snapshot's `night` is already remapped for it; this only drives the toggle button. */
  dark: boolean;
  touch: boolean;
  /** Frames per second to show in the corner, or null to hide the counter. */
  fps: number | null;
}

/** One leaderboard row: a player's best verified run. */
export interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  mobile: boolean;
  /** Started fast (Settings.startFast). */
  fast: boolean;
  /** The signed-in player's own row. */
  me: boolean;
}

/** What the HUD shows of the team leaderboard (src/net/ranked.ts builds it). */
export interface BoardView {
  /** off: no leaderboard server (offline, or a static host), so nothing is shown. */
  account: 'off' | 'signedOut' | 'signedIn';
  /** Who is signed in (the config panel shows it). */
  name: string | null;
  email: string | null;
  /** The top rows, plus the player's own row at the end if it is further down. */
  entries: readonly BoardEntry[];
  /** A line under the board on the title and game-over screens (the last run's verdict). */
  note: string;
  /** A line under the score while a run is going (RANKED, or why it is not). */
  live: string;
}

export interface Hud {
  update(s: GameSnapshot, ctx: HudContext): void;
  setBoard(view: BoardView): void;
  handleEvents(events: GameEvent[]): void;
  /** HUD buttons (camera, mute, theme, pause, config) emit UiActions. */
  onAction(cb: (action: UiAction) => void): () => void;
  /** The config panel's controls report edits here. */
  onSettings(cb: (change: Partial<Settings>) => void): () => void;
  dispose(): void;
}

// Factory: src/ui/hud.ts        export function createHud(root: HTMLElement): Hud
