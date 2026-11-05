// The hits in a crash clip, so funny mode's crash can twitch along with the sound.

/** Beat finding: 20 ms loudness windows over the first 8 s; hits at least 0.18 s apart, 24 at most. */
const BEAT_WINDOW_S = 0.02;
const BEAT_SPAN_S = 8;
const BEAT_GAP_S = 0.18;
const MAX_BEATS = 24;

/**
 * The hits in a clip (seconds from its start): windows whose loudness jumps well above the
 * recent average, so the crash animation can twitch along with the sound.
 */
export function findBeats(buffer: AudioBuffer): number[] {
  const data = buffer.getChannelData(0);
  const win = Math.max(1, Math.round(buffer.sampleRate * BEAT_WINDOW_S));
  const n = Math.min(Math.floor(data.length / win), Math.round(BEAT_SPAN_S / BEAT_WINDOW_S));
  const level = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * win; j < (i + 1) * win; j++) sum += data[j] * data[j];
    level[i] = Math.sqrt(sum / win);
  }
  // How far each window rises over the 8 before it.
  const rise = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    let avg = 0;
    const from = Math.max(0, i - 8);
    for (let j = from; j < i; j++) avg += level[j];
    rise[i] = Math.max(0, level[i] - 1.3 * (avg / (i - from)));
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += rise[i] / n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (rise[i] - mean) ** 2 / n;
  const threshold = Math.max(0.01, mean + 1.2 * Math.sqrt(sd));
  const beats: number[] = [];
  for (let i = 1; i < n - 1 && beats.length < MAX_BEATS; i++) {
    const t = i * BEAT_WINDOW_S;
    if (rise[i] > threshold && rise[i] >= rise[i - 1] && rise[i] >= rise[i + 1] && (beats.length === 0 || t - beats[beats.length - 1] >= BEAT_GAP_S)) beats.push(t);
  }
  return beats;
}
