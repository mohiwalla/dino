// Pixel text for plain DOM (the pages and the curtain between them): a PixelMask drawn as an image
// mask in the text colour, at whole device pixels per art pixel so its edges stay sharp.

import type { PixelMask } from './ui/font';

const masks = new Map<string, string>();

/** A mask as a PNG data URL at `unit` device pixels per art pixel (cached). */
function maskUrl(key: string, mask: PixelMask, unit: number): string {
  const cached = masks.get(`${key}|${unit}`);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, mask.w * unit);
  canvas.height = mask.h * unit;
  const g = canvas.getContext('2d');
  if (g) {
    for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) if (mask.bits[y * mask.w + x]) g.fillRect(x * unit, y * unit, unit, unit);
  }
  const url = canvas.toDataURL();
  masks.set(`${key}|${unit}`, url);
  return url;
}

/** A pixel mask drawn at `scale` CSS px per art pixel, in the text colour; `label` is what it reads as. */
export function pixels(mask: PixelMask, scale: number, label: string, key = label): HTMLElement {
  const dpr = window.devicePixelRatio || 1;
  // Whole device pixels per art pixel keep the edges sharp.
  const unit = Math.max(1, Math.round(scale * dpr));
  const span = document.createElement('span');
  span.className = 'px';
  span.style.width = `${(mask.w * unit) / dpr}px`;
  span.style.height = `${(mask.h * unit) / dpr}px`;
  span.style.setProperty('--mask', `url(${maskUrl(key, mask, unit)})`);
  if (label) {
    const sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = label;
    span.append(sr);
  } else span.setAttribute('aria-hidden', 'true');
  return span;
}

