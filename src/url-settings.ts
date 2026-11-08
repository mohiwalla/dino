// Settings from the page's query string, for this visit only: ?funny=true&nsfw=true&volume=25.
// Each one stands in for its saved value (as STORAGE_KEYS stores it) when the game reads it at
// load, and is never written back, so the saved configuration stays as it was. Changing a
// setting in the config panel still saves it, as usual.

import { MULTIPLIERS, STORAGE_KEYS } from './config';

const params = new URLSearchParams(location.search);

/** true/false, 1/0, on/off, yes/no; a bare ?nsfw is on. */
function flag(name: string): string | null {
  const value = params.get(name)?.toLowerCase();
  if (value === undefined) return null;
  if (['', 'true', '1', 'on', 'yes'].includes(value)) return '1';
  if (['false', '0', 'off', 'no'].includes(value)) return '0';
  return null;
}

/** ?volume=0..100 (percent), stored as 0..1. */
function volume(): string | null {
  const raw = params.get('volume');
  const v = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(v) ? String(Math.min(100, Math.max(0, v)) / 100) : null;
}

/** ?funny=true|false, or ?mode=funny|regular. */
function mode(): string | null {
  const named = params.get('mode');
  if (named === 'funny' || named === 'regular') return named;
  const funny = flag('funny');
  return funny === null ? null : funny === '1' ? 'funny' : 'regular';
}

/** ?multiplier=1..2 (or ?speed=), one of MULTIPLIERS; a trailing x is fine (1.5x). */
function multiplier(): string | null {
  const v = Number((params.get('multiplier') ?? params.get('speed'))?.replace(/x$/i, ''));
  return MULTIPLIERS.includes(v) ? String(v) : null;
}

/** ?period=week|all: which team board shows. */
function period(): string | null {
  const v = params.get('period');
  return v === 'week' || v === 'all' ? v : null;
}

const overrides = new Map<string, string>();
for (const [key, value] of [
  [STORAGE_KEYS.mode, mode()],
  [STORAGE_KEYS.nsfw, flag('nsfw')],
  [STORAGE_KEYS.farts, flag('farts')],
  [STORAGE_KEYS.volume, volume()],
  // Asking for a volume means hearing it, as moving the panel's slider does.
  [STORAGE_KEYS.muted, flag('muted') ?? flag('mute') ?? (volume() === null ? null : '0')],
  [STORAGE_KEYS.dayNight, flag('daynight')],
  [STORAGE_KEYS.multiplier, multiplier()],
  [STORAGE_KEYS.ranked, flag('ranked')],
  [STORAGE_KEYS.showBoard, flag('board')],
  [STORAGE_KEYS.boardPeriod, period()],
] as const) {
  if (value !== null) overrides.set(key, value);
}

/** The query string's value for a saved setting, in its stored form; null when the URL leaves it alone. */
export function urlSetting(key: string): string | null {
  return overrides.get(key) ?? null;
}
