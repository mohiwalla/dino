// Debug wireframes for sim boxes: one LineSegments over a preallocated buffer, refilled each
// frame and trimmed with the draw range. Boxes get a little depth so they read in every camera.

import * as THREE from 'three';

const MAX_BOXES = 160;
const VERTS_PER_BOX = 24;
const HALF_DEPTH = 12;

// The 12 edges of a box as corner-index pairs; corner bits are (x, y, z).
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

export interface DebugBoxes {
  readonly lines: THREE.LineSegments;
  begin(): void;
  /** y-up box with bottom-left (x, y). */
  box(x: number, y: number, w: number, h: number, color: THREE.Color): void;
  end(): void;
  dispose(): void;
}

export function createDebugBoxes(): DebugBoxes {
  const positions = new Float32Array(MAX_BOXES * VERTS_PER_BOX * 3);
  const colors = new Float32Array(MAX_BOXES * VERTS_PER_BOX * 3);
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('color', colAttr);
  geometry.setDrawRange(0, 0);
  const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 1000;
  lines.visible = false;
  lines.name = 'debugBoxes';
  let count = 0;

  return {
    lines,

    begin() {
      count = 0;
    },

    box(x, y, w, h, color) {
      if (count >= MAX_BOXES) return;
      let o = count * VERTS_PER_BOX * 3;
      for (let e = 0; e < EDGES.length; e++, o += 3) {
        const c = EDGES[e];
        positions[o] = c & 1 ? x + w : x;
        positions[o + 1] = c & 2 ? y + h : y;
        positions[o + 2] = c & 4 ? HALF_DEPTH : -HALF_DEPTH;
        colors[o] = color.r;
        colors[o + 1] = color.g;
        colors[o + 2] = color.b;
      }
      count++;
    },

    end() {
      geometry.setDrawRange(0, count * VERTS_PER_BOX);
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    },

    dispose() {
      lines.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
