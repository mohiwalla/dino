import { describe, expect, test } from 'bun:test';
import { findBeats } from '../src/audio/beats';
import { mulberry32 } from '../src/sim/rng';
import { createShuffleBag } from '../src/shuffle';

describe('shuffle bag', () => {
  test('every item comes up once per round, and never twice in a row', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const bag = createShuffleBag(items, mulberry32(3));
    let last = '';
    for (let round = 0; round < 200; round++) {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const next = bag.next();
        expect(next).not.toBe(last);
        seen.add(next);
        last = next;
      }
      expect(seen.size).toBe(items.length);
    }
  });

  test('a bag of one just repeats it', () => {
    const bag = createShuffleBag(['only']);
    expect([bag.next(), bag.next()]).toEqual(['only', 'only']);
  });
});

describe('crash clip beats', () => {
  test('finds the hits in a clip', () => {
    const rate = 8000;
    const data = new Float32Array(rate * 3);
    // Quiet hum, with a loud 40 ms burst at each hit.
    for (let i = 0; i < data.length; i++) data[i] = 0.02 * Math.sin(i / 7);
    const hits = [0.5, 1.2, 2.0];
    for (const t of hits) for (let i = 0; i < rate * 0.04; i++) data[Math.round(t * rate) + i] = 0.8 * Math.sin(i / 3);
    const buffer = { sampleRate: rate, getChannelData: () => data } as unknown as AudioBuffer;
    const beats = findBeats(buffer);
    expect(beats.length).toBe(hits.length);
    beats.forEach((b, i) => expect(Math.abs(b - hits[i])).toBeLessThan(0.05));
  });
});
