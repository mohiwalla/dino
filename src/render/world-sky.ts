// Sky colour and fog. The background and the fog share one colour, so anything far enough
// away dissolves into the flat canvas exactly, like an infinite version of Chrome's page.
//
// The three camera modes see the lane from very different distances (side view: ~1150 units
// away, square-on), so a fixed fog range cannot suit them all. Instead the fog is refitted to
// whatever camera is rendering, just before each render: it ends where obstacles spawn (they
// fade in instead of popping) but never closer than MIN_SPAN behind the lane's focus.

import * as THREE from 'three';
import { PALETTE, RUNNER } from '../config';

/** A point on the lane the cameras frame; fog starts no closer than CLEAR beyond it. */
const FOCUS = new THREE.Vector3(200, 20, 0);
const SPAWN = new THREE.Vector3(RUNNER.SPAWN_X, 0, 0);
const MIN_SPAN = 530;
const FADE = 480;
const CLEAR = 120;

export interface WorldSky {
  /** The sky colour: scene background and fog. Set it, the fog follows on the next render. */
  readonly color: THREE.Color;
  readonly fog: THREE.Fog;
  dispose(): void;
}

type SceneHook = THREE.Scene['onBeforeRender'];

export function createSky(scene: THREE.Scene): WorldSky {
  const prevBackground = scene.background;
  const prevFog = scene.fog;
  const ownHook = Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender');
  const prevHook: SceneHook = scene.onBeforeRender;

  const color = new THREE.Color(PALETTE.day.bg);
  const fog = new THREE.Fog(color.clone(), 500, 1000);
  scene.background = color;
  scene.fog = fog;

  const camPos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const depth = (p: THREE.Vector3) => (p.x - camPos.x) * fwd.x + (p.y - camPos.y) * fwd.y + (p.z - camPos.z) * fwd.z;

  function fitFog(camera: THREE.Camera): void {
    fog.color.copy(color);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    fwd.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
    const focus = depth(FOCUS);
    const far = Math.max(depth(SPAWN), focus + MIN_SPAN);
    fog.far = far;
    fog.near = Math.max(far - FADE, focus + CLEAR);
  }

  const hook: SceneHook = function (this: THREE.Scene, renderer, s, camera, geometry, material, group) {
    fitFog(camera);
    prevHook.call(this, renderer, s, camera, geometry, material, group);
  };
  scene.onBeforeRender = hook;

  return {
    color,
    fog,
    dispose() {
      if (scene.onBeforeRender === hook) {
        if (ownHook) scene.onBeforeRender = prevHook;
        else delete (scene as Partial<Pick<THREE.Scene, 'onBeforeRender'>>).onBeforeRender;
      }
      if (scene.background === color) scene.background = prevBackground;
      if (scene.fog === fog) scene.fog = prevFog;
    },
  };
}
