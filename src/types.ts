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

/** 'happy' (^ ^ eyes) is the renderer's own, for celebrating; the sim never uses it. */
export type TrexFrame = 'idle' | 'blink' | 'run1' | 'run2' | 'duck1' | 'duck2' | 'jump' | 'crashed' | 'happy';

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
  /** Cacti side by side (1..3). Pterodactyls: 1, or 2 for a duck-only stacked pair (OBSTACLES.pterodactyl.stackGap apart). */
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
  /** Chrome's obstacle rules (no birds below 8.5, an even pick, no stacked pairs): runs recorded before SIM_VERSION 3. */
  classicObstacles?: boolean;
}

// Factory: src/sim/game.ts      export function createGameSim(opts?: GameSimOptions): GameSim
// Bot:     src/sim/autopilot.ts export function autopilot(s: GameSnapshot): InputFrame
//          (a stateless bot that clears obstacles; used by ?autoplay and by tests)

// ─── Input (src/input) ───────────────────────────────────────────────────────────────────

/** Non-gameplay actions, routed by main.ts. */
/** escape is the Escape key: like togglePause, except it alone can call off a resume countdown. */
export type UiAction = 'toggleCamera' | 'toggleMute' | 'togglePause' | 'escape' | 'toggleDebug' | 'toggleTheme' | 'toggleConfig' | 'signOut' | 'deleteStats' | 'starLater' | 'starDone';

/** regular: Chrome's runner. funny: meme crash clips (and the flop and game-over lines that go with them). */
export type GameMode = 'regular' | 'funny';

/** Everything the config panel edits. main.ts owns and persists it. */
export interface Settings {
  /** Sound effects volume, 0..1. */
  volume: number;
  muted: boolean;
  /** Submit runs to the team leaderboard while signed in. */
  ranked: boolean;
  /** Game speed multiplier (one of MULTIPLIERS), from the next run on. Ranked as usual, tagged on the board. */
  multiplier: number;
  /** Show the team board on the title and game-over screens. */
  showBoard: boolean;
  /** Which team board shows: all time, or this week's. */
  boardPeriod: 'all' | 'week';
  mode: GameMode;
  /** Jumps fart, with a cloud. A funny-mode option: it only counts in funny mode. */
  farts: boolean;
  /** Funny mode's crash clips come only from the NSFW set. */
  nsfw: boolean;
  /** Chrome's night every so often. Off, the chosen theme (D) stays put. */
  dayNight: boolean;
}

/** What the player saw that their settings and controls decide (all but sound), at one moment of a run. */
export interface LookState {
  mode: GameMode;
  farts: boolean;
  nsfw: boolean;
  dayNight: boolean;
  dark: boolean;
  camera: CameraView;
}

/**
 * How a run looked and sounded to its player, saved with a ranked run so its replay shows exactly
 * the same: their look as the run started and every change to it after (settings, theme, camera
 * switches and drags), and what came up at random (the crash clip, the game-over line, the crash
 * move, and a seed for the fart sounds). Only the viewer's sound level and mute are their own.
 */
export interface RunLook extends LookState {
  /** Changes to the look: [steps into the run, the fields that changed]. */
  changes: [number, Partial<LookState>][];
  /** The high score on screen as the run started. */
  hi: number;
  /** The T-Rex wore a crown (its player was in the top 3) as the run started; it flew off to the board. */
  crown: boolean;
  /** Which one: the player's place (1 gold, 2 silver, 3 bronze). Missing on runs from before silver and bronze: gold. */
  place?: CrownPlace;
  /** Seeds the fart sounds' order and pitch for the run. */
  fx: number;
  /** The crash clip's URL; empty when the crash sound was synthesised. */
  clip: string;
  /** Funny mode's game-over line. */
  line: string;
  /** Funny mode's crash move. */
  move: string;
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
  /** Subscribe to camera-orbit drags (middle-drag, Ctrl/Cmd + Shift + drag, two fingers), in CSS px moved. */
  onOrbit(cb: (dx: number, dy: number) => void): () => void;
  /**
   * How long a first finger waits to see if a second follows (a two-finger orbit rather than a
   * tap). 0 means taps count at once: main.ts sets it on menus only, so taps in a run stay instant.
   */
  setGestureWindow(ms: number): void;
  /** True if the most recent input came from a touch screen (hints switch from "Space" to "Tap"). */
  readonly touch: boolean;
  dispose(): void;
}

// Factory: src/input/input.ts   export function createInput(): InputController
// Listens on window. Pointer/touch presses on elements marked [data-ui] (HUD buttons) are
// ignored for gameplay; everything else on the page is the play surface.

// ─── Audio (src/audio) ───────────────────────────────────────────────────────────────────

/** fart is the farts setting's jump, slide funny mode's crash (src/audio/funny.ts). */
export type SfxName = 'jump' | 'milestone' | 'crash' | 'victory' | 'fart' | 'slide';

export interface Sfx {
  play(name: SfxName): void;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  /** 0..1. */
  readonly volume: number;
  setVolume(volume: number): void;
  /** Resume the AudioContext; call from a user gesture. Safe to call repeatedly. */
  unlock(): void;
  /** Fetch the recorded farts and crash clips ahead of the first jump; `nsfw` picks the crash clip set. */
  preloadFunny(nsfw: boolean): void;
  /** Cut funny mode's crash clip short (a new run started). */
  stopFunny(): void;
  /** The hits (s) of the crash clip the last play('slide') started, for the crash to move to; empty otherwise. */
  readonly crashBeats: readonly number[];
  /** The URL of the crash clip the last play('slide') started; empty if it was synthesised. */
  readonly crashClip: string;
  /** A replay: crashes play this clip (fetched now) instead of the bag's; '' plays the synthesised sound, as its player heard. */
  queueCrash(url: string): void;
  /** The queued clip has loaded (or failed to, or there's no audio): the replay can start without missing it. */
  readonly crashReady: boolean;
  /** Fart sounds come in an order and pitch set by `seed`, so a replay hears the run's own. */
  seedFarts(seed: number): void;
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
/** A place on the team board with a crown: 1 gold, 2 silver, 3 bronze. */
export type CrownPlace = 1 | 2 | 3;
export const CROWN_PLACES: readonly CrownPlace[] = [1, 2, 3];

/** Where a board's crown rests: a point in the scene, and the scale that makes it the right size on screen. */
export interface CrownSpot {
  point: THREE.Vector3;
  scale: number;
  /** The board's own opacity (it fades out after a run starts); the crown fades with it. */
  opacity: number;
}

export interface Entities {
  /** The T-Rex's root object (its position is the interpolated sim position). The camera follows it. */
  readonly trex: THREE.Object3D;
  update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number): void;
  handleEvents(events: GameEvent[]): void;
  /** Draw sim collision boxes as wireframes. */
  setDebug(on: boolean): void;
  /** Funny mode: a different slapstick crash every time, twitching on the crash clip's hits. Cosmetic only. */
  setFunny(on: boolean): void;
  /** The hits (s) of the crash clip that just started, for the crash about to be shown. */
  setCrashBeats(beats: readonly number[]): void;
  /** A replay: funny crashes do this move instead of the next one in the bag (null: back to the bag). */
  setCrashMove(move: string | null): void;
  /** The last funny crash's move. */
  readonly crashMove: string;
  /** The player is in the top 3 of the team board: the T-Rex wears that place's crown (null: none). */
  setCrown(place: CrownPlace | null): void;
  /** Fly the crown it wears from the head to its resting place by the board, or from there onto the head. */
  flyCrown(direction: 'out' | 'in', board: () => CrownSpot | null): void;
  /** Each place's crown's resting place by its row of the board (asked every frame), null while that row or the board is away. */
  setBoardCrown(spot: ((place: CrownPlace) => CrownSpot | null) | null): void;
  /** Place the crowns for this frame. Call after the camera has moved: the board's ones sit just in front of it. */
  placeCrowns(dtMs: number): void;
  /** Fart clouds on jumps. Cosmetic only. */
  setFarts(on: boolean): void;
  /** A rank up or a new best: the T-Rex gets up and hops for joy until the next run. */
  celebrate(): void;
  dispose(): void;
}

// Factory: src/render/entities.ts export function createEntities(scene: THREE.Scene, models: ModelLibrary): Entities

/**
 * cinematic – default: three-quarter view from the side and slightly behind and above.
 * side      – the classic 2D Chrome framing: square-on side view, low FOV, far away.
 */
export type CameraMode = 'cinematic' | 'side';

export const CAMERA_MODES: readonly CameraMode[] = ['cinematic', 'side'];

/** Where the camera looks: a preset, and (custom) the player's orbit from it, in radians. */
export interface CameraView {
  mode: CameraMode;
  custom: boolean;
  yaw: number;
  pitch: number;
}

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly mode: CameraMode;
  /** The view is the player's custom one (a preset turned by a camera drag). */
  readonly custom: boolean;
  /** The view as it stands, for a ranked run's replay. */
  readonly view: CameraView;
  /** A replay: the camera takes this view, following orbit changes as a drag would. */
  setView(view: CameraView): void;
  /** Smoothly transitions to the new mode (a preset; leaves the custom view). */
  setMode(mode: CameraMode): void;
  /** The camera button / C: cinematic, side, then the custom view if the player has made one. */
  cycle(): void;
  /** Funny mode: after a crash the camera closes in on the T-Rex's face. */
  setFunny(on: boolean): void;
  /** A rank up or a new best: the camera closes in and slowly circles the dancing T-Rex until restart. */
  celebrate(): void;
  /** Turn the view around its target by these angles (radians), like a middle-drag in Blender; kept until the mode changes. */
  orbit(dYaw: number, dPitch: number): void;
  resize(width: number, height: number): void;
  update(curr: GameSnapshot, trex: THREE.Object3D, dtMs: number): void;
  handleEvents(events: GameEvent[]): void;
}

// Factory: src/render/camera.ts export function createCameraRig(initialMode: CameraMode): CameraRig

// ─── HUD (src/ui) ────────────────────────────────────────────────────────────────────────

export interface HudContext {
  cameraMode: CameraMode;
  /** The view was orbited away from the mode's angle: the camera button says CUSTOM. */
  cameraCustom: boolean;
  settings: Readonly<Settings>;
  /** The config panel is open. */
  configOpen: boolean;
  /** The prompt to star the repo on GitHub is open. */
  starOpen: boolean;
  /** Dark theme on. The snapshot's `night` is already remapped for it; this only drives the toggle button. */
  dark: boolean;
  touch: boolean;
  /** Frames per second to show in the corner, or null to hide the counter. */
  fps: number | null;
  /** Paused and counting down to resume: the number to show (3, 2, 1), else null. */
  resumeIn: number | null;
  /**
   * A replay: loading, playing (by itself), or over (it stays on its game-over screen, where a press
   * watches it again). 'off' outside replays.
   */
  replay: 'off' | 'loading' | 'playing' | 'over';
  /** The mode the run is shown in: the setting's, but always regular in a replay. */
  mode: GameMode;
}

/** One leaderboard row: a player's best verified run. */
export interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  mobile: boolean;
  /** Started fast (the old fast mode; runs from before the multiplier). */
  fast: boolean;
  /** The game speed multiplier it was played at (Settings.multiplier). */
  multiplier: number;
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
  /** The same for this week (Monday to Sunday, India time). */
  week: readonly BoardEntry[];
  /** Last week's top 3 while they are news (the first days of a week), else empty. */
  lastWeek: readonly BoardEntry[];
  /** A line under the board on the title and game-over screens (the last run's verdict). */
  note: string;
  /** A line under the score while a run is going (RANKED, or why it is not). */
  live: string;
  /** The player's last ranked run set a new best: their rank before (null: not on the board) and now. Cleared after one view. */
  newBest: { from: number | null; to: number } | null;
  /** The player just deleted their stats, so their row leaves the board. Cleared after one view. */
  statsDeleted: object | null;
}

export interface Hud {
  update(s: GameSnapshot, ctx: HudContext): void;
  setBoard(view: BoardView): void;
  /** Keep the board on screen for `ms` after a run starts (fading out at the end), for the crown to fly back into. */
  lingerBoard(ms: number): void;
  /** Where a place's crown rests by its row of the board on screen (CSS px: the right edge of its spot, the letters' baseline and height) and the board's opacity, or null while that row isn't shown. */
  crownRest(place: CrownPlace): { right: number; baseline: number; height: number; opacity: number } | null;
  /** Confetti over the game, for a rank up or a new best. */
  celebrate(): void;
  /** A replay: funny game overs show this line instead of a random one (null: random again). */
  setCrashLine(line: string | null): void;
  /** The last funny game over's line. */
  readonly crashLine: string;
  handleEvents(events: GameEvent[]): void;
  /** HUD buttons (camera, mute, theme, pause, config) emit UiActions. */
  onAction(cb: (action: UiAction) => void): () => void;
  /** The config panel's controls report edits here. */
  onSettings(cb: (change: Partial<Settings>) => void): () => void;
  dispose(): void;
}

// Factory: src/ui/hud.ts        export function createHud(root: HTMLElement): Hud
