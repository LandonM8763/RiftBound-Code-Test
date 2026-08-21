import { describe, expect, it } from "vitest";

import { Rng } from "./rng.js";

const draw = (rng: Rng, count: number): number[] =>
  Array.from({ length: count }, () => rng.nextUint32());

describe("Rng determinism", () => {
  it("produces an identical stream for the same numeric seed", () => {
    expect(draw(Rng.fromSeed(42), 20)).toEqual(draw(Rng.fromSeed(42), 20));
  });

  it("produces an identical stream for the same string seed", () => {
    expect(draw(Rng.fromSeed("game-1"), 20)).toEqual(
      draw(Rng.fromSeed("game-1"), 20),
    );
  });

  it("produces different streams for different seeds", () => {
    expect(draw(Rng.fromSeed(1), 20)).not.toEqual(draw(Rng.fromSeed(2), 20));
    expect(draw(Rng.fromSeed("a"), 20)).not.toEqual(
      draw(Rng.fromSeed("b"), 20),
    );
  });

  it("resumes exactly from a serialized state", () => {
    const original = Rng.fromSeed("resume");
    draw(original, 7);

    const resumed = Rng.fromState(original.state);
    expect(draw(resumed, 10)).toEqual(draw(original, 10));
  });

  it("survives a JSON round trip of its state", () => {
    const original = Rng.fromSeed("json");
    draw(original, 3);

    const restored = Rng.fromState(
      JSON.parse(JSON.stringify(original.state)) as never,
    );
    expect(draw(restored, 5)).toEqual(draw(original, 5));
  });

  it("clones into an independent generator at the same position", () => {
    const original = Rng.fromSeed("clone");
    draw(original, 4);
    const copy = original.clone();

    expect(draw(copy, 5)).toEqual(draw(original.clone(), 5));

    // Advancing the copy must not disturb the original.
    const reference = original.clone();
    draw(copy, 100);
    expect(draw(original, 3)).toEqual(draw(reference, 3));
  });
});

describe("Rng.nextUint32", () => {
  it("stays inside the unsigned 32-bit range", () => {
    const rng = Rng.fromSeed("range");
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.nextUint32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });

  it("does not immediately repeat itself", () => {
    const values = new Set(draw(Rng.fromSeed("distinct"), 1000));
    expect(values.size).toBe(1000);
  });
});

describe("Rng.nextFloat", () => {
  it("stays within [0, 1)", () => {
    const rng = Rng.fromSeed("float");
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("Rng.nextInt", () => {
  it("stays within the requested bound", () => {
    const rng = Rng.fromSeed("bound");
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it("always returns 0 for a bound of 1", () => {
    const rng = Rng.fromSeed("one");
    for (let i = 0; i < 100; i += 1) {
      expect(rng.nextInt(1)).toBe(0);
    }
  });

  it("rejects bounds that are not positive integers", () => {
    const rng = Rng.fromSeed("invalid");
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-3)).toThrow(RangeError);
    expect(() => rng.nextInt(2.5)).toThrow(RangeError);
    expect(() => rng.nextInt(Number.NaN)).toThrow(RangeError);
  });

  it("is unbiased across a bound that does not divide 2^32", () => {
    // 7 is the classic modulo-bias tripwire. A naive `nextUint32() % 7` skews
    // the low buckets; rejection sampling must not. Fixed seed, so a failure
    // here is a real regression rather than a flaky draw.
    const rng = Rng.fromSeed("uniformity");
    const bound = 7;
    const trials = 700_000;
    const counts = new Array<number>(bound).fill(0);

    for (let i = 0; i < trials; i += 1) {
      const index = rng.nextInt(bound);
      counts[index] = (counts[index] ?? 0) + 1;
    }

    const expected = trials / bound;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.02);
    }
  });
});

describe("Rng.shuffle", () => {
  it("returns a permutation of the input", () => {
    const input = Array.from({ length: 40 }, (_, i) => i);
    const shuffled = Rng.fromSeed("perm").shuffle(input);

    expect(shuffled).toHaveLength(input.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    Rng.fromSeed("nomutate").shuffle(input);

    expect(input).toEqual(snapshot);
  });

  it("is reproducible for a given seed", () => {
    const input = Array.from({ length: 40 }, (_, i) => i);
    expect(Rng.fromSeed("deck").shuffle(input)).toEqual(
      Rng.fromSeed("deck").shuffle(input),
    );
  });

  it("handles empty and single-element inputs", () => {
    const rng = Rng.fromSeed("edge");
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle(["only"])).toEqual(["only"]);
  });

  it("reaches every permutation about equally often", () => {
    // The end-to-end check that matters for a deck shuffler: an off-by-one in
    // Fisher-Yates or a biased bound shows up here as a skewed permutation
    // distribution even when each individual draw looks fine.
    const rng = Rng.fromSeed("permutations");
    const trials = 120_000;
    const seen = new Map<string, number>();

    for (let i = 0; i < trials; i += 1) {
      const key = rng.shuffle(["a", "b", "c"]).join("");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    expect(seen.size).toBe(6);
    const expected = trials / 6;
    for (const count of seen.values()) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });
});

describe("Rng.pick", () => {
  it("only ever returns members of the list", () => {
    const rng = Rng.fromSeed("pick");
    const items = ["x", "y", "z"];
    for (let i = 0; i < 500; i += 1) {
      expect(items).toContain(rng.pick(items));
    }
  });

  it("throws on an empty list", () => {
    expect(() => Rng.fromSeed("empty").pick([])).toThrow(RangeError);
  });
});
