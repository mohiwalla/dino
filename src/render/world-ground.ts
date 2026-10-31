// The ground: a huge shadow-receiving plane that melts into the fog, Chrome's horizon line
// reinterpreted as a thin raised ink line just behind the lane (with its little bumps), and
// hash-scattered specks, pebbles, rocks, dune ridges and distant mesas that scroll with the
// world's forward motion.

import * as THREE from 'three';
import { BUMP_VARIANTS, MESA_VARIANTS, bumpGeometry, duneGeometry, mesaGeometry, pebbleGeometry, rockGeometry, unitVoxelGeometry } from './world-shapes';
import { type ItemRandom, type Placement, type ScatterLayer, type ScatterSpec, createScatterLayer } from './world-scatter';
import { createHeightHazeMaterial } from './world-haze';

const LINE_Z = -20;
const LINE_DEPTH = 1.6;
const LINE_HEIGHT = 1;
const LINE_HALF_LENGTH = 4000;

/** Near decorations are drawn in this world-x window; beyond it the fog has them. */
const NEAR_X_MIN = -450;
const NEAR_X_MAX = 1400;
/** Far horizon mesas: they scroll slower than the ground and sink into the horizon at the window ends. */
const MESA_PARALLAX = 0.15;
const MESA_X_MIN = -2600;
const MESA_X_MAX = 3800;
const MESA_HAZE = 0.64;
/** Night skies are dark: light (inverted) mesas need more haze to stay a whisper. */
const MESA_HAZE_NIGHT = 0.8;
const MESA_HAZE_HEIGHT = 32;
/** Pebbles and rocks are softer than the lane ink: their colour leans this far toward the ground. */
const PEBBLE_TONE = 0.3;
const ROCK_TONE = 0.55;
/**
 * Dune ridges are ground-coloured relief: tops match the lit ground, and only DUNE_LIT of the
 * colour responds to light, so their flanks stay soft (no grey slabs in the side view).
 */
const DUNE_TONE = 0.97;
const DUNE_LIT = 0.35;

const QUARTER = Math.PI / 2;

export interface GroundColors {
  /** Ground plane material colour (already divided by `topFactor`, so it reads as `groundLit`). */
  ground: THREE.Color;
  /** The colour lit ground should read as. */
  groundLit: THREE.Color;
  /** Light on an unshadowed top face (irradiance / PI), per channel. */
  topFactor: THREE.Color;
  /** Ink for the line, specks, pebbles and rocks. */
  detail: THREE.Color;
  sky: THREE.Color;
  /** Night amount in [0, 1]. */
  night: number;
}

export interface WorldGround {
  /** `scroll`: total forward motion in px (the interpolated sim distance, kept monotonic). */
  update(scroll: number, colors: GroundColors): void;
  dispose(): void;
}

export function createGround(scene: THREE.Scene): WorldGround {
  const root = new THREE.Group();
  root.name = 'world.ground';
  scene.add(root);

  const groundMat = new THREE.MeshLambertMaterial();
  const duneMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const detailMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const pebbleMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesa = createHeightHazeMaterial(MESA_HAZE, MESA_HAZE_HEIGHT);

  const planeGeo = new THREE.PlaneGeometry(16000, 12000).rotateX(-Math.PI / 2);
  const plane = new THREE.Mesh(planeGeo, groundMat);
  plane.name = 'world.groundPlane';
  plane.position.set(2000, 0, -3000);
  plane.receiveShadow = true;
  root.add(plane);

  const unit = unitVoxelGeometry();
  const line = new THREE.Mesh(unit, detailMat);
  line.name = 'world.horizonLine';
  line.position.set(-LINE_HALF_LENGTH, 0, LINE_Z);
  line.scale.set(LINE_HALF_LENGTH * 2, LINE_HEIGHT, LINE_DEPTH);
  line.receiveShadow = true;
  root.add(line);

  const geometries: THREE.BufferGeometry[] = [planeGeo, unit];
  const own = <T extends THREE.BufferGeometry>(g: T): T => (geometries.push(g), g);
  const near = (spec: Omit<ScatterSpec, 'xMin' | 'xMax' | 'material'> & { material?: THREE.Material }): ScatterSpec => ({
    xMin: NEAR_X_MIN,
    xMax: NEAR_X_MAX,
    material: detailMat,
    receiveShadow: true,
    ...spec,
  });

  const specs: ScatterSpec[] = [
    near({ name: 'specks', geometry: unit, seed: 11, cell: 7, perCell: 2, place: placeSpeck }),
    near({ name: 'pebblesA', geometry: own(pebbleGeometry(0)), material: pebbleMat, seed: 23, cell: 40, perCell: 2, castShadow: true, place: placePebble }),
    near({ name: 'pebblesB', geometry: own(pebbleGeometry(1)), material: pebbleMat, seed: 37, cell: 52, perCell: 2, castShadow: true, place: placePebble }),
    near({ name: 'rocks', geometry: own(rockGeometry()), material: rockMat, seed: 41, cell: 240, perCell: 1, castShadow: true, place: placeRock }),
    near({ name: 'dunes', geometry: own(duneGeometry()), material: duneMat, seed: 53, cell: 230, perCell: 1, castShadow: true, place: placeDune }),
  ];
  for (let v = 0; v < BUMP_VARIANTS; v++)
    specs.push(near({ name: `bumps${v}`, geometry: own(bumpGeometry(v, 2)), seed: 61 + v, cell: 150 + v * 47, perCell: 1, place: placeBump }));
  for (let v = 0; v < MESA_VARIANTS; v++)
    specs.push({
      name: `mesas${v}`,
      geometry: own(mesaGeometry(v)),
      material: mesa.material,
      seed: 71 + v,
      cell: 640 + v * 190,
      perCell: 1,
      xMin: MESA_X_MIN,
      xMax: MESA_X_MAX,
      parallax: MESA_PARALLAX,
      edgeSink: 900,
      place: v === MESA_VARIANTS - 1 ? placeMesaFront : placeMesa,
    });

  const layers: ScatterLayer[] = specs.map((s) => {
    const layer = createScatterLayer(s);
    root.add(layer.mesh);
    return layer;
  });

  return {
    update(scroll, colors) {
      groundMat.color.copy(colors.ground);
      setSoftRelief(duneMat, colors.groundLit, colors.topFactor, DUNE_TONE, DUNE_LIT);
      detailMat.color.copy(colors.detail);
      pebbleMat.color.lerpColors(colors.detail, colors.ground, PEBBLE_TONE);
      rockMat.color.lerpColors(colors.detail, colors.ground, ROCK_TONE);
      mesa.material.color.copy(colors.detail);
      mesa.color.copy(colors.sky);
      mesa.haze = MESA_HAZE + (MESA_HAZE_NIGHT - MESA_HAZE) * colors.night;
      for (let i = 0; i < layers.length; i++) layers[i].update(scroll);
    },
    dispose() {
      for (const layer of layers) layer.dispose();
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      groundMat.dispose();
      duneMat.dispose();
      detailMat.dispose();
      pebbleMat.dispose();
      rockMat.dispose();
      mesa.material.dispose();
    },
  };
}

/** Colour + emissive so a top face reads as `lit * tone` while only `k` of it reacts to light. */
function setSoftRelief(mat: THREE.MeshLambertMaterial, lit: THREE.Color, top: THREE.Color, tone: number, k: number): void {
  mat.color.setRGB((lit.r * tone) / (k * top.r + 1 - k), (lit.g * tone) / (k * top.g + 1 - k), (lit.b * tone) / (k * top.b + 1 - k));
  mat.emissive.copy(mat.color).multiplyScalar(1 - k);
  mat.color.multiplyScalar(k);
}

function reset(p: Placement): void {
  p.y = 0;
  p.sx = 1;
  p.sy = 1;
  p.sz = 1;
  p.yaw = 0;
}

/** Exponential-ish spread: mostly small, occasionally up to `max`. */
function spread(r: number, mean: number, max: number): number {
  return Math.min(max, -Math.log(1 - r * 0.999) * mean);
}

// Chrome's ground sprite: short 1 px dashes just under the horizon line. In 3D: flat ink
// dashes scattered mostly in front of the line (toward the camera), a few behind.
function placeSpeck(r: ItemRandom, p: Placement): boolean {
  if (r.get(0) > 0.5) return false;
  reset(p);
  p.u = r.get(1);
  const front = r.get(2) < 0.75;
  const d = spread(r.get(3), front ? 22 : 18, 90);
  p.z = front ? LINE_Z + 3 + d : LINE_Z - 3 - d;
  if (r.get(4) > Math.exp(-d / 70)) return false;
  p.sx = 1 + Math.floor(r.get(5) * 3);
  p.sy = 0.6;
  p.sz = r.get(6) < 0.3 ? 1.6 : 1;
  return true;
}

function placePebble(r: ItemRandom, p: Placement): boolean {
  if (r.get(0) > 0.4) return false;
  reset(p);
  p.u = r.get(1);
  const behind = r.get(2) < 0.6;
  const d = spread(r.get(3), 55, 380);
  p.z = behind ? LINE_Z - 6 - d : LINE_Z + 10 + d * 0.6;
  if (p.z > 240) return false;
  const s = 0.6 + r.get(4) ** 3 * 1.1 + d / 500;
  p.sx = s * r.range(5, 0.8, 1.2);
  p.sy = s * r.range(6, 0.6, 1);
  p.sz = s * r.range(7, 0.8, 1.2);
  p.yaw = Math.floor(r.get(8) * 4) * QUARTER;
  return true;
}

function placeRock(r: ItemRandom, p: Placement): boolean {
  if (r.get(0) > 0.45) return false;
  reset(p);
  p.u = r.get(1);
  // Rocks near the camera would loom large; keep the near side to a rare small one.
  const behind = r.get(2) < 0.85;
  p.z = behind ? r.range(3, -560, -90) : r.range(3, 60, 160);
  const s = behind ? r.range(4, 1.4, 3) : r.range(4, 0.9, 1.3);
  p.sx = s * r.range(5, 0.8, 1.3);
  p.sy = s * r.range(6, 0.5, 0.9);
  p.sz = s;
  p.yaw = Math.floor(r.get(7) * 4) * QUARTER;
  return true;
}

function placeDune(r: ItemRandom, p: Placement): boolean {
  if (r.get(0) > 0.6) return false;
  reset(p);
  p.u = r.get(1);
  p.z = r.range(2, -460, -220);
  p.sx = r.range(3, 1, 2.2);
  p.sy = r.range(4, 0.6, 1.2);
  p.sz = r.range(5, 1, 1.6);
  p.yaw = r.get(6) < 0.5 ? 0 : Math.PI;
  return true;
}

function placeBump(r: ItemRandom, p: Placement): boolean {
  if (r.get(0) > 0.5) return false;
  reset(p);
  p.u = r.get(1);
  p.y = LINE_HEIGHT;
  p.z = LINE_Z;
  p.sz = LINE_DEPTH / 2;
  return true;
}

function placeMesa(r: ItemRandom, p: Placement): boolean {
  if (r.get(0) > 0.55) return false;
  reset(p);
  p.u = r.get(1);
  p.z = r.range(2, -1650, -1250);
  p.sx = r.range(3, 0.8, 1.6);
  p.sy = r.range(4, 0.55, 1.1);
  p.sz = r.range(5, 1, 2);
  p.yaw = r.get(6) < 0.5 ? 0 : Math.PI;
  return true;
}

/** Mostly behind the lane, but some on the near side so the chase view has a horizon on both flanks. */
function placeMesaFront(r: ItemRandom, p: Placement): boolean {
  if (!placeMesa(r, p)) return false;
  if (r.get(7) < 0.5) p.z = r.range(8, 1300, 1700);
  return true;
}
