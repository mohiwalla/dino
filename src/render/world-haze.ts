// A Lambert material for far horizon landforms: instead of the scene fog (which would erase
// them completely) it blends toward the sky colour by a haze that is total at the ground and
// eases to `haze` at `height`, so mesas rise out of the mist instead of floating on it.

import * as THREE from 'three';

export interface HeightHazeMaterial {
  readonly material: THREE.MeshLambertMaterial;
  /** Linear sky colour to blend into; copy into it every frame. */
  readonly color: THREE.Color;
  /** Haze at and above the fade height, in [0, 1]. */
  haze: number;
}

export function createHeightHazeMaterial(haze: number, height: number): HeightHazeMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false });
  const uniforms = {
    uHazeColor: { value: new THREE.Color() },
    uHaze: { value: haze },
    uHazeHeight: { value: height },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'varying float vHazeY;\nvoid main() {').replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vec4 hazeWorld = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        hazeWorld = instanceMatrix * hazeWorld;
      #endif
      vHazeY = ( modelMatrix * hazeWorld ).y;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uHazeColor;\nuniform float uHaze;\nuniform float uHazeHeight;\nvarying float vHazeY;\nvoid main() {')
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        float hazeT = smoothstep( 0.0, uHazeHeight, vHazeY );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, uHazeColor, mix( 1.0, uHaze, hazeT ) );`,
      );
  };
  material.customProgramCacheKey = () => 'world-height-haze';

  return {
    material,
    color: uniforms.uHazeColor.value,
    get haze() {
      return uniforms.uHaze.value;
    },
    set haze(v: number) {
      uniforms.uHaze.value = v;
    },
  };
}
