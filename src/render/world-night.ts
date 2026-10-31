// The night sky: a voxel moon (shape from the sim's moon phase) and gently twinkling voxel
// stars, both fading in with `night`. They live far behind the lane, high enough to be framed
// by the cinematic and side cameras, and blend from the sky colour so no transparency is needed.

import * as THREE from 'three';
import { NIGHT } from '../config';
import { moonGeometry, starGeometry } from './world-shapes';
import { hash, setHazed, writeInstance } from './world-util';

const MOON_RADIUS = 11;
const MOON_VOXEL = 3.8;
const MOON_POS = new THREE.Vector3(640, 230, -1500);
/** Chrome's moon creeps left at 0.25 px per frame while it is out. */
const MOON_SPEED = 0.25 / (1000 / 60);
/** Moon brightness that does not depend on the lights (soft, glowing look). */
const MOON_SELF_LIT = 0.6;

const STAR_COUNT = 64;
const STAR_VOXEL = 3;
const STAR_SEED = 4242;
/** Stars sit on a dome around the play area, low in the sky where the cameras look. */
const DOME_CENTER = new THREE.Vector3(300, 0, 0);
const DOME_RADIUS = 2800;
const DEG = Math.PI / 180;

export interface NightColors {
  sky: THREE.Color;
  moon: THREE.Color;
  star: THREE.Color;
}

export interface WorldNight {
  update(night: number, moonPhase: number, dtMs: number, colors: NightColors): void;
  dispose(): void;
}

interface Star {
  x: number;
  y: number;
  z: number;
  size: number;
  speed: number;
  phase: number;
}

/**
 * Half the stars face the side and cinematic cameras (behind the lane, azimuth around -Z), the
 * rest spread toward +X for the chase camera. Elevations stay low: those cameras see little sky.
 */
function placeStar(i: number): Star {
  const r = (salt: number) => hash(i, salt, STAR_SEED);
  const azimuth = (i % 2 === 0 ? -24 + 48 * r(1) : 24 + 116 * r(1)) * DEG;
  const elevation = (r(2) < 0.85 ? 2 + 8.5 * r(3) : 10 + 12 * r(3)) * DEG;
  const flat = Math.cos(elevation) * DOME_RADIUS;
  return {
    x: DOME_CENTER.x + Math.sin(azimuth) * flat,
    y: DOME_CENTER.y + Math.sin(elevation) * DOME_RADIUS,
    z: DOME_CENTER.z - Math.cos(azimuth) * flat,
    size: 0.6 + 0.7 * r(4) ** 2,
    speed: 0.0012 + 0.0022 * r(5),
    phase: Math.PI * 2 * r(6),
  };
}

export function createNightSky(scene: THREE.Scene): WorldNight {
  // Always drawn (in the sky colour by day): showing it only at night would compile its shaders
  // mid-run, right as the first night falls.
  const root = new THREE.Group();
  root.name = 'world.night';
  scene.add(root);

  const moonGeos = Array.from({ length: NIGHT.MOON_PHASES }, (_, p) => moonGeometry(p, MOON_RADIUS, MOON_VOXEL));
  const moonMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false });
  const moon = new THREE.Mesh(moonGeos[0], moonMat);
  moon.name = 'world.moon';
  moon.position.copy(MOON_POS);
  root.add(moon);

  const starGeo = starGeometry(STAR_VOXEL);
  const starMat = new THREE.MeshBasicMaterial({ fog: false });
  const stars = new THREE.InstancedMesh(starGeo, starMat, STAR_COUNT);
  stars.name = 'world.stars';
  stars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  stars.frustumCulled = false;
  root.add(stars);
  const starData: Star[] = Array.from({ length: STAR_COUNT }, (_, i) => placeStar(i));
  const starArr = stars.instanceMatrix.array as Float32Array;

  let drift = 0;
  let timeMs = 0;

  function updateStars(): void {
    for (let i = 0; i < STAR_COUNT; i++) {
      const s = starData[i];
      const tw = 0.5 + 0.5 * Math.sin(timeMs * s.speed + s.phase);
      const k = s.size * (0.55 + 0.45 * tw * tw);
      writeInstance(starArr, i, s.x - drift * 0.5, s.y, s.z, k, k, k);
    }
    stars.instanceMatrix.needsUpdate = true;
  }
  updateStars();

  return {
    update(night, moonPhase, dtMs, colors) {
      timeMs += dtMs;
      // The moon creeps while it is out and is back at its start for the next night.
      drift = night > 0 ? drift + dtMs * MOON_SPEED : 0;
      const phase = Math.min(NIGHT.MOON_PHASES - 1, Math.max(0, Math.round(moonPhase)));
      moon.geometry = moonGeos[phase];
      moon.position.x = MOON_POS.x - drift;
      setHazed(moonMat, colors.moon, colors.sky, 1 - night, 1 - MOON_SELF_LIT);
      starMat.color.lerpColors(colors.sky, colors.star, night);
      if (night > 0) updateStars();
    },
    dispose() {
      root.removeFromParent();
      for (const g of moonGeos) g.dispose();
      moonMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      stars.dispose();
    },
  };
}
