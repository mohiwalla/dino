// The environment: sky + fog, lights + shadows, the scrolling ground, clouds, moon and stars.
// Entirely driven by the sim snapshots (distance scrolls the ground, night blends the palette).

import * as THREE from 'three';
import { PALETTE } from '../config';
import type { GameSnapshot, World } from '../types';
import { createClouds } from './world-clouds';
import { type GroundColors, createGround } from './world-ground';
import { createLighting } from './world-lighting';
import { type NightColors, createNightSky } from './world-night';
import { createSky } from './world-sky';
import { clamp01, lerpSrgb, srgb } from './world-util';

const DAY = {
  bg: srgb(PALETTE.day.bg),
  ground: srgb(PALETTE.day.ground),
  detail: srgb(PALETTE.day.groundDetail),
  cloud: srgb(PALETTE.day.cloud),
};
const NIGHT = {
  bg: srgb(PALETTE.night.bg),
  ground: srgb(PALETTE.night.ground),
  detail: srgb(PALETTE.night.groundDetail),
  cloud: srgb(PALETTE.night.cloud),
};

export function createWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): World {
  // The lighting is calibrated for plain sRGB output (see world-lighting.ts).
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const lighting = createLighting(scene, renderer);
  const sky = createSky(scene);
  const ground = createGround(scene);
  const clouds = createClouds(scene);
  const nightSky = createNightSky(scene);

  const groundLit = new THREE.Color();
  const groundColors: GroundColors = {
    ground: new THREE.Color(),
    groundLit,
    topFactor: lighting.topFactor,
    detail: new THREE.Color(),
    sky: sky.color,
    night: 0,
  };
  const cloudColor = new THREE.Color();
  const nightColors: NightColors = {
    sky: sky.color,
    moon: new THREE.Color(PALETTE.night.moon),
    star: new THREE.Color(PALETTE.night.star),
  };

  function updateColors(night: number): void {
    groundColors.night = night;
    lerpSrgb(sky.color, DAY.bg, NIGHT.bg, night);
    lerpSrgb(groundColors.detail, DAY.detail, NIGHT.detail, night);
    lerpSrgb(cloudColor, DAY.cloud, NIGHT.cloud, night);
    // Pre-divide by the light on a top face so the lit ground reads as the palette colour.
    lerpSrgb(groundLit, DAY.ground, NIGHT.ground, night);
    const f = lighting.topFactor;
    groundColors.ground.setRGB(groundLit.r / f.r, groundLit.g / f.g, groundLit.b / f.b);
  }

  let scroll = 0;
  let lastDistance = Number.NaN;

  return {
    update(prev: GameSnapshot, curr: GameSnapshot, alpha: number, dtMs: number) {
      // A restart drops distance to 0: snap rather than sweep the ground backwards.
      const distance = curr.distance < prev.distance ? curr.distance : prev.distance + (curr.distance - prev.distance) * alpha;
      // The scenery follows the forward motion only, so it carries on seamlessly across a restart.
      if (Number.isNaN(lastDistance)) scroll = lastDistance = distance;
      else if (distance < lastDistance) lastDistance = distance;
      scroll += distance - lastDistance;
      lastDistance = distance;
      const night = clamp01(prev.night + (curr.night - prev.night) * alpha);
      lighting.update(night);
      updateColors(night);
      ground.update(scroll, groundColors);
      clouds.update(scroll, cloudColor, sky.color);
      nightSky.update(night, curr.moonPhase, dtMs, nightColors);
    },
    handleEvents() {
      // Everything is derived from snapshots; no event needs special handling.
    },
    dispose() {
      nightSky.dispose();
      clouds.dispose();
      ground.dispose();
      sky.dispose();
      lighting.dispose();
    },
  };
}
