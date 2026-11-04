// Chrome-style pixel HUD drawn over the 3D view: score + high score (top-right), title
// prompt, game over panel, pause overlay, FPS counter and the top-left camera / sound / pause
// buttons. All text is the NES-style pixel font in src/ui/font.ts, drawn into canvases at
// an integer number of device pixels per art pixel. The DOM is only touched on change.

import './hud.css';
import { PALETTE, SCORE } from '../config';
import type { BoardView, CameraMode, GameEvent, GamePhase, GameSnapshot, Hud, HudContext, Settings, UiAction } from '../types';
import { createConfigPanel } from './config';
import { createMask, digitCount, layoutRuns, layoutText, MONO_PITCH, GLYPH_H, writeChar, writeNumber, type PixelMask } from './font';
import { api } from '../net/api';
import { CAMERA_ICON, GEAR_ICON, MOON_ICON, PAUSE_ICON, PLAY_ICON, RESTART_ICON, SPEAKER_OFF_ICON, SPEAKER_ON_ICON, SUN_ICON } from './icons';
import { PixelCanvas, type Tones } from './pixel-canvas';

/** Which pixel scale an element uses: headline text, small text, or button icons. */
type Tier = 'big' | 'small' | 'button';

interface ViewState {
  phase: GamePhase;
  touch: boolean;
  fps: boolean;
  config: boolean;
}

interface Item {
  canvas: PixelCanvas;
  tier: Tier;
  /** Skip redraws while hidden; hidden canvases catch up when they become visible. */
  visible: (v: ViewState) => boolean;
}

interface Units {
  big: number;
  small: number;
  button: number;
  dpr: number;
}

const CAMERA_LABELS: Readonly<Record<CameraMode, string>> = { cinematic: 'CINEMATIC', side: 'SIDE', chase: 'CHASE' };
const DESKTOP_LEGEND: readonly (readonly [string, string])[] = [
  ['SPACE / ↑', 'JUMP'],
  ['↓', 'DUCK'],
  ['C', 'CAMERA'],
  ['M', 'SOUND'],
  ['D', 'DARK'],
];
const TOUCH_LEGEND: readonly (readonly [string, string])[] = [
  ['TAP', 'JUMP'],
  ['SWIPE DOWN', 'DUCK'],
];
/** Funny mode's game-over lines, one picked at random per crash. */
const FUNNY_GAME_OVER: readonly string[] = [
  'SKILL ISSUE',
  'OOF',
  'GG NO RE',
  'BONK!',
  'CACTUS: 1  YOU: 0',
  'WASTED',
  'NOT LIKE THIS',
  'TOUCH GRASS',
  'YEET FAILED',
  'TASTES LIKE CACTUS',
];
const SCORE_GAP_SLOTS = 2;
const FPS_SLOTS = 7;
/** Leaderboard row: rank and dot, a mark slot (⚡ start-fast, 📱 mobile), name, space, score. */
const BOARD_NAME_SLOTS = 10;
const BOARD_SCORE_SLOT = 3 + 2 + BOARD_NAME_SLOTS + 1;
const BOARD_ROW_SLOTS = BOARD_SCORE_SLOT + SCORE.MAX_DIGITS;

const always = (): boolean => true;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sign-out red, darker on the light theme and lighter on the dark one. */
const DAY_DANGER = '#c62828';
const NIGHT_DANGER = '#ff6e6e';
const DANGER = [hexToRgb(DAY_DANGER), hexToRgb(NIGHT_DANGER)] as const;
const DAY_INK = hexToRgb(PALETTE.day.ink);
const NIGHT_INK = hexToRgb(PALETTE.night.ink);
const DAY_BG = hexToRgb(PALETTE.day.bg);
const NIGHT_BG = hexToRgb(PALETTE.night.bg);

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** A name as the pixel font can draw it, in BOARD_NAME_SLOTS: "KAMALJOT SINGH" -> "KAMALJOT S". */
function boardName(name: string): string {
  const plain = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= BOARD_NAME_SLOTS) return plain;
  const words = plain.split(' ');
  return (words.length > 1 ? `${words[0]} ${words[words.length - 1][0]}` : plain).slice(0, BOARD_NAME_SLOTS);
}

function boardRow(rank: number, name: string, score: number, mobile: boolean, fast: boolean, tone: number): PixelMask {
  const mask = createMask(BOARD_ROW_SLOTS * MONO_PITCH - 1, GLYPH_H);
  writeNumber(mask, rank, 0, 2, false, tone);
  writeChar(mask, '.', 2, tone);
  if (fast) writeChar(mask, '⚡', 3, tone);
  if (mobile) writeChar(mask, '📱', fast ? 4 : 3, tone);
  [...boardName(name)].forEach((ch, i) => writeChar(mask, ch, 5 + i, tone));
  writeNumber(mask, score, BOARD_SCORE_SLOT, SCORE.MAX_DIGITS, true, tone);
  return mask;
}

function computeUnits(width: number, height: number, dpr: number): Units {
  // Headline art pixel: ~3 CSS px on a 1280 x 720 window, down to 1.5 CSS px on phones (Chrome's
  // own canvas shrinks on phones too), and never under 2 device px.
  const css = Math.min(5, Math.max(1.5, Math.min(width, height * 1.78) / 440));
  const big = Math.max(2, Math.round(css * dpr));
  const small = Math.max(2, Math.ceil(1.2 * dpr), Math.round(big * 0.67));
  return { big, small, button: Math.max(small, Math.round(2 * dpr)), dpr };
}

export function createHud(root: HTMLElement): Hud {
  const listeners = new Set<(action: UiAction) => void>();
  const emit = (action: UiAction): void => listeners.forEach((cb) => cb(action));
  const settingsListeners = new Set<(change: Partial<Settings>) => void>();
  const emitSettings = (change: Partial<Settings>): void => settingsListeners.forEach((cb) => cb(change));
  const items: Item[] = [];
  const tones: Tones = { version: 0, ink: PALETTE.day.ink, dim: PALETTE.day.ink, halo: 'transparent', bg: PALETTE.day.bg, danger: DAY_DANGER };
  const view: ViewState = { phase: 'title', touch: false, fps: false, config: false };

  const add = (parent: HTMLElement, mask: PixelMask, className: string, tier: Tier, visible: Item['visible'] = always, halo = true): PixelCanvas => {
    const canvas = new PixelCanvas(mask, className, halo);
    parent.appendChild(canvas.el);
    items.push({ canvas, tier, visible });
    return canvas;
  };

  const hud = el('div', 'hud', root);
  hud.dataset.phase = 'title';
  const status = el('div', 'hud-status', hud);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  // ── Buttons ──
  const bar = el('div', 'hud-bar', hud);
  const button = (className: string, action: UiAction): HTMLButtonElement => {
    const b = el('button', `hud-btn ${className}`, bar);
    b.type = 'button';
    b.setAttribute('data-ui', '');
    b.addEventListener('click', () => emit(action));
    // Mouse clicks must not move focus here, or the next Space would press the button instead of jumping.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  };
  const cameraBtn = button('hud-btn-camera', 'toggleCamera');
  add(cameraBtn, CAMERA_ICON, 'hud-icon', 'button', always, false);
  const cameraLabel = add(cameraBtn, layoutText(CAMERA_LABELS.cinematic), 'hud-btn-label', 'small', always, false);
  const soundBtn = button('hud-btn-sound', 'toggleMute');
  soundBtn.setAttribute('aria-label', 'Mute sound');
  const soundIcon = add(soundBtn, SPEAKER_ON_ICON, 'hud-icon', 'button', always, false);
  const themeBtn = button('hud-btn-theme', 'toggleTheme');
  themeBtn.setAttribute('aria-label', 'Dark mode');
  const themeIcon = add(themeBtn, MOON_ICON, 'hud-icon', 'button', always, false);
  const pauseBtn = button('hud-btn-pause', 'togglePause');
  const pauseVisible = (v: ViewState): boolean => v.touch && (v.phase === 'playing' || v.phase === 'paused');
  const pauseIcon = add(pauseBtn, PAUSE_ICON, 'hud-icon', 'button', pauseVisible, false);
  const configBtn = button('hud-btn-config', 'toggleConfig');
  configBtn.setAttribute('aria-label', 'Configuration');
  configBtn.setAttribute('aria-haspopup', 'dialog');
  add(configBtn, GEAR_ICON, 'hud-icon', 'button', always, false);
  // A plain link, so signing in never depends on a click handler.
  const signInLink = el('a', 'hud-btn hud-btn-signin', bar);
  signInLink.href = api.loginUrl(location.pathname + location.search);
  signInLink.setAttribute('data-ui', '');
  signInLink.setAttribute('aria-label', 'Sign in with Microsoft to join the team leaderboard');
  add(signInLink, layoutText('SIGN IN'), 'hud-btn-label', 'small', always, false);

  // ── Score ──
  const scoreBox = el('div', 'hud-score', hud);
  let scoreMask = createMask(1, GLYPH_H);
  const scoreCanvas = add(scoreBox, scoreMask, 'hud-score-text', 'big');
  const isRunning = (v: ViewState): boolean => v.phase === 'playing' || v.phase === 'paused';
  const liveLine = add(scoreBox, layoutText(''), 'hud-live', 'small', isRunning);

  // ── Leaderboard (title and game over) ──
  const isMenu = (v: ViewState): boolean => v.phase === 'title' || v.phase === 'crashed';
  const boardBox = el('div', 'hud-board', hud);
  add(boardBox, layoutText('TEAM BOARD'), 'hud-board-title', 'small', isMenu);
  const boardRows = el('div', 'hud-board-rows', boardBox);
  const rowCanvases: PixelCanvas[] = [];
  const boardNote = add(boardBox, layoutText(''), 'hud-board-note', 'small', isMenu);
  const boardList = el('ol', 'hud-status', boardBox);
  let boardKey = '';
  let boardView: BoardView | null = null;

  // ── Config panel ──
  const config = createConfigPanel(hud, (parent, mask, className, tier) => add(parent, mask, className, tier, (v) => v.config, false), emit, emitSettings);
  let lastConfigOpen: boolean | null = null;
  const backdropHasFocus = (): boolean => hud.querySelector('.hud-config-backdrop')?.contains(document.activeElement) ?? false;

  // ── Title ──
  const isTitle = (v: ViewState): boolean => v.phase === 'title';
  const title = el('div', 'hud-panel hud-title', hud);
  const pressDesktop = layoutText('PRESS SPACE TO PLAY');
  const pressTouch = layoutText('TAP TO PLAY');
  const press = add(title, pressDesktop, 'hud-press', 'big', isTitle);
  const legend = (entries: readonly (readonly [string, string])[], touch: boolean): void => {
    const row = el('div', `hud-legend hud-legend-${touch ? 'touch' : 'desktop'}`, title);
    const visible = (v: ViewState): boolean => isTitle(v) && v.touch === touch;
    entries.forEach(([key, label], i) => {
      if (i > 0) add(row, layoutText('·'), 'hud-sep', 'small', visible);
      add(row, layoutRuns([[key, 1], [label, 2]], { space: 4 }), 'hud-legend-item', 'small', visible);
    });
  };
  legend(DESKTOP_LEGEND, false);
  legend(TOUCH_LEGEND, true);

  // ── Game over ──
  const isCrashed = (v: ViewState): boolean => v.phase === 'crashed';
  const over = el('div', 'hud-panel hud-over', hud);
  add(over, layoutText('NEW HIGH SCORE'), 'hud-new-high', 'small', isCrashed);
  const gameOverClassic = layoutText('G A M E  O V E R', { space: 7 });
  const gameOver = add(over, gameOverClassic, 'hud-game-over', 'big', isCrashed);
  let mode: Settings['mode'] = 'regular';
  add(over, RESTART_ICON, 'hud-restart', 'big', isCrashed);
  const restartDesktop = layoutText('PRESS SPACE TO RESTART');
  const restartTouch = layoutText('TAP TO RESTART');
  const restartHint = add(over, restartDesktop, 'hud-hint', 'small', isCrashed);

  // ── Paused ──
  const isPaused = (v: ViewState): boolean => v.phase === 'paused';
  const paused = el('div', 'hud-panel hud-paused', hud);
  add(paused, layoutText('PAUSED'), 'hud-paused-title', 'big', isPaused);
  const resumeDesktop = layoutText('PRESS P TO RESUME');
  const resumeTouch = layoutText('TAP TO RESUME');
  const resumeHint = add(paused, resumeDesktop, 'hud-hint', 'small', isPaused);

  // ── FPS ──
  const fpsBox = el('div', 'hud-fps', hud);
  const fpsMask = createMask(FPS_SLOTS * MONO_PITCH - 1, GLYPH_H);
  'FPS'.split('').forEach((ch, i) => writeChar(fpsMask, ch, FPS_SLOTS - 3 + i, 2));
  const fpsCanvas = add(fpsBox, fpsMask, 'hud-fps-text', 'small', (v) => v.fps);

  // ── Change tracking: everything below is compared before touching the DOM. ──
  let units: Units | null = null;
  let measureNeeded = true;
  let colorKey = -1;
  let lastPhase: GamePhase | null = null;
  let lastTouch: boolean | null = null;
  let lastMode: CameraMode | null = null;
  let lastMuted: boolean | null = null;
  let lastDark: boolean | null = null;
  let lastFps = -1;
  let lastFpsShown: boolean | null = null;
  let lastCanRestart: boolean | null = null;
  let lastNewHigh: boolean | null = null;
  let lastPaused: boolean | null = null;
  let peekTimer = 0;
  let newHighScore = false;
  let crashScore = 0;
  let scoreSlots = 0;
  let lastHighOnly: boolean | null = null;
  let lastScore = -1;
  let lastHigh = -1;
  let lastHideCurrent: boolean | null = null;

  const onResize = (): void => {
    measureNeeded = true;
  };
  window.addEventListener('resize', onResize);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  observer?.observe(root);

  function measure(): void {
    const dpr = window.devicePixelRatio || 1;
    if (!measureNeeded && units && units.dpr === dpr) return;
    measureNeeded = false;
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    const next = computeUnits(w, h, dpr);
    if (units && next.big === units.big && next.small === units.small && next.button === units.button && next.dpr === units.dpr) return;
    units = next;
    hud.style.setProperty('--hud-u', `${next.big / dpr}px`);
    hud.style.setProperty('--hud-s', `${next.small / dpr}px`);
    hud.style.setProperty('--hud-b', `${next.button / dpr}px`);
    // The score's 2-slot gap separates HI from the current score inside one canvas; nothing else to lay out.
  }

  function updateColors(night: number): void {
    const t = Math.min(1, Math.max(0, night));
    const ink = [mix(DAY_INK[0], NIGHT_INK[0], t), mix(DAY_INK[1], NIGHT_INK[1], t), mix(DAY_INK[2], NIGHT_INK[2], t)];
    const bg = [mix(DAY_BG[0], NIGHT_BG[0], t), mix(DAY_BG[1], NIGHT_BG[1], t), mix(DAY_BG[2], NIGHT_BG[2], t)];
    const key = (ink[0] << 16) | (ink[1] << 8) | ink[2] | (bg[0] << 24);
    if (key === colorKey) return;
    colorKey = key;
    tones.version++;
    tones.ink = `rgb(${ink[0]},${ink[1]},${ink[2]})`;
    tones.dim = `rgb(${mix(ink[0], bg[0], 0.2)},${mix(ink[1], bg[1], 0.2)},${mix(ink[2], bg[2], 0.2)})`;
    tones.halo = `rgba(${bg[0]},${bg[1]},${bg[2]},0.72)`;
    tones.bg = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    const [dd, nd] = DANGER;
    tones.danger = `rgb(${mix(dd[0], nd[0], t)},${mix(dd[1], nd[1], t)},${mix(dd[2], nd[2], t)})`;
    hud.style.setProperty('--hud-danger', tones.danger);
    hud.style.setProperty('--hud-ink', tones.ink);
    hud.style.setProperty('--hud-wash', `rgba(${bg[0]},${bg[1]},${bg[2]},0.55)`);
    hud.style.setProperty('--hud-bg', `rgb(${bg[0]},${bg[1]},${bg[2]})`);
  }

  /** "HI 00123  00045" on a fixed slot grid; HI in the 80% tone, current score optional. */
  /** `highOnly` (title screen) drops the current score's slots, so HI sits flush right. */
  function updateScore(score: number, high: number, hideCurrent: boolean, highOnly: boolean): void {
    if (score === lastScore && high === lastHigh && hideCurrent === lastHideCurrent && highOnly === lastHighOnly) return;
    lastHighOnly = highOnly;
    lastScore = score;
    lastHigh = high;
    lastHideCurrent = hideCurrent;
    // Nothing drawn (title screen, no high score yet): the leaderboard moves up into the space.
    hud.dataset.scoreEmpty = String(high === 0 && hideCurrent);
    const digits = Math.max(SCORE.MAX_DIGITS, digitCount(score), digitCount(high));
    const slots = highOnly ? 3 + digits : 3 + digits + SCORE_GAP_SLOTS + digits;
    if (slots !== scoreSlots) {
      scoreSlots = slots;
      scoreMask = createMask(slots * MONO_PITCH - 1, GLYPH_H);
      scoreCanvas.setMask(scoreMask);
    } else {
      scoreMask.bits.fill(0);
      scoreCanvas.invalidate();
    }
    if (high > 0) {
      writeChar(scoreMask, 'H', 0, 2);
      writeChar(scoreMask, 'I', 1, 2);
      writeNumber(scoreMask, high, 3, digits, true, 2);
    }
    if (!hideCurrent && !highOnly) writeNumber(scoreMask, score, 3 + digits + SCORE_GAP_SLOTS, digits, true, 1);
  }

  function updatePhase(s: GameSnapshot): void {
    if (s.phase === lastPhase) return;
    lastPhase = s.phase;
    hud.dataset.phase = s.phase;
    if (s.phase === 'crashed') {
      const line = FUNNY_GAME_OVER[Math.floor(Math.random() * FUNNY_GAME_OVER.length)];
      gameOver.setMask(mode !== 'regular' ? layoutText(line) : gameOverClassic);
    }
    if (s.phase === 'crashed') status.textContent = `Game over. Score ${crashScore || s.score}.${newHighScore ? ' New high score!' : ''}`;
    else if (s.phase === 'paused') status.textContent = 'Paused.';
    else status.textContent = '';
  }

  function updateContext(s: GameSnapshot, ctx: HudContext): void {
    if (ctx.touch !== lastTouch) {
      lastTouch = ctx.touch;
      hud.dataset.touch = String(ctx.touch);
      press.setMask(ctx.touch ? pressTouch : pressDesktop);
      restartHint.setMask(ctx.touch ? restartTouch : restartDesktop);
      resumeHint.setMask(ctx.touch ? resumeTouch : resumeDesktop);
    }
    if (ctx.cameraMode !== lastMode) {
      // Narrow screens hide the mode name; show it briefly after a switch.
      if (lastMode !== null) {
        hud.dataset.labelPeek = 'true';
        clearTimeout(peekTimer);
        peekTimer = window.setTimeout(() => delete hud.dataset.labelPeek, 1500);
      }
      lastMode = ctx.cameraMode;
      cameraLabel.setMask(layoutText(CAMERA_LABELS[ctx.cameraMode]));
      cameraBtn.setAttribute('aria-label', `Camera: ${ctx.cameraMode}. Switch camera`);
    }
    const muted = ctx.settings.muted;
    if (muted !== lastMuted) {
      lastMuted = muted;
      soundIcon.setMask(muted ? SPEAKER_OFF_ICON : SPEAKER_ON_ICON);
      soundBtn.setAttribute('aria-pressed', String(muted));
    }
    // No ranked runs, no board.
    const showBoard = String(ctx.settings.showBoard && ctx.settings.ranked);
    if (hud.dataset.showBoard !== showBoard) hud.dataset.showBoard = showBoard;
    config.update(ctx.settings, boardView, ctx.touch);
    if (ctx.configOpen !== lastConfigOpen) {
      lastConfigOpen = ctx.configOpen;
      hud.dataset.config = String(ctx.configOpen);
      configBtn.setAttribute('aria-expanded', String(ctx.configOpen));
      if (ctx.configOpen) config.focus();
      else if (backdropHasFocus()) configBtn.focus({ preventScroll: true });
    }
    if (ctx.dark !== lastDark) {
      lastDark = ctx.dark;
      themeIcon.setMask(ctx.dark ? SUN_ICON : MOON_ICON);
      themeBtn.setAttribute('aria-pressed', String(ctx.dark));
    }
    const isPausedNow = s.phase === 'paused';
    if (isPausedNow !== lastPaused) {
      lastPaused = isPausedNow;
      pauseIcon.setMask(isPausedNow ? PLAY_ICON : PAUSE_ICON);
      pauseBtn.setAttribute('aria-label', isPausedNow ? 'Resume' : 'Pause');
    }
    const fpsShown = ctx.fps !== null;
    if (fpsShown !== lastFpsShown) {
      lastFpsShown = fpsShown;
      hud.dataset.fps = String(fpsShown);
    }
    const fps = ctx.fps === null ? -1 : Math.min(999, Math.max(0, Math.round(ctx.fps)));
    if (fps !== lastFps && fps >= 0) {
      lastFps = fps;
      for (let y = 0; y < GLYPH_H; y++) fpsMask.bits.fill(0, y * fpsMask.w, y * fpsMask.w + 3 * MONO_PITCH);
      writeNumber(fpsMask, fps, 0, 3, false, 1);
      fpsCanvas.invalidate();
    }
  }

  function updateFlags(s: GameSnapshot): void {
    const canRestart = s.phase === 'crashed' && s.canRestart;
    if (canRestart !== lastCanRestart) {
      lastCanRestart = canRestart;
      hud.dataset.canRestart = String(canRestart);
    }
    const showNewHigh = s.phase === 'crashed' && newHighScore;
    if (showNewHigh !== lastNewHigh) {
      lastNewHigh = showNewHigh;
      hud.dataset.newHigh = String(showNewHigh);
    }
  }

  function renderCanvases(): void {
    if (!units) return;
    for (const item of items) {
      if (!item.visible(view)) continue;
      const unit = item.tier === 'big' ? units.big : item.tier === 'small' ? units.small : units.button;
      item.canvas.render(unit, units.dpr, tones);
    }
  }

  function setBoard(view: BoardView): void {
    const key = JSON.stringify(view);
    if (key === boardKey) return;
    boardKey = key;
    boardView = view;
    hud.dataset.account = view.account;
    view.entries.forEach((e, i) => {
      if (!rowCanvases[i]) rowCanvases.push(add(boardRows, createMask(1, GLYPH_H), 'hud-board-row', 'small', isMenu));
      rowCanvases[i].setMask(boardRow(e.rank, e.name, e.score, e.mobile, e.fast, e.me ? 1 : 2));
      rowCanvases[i].el.classList.toggle('hud-board-me', e.me);
      rowCanvases[i].el.hidden = false;
    });
    for (let i = view.entries.length; i < rowCanvases.length; i++) rowCanvases[i].el.hidden = true;
    boardNote.setMask(layoutText(view.note));
    liveLine.setMask(layoutText(view.live));
    // Screen readers get the board as text.
    boardList.replaceChildren(
      ...view.entries.map((e) => {
        const li = document.createElement('li');
        li.textContent = `${e.rank}. ${e.name}${e.me ? ' (you)' : ''}: ${e.score}${e.fast ? ', started fast' : ''}${e.mobile ? ', on mobile' : ''}`;
        return li;
      }),
    );
  }

  return {
    setBoard,

    update(s: GameSnapshot, ctx: HudContext): void {
      mode = ctx.settings.mode;
      measure();
      updateColors(s.night);
      updatePhase(s);
      updateContext(s, ctx);
      updateFlags(s);
      updateScore(s.score, s.highScore, s.phase === 'title' || s.scoreFlash, s.phase === 'title');
      view.phase = s.phase;
      view.touch = ctx.touch;
      view.fps = ctx.fps !== null;
      view.config = ctx.configOpen;
      renderCanvases();
    },

    handleEvents(events: GameEvent[]): void {
      for (const e of events) {
        if (e.type === 'crash') {
          newHighScore = e.newHighScore;
          crashScore = e.score;
        } else if (e.type === 'start' || e.type === 'restart') {
          newHighScore = false;
          crashScore = 0;
        }
      }
    },

    onAction(cb: (action: UiAction) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    onSettings(cb: (change: Partial<Settings>) => void): () => void {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },

    dispose(): void {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      clearTimeout(peekTimer);
      listeners.clear();
      settingsListeners.clear();
      hud.remove();
    },
  };
}
