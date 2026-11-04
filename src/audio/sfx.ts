// Chrome's three runner sounds, synthesised with WebAudio instead of shipped as samples:
//   jump      – "button-press": a very short, bright square blip.
//   milestone – "score-reached": two quick high beeps.
//   crash     – "hit": a short, low, falling buzz.
// Every note has a few-ms attack and release so nothing clicks. The AudioContext is created
// lazily and only plays once a user gesture has unlocked it; without WebAudio it is silent.

import { STORAGE_KEYS } from '../config';
import type { Sfx, SfxName } from '../types';
import { createFunnyClips, scheduleFart, scheduleSlide } from './funny';

const MASTER_GAIN = 0.25;
const ATTACK = 0.004;
const RELEASE = 0.012;

interface Note {
  type: OscillatorType;
  /** Seconds after the sound's start. */
  at: number;
  dur: number;
  freq: number;
  /** Optional pitch glide target, reached exponentially at the end of the note. */
  freqEnd?: number;
  gain: number;
  /** Optional low-pass cutoff (Hz) to round off harsh harmonics. */
  lowpass?: number;
}

/** Note lists per sound; times and pitches tuned by ear against Chrome's samples. */
export const SFX_NOTES: Readonly<Record<'jump' | 'milestone' | 'crash', readonly Note[]>> = {
  jump: [{ type: 'square', at: 0, dur: 0.06, freq: 780, freqEnd: 1040, gain: 0.32, lowpass: 5200 }],
  milestone: [
    { type: 'square', at: 0, dur: 0.075, freq: 1318.5, gain: 0.26, lowpass: 6000 },
    { type: 'square', at: 0.105, dur: 0.12, freq: 1318.5, gain: 0.26, lowpass: 6000 },
  ],
  crash: [
    { type: 'sawtooth', at: 0, dur: 0.2, freq: 150, freqEnd: 58, gain: 0.55, lowpass: 1400 },
    { type: 'square', at: 0, dur: 0.2, freq: 75, freqEnd: 40, gain: 0.32, lowpass: 900 },
  ],
};

/** Schedule one sound into any (online or offline) context. Exported for the dev check page. */
export function scheduleSfx(ctx: BaseAudioContext, destination: AudioNode, name: SfxName, t0: number): void {
  if (name === 'fart') return scheduleFart(ctx, destination, t0);
  if (name === 'slide') return scheduleSlide(ctx, destination, t0);
  for (const n of SFX_NOTES[name]) {
    const start = t0 + n.at;
    const end = start + n.dur;
    const osc = ctx.createOscillator();
    osc.type = n.type;
    osc.frequency.setValueAtTime(n.freq, start);
    if (n.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(n.freqEnd, end);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(n.gain, start + ATTACK);
    env.gain.setValueAtTime(n.gain, end - RELEASE);
    env.gain.linearRampToValueAtTime(0, end);
    let head: AudioNode = osc;
    if (n.lowpass !== undefined) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = n.lowpass;
      osc.connect(filter);
      head = filter;
    }
    head.connect(env);
    env.connect(destination);
    osc.start(start);
    osc.stop(end + 0.01);
    osc.onended = () => env.disconnect();
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.muted) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.muted, muted ? '1' : '0');
  } catch {
    // Storage can be unavailable (private mode, sandboxed iframes); mute just won't persist.
  }
}

/** 0..1, scales MASTER_GAIN. Defaults to full. */
function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEYS.volume) ?? '1');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

function writeVolume(volume: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS.volume, String(volume));
  } catch {
    // Same as mute: just won't persist.
  }
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createSfx(): Sfx {
  let muted = readMuted();
  let volume = readVolume();
  let ctx: AudioContext | null = null;
  const clips = createFunnyClips();
  let master: GainNode | null = null;
  let failed = false;

  function ensureContext(): AudioContext | null {
    if (ctx || failed) return ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      failed = true;
      return null;
    }
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN * volume;
      master.connect(ctx.destination);
    } catch {
      failed = true;
      ctx = null;
    }
    return ctx;
  }

  function unlock(): void {
    const c = ensureContext();
    if (!c || c.state === 'running') return;
    try {
      // Older iOS Safari only unlocks after a buffer is started inside the gesture.
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, c.sampleRate);
      src.connect(c.destination);
      src.start(0);
      void c.resume().catch(() => undefined);
    } catch {
      // Leave it locked; play() stays silent.
    }
  }

  // main.ts samples input inside rAF, outside any gesture, so also unlock straight from the
  // gestures themselves. Kept for the page's lifetime: iOS re-suspends after interruptions.
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true, passive: true });

  return {
    play(name: SfxName): void {
      if (muted || !ctx || !master || ctx.state !== 'running') return;
      try {
        const t0 = ctx.currentTime + 0.005;
        if (name === 'fart' || name === 'slide') {
          clips.load(ctx);
          if (clips.play(ctx, master, name, t0)) return;
        }
        scheduleSfx(ctx, master, name, t0);
      } catch {
        // A broken audio stack must never take the game down.
      }
    },

    get muted(): boolean {
      return muted;
    },

    setMuted(value: boolean): void {
      if (value === muted) return;
      muted = value;
      writeMuted(value);
    },

    get volume(): number {
      return volume;
    },

    setVolume(value: number): void {
      volume = Math.min(1, Math.max(0, value));
      writeVolume(volume);
      if (ctx && master) master.gain.setTargetAtTime(MASTER_GAIN * volume, ctx.currentTime, 0.01);
    },

    unlock,

    stopFunny() {
      clips.stopCrash();
    },

    preloadFunny(nsfw) {
      const c = ensureContext();
      clips.setNsfw(c, nsfw);
      if (c) clips.load(c);
    },
  };
}
