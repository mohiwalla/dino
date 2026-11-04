// Every tunable number in the game. Values marked "Chrome" come from Chromium's offline
// T-Rex runner (components/neterror/resources/dino_game) and are in Chrome sprite pixels
// ("px") and px-per-frame at 60 fps. See src/types.ts for the coordinate conventions.

export const SIM = {
  FPS: 60,
  /** One fixed simulation step == one Chrome animation frame. */
  STEP_MS: 1000 / 60,
  /** Cap on catch-up steps per rendered frame, so a stalled tab does not spiral. */
  MAX_STEPS_PER_FRAME: 5,
} as const;

/** Chrome Runner.config, plus our 3D spawn window. */
export const RUNNER = {
  SPEED: 6,
  MAX_SPEED: 13,
  /** Added to the speed every frame until MAX_SPEED. */
  ACCELERATION: 0.001,
  /** Chrome multiplies speed by this on mobile-width screens. We leave it off (see GameSimOptions.mobile). */
  MOBILE_SPEED_COEFFICIENT: 1.2,
  GAP_COEFFICIENT: 0.6,
  MAX_GAP_COEFFICIENT: 1.5,
  /** No obstacles for this long after a run starts (ms). */
  CLEAR_TIME: 3000,
  /** After a crash, restart input is ignored for this long (ms). */
  GAMEOVER_CLEAR_TIME: 750,
  MAX_OBSTACLE_LENGTH: 3,
  MAX_OBSTACLE_DUPLICATION: 2,
  /**
   * Our "virtual canvas width". Chrome spawns obstacles at the right edge of a 600 px canvas;
   * a 3D camera can see much further, so new obstacles appear this far ahead of the T-Rex
   * (fog hides the pop-in) and the Chrome gap rule is applied against this edge instead.
   */
  SPAWN_X: 1100,
  /** Obstacles are dropped once their right edge is behind this x. */
  DESPAWN_X: -220,
} as const;

/**
 * Chrome Trex.config, converted to y-up. Heights are measured from the ground (y = 0)
 * to the T-Rex's feet; velocities are px/frame with + meaning up.
 */
export const TREX = {
  /** Left edge of the T-Rex sprite box. The world scrolls past it; it never moves in x while running. */
  START_X: 0,
  WIDTH: 44,
  HEIGHT: 47,
  WIDTH_DUCK: 59,
  HEIGHT_DUCK: 25,
  GRAVITY: 0.6,
  /** Jump starts with vy = INITIAL_JUMP_VELOCITY + speed / 10. */
  INITIAL_JUMP_VELOCITY: 10,
  /** Releasing jump (once MIN_JUMP_HEIGHT is reached) clamps upward vy to at most this. */
  DROP_VELOCITY: 5,
  /** Chrome: groundYPos(93) - MIN_JUMP_HEIGHT(30) in canvas coords -> 30 px above ground. */
  MIN_JUMP_HEIGHT: 30,
  /** Chrome: groundYPos(93) - MAX_JUMP_HEIGHT(30) in canvas coords -> 63 px above ground. */
  MAX_JUMP_HEIGHT: 63,
  /** While speed-dropping, gravity is multiplied by this. Speed drop sets vy to -1 immediately. */
  SPEED_DROP_COEFFICIENT: 3,
  /** Idle blink: random wait in [0, BLINK_TIMING) ms between blinks. */
  BLINK_TIMING: 7000,
  BLINK_DURATION_MS: 1000 / 3,
  RUN_FRAME_MS: 1000 / 12,
  DUCK_FRAME_MS: 1000 / 8,
  /**
   * Chrome collision boxes, in sprite-local canvas coords: (x, y) is the box's top-left
   * measured from the sprite's top-left, y grows DOWN. Convert before use in y-up space.
   */
  COLLISION_RUNNING: [
    { x: 22, y: 0, w: 17, h: 16 },
    { x: 1, y: 18, w: 30, h: 9 },
    { x: 10, y: 35, w: 14, h: 8 },
    { x: 1, y: 24, w: 29, h: 5 },
    { x: 5, y: 30, w: 21, h: 4 },
    { x: 9, y: 34, w: 15, h: 4 },
  ],
  /** Chrome's ducking box is relative to the 47 px tall standing sprite top; its bottom sits at 43. */
  COLLISION_DUCKING: [{ x: 1, y: 18, w: 55, h: 25 }],
} as const;

export type ObstacleTypeConfig = {
  readonly width: number;
  readonly height: number;
  /** Possible heights of the obstacle's bottom above the ground, y-up px. */
  readonly yUp: readonly number[];
  /** Same, for touch devices (Chrome's yPosMobile): no mid-height pterodactyls since there is no duck button. */
  readonly yUpMobile: readonly number[];
  /** Groups of 2-3 are only allowed once speed >= multipleSpeed. */
  readonly multipleSpeed: number;
  /** Obstacle type is only chosen once speed >= minSpeed. */
  readonly minSpeed: number;
  readonly minGap: number;
  /** Pterodactyls fly at speed +/- speedOffset relative to the ground. */
  readonly speedOffset: number;
  readonly numFrames: number;
  readonly frameMs: number;
  /** Chrome collision boxes for a single obstacle, sprite-local, y-down from the sprite's top-left. */
  readonly collision: readonly { x: number; y: number; w: number; h: number }[];
};

/** Chrome Obstacle.types. Canvas yPos values (105/90 for cacti; 100/75/50 for the pterodactyl) are converted to y-up. */
export const OBSTACLES = {
  cactusSmall: {
    width: 17,
    height: 35,
    yUp: [0],
    yUpMobile: [0],
    multipleSpeed: 4,
    minSpeed: 0,
    minGap: 120,
    speedOffset: 0,
    numFrames: 1,
    frameMs: 0,
    collision: [
      { x: 0, y: 7, w: 5, h: 27 },
      { x: 4, y: 0, w: 6, h: 34 },
      { x: 10, y: 4, w: 7, h: 14 },
    ],
  },
  cactusLarge: {
    width: 25,
    height: 50,
    yUp: [0],
    yUpMobile: [0],
    multipleSpeed: 7,
    minSpeed: 0,
    minGap: 120,
    speedOffset: 0,
    numFrames: 1,
    frameMs: 0,
    collision: [
      { x: 0, y: 12, w: 7, h: 38 },
      { x: 8, y: 0, w: 7, h: 49 },
      { x: 13, y: 10, w: 10, h: 38 },
    ],
  },
  pterodactyl: {
    width: 46,
    height: 40,
    yUp: [0, 25, 50],
    yUpMobile: [0, 50],
    multipleSpeed: 999,
    minSpeed: 8.5,
    minGap: 150,
    speedOffset: 0.8,
    numFrames: 2,
    frameMs: 1000 / 6,
    collision: [
      { x: 15, y: 15, w: 16, h: 5 },
      { x: 18, y: 21, w: 24, h: 6 },
      { x: 2, y: 14, w: 4, h: 3 },
      { x: 6, y: 10, w: 4, h: 7 },
      { x: 10, y: 8, w: 6, h: 9 },
    ],
  },
} as const satisfies Record<string, ObstacleTypeConfig>;

/** Number of distinct voxel models per cactus kind; the sim picks variant indices in [0, count). */
export const CACTUS_VARIANTS = { cactusSmall: 3, cactusLarge: 3 } as const;

/** Chrome DistanceMeter.config. score = round(distance * COEFFICIENT). */
export const SCORE = {
  COEFFICIENT: 0.025,
  ACHIEVEMENT_DISTANCE: 100,
  /** The score blinks FLASH_ITERATIONS times, each blink is FLASH_DURATION_MS hidden + FLASH_DURATION_MS shown. */
  FLASH_DURATION_MS: 1000 / 4,
  FLASH_ITERATIONS: 3,
  MAX_DIGITS: 5,
} as const;

/** Chrome night mode: every INVERT_DISTANCE points the scene inverts for INVERT_FADE_DURATION ms. */
export const NIGHT = {
  INVERT_DISTANCE: 700,
  INVERT_FADE_DURATION: 12000,
  /** How long the day<->night colour blend takes (Chrome's CSS filter transition). */
  TRANSITION_MS: 1500,
  MOON_PHASES: 7,
} as const;

/** Monochrome Chrome palette. Night is Chrome's CSS invert(1) of the day colours. */
export const PALETTE = {
  day: {
    bg: '#f7f7f7',
    ink: '#535353',
    eye: '#f7f7f7',
    ground: '#efefef',
    groundDetail: '#535353',
    cloud: '#dfdfdf',
  },
  night: {
    bg: '#080808',
    ink: '#acacac',
    eye: '#080808',
    ground: '#101010',
    groundDetail: '#acacac',
    cloud: '#2b2b2b',
    moon: '#f4f4f4',
    star: '#ffffff',
  },
} as const;

/**
 * Voxel material slots shared by every voxel model. A voxel value of N renders with
 * material index N - 1 (see src/render/voxel.ts).
 */
export const SLOT = {
  INK: 1,
  EYE: 2,
} as const;

export const STORAGE_KEYS = {
  highScore: 'dino3d.highScore',
  muted: 'dino3d.muted',
  cameraMode: 'dino3d.cameraMode',
  theme: 'dino3d.theme',
  volume: 'dino3d.volume',
  /** "0" when the player turned ranked runs off in the config panel. */
  ranked: 'dino3d.ranked',
  /** "0" when the player hid the team board. */
  showBoard: 'dino3d.showBoard',
  mode: 'dino3d.mode',
  /** The last leaderboard and account seen, shown at once on the next load. */
  board: 'dino3d.board',
} as const;
