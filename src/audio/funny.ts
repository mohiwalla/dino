// The silly sounds. fart (a jump, with farts on) plays a recorded clip from ./farts at a slightly
// random pitch; slide (funny mode's crash) plays a meme clip from ./crash, or only from
// ./crash/nsfw with NSFW on. Both go through a shuffle bag (src/shuffle.ts): every clip plays
// once before any repeats. The farts are small and all decoded up front; the crash clips are 1.4 MB, so
// only the next one is fetched and decoded ahead of time, and the service worker caches each
// as it is fetched rather than precaching them all.
// Until they have loaded, synthesised stand-ins below play instead:
//   fart  – a buzzy low sawtooth, wobbled in pitch and sputtered in volume.
//   slide – a cartoon bonk, then a slide whistle falling away.

import { createShuffleBag } from '../shuffle';
import { mulberry32 } from '../sim/rng';
import { findBeats } from './beats';

const FART_URLS = Object.values(import.meta.glob<string>('./farts/*.mp3', { eager: true, query: '?url', import: 'default' }));
const SAFE_CRASH_URLS = Object.values(import.meta.glob<string>('./crash/*.mp3', { eager: true, query: '?url', import: 'default' }));
const NSFW_CRASH_URLS = Object.values(import.meta.glob<string>('./crash/nsfw/*.mp3', { eager: true, query: '?url', import: 'default' }));
/** Clip level against the synthesised sounds. */
const CLIP_GAIN = 1;

/** Chosen so the two sounds sit about as loud as Chrome's. */
const FART_GAIN = 0.9;
const BONK_GAIN = 0.5;
const WHISTLE_GAIN = 0.32;

function envelope(ctx: BaseAudioContext, start: number, end: number, gain: number, attack = 0.008, release = 0.06): GainNode {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + attack);
  env.gain.setValueAtTime(gain, Math.max(start + attack, end - release));
  env.gain.linearRampToValueAtTime(0, end);
  return env;
}

/** An LFO at `hz` added to `param`, swinging it by +/- `depth`. */
function wobble(ctx: BaseAudioContext, param: AudioParam, hz: number, depth: number, type: OscillatorType, start: number, end: number): void {
  const lfo = ctx.createOscillator();
  lfo.type = type;
  lfo.frequency.setValueAtTime(hz, start);
  const amount = ctx.createGain();
  amount.gain.value = depth;
  lfo.connect(amount).connect(param);
  lfo.start(start);
  lfo.stop(end + 0.01);
  lfo.onended = () => amount.disconnect();
}

export function scheduleFart(ctx: BaseAudioContext, destination: AudioNode, t0: number, random: () => number = Math.random): void {
  const dur = 0.2 + random() * 0.22;
  const end = t0 + dur;
  const f0 = 68 + random() * 46;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f0 * 1.15, t0);
  osc.frequency.exponentialRampToValueAtTime(f0 * 0.72, end);
  wobble(ctx, osc.frequency, 20 + random() * 14, f0 * 0.3, 'sine', t0, end);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(650 + random() * 300, t0);
  filter.Q.value = 3;

  // Sputter: the volume flutters between about 30% and 100%.
  const sputter = ctx.createGain();
  sputter.gain.value = 0.65;
  wobble(ctx, sputter.gain, 14 + random() * 10, 0.35, 'square', t0, end);

  const env = envelope(ctx, t0, end, FART_GAIN, 0.012, 0.08);
  osc.connect(filter).connect(sputter).connect(env).connect(destination);
  osc.start(t0);
  osc.stop(end + 0.01);
  osc.onended = () => env.disconnect();
}

export function scheduleSlide(ctx: BaseAudioContext, destination: AudioNode, t0: number): void {
  const bonk = ctx.createOscillator();
  bonk.type = 'triangle';
  bonk.frequency.setValueAtTime(220, t0);
  bonk.frequency.exponentialRampToValueAtTime(90, t0 + 0.12);
  const bonkEnv = envelope(ctx, t0, t0 + 0.13, BONK_GAIN, 0.003, 0.05);
  bonk.connect(bonkEnv).connect(destination);
  bonk.start(t0);
  bonk.stop(t0 + 0.14);
  bonk.onended = () => bonkEnv.disconnect();

  const start = t0 + 0.08;
  const end = start + 0.7;
  const whistle = ctx.createOscillator();
  whistle.type = 'sine';
  whistle.frequency.setValueAtTime(1500, start);
  whistle.frequency.exponentialRampToValueAtTime(240, end);
  wobble(ctx, whistle.frequency, 7, 28, 'sine', start, end);
  const env = envelope(ctx, start, end, WHISTLE_GAIN, 0.02, 0.15);
  whistle.connect(env).connect(destination);
  whistle.start(start);
  whistle.stop(end + 0.01);
  whistle.onended = () => env.disconnect();
}

export interface FunnyClips {
  /** Start fetching and decoding the clips (safe to call repeatedly). */
  load(ctx: BaseAudioContext): void;
  /** NSFW on: crash clips come only from the NSFW set. */
  setNsfw(ctx: BaseAudioContext | null, on: boolean): void;
  /** Plays a clip if they have loaded; returns false so the caller can fall back to synthesis. */
  play(ctx: BaseAudioContext, destination: AudioNode, name: 'fart' | 'slide', t0: number): boolean;
  /** Cuts a crash clip still playing (the next run started). */
  stopCrash(): void;
  /** The hits of the crash clip last started by play('slide'), in seconds; empty if it was synthesised. */
  readonly crashBeats: readonly number[];
  /** The URL of the crash clip last started by play('slide'); empty if it was synthesised. */
  readonly crashClip: string;
  /** A replay: every crash plays this clip (fetched now) whatever the bag holds; '' plays none (the synthesised sound). */
  queueCrash(ctx: BaseAudioContext, url: string): void;
  /** The queued clip has loaded (or failed to): a replay may start. True with nothing queued. */
  readonly crashReady: boolean;
  /** Farts come in an order and pitch set by `seed`. */
  seedFarts(seed: number): void;
}

export function createFunnyClips(): FunnyClips {
  let farts: AudioBuffer[] = [];
  /** Fart indices, each played once before any repeats. */
  let fartBag = createShuffleBag<number>([]);
  let loading = false;
  let crashUrls = SAFE_CRASH_URLS;
  /** Crash clips, each played once before any repeats; refilled when NSFW changes the set. */
  let crashBag = createShuffleBag(crashUrls);
  /** The next crash clip, decoded ahead; `crashUrl` is the one it came from. */
  let nextCrash: AudioBuffer | null = null;
  let nextBeats: number[] = [];
  let crashBeats: readonly number[] = [];
  let crashClip = '';
  /** A replay's crash clip ('' for none: the synthesised sound), or null to take them from the bag. */
  let queued: string | null = null;
  /** The clip last asked for, and the last one done loading (or failing to). */
  let crashUrl = '';
  let loadedUrl = '';
  let fartRandom: () => number = Math.random;
  let fetchingCrash = false;
  let playingCrash: AudioBufferSourceNode | null = null;

  const decode = (ctx: BaseAudioContext, url: string): Promise<AudioBuffer> =>
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data));

  /** Takes the next crash clip (the replay's, else the bag's) and decodes it, ready for the next crash. */
  function prepareCrash(ctx: BaseAudioContext): void {
    if (fetchingCrash || nextCrash || queued === '' || crashUrls.length === 0) return;
    fetchingCrash = true;
    const url = (crashUrl = queued ?? crashBag.next());
    decode(ctx, url)
      .then((b) => {
        // A clip asked for since (a replay's) wins over this one, whenever each finishes.
        if (url !== crashUrl) return;
        // Dropped if the mode changed while it decoded and the clip isn't in the new set (a replay's always counts).
        nextCrash = url === queued || crashUrls.includes(url) ? b : null;
        nextBeats = nextCrash ? findBeats(nextCrash) : [];
      })
      .catch(() => undefined)
      .finally(() => {
        if (url !== crashUrl) return;
        fetchingCrash = false;
        loadedUrl = url;
      });
  }

  return {
    load(ctx) {
      if (loading) return;
      loading = true;
      Promise.all(FART_URLS.map((u) => decode(ctx, u)))
        .then((buffers) => {
          farts = buffers;
          fartBag = createShuffleBag(buffers.map((_, i) => i), fartRandom);
        })
        .catch(() => (loading = false));
      prepareCrash(ctx);
    },

    setNsfw(ctx, on) {
      const urls = on ? NSFW_CRASH_URLS : SAFE_CRASH_URLS;
      if (urls === crashUrls) return;
      crashUrls = urls;
      crashBag = createShuffleBag(urls);
      if (crashUrl !== queued && !urls.includes(crashUrl)) nextCrash = null;
      if (ctx && loading) prepareCrash(ctx);
    },

    play(ctx, destination, name, t0) {
      let buffer: AudioBuffer | null = null;
      let rate = 1;
      if (name === 'slide') {
        buffer = nextCrash;
        crashBeats = buffer ? nextBeats : [];
        crashClip = buffer ? crashUrl : '';
        nextCrash = null;
        prepareCrash(ctx);
      } else if (farts.length > 0) {
        buffer = farts[fartBag.next()];
        rate = 0.9 + fartRandom() * 0.25;
      }
      if (!buffer) return false;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = CLIP_GAIN;
      src.connect(gain).connect(destination);
      src.start(t0);
      src.onended = () => {
        gain.disconnect();
        if (playingCrash === src) playingCrash = null;
      };
      if (name === 'slide') playingCrash = src;
      return true;
    },

    get crashBeats() {
      return crashBeats;
    },

    get crashClip() {
      return crashClip;
    },

    queueCrash(ctx, url) {
      queued = url;
      if (url !== '' && crashUrl === url && (nextCrash || fetchingCrash)) return;
      // Whatever was loading (a bag clip) is disowned: it lands nowhere when it finishes.
      crashUrl = url;
      nextCrash = null;
      fetchingCrash = false;
      prepareCrash(ctx);
    },

    get crashReady() {
      return !queued || nextCrash !== null || loadedUrl === queued;
    },

    seedFarts(seed) {
      fartRandom = mulberry32(seed);
      fartBag = createShuffleBag(farts.map((_, i) => i), fartRandom);
    },

    stopCrash() {
      try {
        playingCrash?.stop();
      } catch {
        // Already stopped.
      }
      playingCrash = null;
    },
  };
}
