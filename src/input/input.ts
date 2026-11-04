// Keyboard, pointer/touch and gamepad -> one InputFrame per sim step.
//
// Presses are latched until the next sample() so none is lost or doubled however many sim
// steps run per rendered frame; held state is always live. Window blur or a hidden tab
// releases everything so nothing sticks.

import type { InputController, InputFrame, UiAction } from '../types';

type Hold = 'jump' | 'duck';

interface PointerHold {
  hold: Hold;
  startY: number;
  touch: boolean;
}

const JUMP_CODES: ReadonlySet<string> = new Set(['Space', 'ArrowUp', 'KeyW']);
const DUCK_CODES: ReadonlySet<string> = new Set(['ArrowDown', 'KeyS']);
const RESTART_CODES: ReadonlySet<string> = new Set(['Enter', 'NumpadEnter']);
/** Downward travel (CSS px) that turns a touch from a jump into a duck. */
const SWIPE_DUCK_PX = 30;
const STICK_DEADZONE = 0.5;

// Standard gamepad mapping.
const PAD_A = 0;
const PAD_B = 1;
const PAD_START = 9;
const PAD_UP = 12;
const PAD_DOWN = 13;

function actionFor(e: KeyboardEvent): UiAction | null {
  if (e.code === 'Backquote') return 'toggleDebug';
  if (e.code === 'Escape') return 'togglePause';
  // Chrome's autofill dispatches keydown events without a key.
  switch (typeof e.key === 'string' ? e.key.toLowerCase() : '') {
    case 'c':
      return 'toggleCamera';
    case 'm':
      return 'toggleMute';
    case 'd':
      return 'toggleTheme';
    case 'p':
      return 'togglePause';
    default:
      return null;
  }
}

function inUi(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-ui]') !== null;
}

function inDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"]') !== null;
}

function pressed(pad: Gamepad, index: number): boolean {
  return pad.buttons[index]?.pressed ?? false;
}

export function createInput(): InputController {
  const listeners = new Set<(action: UiAction) => void>();
  const jumpKeys = new Set<string>();
  const duckKeys = new Set<string>();
  const pointers = new Map<number, PointerHold>();
  /** Returned by every sample(); copy it if you need to keep one. */
  const frame: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };

  // Pointers currently holding jump / duck, recounted whenever `pointers` changes.
  let jumpPointers = 0;
  let duckPointers = 0;
  let jumpLatch = false;
  let restartLatch = false;
  // A duck tapped between two samples still reaches the sim once (speed drop on a quick tap).
  let duckLatch = false;
  let touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let gamepads = 0;
  let padJump = false;
  let padDuck = false;
  let padStart = false;

  const emit = (action: UiAction): void => listeners.forEach((cb) => cb(action));

  function countPointers(): void {
    jumpPointers = 0;
    duckPointers = 0;
    pointers.forEach((p) => {
      if (p.hold === 'jump') jumpPointers++;
      else duckPointers++;
    });
  }

  function releaseAll(): void {
    jumpKeys.clear();
    duckKeys.clear();
    pointers.clear();
    countPointers();
    duckLatch = false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter activates a focused HUD button; Space only does inside a dialog (the config panel),
    // so the game still jumps on Space after focus returns to a HUD button.
    if (RESTART_CODES.has(e.code) && inUi(e.target)) return;
    if (e.code === 'Space' && inDialog(e.target)) return;
    const jump = JUMP_CODES.has(e.code);
    const duck = DUCK_CODES.has(e.code);
    const restart = RESTART_CODES.has(e.code);
    const action = actionFor(e);
    if (!jump && !duck && !restart && !action) return;
    e.preventDefault();
    touch = false;
    if (e.repeat) return;
    if (jump) {
      jumpKeys.add(e.code);
      jumpLatch = true;
    } else if (duck) {
      duckKeys.add(e.code);
      duckLatch = true;
    } else if (restart) {
      restartLatch = true;
    } else if (action) {
      emit(action);
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (JUMP_CODES.has(e.code) || DUCK_CODES.has(e.code)) {
      jumpKeys.delete(e.code);
      duckKeys.delete(e.code);
      e.preventDefault();
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (inUi(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    touch = e.pointerType !== 'mouse';
    pointers.set(e.pointerId, { hold: 'jump', startY: e.clientY, touch });
    countPointers();
    jumpLatch = true;
    restartLatch = true;
  }

  function onPointerMove(e: PointerEvent): void {
    const p = pointers.get(e.pointerId);
    if (!p || !p.touch || p.hold === 'duck') return;
    if (e.clientY - p.startY > SWIPE_DUCK_PX) {
      p.hold = 'duck';
      countPointers();
      duckLatch = true;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (pointers.delete(e.pointerId)) countPointers();
  }

  // Android fires contextmenu (and then pointercancel) on a long press, which would cut a held jump.
  function onContextMenu(e: Event): void {
    if (touch && !inUi(e.target)) e.preventDefault();
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') releaseAll();
  }

  function onGamepadConnected(): void {
    gamepads++;
  }

  function onGamepadDisconnected(): void {
    gamepads = Math.max(0, gamepads - 1);
    if (gamepads === 0) padJump = padDuck = padStart = false;
  }

  function pollGamepads(): void {
    if (gamepads === 0 || typeof navigator.getGamepads !== 'function') return;
    let jump = false;
    let duck = false;
    let start = false;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected) continue;
      const stickY = pad.axes[1] ?? 0;
      jump ||= pressed(pad, PAD_A) || pressed(pad, PAD_B) || pressed(pad, PAD_UP) || stickY < -STICK_DEADZONE;
      duck ||= pressed(pad, PAD_DOWN) || stickY > STICK_DEADZONE;
      start ||= pressed(pad, PAD_START);
    }
    if (jump && !padJump) jumpLatch = true;
    if (duck && !padDuck) duckLatch = true;
    if (start && !padStart) restartLatch = true;
    padJump = jump;
    padDuck = duck;
    padStart = start;
  }

  const opts: AddEventListenerOptions = { capture: true };
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('keyup', onKeyUp, opts);
  window.addEventListener('pointerdown', onPointerDown, opts);
  window.addEventListener('pointermove', onPointerMove, opts);
  window.addEventListener('pointerup', onPointerUp, opts);
  window.addEventListener('pointercancel', onPointerUp, opts);
  window.addEventListener('contextmenu', onContextMenu, opts);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('gamepadconnected', onGamepadConnected);
  window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

  return {
    sample(): InputFrame {
      pollGamepads();
      frame.jumpPressed = jumpLatch;
      frame.restartPressed = restartLatch;
      frame.jumpHeld = jumpKeys.size > 0 || padJump || jumpPointers > 0;
      frame.duckHeld = duckKeys.size > 0 || padDuck || duckLatch || duckPointers > 0;
      jumpLatch = false;
      restartLatch = false;
      duckLatch = false;
      return frame;
    },

    onAction(cb: (action: UiAction) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    get touch(): boolean {
      return touch;
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown, opts);
      window.removeEventListener('keyup', onKeyUp, opts);
      window.removeEventListener('pointerdown', onPointerDown, opts);
      window.removeEventListener('pointermove', onPointerMove, opts);
      window.removeEventListener('pointerup', onPointerUp, opts);
      window.removeEventListener('pointercancel', onPointerUp, opts);
      window.removeEventListener('contextmenu', onContextMenu, opts);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      listeners.clear();
      releaseAll();
    },
  };
}
