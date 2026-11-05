// The config panel: a modal over the game for everything that doesn't need a HUD button of
// its own (account, sound volume, ranked play, the team board, modes and toggles). Text is the HUD's
// pixel font; the controls are real buttons and a range input, so keyboards and screen
// readers work. hud.ts owns it and draws its canvases.

import { MULTIPLIERS } from '../config';
import type { BoardView, GameMode, Settings, UiAction } from '../types';
import { layoutText, type PixelMask } from './font';
import { BIN_ICON, SIGN_IN_ICON, SIGN_OUT_ICON } from './icons';
import type { PixelCanvas } from './pixel-canvas';

type AddCanvas = (parent: HTMLElement, mask: PixelMask, className: string, tier: 'big' | 'small' | 'button') => PixelCanvas;

export interface ConfigPanel {
  update(settings: Readonly<Settings>, board: BoardView | null, touch: boolean): void;
  /** Called when the panel opens. */
  focus(): void;
}

/** An email in the pixel font's character set. */
function pixelEmail(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9.@_-]/g, '')
    .slice(0, 40);
}

export function createConfigPanel(
  root: HTMLElement,
  add: AddCanvas,
  emitAction: (action: UiAction) => void,
  emitSettings: (change: Partial<Settings>) => void,
): ConfigPanel {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  };

  const backdrop = el('div', 'hud-config-backdrop', root);
  backdrop.setAttribute('data-ui', '');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Configuration');
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) emitAction('toggleConfig');
  });
  const panel = el('div', 'hud-config', backdrop);

  /** A pixel-text button; `text` swaps its label later. */
  const chip = (parent: HTMLElement, label: string, onClick: () => void): { el: HTMLButtonElement; canvas: PixelCanvas; text(label: string): void } => {
    const b = el('button', 'hud-chip', parent);
    b.type = 'button';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    const canvas = add(b, layoutText(label), 'hud-chip-text', 'small');
    let shown = label;
    return {
      el: b,
      canvas,
      text(next) {
        if (next === shown) return;
        shown = next;
        canvas.setMask(layoutText(next));
      },
    };
  };

  /**
   * One choice of several, as radio buttons. `set` marks the chosen value; a disabled option
   * stays greyed out (and a disabled group shows `shown` without being clickable).
   */
  const radio = <T extends string | boolean>(parent: HTMLElement, label: string, options: readonly (readonly [T, string])[], onPick: (value: T) => void) => {
    const group = el('div', 'hud-config-radios', parent);
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const chips = options.map(([value, text]) => {
      const c = chip(group, text, () => onPick(value));
      c.el.setAttribute('role', 'radio');
      return [value, c] as const;
    });
    return {
      set(shown: T, disabled: (value: T) => boolean = () => false) {
        for (const [value, c] of chips) {
          c.el.setAttribute('aria-checked', String(value === shown));
          c.canvas.setTint(value === shown ? 'bg' : null); // the chosen chip is ink-filled
          c.el.disabled = disabled(value);
        }
      },
    };
  };

  const row = (label: string): HTMLElement => {
    add(panel, layoutText(label), 'hud-config-label', 'small');
    return el('div', 'hud-config-controls', panel);
  };

  // ── Header ──
  const header = el('div', 'hud-config-header', panel);
  add(header, layoutText('CONFIGURATION'), 'hud-config-title', 'small');
  const close = chip(header, 'ESC', () => emitAction('toggleConfig'));
  close.el.setAttribute('aria-label', 'Close');

  let settings: Readonly<Settings> | null = null;

  /** A heading over the rows that follow, with a rule out to the panel's edge. */
  const section = (title: string): void => {
    const head = el('div', 'hud-config-section', panel);
    add(head, layoutText(title), 'hud-config-section-title', 'small');
  };

  /** An on/off switch with ON / OFF beside it, for a boolean setting; a disabled one is greyed out, a hidden one gone. */
  const toggle = (label: string, ariaLabel: string, key: 'ranked' | 'farts' | 'nsfw' | 'dayNight') => {
    const parent = row(label);
    const sw = el('button', 'hud-switch', parent);
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', ariaLabel);
    sw.addEventListener('mousedown', (e) => e.preventDefault());
    sw.addEventListener('click', () => settings && emitSettings({ [key]: !settings[key] }));
    el('span', 'hud-switch-knob', sw);
    const text = add(parent, layoutText('ON'), 'hud-config-value', 'small');
    const rowLabel = parent.previousElementSibling as HTMLElement;
    const set = (on: boolean, disabled = false, hidden = false) => {
      parent.hidden = rowLabel.hidden = hidden;
      sw.setAttribute('aria-checked', String(on));
      sw.disabled = disabled;
      text.setMask(layoutText(on ? 'ON' : 'OFF'));
    };
    return Object.assign(set, { label: rowLabel });
  };

  // ── Player ──
  section('PLAYER');
  const account = row('ACCOUNT');
  const accountText = add(account, layoutText(''), 'hud-config-value', 'small');
  const signIn = el('a', 'hud-chip hud-chip-with-icon', account);
  signIn.setAttribute('data-ui', '');
  add(signIn, SIGN_IN_ICON, 'hud-chip-icon', 'small');
  add(signIn, layoutText('SIGN IN'), 'hud-chip-text', 'small');
  const setRanked = toggle('RANKED RUNS', 'Ranked runs', 'ranked');
  const historyRow = row('HISTORY');
  const historyLabel = historyRow.previousElementSibling as HTMLElement;
  const myRuns = el('a', 'hud-chip', historyRow);
  myRuns.href = '/runs';
  myRuns.setAttribute('data-ui', '');
  add(myRuns, layoutText('MY RUNS'), 'hud-chip-text', 'small');
  const boardRow = row('TEAM BOARD');
  const boardLabel = boardRow.previousElementSibling as HTMLElement;
  const board = radio(boardRow, 'Team board', [[true, 'SHOWN'], [false, 'HIDDEN']], (on) => emitSettings({ showBoard: on }));

  // ── Sound ──
  section('SOUND');
  const sound = row('VOLUME');
  const soundToggle = chip(sound, 'ON', () => settings && emitSettings({ muted: !settings.muted }));
  const volume = el('input', 'hud-range', sound);
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.step = '5';
  volume.setAttribute('aria-label', 'Volume');
  volume.addEventListener('input', () => emitSettings({ volume: Number(volume.value) / 100, muted: false }));
  const volumeText = add(sound, layoutText('100'), 'hud-config-value', 'small');
  const modes = radio(
    row('MODE'),
    'Mode',
    [
      ['regular', 'REGULAR'],
      ['funny', 'FUNNY'],
    ] as const satisfies readonly (readonly [GameMode, string])[],
    (mode) => emitSettings({ mode }),
  );
  // Sub-options of FUNNY, indented under MODE.
  const setNsfw = toggle('NSFW', 'NSFW crash sounds', 'nsfw');
  setNsfw.label.classList.add('hud-config-sub');
  const setFarts = toggle('FARTS', 'Farts', 'farts');
  setFarts.label.classList.add('hud-config-sub');

  // ── Gameplay ──
  section('GAMEPLAY');
  // The game speed multiplier: a slider over MULTIPLIERS, applied from the next run.
  const pace = row('MULTIPLIER');
  const paceRange = el('input', 'hud-range', pace);
  paceRange.type = 'range';
  paceRange.min = '0';
  paceRange.max = String(MULTIPLIERS.length - 1);
  paceRange.step = '1';
  paceRange.setAttribute('aria-label', 'Game speed multiplier');
  paceRange.addEventListener('input', () => emitSettings({ multiplier: MULTIPLIERS[Number(paceRange.value)] }));
  const paceText = add(pace, layoutText('1X'), 'hud-config-value', 'small');
  const setDayNight = toggle('DAY/NIGHT CYCLE', 'Day and night cycle', 'dayNight');

  // The account actions sit at the bottom, away from the everyday settings: deleting the
  // player's stats (filled red) on the left, SIGN OUT on the right.
  const footer = el('div', 'hud-config-footer', panel);
  /** The bin asks once more before it acts; the question lapses after a few seconds. */
  let confirmTimer = 0;
  const resetDelete = (): void => {
    clearTimeout(confirmTimer);
    confirmTimer = 0;
    deleteBtn.text('STATS');
    deleteBtn.el.setAttribute('aria-label', 'Delete my stats');
  };
  const deleteBtn = chip(footer, 'STATS', () => {
    if (confirmTimer) {
      resetDelete();
      emitAction('deleteStats');
      return;
    }
    deleteBtn.text('SURE?');
    deleteBtn.el.setAttribute('aria-label', 'Confirm: delete all my stats');
    confirmTimer = window.setTimeout(resetDelete, 4000);
  });
  deleteBtn.el.classList.add('hud-chip-danger', 'hud-chip-with-icon');
  deleteBtn.el.setAttribute('aria-label', 'Delete my stats');
  deleteBtn.canvas.setTint('bg'); // knocked out of the red fill
  const binIcon = add(deleteBtn.el, BIN_ICON, 'hud-chip-icon', 'small');
  binIcon.setTint('bg');
  deleteBtn.el.prepend(binIcon.el);
  const signOut = chip(footer, 'SIGN OUT', () => emitAction('signOut'));
  signOut.el.classList.add('hud-chip-with-icon');
  signOut.el.prepend(add(signOut.el, SIGN_OUT_ICON, 'hud-chip-icon', 'small').el);

  let lastKey = '';
  return {
    update(next, view, touch) {
      const key = JSON.stringify([next, view?.account, view?.email, view?.entries.some((e) => e.me), touch]);
      if (key === lastKey) return;
      lastKey = key;
      settings = next;

      const signedIn = view?.account === 'signedIn';
      // Signed out, the SIGN IN button says it all.
      accountText.setMask(layoutText(view?.account === 'off' || !view ? 'OFFLINE' : signedIn ? pixelEmail(view.email ?? '') : ''));
      accountText.el.hidden = view?.account === 'signedOut';
      accountText.el.setAttribute('aria-label', signedIn ? `Signed in as ${view.email}` : 'Not signed in');
      footer.hidden = !signedIn;
      // Nothing on the board, nothing to delete.
      const hasStats = view?.entries.some((e) => e.me) ?? false;
      if (!hasStats && confirmTimer) resetDelete();
      deleteBtn.el.disabled = !hasStats;
      close.text(touch ? 'CLOSE' : 'ESC');
      signIn.hidden = view?.account !== 'signedOut';
      signIn.href = `/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;

      soundToggle.text(next.muted ? 'OFF' : 'ON');
      soundToggle.el.setAttribute('aria-pressed', String(!next.muted));
      soundToggle.el.setAttribute('aria-label', 'Sound');
      const percent = Math.round(next.volume * 100);
      if (document.activeElement !== volume) volume.value = String(percent);
      volumeText.setMask(layoutText(String(next.muted ? 0 : percent)));

      // Ranked runs and the board need an account.
      setRanked(next.ranked, false, !signedIn);
      const paceIndex = Math.max(0, MULTIPLIERS.indexOf(next.multiplier));
      if (document.activeElement !== paceRange) paceRange.value = String(paceIndex);
      paceRange.setAttribute('aria-valuetext', `${next.multiplier} times`);
      paceText.setMask(layoutText(`${next.multiplier}X`));
      setDayNight(next.dayNight);
      // The board only shows with ranked runs on.
      board.set(next.showBoard && next.ranked, () => !next.ranked);
      boardRow.hidden = boardLabel.hidden = !signedIn;
      historyRow.hidden = historyLabel.hidden = !signedIn;
      modes.set(next.mode);
      // NSFW picks funny mode's crash clips, so it only shows there.
      setNsfw(next.nsfw, false, next.mode !== 'funny');
      setFarts(next.farts, false, next.mode !== 'funny');
    },

    focus() {
      close.el.focus({ preventScroll: true });
    },
  };
}
