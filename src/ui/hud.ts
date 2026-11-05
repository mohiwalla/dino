// Chrome-style pixel HUD drawn over the 3D view: score + high score (top-right), title
// prompt, game over panel, pause overlay, FPS counter and the top-left camera / sound / pause
// buttons. All text is the NES-style pixel font in src/ui/font.ts, drawn into canvases at
// an integer number of device pixels per art pixel. The DOM is only touched on change.

import './hud.css';
import { PALETTE, REPO_URL, SCORE } from '../config';
import type { BoardEntry, BoardView, CameraMode, GameEvent, GamePhase, GameSnapshot, Hud, HudContext, Settings, UiAction } from '../types';
import { createConfigPanel } from './config';
import { createConfetti } from './confetti';
import { createStarPrompt } from './star';
import { createMask, digitCount, layoutRuns, layoutText, MONO_PITCH, GLYPH_H, writeChar, writeNumber, type PixelMask } from './font';
import { api } from '../net/api';
import { CAMERA_ICON, CROWN_ICON, GEAR_ICON, GITHUB_ICON, MOON_ICON, PAUSE_ICON, PLAY_ICON, RESTART_ICON, SIGN_IN_ICON, SPEAKER_OFF_ICON, SPEAKER_ON_ICON, SUN_ICON } from './icons';
import { PixelCanvas, type Tones } from './pixel-canvas';

/** Which pixel scale an element uses: headline text, small text, or button icons. */
type Tier = 'big' | 'small' | 'button';

interface ViewState {
  phase: GamePhase;
  touch: boolean;
  fps: boolean;
  config: boolean;
  star: boolean;
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

const CAMERA_LABELS: Readonly<Record<CameraMode, string>> = { cinematic: 'CINEMATIC', side: 'SIDE' };
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
  'EXTINCT AGAIN!',
  'GIT GUD BRO',
  'TINY ARMS BIG L',
  'DINO DOOMED',
  'PRICKLY DEFEAT',
  'PTERO OWNED YOU',
  'WIFI BACK YET?',
  'BACK TO WORK!',
  'CHAI BREAK NOW?',
  '404 SKILL NOT FND',
  'DINO DOWN!',
  'NEED HEALING!',
  'BLAME THE PING',
  'CTRL ALT DEFEAT',
  'FOSSILIZED!',
  'DONT HUG CACTI',
  'BIRD BRAINED!',
  'RAGE QUIT TIME?',
  'CACTUS WINS!',
  'TRY JUMPING NEXT',
  'DUCK NEXT TIME!',
  'METEOR WAS KINDER',
  'NO CHAI FOR YOU',
  'PING 9999 MS',
  'OUTPLAYED BY PLANT',
  'RIP BOZO',
  'HR SAW THAT RUN',
  'BOSS IS LOOKING!',
  'PRESS F TO PAY',
  'YOU HAD ONE JOB',
  'DINO NUGGETS NOW',
  'FREE ACUPUNCTURE!',
  'ZERO REACTION TIME',
  'EOD REPORT DUE!',
  'GRAVITY: 1 YOU: 0',
  'AIR TRAFFIC FAIL',
  'SHARP LANDING!',
  'SO CLOSE YET SO L',
  'UNINSTALL CHROME',
  'SEGFAULT AT CACTUS',
  'NULL JUMP POINTER',
  'GIT PUSH --FORCE L',
  '404 JUMP NOT FOUND',
  'SYNTAX ERROR: OUCH',
  'UNCAUGHT CACTUS!',
  'STACK OVERFLOWED!',
  'RUNTIME EXCEPTION!',
  'COMPILATION FAILED',
  'RM -RF /DINO',
  'MERGE CONFLICT!',
  'PR REJECTED!',
  'OFF BY ONE PIXEL!',
  'INFINITE PAIN LOOP',
  'WORKS ON MY DINO!',
  'COMMIT AND CRY',
  'LINTING FAILED!',
  'CACTUS IS NOT NULL',
  'TODO: LEARN 2 JUMP',
  'DEPLOY FAILED!',
  'PTERO IN PROD!',
  'SUDO JUMP NEXT!',
  'OUT OF MEMORY!',
  '10X DEV 0X JUMPER',
  'CODE REVIEW: 0/10',
  'GARBAGE COLLECTED!',
  'DINO DEPRECATED',
  'BROKEN BUILD!',
  'NO UNIT TESTS?',
  'EXIT CODE: 1',
  'KERNEL PANIC!',
  'CACTUS INJECTED!',
  'DOCKER CRASHED!',
  'DNS NOT RESOLVED!',
  '500 INTERNAL OUCH',
  'BUFFER OVERFLOW!',
  'HARDCODED DEFEAT',
  'DEBUG YOUR REFLEX',
  'HOTFIX REQUIRED!',
  'DONT DEPLOY FRIDAY',
];
const SCORE_GAP_SLOTS = 2;
const FPS_SLOTS = 7;
/** Leaderboard row: rank and dot, a mark slot (⚡ start-fast, 📱 mobile), name, space, score. */
const BOARD_NAME_SLOTS = 10;
/** Slots between the rank and the name for the tags: a bolt for a sped-up run, a phone for mobile. */
const BOARD_TAG_SLOTS = 2;
const BOARD_SCORE_SLOT = 3 + BOARD_TAG_SLOTS + BOARD_NAME_SLOTS + 1;
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
/** Bright on the day's dark ink, deep on the night's light ink. */
const DAY_GOLD = '#ffc61a';
const GOLD = [hexToRgb(DAY_GOLD), hexToRgb('#7a5200')] as const;
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

/** What a row's bolt means, for its tooltip and screen readers: the multiplier, or the old fast start. */
function speedNote(entry: BoardEntry): string {
  if (entry.multiplier !== 1) return `${entry.multiplier}x speed`;
  return entry.fast ? 'started fast' : '';
}

function boardRow(entry: BoardEntry, tone: number): PixelMask {
  const mask = createMask(BOARD_ROW_SLOTS * MONO_PITCH - 1, GLYPH_H);
  writeNumber(mask, entry.rank, 0, 2, false, tone);
  writeChar(mask, '.', 2, tone);
  // The bolt marks any run off the standard pace (the exact multiplier is in the row's tooltip).
  const sped = entry.multiplier !== 1 || entry.fast;
  if (sped) writeChar(mask, '⚡', 3, tone);
  if (entry.mobile) writeChar(mask, '📱', sped ? 4 : 3, tone);
  [...boardName(entry.name)].forEach((ch, i) => writeChar(mask, ch, 3 + BOARD_TAG_SLOTS + i, tone));
  writeNumber(mask, entry.score, BOARD_SCORE_SLOT, SCORE.MAX_DIGITS, true, tone);
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
  const tones: Tones = { version: 0, ink: PALETTE.day.ink, dim: PALETTE.day.ink, halo: 'transparent', bg: PALETTE.day.bg, danger: DAY_DANGER, gold: DAY_GOLD };
  const view: ViewState = { phase: 'title', touch: false, fps: false, config: false, star: false };

  const add = (parent: HTMLElement, mask: PixelMask, className: string, tier: Tier, visible: Item['visible'] = always, halo = true): PixelCanvas => {
    const canvas = new PixelCanvas(mask, className, halo);
    parent.appendChild(canvas.el);
    items.push({ canvas, tier, visible });
    return canvas;
  };

  const hud = el('div', 'hud', root);
  const confetti = createConfetti(hud);
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
  add(signInLink, SIGN_IN_ICON, 'hud-icon hud-signin-icon', 'button', always, false);
  add(signInLink, layoutText('SIGN IN'), 'hud-btn-label', 'small', always, false);
  // The source, in the bottom-right corner whenever the game isn't running.
  const githubLink = el('a', 'hud-btn hud-btn-github', hud);
  githubLink.href = REPO_URL;
  githubLink.target = '_blank';
  githubLink.rel = 'noopener';
  githubLink.setAttribute('data-ui', '');
  githubLink.setAttribute('aria-label', 'Source code on GitHub');
  githubLink.addEventListener('mousedown', (e) => e.preventDefault());
  add(githubLink, GITHUB_ICON, 'hud-icon', 'button', (v) => v.phase !== 'playing', false);

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
  // An invisible crown-sized spot left of first place, where the 3D crown rests (main.ts).
  const crownAnchor = add(boardRows, CROWN_ICON, 'hud-board-crown', 'small', isMenu);
  const rowCanvases: PixelCanvas[] = [];
  const boardNote = add(boardBox, layoutText(''), 'hud-board-note', 'small', isMenu);
  const boardList = el('ol', 'hud-status', boardBox);
  let boardKey = '';
  let boardView: BoardView | null = null;
  let animatedBest: BoardView['newBest'] = null;
  let animatedDelete: BoardView['statsDeleted'] = null;
  let lingerTimer = 0;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  /** Distance between two board rows on screen, or 0 while the board isn't laid out. */
  function rowPitch(rows: readonly HTMLElement[]): number {
    if (rows.length === 0) return 0;
    const first = rows[0].getBoundingClientRect();
    return rows.length > 1 ? rows[1].getBoundingClientRect().top - first.top : first.height;
  }

  /**
   * Deleted stats: a copy of the player's old row decays where it stood, its pixels dropping out
   * in random blocks as it fades and sinks, while what was below it (rows, the note) slides up.
   */
  function decayRow(old: HTMLCanvasElement, below: readonly HTMLElement[], pitch: number): void {
    const rect = old.getBoundingClientRect();
    if (rect.height === 0 || reducedMotion?.matches) return;
    const ghost = document.createElement('canvas');
    ghost.width = old.width;
    ghost.height = old.height;
    ghost.className = 'hud-board-ghost';
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const g = ghost.getContext('2d');
    if (!g) return;
    g.drawImage(old, 0, 0);
    hud.appendChild(ghost);
    // Blocks of about one art pixel, so it crumbles like the pixel art it is.
    const block = Math.max(2, Math.round(ghost.height / (GLYPH_H + 2)));
    const cols = Math.ceil(ghost.width / block);
    const cells = Array.from({ length: cols * Math.ceil(ghost.height / block) }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    const DECAY_MS = 750;
    const start = performance.now();
    let cleared = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / DECAY_MS);
      for (const target = Math.floor(cells.length * t * t); cleared < target; cleared++) {
        const c = cells[cleared];
        g.clearRect((c % cols) * block, Math.floor(c / cols) * block, block, block);
      }
      ghost.style.opacity = String(1 - t * t);
      ghost.style.transform = `translateY(${t * t * pitch * 0.6}px)`;
      if (t < 1) requestAnimationFrame(tick);
      else ghost.remove();
    };
    requestAnimationFrame(tick);
    const timing = { duration: 500, delay: 450, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' as const };
    for (const el of below) el.animate?.([{ transform: `translateY(${pitch}px)` }, { transform: 'none' }], timing);
  }

  /**
   * A new best: the player's row blinks. If it moved them up, it first slides up from where they
   * stood (or from below the list, if they were further down or new) into their new place, and
   * the rows they passed shuffle down a slot. Skipped while the board isn't laid out.
   */
  function animateNewBest(view: BoardView): void {
    const me = view.entries.findIndex((e) => e.me);
    const from = view.newBest?.from ?? null;
    const rows = rowCanvases.slice(0, view.entries.length).map((c) => c.el);
    if (me < 0 || typeof rows[me].animate !== 'function') return;
    const pitch = rowPitch(rows);
    if (pitch <= 0) return;
    const blink = (delay: number): Animation => rows[me].animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], { duration: 420, iterations: 3, delay });
    if (from !== null && from <= view.newBest!.to) {
      blink(350);
      return;
    }
    let old = from === null ? -1 : view.entries.findIndex((e) => e.rank === from);
    if (old <= me) old = rows.length;
    const timing = { duration: 900, delay: 350, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' as const };
    rows[me].animate([{ transform: `translateY(${(old - me) * pitch}px)` }, { transform: 'none' }], timing);
    for (let i = me + 1; i < Math.min(old, rows.length); i++) rows[i].animate([{ transform: `translateY(${-pitch}px)` }, { transform: 'none' }], timing);
    blink(1300);
  }

  // ── Config panel ──
  const config = createConfigPanel(hud, (parent, mask, className, tier) => add(parent, mask, className, tier, (v) => v.config, false), emit, emitSettings);
  let lastConfigOpen: boolean | null = null;
  const backdropHasFocus = (): boolean => hud.querySelector('.hud-config-backdrop')?.contains(document.activeElement) ?? false;

  // ── Star prompt ──
  const starPrompt = createStarPrompt(hud, (parent, mask, className, tier) => add(parent, mask, className, tier, (v) => v.star, false), emit);
  let lastStarOpen: boolean | null = null;

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
  const pausedMask = layoutText('PAUSED');
  const pausedTitle = add(paused, pausedMask, 'hud-paused-title', 'big', isPaused);
  let lastResumeIn: number | null = null;
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
    const [dg, ng] = GOLD;
    tones.gold = `rgb(${mix(dg[0], ng[0], t)},${mix(dg[1], ng[1], t)},${mix(dg[2], ng[2], t)})`;
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
    if (ctx.starOpen !== lastStarOpen) {
      lastStarOpen = ctx.starOpen;
      hud.dataset.star = String(ctx.starOpen);
      if (ctx.starOpen) starPrompt.focus();
      else if (hud.querySelector('.hud-star-backdrop')?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    }
    if (ctx.dark !== lastDark) {
      lastDark = ctx.dark;
      themeIcon.setMask(ctx.dark ? SUN_ICON : MOON_ICON);
      themeBtn.setAttribute('aria-pressed', String(ctx.dark));
    }
    const isPausedNow = s.phase === 'paused';
    // Resuming counts down in place of PAUSED; the hint hides meanwhile.
    if (ctx.resumeIn !== lastResumeIn) {
      lastResumeIn = ctx.resumeIn;
      pausedTitle.setMask(ctx.resumeIn === null ? pausedMask : layoutText(String(ctx.resumeIn)));
      hud.dataset.countdown = String(ctx.resumeIn !== null);
    }
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
    // Deleted stats: copy the player's row off the old board before it is redrawn.
    let decay: (() => void) | null = null;
    if (view.statsDeleted && view.statsDeleted !== animatedDelete) {
      animatedDelete = view.statsDeleted;
      const gone = boardView?.entries.findIndex((e) => e.me) ?? -1;
      if (gone >= 0) {
        const old = rowCanvases[gone].el;
        const copy = document.createElement('canvas');
        copy.width = old.width;
        copy.height = old.height;
        copy.getContext('2d')?.drawImage(old, 0, 0);
        const rect = old.getBoundingClientRect();
        const pitch = rowPitch(rowCanvases.slice(0, boardView!.entries.length).map((c) => c.el));
        decay = () => {
          // Stand the copy in for the old row (same box), then let it decay.
          copy.getBoundingClientRect = () => rect;
          decayRow(copy, [...rowCanvases.slice(gone, view.entries.length).map((c) => c.el), boardNote.el], pitch);
        };
      }
    }
    boardView = view;
    hud.dataset.account = view.account;
    view.entries.forEach((e, i) => {
      if (!rowCanvases[i]) rowCanvases.push(add(boardRows, createMask(1, GLYPH_H), 'hud-board-row', 'small', isMenu));
      rowCanvases[i].setMask(boardRow(e, e.me ? 1 : 2));
      rowCanvases[i].el.classList.toggle('hud-board-me', e.me);
      const note = speedNote(e);
      if (note) rowCanvases[i].el.title = note;
      else rowCanvases[i].el.removeAttribute('title');
      rowCanvases[i].el.hidden = false;
    });
    for (let i = view.entries.length; i < rowCanvases.length; i++) rowCanvases[i].el.hidden = true;
    if (view.newBest && view.newBest !== animatedBest) {
      animatedBest = view.newBest;
      animateNewBest(view);
    }
    decay?.();
    boardNote.setMask(layoutText(view.note));
    liveLine.setMask(layoutText(view.live));
    // Screen readers get the board as text.
    boardList.replaceChildren(
      ...view.entries.map((e) => {
        const li = document.createElement('li');
        li.textContent = `${e.rank}. ${e.name}${e.me ? ' (you)' : ''}: ${e.score}${speedNote(e) ? `, ${speedNote(e)}` : ''}${e.mobile ? ', on mobile' : ''}`;
        return li;
      }),
    );
  }

  return {
    setBoard,

    lingerBoard(ms) {
      clearTimeout(lingerTimer);
      hud.style.setProperty('--hud-linger', `${ms}ms`);
      hud.dataset.boardLinger = 'true';
      lingerTimer = window.setTimeout(() => delete hud.dataset.boardLinger, ms);
    },

    crownRest() {
      const row = rowCanvases[0]?.el;
      if (!row || row.hidden || (boardView?.entries.length ?? 0) === 0) return null;
      const spot = crownAnchor.el.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      if (rect.height === 0) return null;
      // The canvas has a pixel of padding round the glyphs: the letters are GLYPH_H of GLYPH_H + 2 rows.
      const pad = rect.height / (GLYPH_H + 2);
      return { right: spot.right, baseline: rect.bottom - pad, height: rect.height - 2 * pad, opacity: Number(getComputedStyle(boardBox).opacity) };
    },

    celebrate() {
      confetti.burst();
    },

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
      view.star = ctx.starOpen;
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
      confetti.dispose();
      listeners.clear();
      settingsListeners.clear();
      hud.remove();
    },
  };
}
