// Chrome's T-Rex runner draws its score and "GAME OVER" with an NES-style 7 x 7 pixel font
// (the sprite sheet's TEXT_SPRITE). The digits, H, I and the GAME OVER letters (A E G M O R V)
// are traced from Chrome's 2x sprite; every other glyph is drawn in the same style: 2 px
// vertical strokes, 1 px horizontals, 7 rows tall.

/** A 1-bit-per-pixel image, y-down (row 0 is the top). Values: 0 empty, else a tone index. */
export interface PixelMask {
  w: number;
  h: number;
  bits: Uint8Array;
}

export const GLYPH_H = 7;
/** Slot width for monospaced runs (score digits): a 7 px glyph plus 1 px tracking. */
export const MONO_PITCH = 8;

const GLYPH_ROWS: Readonly<Record<string, readonly string[]>> = {
  '0': ['..###..', '.#..##.', '##...##', '##...##', '##...##', '.##..#.', '..###..'],
  '1': ['...##..', '..###..', '...##..', '...##..', '...##..', '...##..', '.######'],
  '2': ['.#####.', '##...##', '....###', '..####.', '.####..', '###....', '#######'],
  '3': ['.######', '....##.', '...##..', '..####.', '.....##', '##...##', '.#####.'],
  '4': ['...###.', '..####.', '.##.##.', '##..##.', '#######', '....##.', '....##.'],
  '5': ['######.', '##.....', '######.', '.....##', '.....##', '##...##', '.#####.'],
  '6': ['..####.', '.##....', '##.....', '######.', '##...##', '##...##', '.#####.'],
  '7': ['#######', '##...##', '....##.', '...##..', '..##...', '..##...', '..##...'],
  '8': ['.####..', '##...#.', '###..#.', '.####..', '#..####', '#....##', '.#####.'],
  '9': ['.#####.', '##...##', '##...##', '.######', '.....##', '....##.', '.####..'],
  A: ['..###..', '.##.##.', '##...##', '##...##', '#######', '##...##', '##...##'],
  B: ['######.', '##...##', '##...##', '######.', '##...##', '##...##', '######.'],
  C: ['..####.', '.##..##', '##.....', '##.....', '##.....', '.##..##', '..####.'],
  D: ['#####..', '##..##.', '##...##', '##...##', '##...##', '##..##.', '#####..'],
  E: ['#######', '##.....', '##.....', '######.', '##.....', '##.....', '#######'],
  F: ['#######', '##.....', '##.....', '######.', '##.....', '##.....', '##.....'],
  G: ['..#####', '.##....', '##.....', '##..###', '##...##', '.##..##', '..#####'],
  H: ['##...##', '##...##', '##...##', '#######', '##...##', '##...##', '##...##'],
  I: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '######'],
  J: ['....###', '.....##', '.....##', '.....##', '##...##', '##...##', '.#####.'],
  K: ['##...##', '##..##.', '##.##..', '####...', '#####..', '##.###.', '##..###'],
  L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######'],
  M: ['##...##', '###.###', '#######', '#######', '##.#.##', '##...##', '##...##'],
  N: ['##...##', '###..##', '####.##', '#######', '##.####', '##..###', '##...##'],
  O: ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  P: ['######.', '##...##', '##...##', '##...##', '######.', '##.....', '##.....'],
  Q: ['.#####.', '##...##', '##...##', '##...##', '##.####', '##..##.', '.###.##'],
  R: ['######.', '##...##', '##...##', '##..###', '#####..', '##.###.', '##..###'],
  S: ['.####..', '##..##.', '##.....', '.#####.', '.....##', '##...##', '.#####.'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  V: ['##...##', '##...##', '##...##', '###.###', '.#####.', '..###..', '...#...'],
  W: ['##...##', '##...##', '##.#.##', '#######', '#######', '###.###', '##...##'],
  X: ['##...##', '###.###', '.#####.', '..###..', '.#####.', '###.###', '##...##'],
  Y: ['##..##', '##..##', '##..##', '.####.', '..##..', '..##..', '..##..'],
  Z: ['#######', '....###', '...###.', '..###..', '.###...', '###....', '#######'],
  // Lowercase (emails). No room for descenders in 7 rows, so g j p q y sit a row higher.
  a: ['......', '......', '.####.', '....##', '.#####', '##..##', '.#####'],
  b: ['##....', '##....', '#####.', '##..##', '##..##', '##..##', '#####.'],
  c: ['......', '......', '.####.', '##....', '##....', '##....', '.####.'],
  d: ['....##', '....##', '.#####', '##..##', '##..##', '##..##', '.#####'],
  e: ['......', '......', '.####.', '##..##', '######', '##....', '.####.'],
  f: ['..###', '.##..', '####.', '.##..', '.##..', '.##..', '.##..'],
  g: ['......', '.#####', '##..##', '##..##', '.#####', '....##', '.####.'],
  h: ['##....', '##....', '#####.', '##..##', '##..##', '##..##', '##..##'],
  i: ['##', '..', '##', '##', '##', '##', '##'],
  j: ['...##', '.....', '...##', '...##', '...##', '##.##', '.###.'],
  k: ['##....', '##....', '##..##', '##.##.', '####..', '##.##.', '##..##'],
  l: ['###.', '.##.', '.##.', '.##.', '.##.', '.##.', '####'],
  m: ['.......', '.......', '###.##.', '##.#.##', '##.#.##', '##.#.##', '##...##'],
  n: ['......', '......', '#####.', '##..##', '##..##', '##..##', '##..##'],
  o: ['......', '......', '.####.', '##..##', '##..##', '##..##', '.####.'],
  p: ['......', '#####.', '##..##', '##..##', '#####.', '##....', '##....'],
  q: ['......', '.#####', '##..##', '##..##', '.#####', '....##', '....##'],
  r: ['.....', '.....', '##.##', '###..', '##...', '##...', '##...'],
  s: ['......', '......', '.#####', '##....', '.####.', '....##', '#####.'],
  t: ['.##..', '.##..', '#####', '.##..', '.##..', '.##..', '..###'],
  u: ['......', '......', '##..##', '##..##', '##..##', '##..##', '.#####'],
  v: ['......', '......', '##..##', '##..##', '##..##', '.####.', '..##..'],
  w: ['.......', '.......', '##...##', '##.#.##', '##.#.##', '##.#.##', '.##.##.'],
  x: ['......', '......', '##..##', '.####.', '..##..', '.####.', '##..##'],
  y: ['......', '##..##', '##..##', '##..##', '.#####', '....##', '.####.'],
  z: ['......', '......', '######', '...##.', '..##..', '.##...', '######'],
  '.': ['..', '..', '..', '..', '..', '##', '##'],
  ':': ['..', '##', '##', '..', '##', '##', '..'],
  '!': ['##', '##', '##', '##', '##', '..', '##'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['......#', '.....##', '....##.', '...##..', '..##...', '.##....', '##.....'],
  '·': ['..', '..', '..', '##', '##', '..', '..'],
  '↑': ['..##..', '.####.', '######', '..##..', '..##..', '..##..', '..##..'],
  '↓': ['..##..', '..##..', '..##..', '..##..', '######', '.####.', '..##..'],
  '@': ['.#####.', '##...##', '##.####', '##.####', '##.###.', '##.....', '.#####.'],
  '_': ['......', '......', '......', '......', '......', '......', '######'],
  '📱': ['.###.', '#...#', '#...#', '#...#', '#...#', '#.#.#', '.###.'],
};

interface Glyph {
  readonly w: number;
  /** GLYPH_H rows of w pixels, row-major, y-down. */
  readonly px: Uint8Array;
}

const GLYPHS = new Map<string, Glyph>();
for (const [ch, rows] of Object.entries(GLYPH_ROWS)) {
  const w = rows[0].length;
  const px = new Uint8Array(w * GLYPH_H);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) px[y * w + x] = row[x] === '#' ? 1 : 0;
  });
  GLYPHS.set(ch, { w, px });
}
const DIGIT_GLYPHS: readonly Glyph[] = Array.from({ length: 10 }, (_, d) => GLYPHS.get(String(d))!);

/** Pixel-art rows ('#' = ink, anything else empty) to a mask; rows may differ in length. */
export function maskFromRows(rows: readonly string[]): PixelMask {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const bits = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') bits[y * w + x] = 1;
  });
  return { w, h, bits };
}

export function createMask(w: number, h: number): PixelMask {
  return { w, h, bits: new Uint8Array(w * h) };
}

export interface TextOptions {
  /** Gap between glyphs in px. Default 1. */
  tracking?: number;
  /** Width of a space in px (before tracking). Default 3. */
  space?: number;
  /** Tone written for ink pixels. Default 1. */
  tone?: number;
}

function glyphFor(ch: string): Glyph | undefined {
  return GLYPHS.get(ch) ?? GLYPHS.get(ch.toUpperCase());
}

/** Width in px of `text` laid out with `opts` (no trailing tracking). */
export function measureText(text: string, opts: TextOptions = {}): number {
  const tracking = opts.tracking ?? 1;
  const space = opts.space ?? 3;
  let w = 0;
  for (const ch of text) w += (glyphFor(ch)?.w ?? space) + tracking;
  return Math.max(0, w - tracking);
}

/** Lay `text` out on a single line. Unknown characters render as spaces. */
export function layoutText(text: string, opts: TextOptions = {}): PixelMask {
  const tracking = opts.tracking ?? 1;
  const space = opts.space ?? 3;
  const mask = createMask(measureText(text, opts), GLYPH_H);
  let x = 0;
  for (const ch of text) {
    const g = glyphFor(ch);
    if (g) writeGlyph(mask, g, x, 0, opts.tone ?? 1);
    x += (g?.w ?? space) + tracking;
  }
  return mask;
}

/** Lay out runs of [text, tone] on one line, separated by a space. */
export function layoutRuns(runs: readonly (readonly [string, number])[], opts: TextOptions = {}): PixelMask {
  const tracking = opts.tracking ?? 1;
  const gap = (opts.space ?? 3) + tracking * 2;
  const parts = runs.map(([text, tone]) => layoutText(text, { ...opts, tone }));
  const mask = createMask(parts.reduce((w, p) => w + p.w, 0) + gap * (parts.length - 1), GLYPH_H);
  let x = 0;
  for (const p of parts) {
    for (let y = 0; y < GLYPH_H; y++) mask.bits.set(p.bits.subarray(y * p.w, (y + 1) * p.w), y * mask.w + x);
    x += p.w + gap;
  }
  return mask;
}

function writeGlyph(mask: PixelMask, g: Glyph, x0: number, y0: number, tone: number): void {
  for (let y = 0; y < GLYPH_H; y++)
    for (let x = 0; x < g.w; x++) {
      const tx = x0 + x;
      if (g.px[y * g.w + x] && tx >= 0 && tx < mask.w) mask.bits[(y0 + y) * mask.w + tx] = tone;
    }
}

/** Write one character into MONO_PITCH slot `slot` of a mask (no allocation). */
export function writeChar(mask: PixelMask, ch: string, slot: number, tone: number): void {
  const g = glyphFor(ch);
  if (g) writeGlyph(mask, g, slot * MONO_PITCH, 0, tone);
}

/**
 * Write `value` as `digits` monospaced digits starting at `slot` (no allocation).
 * `zeroPad` false leaves leading zeros blank (right-aligned number).
 */
export function writeNumber(mask: PixelMask, value: number, slot: number, digits: number, zeroPad: boolean, tone: number): void {
  let v = Math.max(0, Math.floor(value));
  for (let i = digits - 1; i >= 0; i--) {
    const d = v % 10;
    if (zeroPad || v > 0 || i === digits - 1) writeGlyph(mask, DIGIT_GLYPHS[d], (slot + i) * MONO_PITCH, 0, tone);
    v = Math.floor(v / 10);
  }
}

/** Number of decimal digits in a non-negative integer (at least 1). */
export function digitCount(value: number): number {
  let n = 1;
  for (let v = Math.floor(Math.max(0, value)); v >= 10; v = Math.floor(v / 10)) n++;
  return n;
}
