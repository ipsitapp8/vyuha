export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Internal 32-bit state; `mulberry32(rng.state())` resumes the exact same sequence. */
  state(): number;
}

/** Deterministic seeded PRNG (mulberry32). The engine never uses Math.random. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state(): number {
      return a;
    },
  };
}

/** Uniform float in [lo, hi). */
export function randRange(rng: Rng, lo: number, hi: number): number {
  return lo + rng.next() * (hi - lo);
}

/** Uniform integer in [lo, hi] inclusive. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng.next() * (hi - lo + 1));
}

/** Standard normal sample (Box-Muller). Always consumes exactly two draws. */
export function gaussian(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Picks one element; throws on an empty list. Consumes exactly one draw. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng.next() * items.length)];
  if (item === undefined) throw new RangeError('pick() from empty list');
  return item;
}
