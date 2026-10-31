// Light rig: a hemisphere fill, a shadow-casting key light from front-left-above (shadows fall
// right and back, toward the far side of the lane), and a cool moon rim light at night.
//
// Calibration (three.js Lambert, linear space): out = albedo * irradiance / PI. By day a face
// pointing at the default camera (+Z) gets irradiance PI, so the #535353 ink reads as #535353;
// top faces get ~1.3x; the shadowed ground keeps ~75% of its lit brightness.

import * as THREE from 'three';
import { clamp01 } from './world-util';

/** From the key light's target toward the light. */
const KEY_OFFSET = new THREE.Vector3(-150, 300, 220);
/** Toward the moon (high, behind the lane, to the right). */
const MOON_DIR = new THREE.Vector3(0.3, 0.45, -1).normalize();
/** The play area that must receive crisp shadows: obstacles from spawn-ish to behind the T-Rex. */
const SHADOW_BOX = new THREE.Box3(new THREE.Vector3(-250, 0, -150), new THREE.Vector3(800, 200, 150));
const SHADOW_MAP_SIZE = 2048;

interface LightLook {
  sky: THREE.Color;
  ground: THREE.Color;
  hemi: number;
  key: THREE.Color;
  keyIntensity: number;
  rim: THREE.Color;
  rimIntensity: number;
  shadow: number;
}

// Day: hemi sky 3.06 / ground 1.72, key 1.365 (see the calibration note above).
const DAY: LightLook = {
  sky: new THREE.Color(1, 1, 1),
  ground: new THREE.Color(0.563, 0.563, 0.563),
  hemi: 3.06,
  key: new THREE.Color(1, 1, 1),
  keyIntensity: 1.365,
  rim: new THREE.Color(0.8, 0.86, 1),
  rimIntensity: 0,
  shadow: 1,
};

// Night: ~0.85x on camera-facing faces, a touch cool, with a moon rim on tops and backs.
const NIGHT_LOOK: LightLook = {
  sky: new THREE.Color(0.9, 0.93, 0.97),
  ground: new THREE.Color(0.55, 0.56, 0.6),
  hemi: 3.0,
  key: new THREE.Color(0.86, 0.92, 0.98),
  keyIntensity: 1.0,
  rim: new THREE.Color(0.78, 0.85, 1),
  rimIntensity: 0.9,
  shadow: 0.75,
};

export interface WorldLighting {
  /** Blend day -> night lighting. */
  update(night: number): void;
  /** Lit-top-face brightness factor per channel (irradiance / PI), for colour calibration. */
  readonly topFactor: THREE.Color;
  dispose(): void;
}

export function createLighting(scene: THREE.Scene, renderer: THREE.WebGLRenderer): WorldLighting {
  renderer.shadowMap.enabled = true;
  // three r187 removed PCFSoftShadowMap; PCF now does soft Vogel-disk filtering via shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const hemi = new THREE.HemisphereLight();
  hemi.name = 'world.hemi';
  scene.add(hemi);

  const key = new THREE.DirectionalLight();
  key.name = 'world.key';
  const target = SHADOW_BOX.getCenter(new THREE.Vector3()).setY(0);
  key.target.position.copy(target);
  key.position.copy(target).add(KEY_OFFSET);
  key.castShadow = true;
  scene.add(key, key.target);
  fitShadowCamera(key);

  const rim = new THREE.DirectionalLight();
  rim.name = 'world.moonRim';
  rim.position.copy(MOON_DIR).multiplyScalar(500).add(target);
  rim.target.position.copy(target);
  scene.add(rim, rim.target);

  const keyDir = KEY_OFFSET.clone().normalize();
  const topFactor = new THREE.Color();
  let lastNight = -1;

  function update(night: number): void {
    const t = clamp01(night);
    if (t === lastNight) return;
    lastNight = t;
    hemi.color.lerpColors(DAY.sky, NIGHT_LOOK.sky, t);
    hemi.groundColor.lerpColors(DAY.ground, NIGHT_LOOK.ground, t);
    hemi.intensity = lerp(DAY.hemi, NIGHT_LOOK.hemi, t);
    key.color.lerpColors(DAY.key, NIGHT_LOOK.key, t);
    key.intensity = lerp(DAY.keyIntensity, NIGHT_LOOK.keyIntensity, t);
    key.shadow.intensity = lerp(DAY.shadow, NIGHT_LOOK.shadow, t);
    rim.color.lerpColors(DAY.rim, NIGHT_LOOK.rim, t);
    // Never hidden, even at 0 by day: a changing light count would recompile every material.
    rim.intensity = lerp(DAY.rimIntensity, NIGHT_LOOK.rimIntensity, t);

    // Irradiance on an unshadowed top face, divided by PI.
    topFactor
      .copy(hemi.color)
      .multiplyScalar(hemi.intensity)
      .add(scaled(key.color, key.intensity * keyDir.y))
      .add(scaled(rim.color, rim.intensity * MOON_DIR.y))
      .multiplyScalar(1 / Math.PI);
  }

  const tmp = new THREE.Color();
  function scaled(c: THREE.Color, s: number): THREE.Color {
    return tmp.copy(c).multiplyScalar(s);
  }

  update(0);

  return {
    update,
    topFactor,
    dispose() {
      scene.remove(hemi, key, key.target, rim, rim.target);
      hemi.dispose();
      key.dispose();
      rim.dispose();
    },
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Size the orthographic shadow camera to exactly enclose SHADOW_BOX as seen from the light. */
function fitShadowCamera(light: THREE.DirectionalLight): void {
  const shadow = light.shadow;
  const cam = shadow.camera;
  cam.position.copy(light.position);
  cam.lookAt(light.target.position);
  cam.updateMatrixWorld(true);

  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? SHADOW_BOX.max.x : SHADOW_BOX.min.x, i & 2 ? SHADOW_BOX.max.y : SHADOW_BOX.min.y, i & 4 ? SHADOW_BOX.max.z : SHADOW_BOX.min.z);
    p.applyMatrix4(cam.matrixWorldInverse);
    min.min(p);
    max.max(p);
  }
  const pad = 4;
  cam.left = min.x - pad;
  cam.right = max.x + pad;
  cam.bottom = min.y - pad;
  cam.top = max.y + pad;
  cam.near = Math.max(0.5, -max.z - pad);
  cam.far = -min.z + pad;
  cam.updateProjectionMatrix();

  shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  // Depth bias in shadow-map NDC units over the (near..far) range, plus a normal offset of
  // ~half a voxel: no acne on 1-unit voxel steps, and contact shadows stay attached at the feet.
  shadow.bias = -0.0004;
  shadow.normalBias = 0.45;
  shadow.radius = 2.5;
}
