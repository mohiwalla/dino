// Small helpers shared by the world-* modules: deterministic hashing, sRGB colour blends and
// allocation-free instance matrix writes.

import * as THREE from 'three';

/** Deterministic hash of up to three integers -> [0, 1). Same inputs, same output, forever. */
export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (b | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ Math.imul(c | 0, 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** An sRGB colour as plain components in [0, 1]. */
export interface Srgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function srgb(hex: string): Srgb {
  const c = new THREE.Color(hex);
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, THREE.SRGBColorSpace);
  return out;
}

/**
 * Blend two sRGB colours in sRGB space (like Chrome's CSS invert transition) and store the
 * result in a (linear) THREE.Color.
 */
export function lerpSrgb(out: THREE.Color, a: Srgb, b: Srgb, t: number): THREE.Color {
  return out.setRGB(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, THREE.SRGBColorSpace);
}

/**
 * Write translation, yaw (about +Y) and scale into a 4x4 column-major instance matrix slot,
 * without touching any THREE math objects.
 */
export function writeInstance(
  arr: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw = 0,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const o = index * 16;
  arr[o] = c * sx;
  arr[o + 1] = 0;
  arr[o + 2] = -s * sx;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = sy;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = s * sz;
  arr[o + 9] = 0;
  arr[o + 10] = c * sz;
  arr[o + 11] = 0;
  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}

/**
 * Lambert material whose output can be faded toward a flat colour without transparency:
 * colour = base * (1 - haze) * lit, emissive = base * (1 - haze) * (1 - lit) + hazeColour * haze.
 * With haze = 1 the surface is exactly the haze colour (the sky), whatever the lighting.
 * `lit` is the share of the colour that responds to lights; the rest is self-lit, which keeps
 * sky objects (clouds, moon, far mesas) soft instead of dark on their shaded sides.
 */
export function setHazed(mat: THREE.MeshLambertMaterial, base: THREE.Color, haze: THREE.Color, amount: number, lit: number): void {
  const keep = 1 - amount;
  mat.color.copy(base).multiplyScalar(keep * lit);
  mat.emissive.copy(base).multiplyScalar(keep * (1 - lit));
  mat.emissive.r += haze.r * amount;
  mat.emissive.g += haze.g * amount;
  mat.emissive.b += haze.b * amount;
}
