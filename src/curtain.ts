// The curtain between the game's pages (play, my runs, admin), so they move like one app: a link
// to another page raises an ink curtain from the bottom, with the pixel DINO 3D and the T-Rex
// running along a ground line; the next page opens under it, and once that page is ready the
// curtain carries on up and away. The pages are separate documents, so the leaving page saves the
// curtain (its HTML and styles) in sessionStorage, and a script in the head of each page writes it
// back before the first paint (see the HTML files), so it never blinks out between the two.

import css from './curtain.css?inline';
import { STORAGE_KEYS } from './config';
import { pixels } from './pixel-text';
import { TREX_SPRITES } from './render/sprites';
import { layoutText, maskFromRows } from './ui/font';

/** The curtain a leaving page saves: {html, css, startedAt} (see the inline script in each page's head). */
const KEY = 'dino3d.curtain';

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
const UP_MS = 450;
const AWAY_MS = 550;
/** The curtain rests a moment before lifting, so the swap underneath is never glimpsed. */
const REST_MS = 120;
/** A page that never says it's ready is uncovered anyway. */
const MAX_COVER_MS = 2500;
const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';

const PAGES: Readonly<Record<string, string>> = { '/': 'PLAY', '/index.html': 'PLAY', '/runs': 'MY RUNS', '/runs.html': 'MY RUNS', '/admin': 'ADMIN', '/admin.html': 'ADMIN' };

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The T-Rex's running frames, as pixel masks (the eye left open). */
const RUN = [TREX_SPRITES.run1, TREX_SPRITES.run2].map((rows) => maskFromRows(rows.map((r) => r.replace(/[^.o]/g, '#').replace(/o/g, '.'))));

function dark(): boolean {
  let choice: string | null = null;
  try {
    choice = localStorage.getItem(STORAGE_KEYS.theme);
  } catch {
    // Storage blocked: the system's.
  }
  return choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** The curtain, covering the page: the wordmark, the running T-Rex on its ground line, and where it's going. */
function build(label: string): HTMLElement {
  const word = layoutText('DINO 3D');
  // As wide as it comfortably fits: about two thirds of the screen, in whole pixels.
  const scale = Math.max(4, Math.min(14, Math.floor((innerWidth * 0.62) / word.w)));
  const runScale = Math.max(1, Math.round(scale / 5));
  const el = document.createElement('div');
  el.className = 'curtain';
  el.dataset.theme = dark() ? 'dark' : 'light';
  el.setAttribute('aria-hidden', 'true');
  const runner = document.createElement('div');
  runner.className = 'curtain-runner';
  for (const [i, frame] of RUN.entries()) {
    const f = pixels(frame, runScale, '', `trex-run${i}`);
    f.classList.add(`curtain-run${i + 1}`);
    runner.append(f);
  }
  const track = document.createElement('div');
  track.className = 'curtain-track';
  track.append(runner);
  const ground = document.createElement('div');
  ground.className = 'curtain-ground';
  ground.style.setProperty('--px', `${runScale}px`);
  ground.style.setProperty('--runner-w', `${RUN[0].w * runScale}px`);
  ground.append(track);
  const wordmark = pixels(word, scale, '', 'DINO 3D');
  wordmark.classList.add('curtain-word');
  const where = pixels(layoutText(label), Math.max(2, Math.round(scale / 4)), '', label);
  where.classList.add('curtain-label');
  const stage = document.createElement('div');
  stage.className = 'curtain-stage';
  stage.append(wordmark, ground, where);
  el.append(stage);
  document.body.append(el);
  return el;
}

const slide = (el: HTMLElement, from: string, to: string, ms: number, delay = 0) =>
  el.animate([{ transform: `translateY(${from})` }, { transform: `translateY(${to})` }], { duration: ms, delay, easing: EASE, fill: 'forwards' }).finished;

/** Raise the curtain, then go to `href`. */
async function leave(href: string, label: string): Promise<void> {
  if (reducedMotion()) {
    location.href = href;
    return;
  }
  // A fresh run for the T-Rex (not carried on from this page's own arrival).
  document.documentElement.style.removeProperty('--curtain-t');
  const el = build(label);
  const startedAt = Date.now();
  await slide(el, '100%', '0%', UP_MS).catch(() => undefined);
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ html: el.outerHTML, css, startedAt }));
  } catch {
    // No note: the next page just opens uncovered.
  }
  location.href = href;
}

let cover: HTMLElement | null = null;
let lifting = false;

/** The page is ready to be seen: the curtain over it (if it came in under one) lifts away. */
export function revealPage(): void {
  const el = cover;
  if (!el || lifting) return;
  lifting = true;
  void slide(el, '0%', '-100%', AWAY_MS, REST_MS)
    .catch(() => undefined)
    .then(() => {
      el.remove();
      if (cover === el) cover = null;
      lifting = false;
    });
}

// Arriving under a curtain: the head wrote the leaving page's one back; it lifts once this page is ready.
{
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was saved.
  }
  cover = document.querySelector<HTMLElement>('.curtain');
  if (cover) setTimeout(revealPage, MAX_COVER_MS);
}

// Links between the pages raise the curtain (not new tabs, downloads, or modified clicks).
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  const label = PAGES[url.pathname];
  if (url.origin !== location.origin || !label || (url.pathname === location.pathname && url.search === location.search)) return;
  e.preventDefault();
  void leave(url.href, url.searchParams.has('replay') ? 'REPLAY' : label);
});

// Back to a page kept in the back/forward cache: it may still have the curtain that left it up.
addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  for (const el of document.querySelectorAll('.curtain')) el.remove();
  cover = null;
  lifting = false;
});
