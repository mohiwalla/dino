// Gameplay entities: the T-Rex, the obstacle pool, small particle effects and debug boxes.
// Everything is positioned from interpolated sim snapshots; nothing here feeds back into the sim.

import * as THREE from 'three';
import { SLOT, TREX } from '../config';
import type { Box, Entities, GameEvent, GameSnapshot, ModelLibrary } from '../types';
import { createDebugBoxes } from './entities-debug';
import { createEffects } from './entities-effects';
import { createObstaclePool, obstacleX } from './entities-obstacles';
import { createSmoke } from './entities-smoke';
import { createTrexView } from './entities-trex';

/** Longer frames (tab switches, breakpoints) are clamped so springs and particles stay sane. */
const MAX_DT_MS = 100;

const SPRITE_COLOR = new THREE.Color('#8a8a8a');
const TREX_HIT_COLOR = new THREE.Color('#e5484d');
const OBSTACLE_HIT_COLOR = new THREE.Color('#2f9e44');

export function createEntities(scene: THREE.Scene, models: ModelLibrary): Entities {
  const trex = createTrexView(models);
  const obstacles = createObstaclePool(models);
  const effects = createEffects(models.materials[SLOT.INK - 1]);
  const debug = createDebugBoxes();
  const smoke = createSmoke();
  scene.add(trex.root, obstacles.root, effects.mesh, smoke.points, debug.lines);
  let farts = false;
  let debugOn = false;
  let night = -1;

  /** Chrome's T-Rex boxes are y-down from the 47 px standing sprite's top; flip them about its height. */
  function drawTrexBoxes(curr: GameSnapshot): void {
    const p = trex.root.position;
    const t = curr.trex;
    debug.box(p.x, p.y, t.width, t.height, SPRITE_COLOR);
    const boxes: readonly Box[] = t.status === 'ducking' ? TREX.COLLISION_DUCKING : TREX.COLLISION_RUNNING;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      debug.box(p.x + b.x, p.y + TREX.HEIGHT - b.y - b.h, b.w, b.h, TREX_HIT_COLOR);
    }
  }

  function drawDebug(prev: GameSnapshot, curr: GameSnapshot, alpha: number, fresh: boolean): void {
    debug.begin();
    drawTrexBoxes(curr);
    for (let k = 0; k < curr.obstacles.length; k++) {
      const o = curr.obstacles[k];
      const x = obstacleX(prev, o, alpha, fresh);
      debug.box(x, o.y, o.width, o.height, SPRITE_COLOR);
      for (let i = 0; i < o.collisionBoxes.length; i++) {
        const b = o.collisionBoxes[i];
        debug.box(x + b.x, o.y + b.y, b.w, b.h, OBSTACLE_HIT_COLOR);
      }
    }
    debug.end();
  }

  function handleEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump':
        trex.jump();
        if (farts) smoke.jump();
        break;
      case 'land':
        trex.land();
        effects.land();
        break;
      case 'crash':
        trex.crash();
        effects.crash();
        break;
      case 'restart':
        trex.restart();
        effects.restart();
        break;
    }
  }

  return {
    trex: trex.root,

    update(prev, curr, alpha, dtMs) {
      if (curr.night !== night) {
        night = curr.night;
        models.setNight(night);
      }
      // Steps since the run started only go backwards when a new run began in between.
      const fresh = curr.runFrames < prev.runFrames;
      const dt = curr.phase === 'paused' ? 0 : Math.min(Math.max(dtMs, 0), MAX_DT_MS);
      trex.update(prev, curr, alpha, dt, fresh);
      obstacles.update(prev, curr, fresh ? 1 : alpha, dt, fresh);
      effects.update(curr, trex.root.position, dt);
      smoke.update(curr, trex.root.position, dt);
      if (debugOn) drawDebug(prev, curr, alpha, fresh);
    },

    handleEvents(events) {
      for (let i = 0; i < events.length; i++) handleEvent(events[i]);
    },

    setDebug(on) {
      debugOn = on;
      debug.lines.visible = on;
    },

    setFunny(on) {
      trex.setFunny(on);
    },

    setFarts(on) {
      farts = on;
    },

    setCrown(on) {
      trex.setCrown(on);
    },

    flyCrown(direction, board) {
      trex.flyCrown(direction, board);
    },

    setBoardCrown(spot) {
      trex.setBoardCrown(spot);
    },

    placeCrowns(dtMs) {
      trex.placeCrowns(dtMs);
    },

    setCrashBeats(beats) {
      trex.setCrashBeats(beats);
    },

    setCrashMove(move) {
      trex.setCrashMove(move);
    },

    get crashMove() {
      return trex.crashMove;
    },

    celebrate() {
      trex.celebrate();
      obstacles.bury();
    },

    dispose() {
      trex.dispose();
      obstacles.dispose();
      effects.dispose();
      smoke.dispose();
      debug.dispose();
    },
  };
}
