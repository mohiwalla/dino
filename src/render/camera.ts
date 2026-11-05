// The camera rig: per-mode framings fitted to the viewport, a title close-up that swoops out
// when the run starts, critically damped transitions, gentle height follow, a speed-dependent
// fov and a short crash shake.

import * as THREE from 'three';
import { RUNNER } from '../config';
import { CAMERA_MODES, type CameraMode, type CameraRig, type GameEvent, type GameSnapshot } from '../types';
import {
  computeBasis,
  dir,
  distanceOf,
  FOV,
  framing,
  fitFraming,
  FRAMING_LENGTH,
  type Framing,
  MODES,
  mixFraming,
  PITCH,
  right,
  SIZE,
  TITLES,
  TX,
  TY,
  TZ,
  up,
  YAW,
} from './camera-framing';

const SWOOP_MS = 1500;
/** SmoothDamp times (s): ~0.8 s to settle on a mode change, tighter while tracking the swoop curve. */
const SMOOTH_TIME = 0.26;
const SWOOP_SMOOTH_TIME = 0.1;
/** Extra cinematic fov (degrees) at MAX_SPEED. */
const SPEED_FOV = 4;
const SHAKE_MS = 420;
/** Shake amplitude as a fraction of the view's half-height. */
const SHAKE_AMOUNT = 0.022;
const MAX_DT_MS = 100;
/** Fraction of the T-Rex's height the title close-up follows, so the first jump stays in frame mid-swoop. */
const TITLE_FOLLOW = 1;
/**
 * Funny mode's crash close-up: once the T-Rex has flopped onto its back, the camera eases in on
 * its face (from the mode's title angle), a little looser than the title close-up.
 */
const FACE_X = -10;
// Aimed above the face, so the face sits below the game-over text in the lower half.
const FACE_Y = 48;
const FACE_SIZE = 66;
const FACE_FOV = 30;
const FACE_DELAY_MS = 250;
const FACE_MS = 900;
/**
 * Celebration: the camera eases in on the dancing T-Rex (aimed above it, so it dances below
 * the game-over text) and circles it slowly until the next run.
 */
const PARTY_X = 22;
const PARTY_Y = 62;
const PARTY_PITCH = 10;
const PARTY_SIZE = 80;
const PARTY_FOV = 34;
const PARTY_IN_MS = 1200;
/** Orbit speed: one full turn in about 24 s. */
const PARTY_TURN_PER_MS = (Math.PI * 2) / 24000;
/** Middle-drag orbit (CameraRig.orbit): how far the camera may tip, as pitch in radians. */
const ORBIT_PITCH_MIN = -0.1;
const ORBIT_PITCH_MAX = 1.35;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Unity-style SmoothDamp on one component of `cur`, a critically damped spring. */
function smoothDamp(cur: Framing, vel: Framing, target: Framing, i: number, smoothTime: number, dt: number): void {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur[i] - target[i];
  const temp = (vel[i] + omega * change) * dt;
  vel[i] = (vel[i] - omega * temp) * decay;
  cur[i] = target[i] + (change + temp) * decay;
}

function prefersReducedMotion(): MediaQueryList | null {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
}

export function createCameraRig(initialMode: CameraMode): CameraRig {
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 2, 6000);
  const reducedMotion = prefersReducedMotion();
  let mode = initialMode;
  let aspect = 16 / 9;

  const fitted = {} as Record<CameraMode, Framing>;
  const fittedTitle = {} as Record<CameraMode, Framing>;
  for (const m of Object.keys(MODES) as CameraMode[]) {
    fitted[m] = new Float64Array(FRAMING_LENGTH);
    fittedTitle[m] = new Float64Array(FRAMING_LENGTH);
  }
  const desired = new Float64Array(FRAMING_LENGTH);
  const current = new Float64Array(FRAMING_LENGTH);
  const velocity = new Float64Array(FRAMING_LENGTH);
  const lookAt = new THREE.Vector3();

  let initialized = false;
  /** 0 = title close-up, 1 = the mode's play framing. */
  let titleBlend = 0;
  let swoopMs = -1;
  let shakeMs = 0;
  let shakeClock = 0;
  let funny = false;
  /** ms since a funny crash, or -1; faceBlend eases 0 -> 1 toward the face close-up. */
  let faceMs = -1;
  let faceBlend = 0;
  /**
   * The player's own orbit (a camera drag), added to every framing. Dragging from a preset makes
   * a custom view (that preset turned by the drag), which the camera cycle keeps as a third stop.
   */
  let orbitYaw = 0;
  let orbitPitch = 0;
  let customView: { mode: CameraMode; yaw: number; pitch: number } | null = null;
  let customOn = false;
  /** ms since celebrate(), or -1; partyBlend eases 0 -> 1 into the orbit. */
  let partyMs = -1;
  let partyBlend = 0;
  /** The yaw the orbit starts from: wherever the camera was looking. */
  let partyYaw = 0;
  const party = framing(PARTY_X, PARTY_Y, 0, PARTY_PITCH, PARTY_SIZE, PARTY_FOV);
  const face = {} as Record<CameraMode, Framing>;
  for (const m of Object.keys(TITLES) as CameraMode[]) {
    const t = TITLES[m].base;
    face[m] = framing(FACE_X, FACE_Y, 0, 0, FACE_SIZE, FACE_FOV);
    face[m][YAW] = t[YAW];
    face[m][PITCH] = t[PITCH];
  }

  function refit(): void {
    for (const m of Object.keys(MODES) as CameraMode[]) {
      fitFraming(fitted[m], MODES[m], aspect);
      fitFraming(fittedTitle[m], TITLES[m], aspect);
    }
  }
  refit();

  function computeDesired(curr: GameSnapshot, trexY: number): void {
    mixFraming(desired, fittedTitle[mode], fitted[mode], titleBlend);
    const speedT = THREE.MathUtils.clamp((curr.speed - RUNNER.SPEED) / (RUNNER.MAX_SPEED - RUNNER.SPEED), 0, 1) * titleBlend;
    desired[TY] += (TITLE_FOLLOW + (MODES[mode].follow - TITLE_FOLLOW) * titleBlend) * Math.max(0, trexY);
    if (mode === 'cinematic') widenFov(desired, SPEED_FOV * speedT);
    if (faceBlend > 0) mixFraming(desired, desired, face[mode], faceBlend);
    if (partyBlend > 0) {
      party[YAW] = partyYaw + partyMs * PARTY_TURN_PER_MS;
      mixFraming(desired, desired, party, partyBlend);
    }
    desired[YAW] += orbitYaw;
    desired[PITCH] = THREE.MathUtils.clamp(desired[PITCH] + orbitPitch, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX);
  }

  function advanceParty(curr: GameSnapshot, dtMs: number): void {
    if (partyMs < 0) return;
    if (curr.phase !== 'crashed') {
      partyMs = -1;
      partyBlend = 0;
      // Unwind the orbit to the nearest equal angle, so the camera doesn't spin back through every turn.
      current[YAW] = Math.atan2(Math.sin(current[YAW]), Math.cos(current[YAW]));
      return;
    }
    partyMs += dtMs;
    partyBlend = easeInOutCubic(Math.min(1, partyMs / PARTY_IN_MS));
  }

  function advanceFace(curr: GameSnapshot, dtMs: number): void {
    if (curr.phase !== 'crashed' || faceMs < 0) {
      faceMs = -1;
      faceBlend = 0;
      return;
    }
    faceMs += dtMs;
    faceBlend = easeInOutCubic(THREE.MathUtils.clamp((faceMs - FACE_DELAY_MS) / FACE_MS, 0, 1));
  }

  /** Widen the fov in place: the camera keeps its distance, so the view genuinely gets wider. */
  function widenFov(f: Framing, degrees: number): void {
    const dist = distanceOf(f);
    f[FOV] += degrees;
    f[SIZE] = dist * Math.tan(THREE.MathUtils.degToRad(f[FOV]) / 2);
  }

  function advanceSwoop(curr: GameSnapshot, dtMs: number): void {
    if (curr.phase === 'title') {
      titleBlend = 0;
      swoopMs = -1;
      return;
    }
    // A run already in progress (e.g. the rig was created mid-game) swoops out on its own.
    if (titleBlend < 1 && swoopMs < 0) swoopMs = 0;
    if (swoopMs < 0) return;
    swoopMs += dtMs;
    titleBlend = easeInOutCubic(Math.min(1, swoopMs / SWOOP_MS));
    if (swoopMs >= SWOOP_MS) swoopMs = -1;
  }

  /** Damped pseudo-random offset of the look-at, in the camera's screen plane. */
  function applyShake(dtMs: number, dist: number): void {
    if (shakeMs <= 0) return;
    shakeMs = Math.max(0, shakeMs - dtMs);
    shakeClock += dtMs / 1000;
    const k = shakeMs / SHAKE_MS;
    const amp = SHAKE_AMOUNT * k * k * dist * Math.tan(THREE.MathUtils.degToRad(current[FOV]) / 2);
    const sx = amp * (Math.sin(shakeClock * 71) * 0.7 + Math.sin(shakeClock * 113 + 1.3) * 0.3);
    const sy = amp * (Math.sin(shakeClock * 89 + 0.4) * 0.7 + Math.sin(shakeClock * 131 + 2.1) * 0.3);
    const ox = right[0] * sx + up[0] * sy;
    const oy = right[1] * sx + up[1] * sy;
    const oz = right[2] * sx + up[2] * sy;
    camera.position.x += ox;
    camera.position.y += oy;
    camera.position.z += oz;
    lookAt.x += ox;
    lookAt.y += oy;
    lookAt.z += oz;
  }

  function applyToCamera(dtMs: number): void {
    computeBasis(current);
    const dist = distanceOf(current);
    lookAt.set(current[TX], current[TY], current[TZ]);
    camera.position.set(lookAt.x + dir[0] * dist, lookAt.y + dir[1] * dist, lookAt.z + dir[2] * dist);
    applyShake(dtMs, dist);
    camera.lookAt(lookAt);
    if (camera.fov !== current[FOV]) {
      camera.fov = current[FOV];
      camera.updateProjectionMatrix();
    }
  }

  return {
    camera,

    get mode() {
      return mode;
    },

    get custom() {
      return customOn;
    },

    setMode(next) {
      mode = next;
      customOn = false;
      orbitYaw = orbitPitch = 0;
    },

    cycle() {
      const i = CAMERA_MODES.indexOf(mode);
      if (customOn) this.setMode(CAMERA_MODES[0]);
      else if (i === CAMERA_MODES.length - 1 && customView) {
        customOn = true;
        mode = customView.mode;
        orbitYaw = customView.yaw;
        orbitPitch = customView.pitch;
      } else this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    },

    orbit(dYaw, dPitch) {
      // From a preset, a fresh custom view starts on it.
      if (!customOn) {
        customView = { mode, yaw: 0, pitch: 0 };
        customOn = true;
        orbitYaw = orbitPitch = 0;
      }
      orbitYaw += dYaw;
      // The tilt is clamped where it lands (computeDesired); this only stops the offset running away.
      orbitPitch = THREE.MathUtils.clamp(orbitPitch + dPitch, -Math.PI / 2, Math.PI / 2);
      customView = { mode, yaw: orbitYaw, pitch: orbitPitch };
      // Moved straight away (not eased in), so the view follows the mouse.
      current[YAW] += dYaw;
      current[PITCH] = THREE.MathUtils.clamp(current[PITCH] + dPitch, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX);
    },

    setFunny(on) {
      funny = on;
    },

    celebrate() {
      if (partyMs >= 0 || reducedMotion?.matches) return;
      partyMs = 0;
      partyYaw = current[YAW];
    },

    resize(width, height) {
      aspect = Math.max(1e-3, width) / Math.max(1, height);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      refit();
    },

    update(curr, trex, dtMs) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS);
      advanceSwoop(curr, dt);
      advanceFace(curr, dt);
      advanceParty(curr, dt);
      computeDesired(curr, trex.position.y);
      if (!initialized) {
        current.set(desired);
        initialized = true;
      }
      const smoothTime = swoopMs >= 0 ? SWOOP_SMOOTH_TIME : SMOOTH_TIME;
      if (dt > 0) for (let i = 0; i < FRAMING_LENGTH; i++) smoothDamp(current, velocity, desired, i, smoothTime, dt / 1000);
      applyToCamera(dt);
    },

    handleEvents(events: GameEvent[]) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'start' && swoopMs < 0 && titleBlend < 1) swoopMs = 0;
        else if (e.type === 'crash' && !reducedMotion?.matches) {
          shakeMs = SHAKE_MS;
          shakeClock = 0;
          if (funny) faceMs = 0;
        }
      }
    },
  };
}
