// The star prompt: a modal asking the player to star the repo on GitHub. main.ts decides when
// it opens (after a second game in one visit; once more on reaching the top 3 if put off) and
// remembers the answer; this only draws it and reports the choice as a UiAction.

import { REPO_URL } from '../config';
import type { UiAction } from '../types';
import { layoutText, type PixelMask } from './font';
import { GITHUB_MARK, STAR_ICON } from './icons';
import type { PixelCanvas } from './pixel-canvas';

type AddCanvas = (parent: HTMLElement, mask: PixelMask, className: string, tier: 'big' | 'small' | 'button') => PixelCanvas;

export interface StarPrompt {
  /** Called when the prompt opens. */
  focus(): void;
}

export function createStarPrompt(root: HTMLElement, add: AddCanvas, emitAction: (action: UiAction) => void): StarPrompt {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  };

  const backdrop = el('div', 'hud-star-backdrop', root);
  backdrop.setAttribute('data-ui', '');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Star the game on GitHub');
  const panel = el('div', 'hud-star', backdrop);
  const head = el('div', 'hud-star-head', panel);
  add(head, GITHUB_MARK, 'hud-star-logo', 'small');
  const lines = el('div', 'hud-star-lines', head);
  add(lines, layoutText('ENJOYING DINO 3D?'), 'hud-config-title', 'small');
  add(lines, layoutText('STAR IT ON GITHUB'), 'hud-config-value', 'small');

  const actions = el('div', 'hud-star-actions', panel);
  const chip = <K extends 'button' | 'a'>(tag: K, label: string, action: UiAction, parent: HTMLElement): [HTMLElementTagNameMap[K], PixelCanvas] => {
    const b = el(tag, 'hud-chip', parent);
    if (b instanceof HTMLButtonElement) {
      b.type = 'button';
      b.addEventListener('mousedown', (e) => e.preventDefault());
    }
    b.addEventListener('click', () => emitAction(action));
    return [b, add(b, layoutText(label), 'hud-chip-text', 'small')];
  };
  chip('button', 'LATER', 'starLater', actions);
  // A real link, so the new tab is never blocked as a popup.
  const [star, starText] = chip('a', 'STAR', 'starDone', actions);
  star.href = REPO_URL;
  star.target = '_blank';
  star.rel = 'noopener';
  star.setAttribute('data-ui', '');
  star.classList.add('hud-chip-primary', 'hud-chip-with-icon');
  const icon = add(star, STAR_ICON, 'hud-chip-icon', 'small');
  star.prepend(icon.el);
  // Knocked out of the ink fill, like a chosen radio; the star itself in gold.
  icon.setTint('gold');
  starText.setTint('bg');

  return {
    focus() {
      star.focus({ preventScroll: true });
    },
  };
}
