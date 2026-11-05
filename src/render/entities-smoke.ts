// The farts setting's gas: soft, round, camera-facing smoke puffs (not voxels) that leave a trail
// along the jump arc. One THREE.Points draw call for the whole pool; each puff grows, drifts
// up and back, and fades. The puff shape is a few octaves of cheap noise in the fragment
// shader, rotated per puff, so no two look alike and no texture is needed.

import * as THREE from 'three';
import { SIM } from '../config';
import type { GameSnapshot } from '../types';

const CAPACITY = 160;
/** Puffs per second from the T-Rex's rear while a farting jump is in the air. */
const TRAIL_RATE = 55;
/** The initial blast when the jump starts. */
const BLAST_COUNT = 10;
/** Puffs keep this share of the ground's scroll: the trail streams behind, but stays in view. */
const SCROLL_SHARE = 0.55;
const RISE = 14;
const DRAG = 1.8;
const COLOR = new THREE.Color('#a5c95a');

const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;
  uniform float uScale;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / -mv.z;
    vAlpha = aAlpha;
    vSeed = aSeed;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vSeed;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), u.x), u.y);
  }
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = vSeed * 6.2831;
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
    float r = length(p);
    if (r > 1.0) discard;
    vec2 q = p * 2.2 + vSeed * 17.0;
    float n = noise(q) * 0.6 + noise(q * 2.1) * 0.3 + noise(q * 4.3) * 0.1;
    float body = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.55);
    float alpha = body * vAlpha;
    if (alpha < 0.01) discard;
    // Lighter where thick, a touch darker at the wispy edge.
    gl_FragColor = vec4(uColor * (0.82 + 0.3 * body), alpha);
  }
`;

export interface Smoke {
  readonly points: THREE.Points;
  /** A farting jump just started: blast, then trail while airborne. */
  jump(): void;
  /** `trex` is the T-Rex root's interpolated position; `dtMs` is 0 while paused. */
  update(curr: GameSnapshot, trex: THREE.Vector3, dtMs: number): void;
  dispose(): void;
}

export function createSmoke(): Smoke {
  const position = new Float32Array(CAPACITY * 3);
  const sizeAttr = new Float32Array(CAPACITY);
  const alphaAttr = new Float32Array(CAPACITY);
  const seedAttr = new Float32Array(CAPACITY);
  const vx = new Float32Array(CAPACITY);
  const vy = new Float32Array(CAPACITY);
  const vz = new Float32Array(CAPACITY);
  const age = new Float32Array(CAPACITY);
  const life = new Float32Array(CAPACITY);
  const size0 = new Float32Array(CAPACITY);
  const size1 = new Float32Array(CAPACITY);
  const peak = new Float32Array(CAPACITY);
  let alive = 0;

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
  const sAttr = new THREE.BufferAttribute(sizeAttr, 1).setUsage(THREE.DynamicDrawUsage);
  const aAttr = new THREE.BufferAttribute(alphaAttr, 1).setUsage(THREE.DynamicDrawUsage);
  const dAttr = new THREE.BufferAttribute(seedAttr, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSize', sAttr);
  geometry.setAttribute('aAlpha', aAttr);
  geometry.setAttribute('aSeed', dAttr);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uScale: { value: 1 }, uColor: { value: COLOR } },
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.name = 'smoke';
  const buffer = new THREE.Vector2();
  // World size -> pixels: half the drawing buffer's height over tan(fov / 2).
  points.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getDrawingBufferSize(buffer);
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 40;
    material.uniforms.uScale.value = (buffer.y * 0.5) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  };

  let airborne = false;
  let trailDebt = 0;
  let blast = false;

  function emit(x: number, y: number, z: number, svx: number, svy: number, svz: number, s0: number, s1: number, l: number, a: number): void {
    if (alive >= CAPACITY) return;
    const i = alive++;
    position[i * 3] = x;
    position[i * 3 + 1] = y;
    position[i * 3 + 2] = z;
    vx[i] = svx;
    vy[i] = svy;
    vz[i] = svz;
    age[i] = 0;
    life[i] = l;
    size0[i] = s0;
    size1[i] = s1;
    peak[i] = a;
    seedAttr[i] = Math.random();
  }

  function kill(i: number): void {
    const last = --alive;
    position[i * 3] = position[last * 3];
    position[i * 3 + 1] = position[last * 3 + 1];
    position[i * 3 + 2] = position[last * 3 + 2];
    vx[i] = vx[last];
    vy[i] = vy[last];
    vz[i] = vz[last];
    age[i] = age[last];
    life[i] = life[last];
    size0[i] = size0[last];
    size1[i] = size1[last];
    peak[i] = peak[last];
    seedAttr[i] = seedAttr[last];
  }

  const r = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

  return {
    points,

    jump() {
      blast = true;
      airborne = true;
    },

    update(curr, trex, dtMs) {
      const dt = dtMs / 1000;
      const playing = curr.phase === 'playing';
      // The tail end of the T-Rex, a little under its middle.
      const ex = trex.x + 3;
      const ey = trex.y + curr.trex.height * 0.32;
      if (dt > 0) {
        if (blast) {
          for (let k = 0; k < BLAST_COUNT; k++) {
            emit(ex + r(-3, 3), ey + r(-4, 4), r(-6, 6), r(-160, -60), r(-40, 30), r(-40, 40), r(10, 16), r(34, 52), r(0.8, 1.3), r(0.5, 0.75));
          }
          blast = false;
        }
        if (airborne && playing && curr.trex.status === 'jumping') {
          trailDebt += TRAIL_RATE * dt;
          while (trailDebt >= 1) {
            trailDebt -= 1;
            emit(ex + r(-2, 2), ey + r(-3, 3), r(-4, 4), r(-60, -20), r(-15, 10), r(-15, 15), r(7, 11), r(22, 34), r(0.6, 1), r(0.35, 0.55));
          }
        } else {
          airborne = false;
          trailDebt = 0;
        }
        const scroll = playing ? ((curr.speed * 1000) / SIM.STEP_MS) * SCROLL_SHARE : 0;
        const drag = Math.exp(-DRAG * dt);
        for (let i = 0; i < alive; ) {
          age[i] += dt;
          if (age[i] >= life[i]) {
            kill(i);
            continue;
          }
          vx[i] *= drag;
          vy[i] = vy[i] * drag + RISE * dt;
          vz[i] *= drag;
          position[i * 3] += (vx[i] - scroll) * dt;
          position[i * 3 + 1] = Math.max(2, position[i * 3 + 1] + vy[i] * dt);
          position[i * 3 + 2] += vz[i] * dt;
          i++;
        }
      }
      for (let i = 0; i < alive; i++) {
        const t = age[i] / life[i];
        // Quick fade in, long fade out; size eases out as the gas spreads.
        sizeAttr[i] = size0[i] + (size1[i] - size0[i]) * (1 - (1 - t) * (1 - t));
        alphaAttr[i] = peak[i] * Math.min(1, t * 10) * (1 - t) * (1 - t);
      }
      geometry.setDrawRange(0, alive);
      posAttr.needsUpdate = sAttr.needsUpdate = aAttr.needsUpdate = dAttr.needsUpdate = true;
    },

    dispose() {
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
