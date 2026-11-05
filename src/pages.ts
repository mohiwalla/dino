// What the game's plain pages share (admin.html, runs.html), drawn like the game's HUD: every word
// in its 7 px pixel font, Chrome's grey ink, square outlines, and the game's light or dark theme.
// Pixel text is an image (a CSS mask in the text colour), with the words kept for screen readers.

import './curtain';
import './pages.css';
import { STORAGE_KEYS } from './config';
import { api, ApiError, type Account } from './net/api';
import { pixels } from './pixel-text';
import { layoutText, type PixelMask } from './ui/font';
import { PLAY_ICON, SIGN_IN_ICON, STAR_ICON } from './ui/icons';

/** The game's theme: ?theme=, else the one picked in the game, else the system's. */
function applyTheme(): void {
  let choice = new URLSearchParams(location.search).get('theme');
  try {
    choice ??= localStorage.getItem(STORAGE_KEYS.theme);
  } catch {
    // Storage blocked: the system's.
  }
  const dark = choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
applyTheme();

export { pixels };

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ── Pixel text ──

/** One line of pixel text. */
export function px(text: string, scale = 2): HTMLElement {
  return pixels(layoutText(text), scale, text);
}

/** Pixel text that wraps between words. */
export function pxWords(text: string, scale = 2): HTMLElement {
  const words = text.split(/\s+/).filter(Boolean);
  const line = h('span', { className: 'px-words' }, ...words.map((w) => pixels(layoutText(w), scale, '', w)));
  line.style.setProperty('--px-scale', `${scale}px`);
  line.append(h('span', { className: 'sr', textContent: text }));
  return line;
}

const icon = (mask: PixelMask, name: string, scale = 2) => pixels(mask, scale, '', `icon:${name}`);

// ── Formatting ──

/** "JUST NOW", "12 MIN AGO", "3 H AGO", "2 D AGO", then the date. */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'JUST NOW';
  if (s < 3600) return `${Math.floor(s / 60)} MIN AGO`;
  if (s < 86400) return `${Math.floor(s / 3600)} H AGO`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} D AGO`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
}

/** A time as "3 H AGO", with the full date and time on hover. */
export function time(ms: number | null): HTMLElement {
  if (ms === null) return px('-');
  const t = h('time', { title: new Date(ms).toLocaleString(), dateTime: new Date(ms).toISOString() }, px(ago(ms)));
  return t;
}

/** Run length from its sim steps (60 a second). */
export function duration(steps: number): string {
  const s = Math.round(steps / 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The old fast start (before the multiplier) shows as 1.5X, as on the board. */
export function speed(r: { multiplier: number; fast: boolean | number }): string {
  const m = r.multiplier !== 1 ? r.multiplier : r.fast ? 1.5 : 1;
  return `${m}X`;
}

const STATUS: Readonly<Record<string, { label: string; tone: string }>> = {
  ok: { label: 'RANKED', tone: 'ok' },
  review: { label: 'IN REVIEW', tone: 'warn' },
  rejected: { label: 'FAILED CHECKS', tone: 'bad' },
  void: { label: 'VOIDED', tone: 'bad' },
  banned: { label: 'BANNED', tone: 'bad' },
};

export function pill(status: string): HTMLElement {
  const s = STATUS[status] ?? { label: status.toUpperCase(), tone: 'ok' };
  return h('span', { className: `pill pill-${s.tone}` }, px(s.label));
}

/** A gold tag beside the player's best run. */
export function bestTag(): HTMLElement {
  return h('span', { className: 'best' }, icon(STAR_ICON, 'star'), px('BEST'));
}

// ── Layout ──

/** The bar across the top: the game's name, the pages, and who is signed in, over a ground line. */
export function topBar(me: Account | null, here: 'runs' | 'admin'): HTMLElement {
  const link = (href: string, label: string, page?: 'runs' | 'admin') => {
    const a = h('a', { href, className: 'chip' }, px(label));
    if (page === here) a.setAttribute('aria-current', 'page');
    return a;
  };
  return h(
    'header',
    { className: 'topbar' },
    h('a', { href: '/', className: 'brand' }, h('img', { src: '/favicon.ico', alt: '', width: 28, height: 28 }), px('DINO 3D', 3)),
    h('nav', { className: 'links' }, link('/', 'PLAY'), link('/runs', 'MY RUNS', 'runs'), ...(me?.admin ? [link('/admin', 'ADMIN', 'admin')] : [])),
    h('span', { className: 'who' }, me ? px(me.email) : ''),
  );
}

/** The page's heading and a line under it. */
export function heading(title: string, lede: string): HTMLElement {
  return h('div', { className: 'heading' }, h('h1', {}, px(title, 4)), h('p', { className: 'lede' }, pxWords(lede)));
}

/** A row of big numbers with labels. */
export function stats(items: readonly (readonly [string, string, string?])[]): HTMLElement {
  return h(
    'section',
    { className: 'stats' },
    ...items.map(([label, value, note]) => h('div', { className: 'stat' }, h('span', { className: 'stat-label' }, pxWords(label)), h('span', { className: 'stat-value' }, px(value, 4)), note ? h('span', { className: 'stat-note' }, pxWords(note)) : '')),
  );
}

/** Tabs as chips, the current one filled; `count` adds a number. */
export function tabs<T extends string>(options: readonly (readonly [T, string, number?])[], current: T, pick: (value: T) => void): HTMLElement {
  return h(
    'div',
    { className: 'tabs', role: 'tablist' },
    ...options.map(([value, label, count]) => {
      const b = h('button', { type: 'button', role: 'tab', className: 'chip' }, px(label));
      if (count) b.append(h('span', { className: 'count' }, px(String(count))));
      b.setAttribute('aria-selected', String(value === current));
      b.addEventListener('click', () => pick(value));
      return b;
    }),
  );
}

export interface Column {
  label: string;
  className?: string;
}

/** A table; on phones each row becomes a card, every cell labelled by its column. */
export function table(columns: readonly Column[], rows: readonly (readonly (Node | string)[])[], rowClass?: (i: number) => string): HTMLElement {
  const head = h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { className: c.className ?? '' }, c.label ? px(c.label) : ''))));
  const body = h(
    'tbody',
    {},
    ...rows.map((cells, i) => {
      const tr = h('tr', { className: rowClass?.(i) ?? '' });
      cells.forEach((cell, j) => {
        const { label, className } = columns[j];
        const td = h('td', { className: `${className ?? ''}${label ? '' : ' unlabelled'}` });
        if (label) td.append(h('span', { className: 'cell-label' }, px(label)));
        td.append(h('span', { className: 'cell' }, typeof cell === 'string' ? px(cell) : cell));
        tr.append(td);
      });
      return tr;
    }),
  );
  return h('div', { className: 'table' }, h('table', {}, head, body));
}

export function empty(text: string, ...extra: (Node | string)[]): HTMLElement {
  return h('div', { className: 'empty' }, pxWords(text), ...extra);
}

// ── Buttons, notices, dialogs ──

/** A chip button; `tone` danger draws it red, primary fills it. */
export function chip(label: string, onClick: () => void, tone: 'plain' | 'danger' | 'primary' = 'plain'): HTMLButtonElement {
  const b = h('button', { type: 'button', className: `chip chip-${tone}` }, px(label));
  b.addEventListener('click', onClick);
  return b;
}

/** A link to watch a run back in the game. */
export function watchLink(id: string, newTab = false): HTMLElement {
  return h('a', { className: 'chip', href: `/?replay=${encodeURIComponent(id)}`, target: newTab ? '_blank' : '', title: 'Watch the replay' }, icon(PLAY_ICON, 'play'), px('WATCH'));
}

/** A short message in the corner that fades away. */
export function toast(text: string, tone: 'ok' | 'bad' = 'ok'): void {
  const t = h('div', { className: `toast toast-${tone}`, role: 'status' }, pxWords(text.toUpperCase()));
  document.body.append(t);
  setTimeout(() => t.classList.add('toast-out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

/** A confirm dialog like the game's panels; resolves to whether the action was confirmed. */
export function confirmAction(title: string, body: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'confirm' });
    const close = (value: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const cancel = chip('CANCEL', () => close(false));
    const ok = chip(action, () => close(true), 'danger');
    dialog.append(h('h2', {}, pxWords(title, 3)), h('p', {}, pxWords(body)), h('div', { className: 'confirm-actions' }, cancel, ok));
    dialog.setAttribute('aria-label', title);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}

/** A chip that runs `act`, disabled while it does; failures become a toast. */
export function actionButton(label: string, act: () => Promise<unknown>, danger = false): HTMLButtonElement {
  const button = chip(
    label,
    () => {
      button.disabled = true;
      act()
        .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'bad'))
        .finally(() => (button.disabled = false));
    },
    danger ? 'danger' : 'plain',
  );
  return button;
}

/** A panel with a title, a line and actions, like the game's settings panel (signed out, not allowed). */
export function panel(title: string, body: string, ...actions: HTMLElement[]): HTMLElement {
  return h('section', { className: 'panel' }, h('h1', {}, px(title, 4)), h('p', {}, pxWords(body)), h('div', { className: 'panel-actions' }, ...actions));
}

/** Signed out: a panel asking to sign in, coming back to `next`. */
export function signIn(title: string, next: string): HTMLElement {
  return panel(title, 'SIGN IN WITH YOUR SIFARS MICROSOFT ACCOUNT TO SEE THIS PAGE.', h('a', { className: 'chip chip-primary', href: api.loginUrl(next) }, icon(SIGN_IN_ICON, 'sign-in'), px('SIGN IN')));
}

/** A placeholder while data loads, blinking like the game's prompts. */
export function loading(): HTMLElement {
  return h('div', { className: 'loading' }, px('LOADING...'));
}
