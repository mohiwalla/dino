// Confetti for a rank up or a new best: square pixel flakes in a burst of colours (the one
// place the HUD leaves its monochrome palette), falling and fluttering over the game for a few
// seconds. One canvas, drawn only while a burst is on screen; skipped under reduced motion.

const COLORS = ['#ffc61a', '#e53935', '#43a047', '#1e88e5', '#8e24aa', '#fb8c00'];
const FLAKES = 150;
/** Seconds before the burst is cut, whatever is still on screen. */
const MAX_SECONDS = 4.5;
/** Gravity, in screen heights per second squared. */
const GRAVITY = 1.1;

interface Flake {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Flutter: the flake's width follows |cos(phase)|. */
  phase: number;
  spin: number;
  color: string;
}

export interface Confetti {
  burst(): void;
  dispose(): void;
}

export function createConfetti(root: HTMLElement): Confetti {
  const canvas = document.createElement('canvas');
  canvas.className = 'hud-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  root.appendChild(canvas);
  const g = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let flakes: Flake[] = [];
  let raf = 0;
  let last = 0;
  let age = 0;

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    age += dt;
    const w = canvas.width;
    const h = canvas.height;
    const px = Math.max(3, Math.round(Math.min(w, h) / 160));
    g!.clearRect(0, 0, w, h);
    flakes = flakes.filter((f) => f.y < h + px * 4);
    for (const f of flakes) {
      f.vy += GRAVITY * h * dt;
      f.vx *= 1 - 1.2 * dt; // air drag
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.phase += f.spin * dt;
      const fw = Math.max(1, Math.round(px * Math.abs(Math.cos(f.phase))));
      g!.fillStyle = f.color;
      g!.fillRect(Math.round(f.x - fw / 2), Math.round(f.y), fw, px);
    }
    if (flakes.length > 0 && age < MAX_SECONDS) raf = requestAnimationFrame(frame);
    else {
      g!.clearRect(0, 0, w, h);
      flakes = [];
      raf = 0;
    }
  }

  return {
    burst() {
      if (!g || reduced?.matches) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(root.clientWidth * dpr);
      canvas.height = Math.round(root.clientHeight * dpr);
      const w = canvas.width;
      const h = canvas.height;
      // Two cannons from the bottom corners, aimed up and in.
      for (let i = 0; i < FLAKES; i++) {
        const left = i % 2 === 0;
        const angle = (left ? -1 : 1) * (0.25 + Math.random() * 0.45);
        const speed = h * (1 + Math.random() * 0.45);
        flakes.push({
          x: left ? w * 0.04 : w * 0.96,
          y: h,
          vx: Math.sin(-angle) * speed,
          vy: -Math.cos(angle) * speed,
          phase: Math.random() * Math.PI,
          spin: 6 + Math.random() * 10,
          color: COLORS[i % COLORS.length],
        });
      }
      age = 0;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },

    dispose() {
      cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}
