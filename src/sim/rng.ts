// Seedable randomness for the simulation. The game uses Math.random; tests pass mulberry32(seed).

export type Random = () => number;

/** mulberry32: a tiny 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chrome's getRandomNum: an integer in [min, max], both inclusive. */
export function randomInt(random: Random, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}
