// The config panel: a modal over the game for everything that doesn't need a HUD button of
// its own (account, sound volume, ranked play, the team board, game modes). Text is the HUD's
// pixel font; the controls are real buttons and a range input, so keyboards and screen
// readers work. hud.ts owns it and draws its canvases.

import type { BoardView, GameMode, Settings, UiAction } from '../types';
import { layoutText, type PixelMask } from './font';
import { SIGN_IN_ICON, SIGN_OUT_ICON } from './icons';
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

  // ── Account ──
  const account = row('ACCOUNT');
  const accountText = add(account, layoutText(''), 'hud-config-value', 'small');
  const signIn = el('a', 'hud-chip hud-chip-with-icon', account);
  signIn.setAttribute('data-ui', '');
  add(signIn, SIGN_IN_ICON, 'hud-chip-icon', 'small');
  add(signIn, layoutText('SIGN IN'), 'hud-chip-text', 'small');

  // ── Sound ──
  const sound = row('SOUND');
  let settings: Readonly<Settings> | null = null;
  const soundToggle = chip(sound, 'ON', () => settings && emitSettings({ muted: !settings.muted }));
  const volume = el('input', 'hud-range', sound);
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.step = '5';
  volume.setAttribute('aria-label', 'Volume');
  volume.addEventListener('input', () => emitSettings({ volume: Number(volume.value) / 100, muted: false }));
  const volumeText = add(sound, layoutText('100'), 'hud-config-value', 'small');

  // ── Leaderboard ──
  const rankedRow = row('RANKED RUNS');
  const rankedSwitch = el('button', 'hud-switch', rankedRow);
  rankedSwitch.type = 'button';
  rankedSwitch.setAttribute('role', 'switch');
  rankedSwitch.setAttribute('aria-label', 'Ranked runs');
  rankedSwitch.addEventListener('mousedown', (e) => e.preventDefault());
  rankedSwitch.addEventListener('click', () => settings && emitSettings({ ranked: !settings.ranked }));
  el('span', 'hud-switch-knob', rankedSwitch);
  const rankedText = add(rankedRow, layoutText('ON'), 'hud-config-value', 'small');
  const board = radio(row('TEAM BOARD'), 'Team board', [[true, 'SHOWN'], [false, 'HIDDEN']], (on) => emitSettings({ showBoard: on }));

  // ── Modes ──
  const modes = radio(
    row('MODE'),
    'Mode',
    [
      ['classic', 'CLASSIC'],
      ['funny', 'FUNNY · SOON'],
    ] as const satisfies readonly (readonly [GameMode, string])[],
    (mode) => emitSettings({ mode }),
  );

  // Sign out sits alone at the bottom, away from the everyday settings.
  const footer = el('div', 'hud-config-footer', panel);
  const signOut = chip(footer, 'SIGN OUT', () => emitAction('signOut'));
  signOut.el.classList.add('hud-chip-danger', 'hud-chip-with-icon');
  signOut.canvas.setTint('bg'); // knocked out of the red fill
  const signOutIcon = add(signOut.el, SIGN_OUT_ICON, 'hud-chip-icon', 'small');
  signOutIcon.setTint('bg');
  signOut.el.prepend(signOutIcon.el);

  let lastKey = '';
  return {
    update(next, view, touch) {
      const key = JSON.stringify([next, view?.account, view?.email, touch]);
      if (key === lastKey) return;
      lastKey = key;
      settings = next;

      const signedIn = view?.account === 'signedIn';
      // Signed out, the SIGN IN button says it all.
      accountText.setMask(layoutText(view?.account === 'off' || !view ? 'OFFLINE' : signedIn ? pixelEmail(view.email ?? '') : ''));
      accountText.el.hidden = view?.account === 'signedOut';
      accountText.el.setAttribute('aria-label', signedIn ? `Signed in as ${view.email}` : 'Not signed in');
      footer.hidden = !signedIn;
      close.text(touch ? 'CLOSE' : 'ESC');
      signIn.hidden = view?.account !== 'signedOut';
      signIn.href = `/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;

      soundToggle.text(next.muted ? 'OFF' : 'ON');
      soundToggle.el.setAttribute('aria-pressed', String(!next.muted));
      soundToggle.el.setAttribute('aria-label', 'Sound');
      const percent = Math.round(next.volume * 100);
      if (document.activeElement !== volume) volume.value = String(percent);
      volumeText.setMask(layoutText(String(next.muted ? 0 : percent)));

      rankedSwitch.setAttribute('aria-checked', String(next.ranked));
      rankedText.setMask(layoutText(next.ranked ? 'ON' : 'OFF'));
      // The board only shows with ranked runs on.
      board.set(next.showBoard && next.ranked, () => !next.ranked);
      modes.set(next.mode, (mode) => mode === 'funny');
    },

    focus() {
      close.el.focus({ preventScroll: true });
    },
  };
}
