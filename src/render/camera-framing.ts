// Camera framings as orbit parameters around a look-at target, plus an aspect-ratio fit.
//
// A framing is (target, yaw, pitch, size, fov). `size` is the half-height of the view at
// the target's depth, in px; distance = size / tan(fov / 2). Interpolating size and fov
// separately keeps the subject's on-screen size steady while the fov changes (a dolly zoom),
// so transitions between modes never "breathe".

import type { CameraMode } from '../types';

export const TX = 0;
export const TY = 1;
export const TZ = 2;
/** Orbit angle around +Y: 0 = camera on +Z (square-on side view), -90° = behind on -X. */
export const YAW = 3;
/** Elevation above the target, radians. */
export const PITCH = 4;
export const SIZE = 5;
/** Vertical fov, degrees. */
export const FOV = 6;
export const FRAMING_LENGTH = 7;
export type Framing = Float64Array;

const DEG = Math.PI / 180;

export function framing(tx: number, ty: number, yawDeg: number, pitchDeg: number, size: number, fov: number): Framing {
  return Float64Array.of(tx, ty, 0, yawDeg * DEG, pitchDeg * DEG, size, fov);
}

export function mixFraming(out: Framing, a: Framing, b: Framing, t: number): Framing {
  for (let i = 0; i < FRAMING_LENGTH; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export function distanceOf(f: Framing): number {
  return f[SIZE] / Math.tan((f[FOV] * DEG) / 2);
}

export interface ModeSpec {
  /** Landscape framing at the base speed. */
  readonly base: Framing;
  /** The fit may widen the fov up to this (degrees) before it pulls the camera back. */
  readonly maxFov: number;
  /**
   * NDC x where the T-Rex's centre is pinned by panning along the track, or null to keep the
   * base target. Pinning keeps the T-Rex near the left on any aspect and spends extra width on
   * the track ahead.
   */
  readonly anchorX: number | null;
  /**
   * Optional framing for tall screens, blended in as the aspect drops from PORTRAIT_FROM to
   * PORTRAIT_TO. Narrow screens look further along the track (more from behind), so the
   * track ahead climbs the screen instead of having to squeeze across its width.
   */
  readonly portrait?: { readonly base: Framing; readonly anchorX: number | null };
  /** Points (x, y, z triples) that must stay in view, and the NDC margin they must stay within. */
  readonly keep: readonly number[];
  readonly margin: number;
  /** Fraction of the T-Rex's height the camera target follows. */
  readonly follow: number;
}

/** The standing T-Rex (with some depth) and ~450 px of track ahead of its nose, up to pterodactyl height. */
const PLAY_KEEP = [-4, 0, 8, 48, 0, 8, -4, 50, -8, 48, 50, -8, 500, 0, 0, 500, 50, 0];
/** Chase sits right behind the T-Rex: keep its silhouette (feet, tail, head) rather than its box corners. */
const CHASE_KEEP = [22, 0, 0, 0, 25, 0, 44, 47, 0, 500, 0, 0, 500, 50, 0];
/** The idle T-Rex with breathing room. */
const TITLE_KEEP = [-16, -2, 10, 60, -2, 10, -16, 60, -10, 60, 60, -10];

export const MODES: Readonly<Record<CameraMode, ModeSpec>> = {
  cinematic: {
    base: framing(190, 24, -34, 12, 128, 38),
    maxFov: 62,
    anchorX: -0.52,
    portrait: { base: framing(190, 20, -62, 24, 100, 50), anchorX: -0.55 },
    keep: PLAY_KEEP,
    margin: 0.9,
    follow: 0.25,
  },
  side: {
    base: framing(230, 62, 0, 2, 150, 14),
    maxFov: 40,
    anchorX: -0.78,
    keep: PLAY_KEEP,
    margin: 0.94,
    follow: 0,
  },
  chase: {
    base: framing(280, 25, -80, 9, 200, 48),
    maxFov: 70,
    anchorX: null,
    portrait: { base: framing(260, 28, -87, 13, 250, 52), anchorX: null },
    keep: CHASE_KEEP,
    margin: 0.92,
    follow: 0.25,
  },
};

/** Title close-ups, one per mode so the swoop out starts from a matching angle. */
export const TITLES: Readonly<Record<CameraMode, ModeSpec>> = {
  cinematic: { base: framing(22, 15, -28, 9, 82, 30), maxFov: 45, anchorX: null, keep: TITLE_KEEP, margin: 0.85, follow: 0 },
  side: { base: framing(22, 15, 0, 3, 82, 30), maxFov: 45, anchorX: null, keep: TITLE_KEEP, margin: 0.85, follow: 0 },
  chase: { base: framing(22, 15, -50, 10, 82, 30), maxFov: 45, anchorX: null, keep: TITLE_KEEP, margin: 0.85, follow: 0 },
};

/** The T-Rex's centre, pinned at ModeSpec.anchorX. */
const ANCHOR = [22, 23, 0] as const;

// Camera basis of the last computeBasis() call: direction from target to camera, right and up.
export const dir = new Float64Array(3);
export const right = new Float64Array(3);
export const up = new Float64Array(3);

export function computeBasis(f: Framing): void {
  const cy = Math.cos(f[YAW]);
  const sy = Math.sin(f[YAW]);
  const cp = Math.cos(f[PITCH]);
  const sp = Math.sin(f[PITCH]);
  dir[0] = sy * cp;
  dir[1] = sp;
  dir[2] = cy * cp;
  right[0] = cy;
  right[1] = 0;
  right[2] = -sy;
  // up = right x forward, forward = -dir.
  up[0] = -(right[1] * dir[2] - right[2] * dir[1]);
  up[1] = -(right[2] * dir[0] - right[0] * dir[2]);
  up[2] = -(right[0] * dir[1] - right[1] * dir[0]);
}

/** Camera-space (right, up, depth) of a point relative to a camera at target + dist * dir. */
function toCamera(f: Framing, dist: number, x: number, y: number, z: number, out: Float64Array): void {
  const rx = x - (f[TX] + dist * dir[0]);
  const ry = y - (f[TY] + dist * dir[1]);
  const rz = z - (f[TZ] + dist * dir[2]);
  out[0] = rx * right[0] + ry * right[1] + rz * right[2];
  out[1] = rx * up[0] + ry * up[1] + rz * up[2];
  out[2] = -(rx * dir[0] + ry * dir[1] + rz * dir[2]);
}

const cam = new Float64Array(3);

/** Pan the target along X so the anchor projects to NDC x = ndcX. Closed form: NDC x is a Möbius function of the pan. */
function pinAnchor(f: Framing, aspect: number, ndcX: number): void {
  const dist = distanceOf(f);
  const tanH = Math.tan((f[FOV] * DEG) / 2) * aspect;
  toCamera(f, dist, ANCHOR[0], ANCHOR[1], ANCHOR[2], cam);
  // Moving the rig by +p along X changes camera-space x by -p * right.x and depth by +p * dir.x.
  const k = ndcX * tanH;
  const denom = right[0] + k * dir[0];
  if (Math.abs(denom) < 1e-6) return;
  f[TX] += (cam[0] - k * cam[2]) / denom;
}

function fits(f: Framing, spec: ModeSpec, aspect: number): boolean {
  const dist = distanceOf(f);
  const tanV = Math.tan((f[FOV] * DEG) / 2);
  const tanH = tanV * aspect;
  const m = spec.margin;
  for (let i = 0; i < spec.keep.length; i += 3) {
    toCamera(f, dist, spec.keep[i], spec.keep[i + 1], spec.keep[i + 2], cam);
    if (cam[2] <= 1) return false;
    if (Math.abs(cam[0] / (cam[2] * tanH)) > m || Math.abs(cam[1] / (cam[2] * tanV)) > m) return false;
  }
  return true;
}

/** Portrait framings fade in (smoothstep) as the aspect ratio drops through this range. */
const PORTRAIT_FROM = 1.25;
const PORTRAIT_TO = 0.6;

// The aspect-blended base framing and anchor that fitFraming() zooms out from.
const base = new Float64Array(FRAMING_LENGTH);
let anchorX: number | null = null;

function blendBase(spec: ModeSpec, aspect: number): void {
  base.set(spec.base);
  anchorX = spec.anchorX;
  const p = spec.portrait;
  if (!p) return;
  const t = Math.min(1, Math.max(0, (PORTRAIT_FROM - aspect) / (PORTRAIT_FROM - PORTRAIT_TO)));
  const s = t * t * (3 - 2 * t);
  mixFraming(base, spec.base, p.base, s);
  if (spec.anchorX !== null && p.anchorX !== null) anchorX = spec.anchorX + (p.anchorX - spec.anchorX) * s;
}

/** Zoom out by factor z: widen the fov (keeping the camera distance) up to maxFov, then pull back. */
function applyZoom(out: Framing, spec: ModeSpec, aspect: number, z: number): void {
  out.set(base);
  const dist = distanceOf(base);
  const size = base[SIZE] * z;
  out[SIZE] = size;
  out[FOV] = Math.min(spec.maxFov, Math.max(base[FOV], (2 * Math.atan(size / dist)) / DEG));
  if (anchorX !== null) pinAnchor(out, aspect, anchorX);
}

/**
 * Fit a mode's framing to the viewport aspect: the smallest zoom-out (>= 1) that keeps every
 * `keep` point inside the margin. Wide screens never zoom in, they just see more track.
 */
export function fitFraming(out: Framing, spec: ModeSpec, aspect: number): Framing {
  blendBase(spec, aspect);
  computeBasis(base);
  applyZoom(out, spec, aspect, 1);
  if (fits(out, spec, aspect)) return out;
  let lo = 1;
  let hi = 2;
  for (applyZoom(out, spec, aspect, hi); !fits(out, spec, aspect) && hi < 64; applyZoom(out, spec, aspect, hi)) hi *= 2;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    applyZoom(out, spec, aspect, mid);
    if (fits(out, spec, aspect)) hi = mid;
    else lo = mid;
  }
  applyZoom(out, spec, aspect, hi);
  return out;
}
