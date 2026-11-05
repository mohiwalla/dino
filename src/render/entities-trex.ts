// The T-Rex view: a mesh whose geometry follows the sim frame, wrapped in a pivot at the
// bottom-centre of the sprite box for a little juice (squash & stretch, speed lean, crash
// recoil). Rotations stay under a few degrees and scaling happens about the feet, so the
// silhouette never strays more than a pixel or two from the sim's collision box.

import * as THREE from 'three';
import { RUNNER, TREX } from '../config';
import { createShuffleBag } from '../shuffle';
import { TREX_SPRITES } from './sprites';
import type { CrownSpot, GameSnapshot, ModelLibrary, TrexFrame } from '../types';

/** Squash & stretch limit, as a fraction of the model's height. */
const MAX_SQUASH = 0.08;
/** Spring velocities (1/s) kicked in by events; peak ≈ impulse / omega. */
const JUMP_STRETCH = 1.5;
const LAND_SQUASH = -1.9;
const CRASH_SQUASH = -1.2;
const SQUASH_OMEGA = 24;
const SQUASH_ZETA = 0.42;
/** Forward lean (radians) at MAX_SPEED. Negative z rotation tips the head toward +X. */
const MAX_LEAN = 0.055;
const LEAN_RATE = 3;
/** Crash recoil: the T-Rex rocks back and settles at a slight backward tilt. */
const CRASH_TILT = 0.06;
const CRASH_KICK = 2.4;
const TILT_OMEGA = 18;
const TILT_ZETA = 0.35;
/**
 * Funny mode's crashes: a different move every time (a shuffle bag, like the sounds), each
 * ending flat out with a bouncy settle, and the T-Rex twitches on every hit of the crash clip.
 *   flop      – a full spin, then onto its back
 *   faceplant – straight over onto its face
 *   launch    – thrown up spinning, landing on its back
 *   pancake   – squashed flat, springing back a little on each hit
 *   topple    – stiff as a board, over onto its side
 *   dizzy     – spins on the spot, wobbles, then keels over backwards
 */
type CrashMove = 'flop' | 'faceplant' | 'launch' | 'pancake' | 'topple' | 'dizzy';
const CRASH_MOVES: readonly CrashMove[] = ['flop', 'faceplant', 'launch', 'pancake', 'topple', 'dizzy'];
const FLOP_TILT = Math.PI / 2;
const FLOP_KICK = 9;
const FLOP_OMEGA = 11;
const FLOP_ZETA = 0.28;
const SPIN_SECONDS = 0.45;
const LAUNCH_SECONDS = 0.8;
const LAUNCH_HEIGHT = 46;
const LAUNCH_TURNS = 2;
const PANCAKE = 0.65;
const PANCAKE_OMEGA = 14;
const PANCAKE_ZETA = 0.3;
const TOPPLE_DELAY = 0.15;
const DIZZY_SECONDS = 1.4;
const DIZZY_TURNS = 3;
/** Half the model's depth as a fraction of its width: how far it lifts lying on its side. */
const HALF_DEPTH = 0.3;
/** On each hit: a squash, a hop (px/s, on a spring) and a twitch of the tilt, alternating sides. */
const BEAT_SQUASH = -1.4;
const BEAT_HOP = 70;
const BEAT_TWITCH = 1.6;
const HOP_OMEGA = 16;
const HOP_ZETA = 0.5;

const easeOut = (p: number): number => p * (2 - p);

/** The move's tilt target (z, + is onto its back) at `t` seconds into the crash. */
function moveTilt(move: CrashMove, t: number): number {
  switch (move) {
    case 'flop':
      return FLOP_TILT;
    case 'faceplant':
      return -FLOP_TILT;
    case 'launch':
      return t < LAUNCH_SECONDS ? 0 : FLOP_TILT;
    case 'dizzy':
      return t < DIZZY_SECONDS ? 0.15 * Math.sin(t * 9) : FLOP_TILT;
    default:
      return 0;
  }
}

/** The move's spin about the vertical axis at `t` seconds into the crash. */
function moveYaw(move: CrashMove, t: number): number {
  switch (move) {
    case 'flop':
      return easeOut(Math.min(1, t / SPIN_SECONDS)) * Math.PI * 2;
    case 'launch':
      return easeOut(Math.min(1, t / LAUNCH_SECONDS)) * Math.PI * 2 * LAUNCH_TURNS;
    case 'dizzy':
      return easeOut(Math.min(1, t / DIZZY_SECONDS)) * Math.PI * 2 * DIZZY_TURNS;
    default:
      return 0;
  }
}
/**
 * Celebration: back on its feet with happy eyes, then a dance on loop until the next run: two
 * hops, a side-to-side sway, a twirling hop and a beat's rest. Times in seconds, heights in px.
 */
const HOP_SECONDS = 0.42;
const HOP_HEIGHT = 16;
const SWAY_START = 2 * HOP_SECONDS;
const SWAY_SECONDS = 1.12;
const SWAY_TILT = 0.2;
const SWAY_BOB = 3;
const TWIRL_START = SWAY_START + SWAY_SECONDS;
const TWIRL_SECONDS = 0.56;
const TWIRL_HEIGHT = 22;
const DANCE_SECONDS = TWIRL_START + TWIRL_SECONDS + 0.3;
/** Landings within one loop of the dance, each kicking in a squash. */
const LANDINGS = [HOP_SECONDS, 2 * HOP_SECONDS, TWIRL_START + TWIRL_SECONDS];
const HOP_SQUASH = -1.6;

/** The dance at `t` seconds into a loop: height above the ground, sway (z) and twirl (y) angles. */
function dance(t: number): { lift: number; sway: number; twirl: number } {
  if (t < SWAY_START) return { lift: HOP_HEIGHT * Math.sin(Math.PI * ((t % HOP_SECONDS) / HOP_SECONDS)), sway: 0, twirl: 0 };
  if (t < TWIRL_START) {
    const p = (t - SWAY_START) / SWAY_SECONDS; // two sways: left, right, left, right
    return { lift: SWAY_BOB * Math.abs(Math.sin(p * Math.PI * 4)), sway: SWAY_TILT * Math.sin(p * Math.PI * 4), twirl: 0 };
  }
  if (t < TWIRL_START + TWIRL_SECONDS) {
    const p = (t - TWIRL_START) / TWIRL_SECONDS;
    return { lift: TWIRL_HEIGHT * Math.sin(Math.PI * p), sway: 0, twirl: p * (2 - p) * Math.PI * 2 };
  }
  return { lift: 0, sway: 0, twirl: 0 };
}

/**
 * The #1 player's crown, after a classic royal crown: a thick base rim, a band, then a wall
 * flaring out into alternating tall and short points, each tipped with a ball. Low-poly and
 * flat-faceted, to sit with the voxel world without being made of voxels itself. The band and wall
 * have real thickness, and the gold is a polished metal reflecting a small built-in studio
 * environment, so it shines as it turns. It hovers just over the head and rides
 * the head's pose (tipping over with it in a crash). Sizes in px.
 */
const CROWN_GOLD = '#ffc24d';
const CROWN_RADIUS = 7;
/** Thickness of the band and the pointed wall. */
const CROWN_THICK = 0.85;
const CROWN_BAND = 2.6;
/** Points around the crown (tall and short alternate), and their heights above the band. */
const CROWN_POINTS = 6;
/** Facets per point along the rim: few, so it reads low-poly like the voxel world, not a detailed model. */
const CROWN_FACETS = 4;
/** Segments round the band and base rim, matching the wall's facets so they meet edge to edge. */
const CROWN_SEGMENTS = CROWN_POINTS * CROWN_FACETS;
const CROWN_TALL = 6.4;
const CROWN_SHORT = 4;
const CROWN_DIP = 1.5;
/** How far the wall flares out at the top of a tall point, as a fraction of the radius. */
const CROWN_FLARE = 0.14;
/** The crown's widest span and full height to the top of its tallest ball (px), for sizing it on screen. */
export const CROWN_WIDTH = 2 * CROWN_RADIUS * (1 + CROWN_FLARE);
export const CROWN_HEIGHT = CROWN_BAND + CROWN_TALL + 2.2;
/** Gap between the top of the head and the crown's base, the bob around it, and its speeds. */
const CROWN_LIFT = 2.7;
const CROWN_BOB = 0.45;
const CROWN_BOB_PER_S = 2.2;
/** One turn in about 18 s. */
const CROWN_TURN_PER_S = 0.35;
/**
 * The crown floats behind the head on a spring: it keeps its place as the head moves and is
 * pulled back over it, so it dips toward the head as a jump rises, drifts up after a landing and
 * floats down after a duck. The lag is kept small (it is a hint, not a distraction).
 */
const CROWN_OMEGA = 20;
const CROWN_ZETA = 0.6;
const CROWN_LAG_UP = 4;
const CROWN_LAG_DOWN = 1.5;
const CROWN_LAG_SIDE = 6;
/**
 * Flights between the head and the crown's resting place by the team board's first place: out
 * when a run starts, in when the player takes (or holds) first place. An arc, sized to the
 * resting crown at the board's end, so the two hand over without a jump.
 */
const CROWN_FLY_SECONDS = 0.8;
const CROWN_FLY_ARC = 14;
/** Showing or hiding, the crown grows in or floats up as it shrinks and fades, over this long. */
const CROWN_FADE_SECONDS = 0.45;
const CROWN_FADE_RISE = 6;

/** Height of the wall's top edge at `angle`: rising to each point, dipping in a curve between. */
function crownEdge(angle: number): number {
  const span = (Math.PI * 2) / CROWN_POINTS;
  const point = Math.floor(angle / span) % CROWN_POINTS;
  const along = (angle / span) % 1; // 0 at this point, 1 at the next
  const here = point % 2 === 0 ? CROWN_TALL : CROWN_SHORT;
  const next = point % 2 === 0 ? CROWN_SHORT : CROWN_TALL;
  // Concave either side of the dip: steep near a point, flattening into the dip.
  return along <= 0.5 ? CROWN_DIP + (here - CROWN_DIP) * (1 - 2 * along) ** 2 : CROWN_DIP + (next - CROWN_DIP) * (2 * along - 1) ** 2;
}

/**
 * The pointed wall as a solid shell: an outer face, an inner face CROWN_THICK further in, and the
 * top edge closing them, so it has body rather than looking like foil. Returns the tips too.
 */
function crownWall(): { faces: THREE.BufferGeometry; edge: THREE.BufferGeometry; tips: THREE.Vector3[] } {
  const SAMPLES = CROWN_SEGMENTS;
  const faces: number[] = [];
  const edge: number[] = [];
  const tips: THREE.Vector3[] = [];
  const at = (angle: number, radius: number, y: number): number[] => [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  for (let k = 0; k <= SAMPLES; k++) {
    const angle = (k / SAMPLES) * Math.PI * 2;
    const h = crownEdge(angle);
    const outer = CROWN_RADIUS * (1 + CROWN_FLARE * (h / CROWN_TALL));
    const inner = outer - CROWN_THICK;
    // Outer bottom, outer top, inner bottom, inner top.
    faces.push(...at(angle, CROWN_RADIUS, CROWN_BAND), ...at(angle, outer, CROWN_BAND + h), ...at(angle, CROWN_RADIUS - CROWN_THICK, CROWN_BAND), ...at(angle, inner, CROWN_BAND + h));
    edge.push(...at(angle, outer, CROWN_BAND + h), ...at(angle, inner, CROWN_BAND + h));
    if (k % CROWN_FACETS === 0 && k < SAMPLES) tips.push(new THREE.Vector3(...at(angle, outer - CROWN_THICK / 2, CROWN_BAND + h)));
  }
  const faceIndex: number[] = [];
  const edgeIndex: number[] = [];
  for (let k = 0; k < SAMPLES; k++) {
    const a = k * 4;
    const b = a + 4;
    faceIndex.push(a, a + 1, b, a + 1, b + 1, b); // outer, facing out
    faceIndex.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3); // inner, facing in
    const e = k * 2;
    edgeIndex.push(e, e + 1, e + 2, e + 1, e + 3, e + 2);
  }
  const build = (positions: number[], index: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
  };
  return { faces: build(faces, faceIndex), edge: build(edge, edgeIndex), tips };
}

/**
 * A tiny equirectangular studio for the gold to reflect: warm light above, a dark floor, and a
 * few bright soft boxes around the horizon, which become the travelling highlights as it turns.
 */
function crownStudio(): THREE.DataTexture {
  const W = 128;
  const H = 64;
  const data = new Uint8Array(W * H * 4);
  const boxes = [
    [0.1, 0.62, 0.08, 0.14],
    [0.32, 0.52, 0.06, 0.1],
    [0.42, 0.7, 0.1, 0.11],
    [0.7, 0.58, 0.06, 0.16],
    [0.88, 0.75, 0.08, 0.09],
  ];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / (H - 1); // 0 = straight down, 1 = straight up
      let l = v < 0.5 ? 0.13 + 0.13 * (v / 0.5) : 0.3 + 0.5 * ((v - 0.5) / 0.5) ** 1.5;
      for (const [bu, bv, bw, bh] of boxes) {
        const du = Math.min(Math.abs(u - bu), 1 - Math.abs(u - bu)) / bw;
        const dv = (v - bv) / bh;
        l += 4 * Math.exp(-(du * du + dv * dv) * 2);
      }
      const i = (y * W + x) * 4;
      const c = Math.min(255, Math.round(255 * l));
      data[i] = c;
      data[i + 1] = Math.round(c * 0.96);
      data[i + 2] = Math.round(c * 0.88);
      data[i + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The crown by day: it reflects a dark studio, which reads too dim against the light scene, so in
 * daylight it gets a warm gold lift and brighter reflections, easing back at night.
 */
const CROWN_DAY_LIFT = 0.25;
const CROWN_DAY_SHINE = 0.3;

/** Brighten a crown's gold for daylight: `night` 0 is full day, 1 full night. */
function lightCrown(crown: THREE.Group, night: number): void {
  const day = 1 - THREE.MathUtils.clamp(night, 0, 1);
  for (const m of crown.userData.metals as THREE.MeshStandardMaterial[]) {
    m.userData.env ??= m.envMapIntensity;
    m.envMapIntensity = m.userData.env * (1 + CROWN_DAY_SHINE * day);
    m.emissive.set(CROWN_GOLD);
    m.emissiveIntensity = CROWN_DAY_LIFT * day;
  }
}

/** The crown's shine: a soft gold glow behind it that breathes, drawn additively so it lights what is behind. */
const GLOW_SIZE = 30;
const GLOW_OPACITY = 0.42;

function createGlow(): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const c = size / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255, 220, 120, 1)');
  grad.addColorStop(0.35, 'rgba(255, 190, 60, 0.45)');
  grad.addColorStop(1, 'rgba(255, 170, 30, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(GLOW_SIZE);
  glow.position.y = CROWN_BAND + CROWN_TALL * 0.4;
  glow.renderOrder = -1;
  return glow;
}

function createCrown(): THREE.Group {
  const crown = new THREE.Group();
  crown.name = 'crown';
  const studio = crownStudio();
  const gold = new THREE.MeshStandardMaterial({ color: CROWN_GOLD, metalness: 1, roughness: 0.08, envMap: studio, envMapIntensity: 2.6, flatShading: true });
  const inside = new THREE.MeshStandardMaterial({ color: CROWN_GOLD, metalness: 1, roughness: 0.45, envMap: studio, envMapIntensity: 0.45, flatShading: true });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    crown.add(mesh);
  };
  const ring = (radius: number, tube: number, y: number): void => add(new THREE.TorusGeometry(radius, tube, 5, CROWN_SEGMENTS).rotateX(Math.PI / 2), gold, 0, y);
  // The band: a thick tube (outside bright, inside dimmer) on a fat rim.
  add(new THREE.CylinderGeometry(CROWN_RADIUS, CROWN_RADIUS, CROWN_BAND, CROWN_SEGMENTS, 1, true).translate(0, CROWN_BAND / 2, 0), gold);
  add(new THREE.CylinderGeometry(CROWN_RADIUS - CROWN_THICK, CROWN_RADIUS - CROWN_THICK, CROWN_BAND, CROWN_SEGMENTS, 1, true).translate(0, CROWN_BAND / 2, 0), inside);
  ring(CROWN_RADIUS - CROWN_THICK / 2, 1.05, 0.2);
  const wall = crownWall();
  add(wall.faces, gold);
  add(wall.edge, gold);
  wall.tips.forEach((tip, i) => {
    const r = i % 2 === 0 ? 1.15 : 0.95;
    add(new THREE.IcosahedronGeometry(r, 0), gold, tip.x, tip.y + r * 0.8, tip.z);
  });
  const glow = createGlow();
  crown.add(glow);
  crown.userData.glow = glow;
  crown.userData.metals = [gold, inside];
  return crown;
}

/** Where a frame's head tops out (mesh coordinates: px from the sprite's left edge and feet). */
function headTop(frame: TrexFrame): { x: number; y: number } {
  const rows = TREX_SPRITES[frame];
  const ducking = frame === 'duck1' || frame === 'duck2';
  const sx = (ducking ? TREX.WIDTH_DUCK : TREX.WIDTH) / rows[0].length;
  const sy = TREX.HEIGHT / TREX_SPRITES.idle.length;
  for (let r = 0; r < rows.length; r++) {
    const cols = [...rows[r]].flatMap((c, i) => (c === 'h' || c === 'o' ? [i] : []));
    if (cols.length > 0) return { x: ((cols[0] + cols[cols.length - 1] + 1) / 2) * sx, y: (rows.length - r) * sy };
  }
  return { x: TREX.WIDTH / 2, y: TREX.HEIGHT };
}

interface Spring {
  x: number;
  v: number;
}

/** Semi-implicit damped spring toward `target`, sub-stepped so large frames stay stable. */
function stepSpring(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (-omega * omega * (s.x - target) - 2 * zeta * omega * s.v) * h;
    s.x += s.v * h;
  }
}

export interface TrexView {
  readonly root: THREE.Group;
  /** `dtMs` is 0 while paused; `fresh` means a restart happened between prev and curr. */
  update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number, fresh: boolean): void;
  jump(): void;
  land(): void;
  crash(): void;
  /** The hits (s) of the crash clip about to play; the next funny crash twitches on them. */
  setCrashBeats(beats: readonly number[]): void;
  /** A replay's crash move, used instead of the bag's (null: the bag again). */
  setCrashMove(move: string | null): void;
  readonly crashMove: string;
  restart(): void;
  /** A rank up or a new best on the game-over screen: stand up and hop for joy until restart. */
  celebrate(): void;
  setFunny(on: boolean): void;
  /** The player is #1 on the team board: wear the crown. */
  setCrown(on: boolean): void;
  /** Place the crowns for this frame; after the camera has moved, since the board's one sits by the camera. */
  placeCrowns(dtMs: number): void;
  /** Fly the crown from the head to its resting place by the board, or from there onto the head. */
  flyCrown(direction: 'out' | 'in', board: () => CrownSpot | null): void;
  /** The crown's resting place by the board's first place (asked every frame), or null while the board is away. */
  setBoardCrown(spot: (() => CrownSpot | null) | null): void;
  dispose(): void;
}

export function createTrexView(models: ModelLibrary): TrexView {
  const root = new THREE.Group();
  root.name = 'trex';
  const pivot = new THREE.Group();
  let frame: TrexFrame = 'idle';
  const mesh = new THREE.Mesh(models.trex(frame), models.materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  pivot.add(mesh);
  root.add(pivot);
  // On the mesh, so it rides every squash, tilt, spin and dance; placed over the head each frame.
  const crown = createCrown();
  crown.visible = false;
  mesh.add(crown);
  let head = headTop(frame);
  /** The crown's lag behind its spot over the head (px), and where that spot was last frame. */
  const lagX: Spring = { x: 0, v: 0 };
  const lagY: Spring = { x: 0, v: 0 };
  let lastSpot: { x: number; y: number } | null = null;
  /** A restart happened since the crowns were last placed (their lag starts over). */
  let crownFresh = false;
  /** Whether the crown should show, and how far it is in (0..1, eased in placeCrown). */
  let wantCrown = false;
  let shown = 0;
  /** A flight to or from the board, or null. */
  let flight: { direction: 'out' | 'in'; t: number; board: () => CrownSpot | null; from: THREE.Vector3; last: CrownSpot | null } | null = null;
  const flyPoint = new THREE.Vector3();
  // The same crown resting by the board's first place: in the root, so it stays upright. Its
  // materials can fade, since it fades with the board.
  const restCrown = createCrown();
  restCrown.visible = false;
  root.add(restCrown);
  const restMaterials = new Set<THREE.Material>();
  restCrown.traverse((o) => {
    if (o instanceof THREE.Mesh) restMaterials.add(o.material as THREE.Material);
  });
  for (const m of restMaterials) m.transparent = true;
  let restSpot: (() => CrownSpot | null) | null = null;

  const squash: Spring = { x: 0, v: 0 };
  const tilt: Spring = { x: 0, v: 0 };
  /** Funny crashes: over onto its side (x rotation), squashed flat (0..1), and hops on the beat (px). */
  const side: Spring = { x: 0, v: 0 };
  const flat: Spring = { x: 0, v: 0 };
  const hop: Spring = { x: 0, v: 0 };
  let lean = 0;
  let crashed = false;
  let funny = false;
  const moves = createShuffleBag(CRASH_MOVES);
  let move: CrashMove = 'flop';
  let forcedMove: CrashMove | null = null;
  /** Seconds into a funny crash, or -1. */
  let crashT = -1;
  /** The hits of the crash clip about to play (set before the crash), and how many have landed. */
  let pendingBeats: readonly number[] = [];
  let beats: readonly number[] = [];
  let beat = 0;
  /** Seconds into the celebration, or -1 when not celebrating. */
  let party = -1;

  function setFrame(next: TrexFrame): void {
    if (next === frame) return;
    frame = next;
    mesh.geometry = models.trex(next);
    head = headTop(next);
  }

  /** Move the crown along its flight; true while one is under way. */
  function flyCrown(dt: number, t: number): boolean {
    if (!flight) return false;
    flight.t = Math.min(1, flight.t + dt / CROWN_FLY_SECONDS);
    const p = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    // The board end, in mesh space (the dino moves under it); the head end where the crown hovers.
    const spot = flight.board() ?? flight.last;
    flight.last = spot;
    root.updateWorldMatrix(true, true);
    const board = spot ? mesh.worldToLocal(flyPoint.copy(spot.point)) : flight.from.clone().add(new THREE.Vector3(60, 60, 0));
    const boardScale = spot?.scale ?? 0.3;
    const rest = new THREE.Vector3(head.x, head.y + CROWN_LIFT, 0);
    const [a, b] = flight.direction === 'out' ? [flight.from, board] : [board, rest];
    crown.position.lerpVectors(a, b, p);
    crown.position.y += CROWN_FLY_ARC * Math.sin(Math.PI * p);
    const toBoard = flight.direction === 'out' ? p : 1 - p;
    crown.scale.setScalar(1 + (boardScale - 1) * toBoard);
    crown.rotation.y = t * CROWN_TURN_PER_S;
    crown.visible = true;
    ((crown.userData.glow as THREE.Sprite).material as THREE.SpriteMaterial).opacity = GLOW_OPACITY;
    if (flight.t >= 1) {
      // Landed: out, the resting crown takes over at the board; in, the crown is on the head.
      shown = flight.direction === 'out' ? 0 : 1;
      crown.visible = shown > 0;
      lagX.x = lagX.v = lagY.x = lagY.v = 0;
      lastSpot = null;
      flight = null;
    }
    return true;
  }

  /** The resting crown by the board: there whenever the board is (and no flight is carrying it), fading with it. */
  function placeRestCrown(t: number): void {
    const spot = flight ? null : (restSpot?.() ?? null);
    restCrown.visible = spot !== null && spot.opacity > 0;
    if (!spot || !restCrown.visible) return;
    root.updateWorldMatrix(true, false);
    restCrown.position.copy(root.worldToLocal(flyPoint.copy(spot.point)));
    restCrown.scale.setScalar(spot.scale);
    restCrown.rotation.y = t * CROWN_TURN_PER_S;
    for (const m of restMaterials) m.opacity = spot.opacity;
    ((restCrown.userData.glow as THREE.Sprite).material as THREE.SpriteMaterial).opacity = GLOW_OPACITY * spot.opacity * (0.8 + 0.2 * Math.sin(t * 2.6));
  }

  /** Hover the crown just over the head, lagging its moves on a spring, bobbing and turning on the wall clock. */
  function placeCrown(dt: number, fresh: boolean): void {
    const now = performance.now() / 1000;
    placeRestCrown(now);
    if (flyCrown(dt, now)) return;
    shown = THREE.MathUtils.clamp(shown + (wantCrown ? 1 : -1) * (dt / CROWN_FADE_SECONDS), 0, 1);
    crown.visible = shown > 0;
    if (!crown.visible) {
      lastSpot = null;
      return;
    }
    // Where the spot over the head is in the scene (enough to tell how far it moved).
    const spot = { x: root.position.x + head.x, y: root.position.y + pivot.position.y + head.y };
    if (lastSpot && !fresh && dt > 0) {
      lagX.x -= spot.x - lastSpot.x;
      lagY.x -= spot.y - lastSpot.y;
      stepSpring(lagX, 0, CROWN_OMEGA, CROWN_ZETA, dt);
      stepSpring(lagY, 0, CROWN_OMEGA, CROWN_ZETA, dt);
      lagX.x = THREE.MathUtils.clamp(lagX.x, -CROWN_LAG_SIDE, CROWN_LAG_SIDE);
      lagY.x = THREE.MathUtils.clamp(lagY.x, -CROWN_LAG_DOWN, CROWN_LAG_UP);
    } else if (fresh) {
      lagX.x = lagX.v = lagY.x = lagY.v = 0;
    }
    lastSpot = spot;
    const t = performance.now() / 1000;
    // Smoothstep in and out; leaving, it also floats up as it goes.
    const s = shown * shown * (3 - 2 * shown);
    const rise = wantCrown ? 0 : (1 - s) * CROWN_FADE_RISE;
    crown.position.set(head.x + lagX.x, head.y + CROWN_LIFT + lagY.x + rise + CROWN_BOB * Math.sin(t * CROWN_BOB_PER_S), 0);
    crown.scale.setScalar(Math.max(0.001, s));
    crown.rotation.y = t * CROWN_TURN_PER_S;
    ((crown.userData.glow as THREE.Sprite).material as THREE.SpriteMaterial).opacity = GLOW_OPACITY * s * (0.8 + 0.2 * Math.sin(t * 2.6));
  }

  function updateJuice(curr: GameSnapshot, dt: number): void {
    const playing = curr.phase === 'playing';
    stepSpring(squash, 0, SQUASH_OMEGA, SQUASH_ZETA, dt);
    squash.x = THREE.MathUtils.clamp(squash.x, -MAX_SQUASH, MAX_SQUASH);
    if (party >= 0) {
      const before = party % DANCE_SECONDS;
      party += dt;
      const now = party % DANCE_SECONDS;
      // Each landing gets a squash, like a real jump.
      for (const at of LANDINGS) if (now < before ? before < at || now >= at : before < at && now >= at) squash.v += HOP_SQUASH;
    }
    const acting = crashT >= 0 && party < 0;
    if (acting) {
      crashT += dt;
      for (; beat < beats.length && crashT >= beats[beat]; beat++) {
        squash.v += BEAT_SQUASH;
        hop.v += BEAT_HOP;
        tilt.v += (beat % 2 === 0 ? 1 : -1) * BEAT_TWITCH;
        if (move === 'pancake') flat.v -= 3;
      }
    }
    if (party >= 0) stepSpring(tilt, 0, TILT_OMEGA, TILT_ZETA, dt);
    else if (acting) stepSpring(tilt, moveTilt(move, crashT), FLOP_OMEGA, FLOP_ZETA, dt);
    else stepSpring(tilt, crashed ? CRASH_TILT : 0, TILT_OMEGA, TILT_ZETA, dt);
    stepSpring(side, acting && move === 'topple' && crashT > TOPPLE_DELAY ? FLOP_TILT : 0, FLOP_OMEGA, FLOP_ZETA, dt);
    stepSpring(flat, acting && move === 'pancake' ? 1 : 0, PANCAKE_OMEGA, PANCAKE_ZETA, dt);
    stepSpring(hop, 0, HOP_OMEGA, HOP_ZETA, dt);

    const speedT = THREE.MathUtils.clamp((curr.speed - RUNNER.SPEED) / (RUNNER.MAX_SPEED - RUNNER.SPEED), 0, 1);
    const leanTarget = playing ? -MAX_LEAN * speedT * speedT : 0;
    lean += (leanTarget - lean) * (1 - Math.exp(-LEAN_RATE * dt));
  }

  return {
    root,

    update(prev, curr, alpha, dtMs, fresh) {
      lightCrown(crown, curr.night);
      lightCrown(restCrown, curr.night);
      const a = fresh ? 1 : alpha;
      const t0 = prev.trex;
      const t1 = curr.trex;
      root.position.set(t0.x + (t1.x - t0.x) * a, t0.y + (t1.y - t0.y) * a, 0);
      setFrame(t1.frame);

      if (dtMs > 0) updateJuice(curr, dtMs / 1000);
      const halfW = t1.width / 2;
      pivot.position.x = halfW;
      mesh.position.x = -halfW;
      const s = squash.x;
      const f = Math.max(0, flat.x) * PANCAKE;
      pivot.scale.set((1 - s * 0.5) * (1 + f * 0.5), (1 + s) * (1 - f), (1 - s * 0.5) * (1 + f * 0.5));
      pivot.rotation.z = lean + tilt.x;
      pivot.rotation.x = side.x;
      const acting = crashT >= 0 && party < 0;
      // Lying down rotates the model about its feet; lift it so it rests on the ground.
      pivot.position.y = funny
        ? halfW * Math.abs(Math.sin(tilt.x)) + t1.width * HALF_DEPTH * Math.abs(Math.sin(side.x)) + Math.max(0, hop.x)
        : 0;
      if (acting && move === 'launch') pivot.position.y += LAUNCH_HEIGHT * Math.sin(Math.PI * Math.min(1, crashT / LAUNCH_SECONDS));
      pivot.rotation.y = acting ? moveYaw(move, crashT) : 0;
      if (party >= 0) {
        const d = dance(party % DANCE_SECONDS);
        setFrame('happy');
        pivot.position.y += d.lift;
        pivot.rotation.z += d.sway;
        pivot.rotation.y = d.twirl;
      }
      crownFresh ||= fresh;
    },

    placeCrowns(dtMs) {
      placeCrown(dtMs / 1000, crownFresh);
      crownFresh = false;
    },

    jump() {
      squash.v += JUMP_STRETCH;
    },

    land() {
      squash.v += LAND_SQUASH;
    },

    crash() {
      crashed = true;
      squash.v += CRASH_SQUASH;
      beats = pendingBeats;
      pendingBeats = [];
      beat = 0;
      if (!funny) {
        tilt.v += CRASH_KICK;
        return;
      }
      move = forcedMove ?? moves.next();
      crashT = 0;
      if (move === 'flop') tilt.v += FLOP_KICK;
      else if (move === 'faceplant') tilt.v -= FLOP_KICK;
    },

    setCrashBeats(next) {
      pendingBeats = next;
    },

    setCrashMove(next) {
      forcedMove = CRASH_MOVES.find((m) => m === next) ?? null;
    },

    get crashMove() {
      return move;
    },

    celebrate() {
      // Can land just before the crash itself reaches the view; the crash then only kicks the tilt.
      if (party >= 0) return;
      party = 0;
    },

    restart() {
      crashed = false;
      crashT = -1;
      party = -1;
      // From a funny crash, back on its feet at once rather than springing up from flat.
      if (Math.abs(tilt.x) > CRASH_TILT * 2) {
        tilt.x = 0;
        tilt.v = 0;
      }
      for (const s of [side, flat, hop]) s.x = s.v = 0;
    },

    setFunny(on) {
      funny = on;
    },

    setCrown(on) {
      wantCrown = on;
    },

    flyCrown(direction, board) {
      if (direction === 'out' && shown === 0) return;
      // In, it takes off from the resting crown's spot (which hides while it flies).
      flight = { direction, t: 0, board, from: crown.position.clone(), last: null };
      wantCrown = direction === 'in';
      crown.visible = true;
    },

    setBoardCrown(spot) {
      restSpot = spot;
    },

    dispose() {
      root.removeFromParent();
    },
  };
}
