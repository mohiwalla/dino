// Draws a PixelMask into a <canvas> at an integer number of device pixels per art pixel, so
// HUD text and icons stay perfectly crisp at any devicePixelRatio. Redraws only on change.

import type { PixelMask } from './font';

/** Shared HUD colours. Bump `version` whenever a colour changes so canvases redraw. */
export interface Tones {
  version: number;
  /** Tone 1. */
  ink: string;
  /** Tone 2: Chrome draws the high score at 80% alpha; this is that colour pre-blended. */
  dim: string;
  /** Soft 1 px outline in the background colour, keeps text legible over the 3D scene. */
  halo: string;
}

/** Empty art pixels around the mask, room for the halo. */
export const PAD = 1;

let scratch = new Uint8Array(256);

export class PixelCanvas {
  readonly el: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private mask: PixelMask;
  private dirty = true;
  private unit = 0;
  private dpr = 0;
  private tonesVersion = -1;

  constructor(
    mask: PixelMask,
    className: string,
    private readonly halo = true,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = className;
    this.el.setAttribute('aria-hidden', 'true');
    this.g = this.el.getContext('2d');
    this.mask = mask;
  }

  setMask(mask: PixelMask): void {
    if (mask === this.mask) return;
    this.mask = mask;
    this.dirty = true;
  }

  /** The mask was edited in place. */
  invalidate(): void {
    this.dirty = true;
  }

  /** `unit` is device pixels per art pixel. */
  render(unit: number, dpr: number, tones: Tones): void {
    if (!this.dirty && unit === this.unit && dpr === this.dpr && tones.version === this.tonesVersion) return;
    const sizeChanged = this.resize(unit, dpr);
    this.unit = unit;
    this.dpr = dpr;
    this.tonesVersion = tones.version;
    this.dirty = false;
    const g = this.g;
    if (!g) return;
    if (!sizeChanged) g.clearRect(0, 0, this.el.width, this.el.height);
    if (this.halo) this.drawHalo(g, unit, tones.halo);
    this.drawTone(g, unit, 1, tones.ink);
    this.drawTone(g, unit, 2, tones.dim);
  }

  /** Returns true if the backing store was resized (which also clears it). */
  private resize(unit: number, dpr: number): boolean {
    const w = (this.mask.w + PAD * 2) * unit;
    const h = (this.mask.h + PAD * 2) * unit;
    if (w === this.el.width && h === this.el.height && dpr === this.dpr) return false;
    this.el.width = w;
    this.el.height = h;
    this.el.style.width = `${w / dpr}px`;
    this.el.style.height = `${h / dpr}px`;
    return true;
  }

  private drawTone(g: CanvasRenderingContext2D, unit: number, tone: number, color: string): void {
    const { w, h, bits } = this.mask;
    g.fillStyle = color;
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (bits[y * w + x] !== tone) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < w && bits[y * w + x] === tone) x++;
        g.fillRect((x0 + PAD) * unit, (y + PAD) * unit, (x - x0) * unit, unit);
      }
    }
  }

  /** Every empty pixel 8-adjacent to ink, in padded coordinates, drawn once. */
  private drawHalo(g: CanvasRenderingContext2D, unit: number, color: string): void {
    const { w, h, bits } = this.mask;
    const pw = w + PAD * 2;
    const ph = h + PAD * 2;
    if (scratch.length < pw * ph) scratch = new Uint8Array(pw * ph * 2);
    scratch.fill(0, 0, pw * ph);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!bits[y * w + x]) continue;
        for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) scratch[(y + dy) * pw + x + dx] = 1;
      }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) scratch[(y + PAD) * pw + x + PAD] = 0;
    g.fillStyle = color;
    for (let y = 0; y < ph; y++) {
      let x = 0;
      while (x < pw) {
        if (!scratch[y * pw + x]) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < pw && scratch[y * pw + x]) x++;
        g.fillRect(x0 * unit, y * unit, (x - x0) * unit, unit);
      }
    }
  }
}
