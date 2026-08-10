/**
 * Deterministic pseudo-random number generation.
 *
 * Determinism is a hard requirement of this engine: the same seed and the same
 * action sequence must always produce an identical game. That is what makes
 * simulation reproducible, golden-game regression tests possible, and fuzz
 * failures debuggable. Nothing in the engine may call `Math.random()`.
 *
 * The generator is sfc32, seeded by splitmix32. Both use only 32-bit integer
 * operations that are exact in JavaScript, so a seed produces the same stream
 * on every platform and every Node version.
 */

export interface RngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

const TWO_POW_32 = 0x1_0000_0000;

/** Expands a single 32-bit seed into a well-mixed stream of 32-bit words. */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e37_79b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0_aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a_2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** FNV-1a, so a human-readable seed string maps to a 32-bit seed. */
function hashString(value: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  private constructor(state: RngState) {
    this.#a = state.a | 0;
    this.#b = state.b | 0;
    this.#c = state.c | 0;
    this.#d = state.d | 0;
  }

  /** Build from a numeric or human-readable seed, e.g. `Rng.fromSeed('game-1')`. */
  static fromSeed(seed: number | string): Rng {
    const numeric = typeof seed === 'string' ? hashString(seed) : seed | 0;
    const next = splitmix32(numeric);
    return new Rng({ a: next(), b: next(), c: next(), d: next() });
  }

  /** Restore a generator mid-stream, for save/reload and search determinization. */
  static fromState(state: RngState): Rng {
    return new Rng(state);
  }

  /** Serializable position in the stream. */
  get state(): RngState {
    return { a: this.#a, b: this.#b, c: this.#c, d: this.#d };
  }

  /** An independent generator positioned at the same point in the stream. */
  clone(): Rng {
    return new Rng(this.state);
  }

  /** Next raw 32-bit value, in `[0, 2^32)`. */
  nextUint32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in `[0, 1)`. */
  nextFloat(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  /**
   * Uniform integer in `[0, maxExclusive)`.
   *
   * Uses rejection sampling rather than a modulo of the raw word. Plain modulo
   * skews the low values whenever the bound does not divide 2^32, which would
   * quietly bias every shuffle — and therefore every statistic this application
   * exists to report.
   */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt bound must be a positive integer, got ${maxExclusive}`);
    }
    // Largest multiple of the bound that fits in 32 bits; anything at or above
    // it would land in a short final bucket, so draw again.
    const limit = TWO_POW_32 - (TWO_POW_32 % maxExclusive);
    let value = this.nextUint32();
    while (value >= limit) {
      value = this.nextUint32();
    }
    return value % maxExclusive;
  }

  /** Uniformly picks one element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Cannot pick from an empty list');
    }
    return items[this.nextInt(items.length)] as T;
  }

  /**
   * Fisher-Yates shuffle, returning a new array and leaving the input alone.
   * The engine is pure; nothing it is handed may be mutated in place.
   */
  shuffle<T>(items: readonly T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const a = result[i] as T;
      const b = result[j] as T;
      result[i] = b;
      result[j] = a;
    }
    return result;
  }
}
