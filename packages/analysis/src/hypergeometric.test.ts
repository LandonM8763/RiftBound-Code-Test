import { describe, expect, it } from "vitest";

import {
  atLeast,
  atMost,
  binomial,
  exactly,
  logBinomial,
  logFactorial,
  mean,
  multivariateAtLeast,
} from "./hypergeometric.js";

describe("factorials and binomials", () => {
  it("computes log factorials", () => {
    expect(logFactorial(0)).toBe(0);
    expect(logFactorial(1)).toBe(0);
    expect(Math.exp(logFactorial(5))).toBeCloseTo(120, 6);
    expect(Math.exp(logFactorial(10))).toBeCloseTo(3_628_800, 3);
  });

  it("rejects invalid factorial input", () => {
    expect(() => logFactorial(-1)).toThrow(RangeError);
    expect(() => logFactorial(1.5)).toThrow(RangeError);
  });

  it("computes binomial coefficients", () => {
    expect(binomial(5, 2)).toBeCloseTo(10, 9);
    expect(binomial(52, 5)).toBeCloseTo(2_598_960, 3);
    expect(binomial(40, 5)).toBeCloseTo(658_008, 6);
  });

  it("treats out-of-range coefficients as zero", () => {
    expect(binomial(5, 6)).toBe(0);
    expect(binomial(5, -1)).toBe(0);
    expect(logBinomial(5, 6)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("exactly", () => {
  it("is a probability distribution that sums to one", () => {
    const params = { population: 40, successes: 3, draws: 7 };
    let total = 0;
    for (let k = 0; k <= 3; k += 1) {
      total += exactly(params, k);
    }
    expect(total).toBeCloseTo(1, 12);
  });

  it("matches a hand-computed value", () => {
    // Exactly one of three copies in the top five of a 40-card deck:
    // C(3,1) * C(37,4) / C(40,5)
    const expected = (3 * binomial(37, 4)) / binomial(40, 5);
    expect(exactly({ population: 40, successes: 3, draws: 5 }, 1)).toBeCloseTo(
      expected,
      12,
    );
  });

  it("is zero for impossible counts", () => {
    const params = { population: 40, successes: 3, draws: 5 };
    expect(exactly(params, 4)).toBe(0);
    expect(exactly(params, -1)).toBe(0);
    expect(exactly({ population: 10, successes: 2, draws: 9 }, 0)).toBe(0);
  });
});

describe("atLeast", () => {
  it("matches the textbook opening-hand figure", () => {
    // 60-card deck, 4 copies, 7 cards: the widely quoted ~39.9%.
    expect(atLeast({ population: 60, successes: 4, draws: 7 }, 1)).toBeCloseTo(
      0.3995,
      4,
    );
  });

  it("matches a hand-computed 40-card figure", () => {
    // Three copies in the opening five of a 40-card deck. The summed-tail
    // implementation is checked against the closed-form complement,
    // 1 - C(37,5)/C(40,5) = 1 - 435897/658008, which is a different code path.
    expect(atLeast({ population: 40, successes: 3, draws: 5 }, 1)).toBeCloseTo(
      1 - 435_897 / 658_008,
      12,
    );
    expect(atLeast({ population: 40, successes: 3, draws: 5 }, 1)).toBeCloseTo(
      0.3376,
      4,
    );
  });

  it("is certain for a minimum of zero or less", () => {
    const params = { population: 40, successes: 3, draws: 5 };
    expect(atLeast(params, 0)).toBe(1);
    expect(atLeast(params, -5)).toBe(1);
  });

  it("is impossible beyond the available copies or draws", () => {
    expect(atLeast({ population: 40, successes: 3, draws: 5 }, 4)).toBe(0);
    expect(atLeast({ population: 40, successes: 10, draws: 3 }, 4)).toBe(0);
  });

  it("is certain when every card is a success", () => {
    expect(atLeast({ population: 10, successes: 10, draws: 4 }, 4)).toBeCloseTo(
      1,
      12,
    );
  });

  it("agrees with a direct sum of the exact probabilities", () => {
    const params = { population: 40, successes: 6, draws: 12 };
    for (const minimum of [1, 2, 3, 4]) {
      let direct = 0;
      for (
        let k = minimum;
        k <= Math.min(params.successes, params.draws);
        k += 1
      ) {
        direct += exactly(params, k);
      }
      expect(atLeast(params, minimum)).toBeCloseTo(direct, 12);
    }
  });

  it("never leaves the unit interval", () => {
    for (let draws = 0; draws <= 40; draws += 1) {
      for (let minimum = 0; minimum <= 4; minimum += 1) {
        const value = atLeast({ population: 40, successes: 3, draws }, minimum);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("atMost and mean", () => {
  it("complements atLeast", () => {
    const params = { population: 40, successes: 3, draws: 8 };
    for (let k = 0; k <= 3; k += 1) {
      expect(atMost(params, k)).toBeCloseTo(1 - atLeast(params, k + 1), 12);
    }
  });

  it("is impossible below zero", () => {
    expect(atMost({ population: 40, successes: 3, draws: 8 }, -1)).toBe(0);
  });

  it("computes the expected count", () => {
    expect(mean({ population: 40, successes: 4, draws: 10 })).toBeCloseTo(
      1,
      12,
    );
    expect(mean({ population: 0, successes: 0, draws: 0 })).toBe(0);
  });
});

describe("parameter validation", () => {
  it("rejects more successes than population", () => {
    expect(() =>
      exactly({ population: 10, successes: 11, draws: 5 }, 1),
    ).toThrow(RangeError);
  });

  it("rejects more draws than population", () => {
    expect(() =>
      exactly({ population: 10, successes: 5, draws: 11 }, 1),
    ).toThrow(RangeError);
  });

  it("rejects negative and fractional parameters", () => {
    expect(() =>
      exactly({ population: -1, successes: 0, draws: 0 }, 0),
    ).toThrow(RangeError);
    expect(() =>
      exactly({ population: 10, successes: 2.5, draws: 5 }, 1),
    ).toThrow(RangeError);
  });
});

describe("multivariateAtLeast", () => {
  it("reduces to the single-category result", () => {
    // Two categories with nothing required of the second is the same question
    // the univariate distribution answers.
    for (const draws of [1, 3, 5, 7]) {
      for (const minimum of [1, 2]) {
        expect(multivariateAtLeast([3, 37], [minimum, 0], draws)).toBeCloseTo(
          atLeast({ population: 40, successes: 3, draws }, minimum),
          12,
        );
      }
    }
  });

  it("matches a hand-computed two-Domain figure", () => {
    // Six Fury and six Calm Runes, two Channelled: one of each is
    // C(6,1)*C(6,1)/C(12,2) = 36/66.
    expect(multivariateAtLeast([6, 6], [1, 1], 2)).toBeCloseTo(36 / 66, 12);
  });

  it("matches a hand-computed four-draw figure", () => {
    // 1 - P(all Fury) - P(all Calm) = 1 - 2*C(6,4)/C(12,4)
    expect(multivariateAtLeast([6, 6], [1, 1], 4)).toBeCloseTo(
      1 - (2 * 15) / 495,
      12,
    );
  });

  it("differs from the product of the per-category odds", () => {
    // The categories compete for the same draws. Multiplying the marginals
    // treats them as independent and overstates the answer, which is the whole
    // reason this function exists.
    const joint = multivariateAtLeast([6, 6], [1, 1], 2);
    const marginal = atLeast({ population: 12, successes: 6, draws: 2 }, 1);

    expect(joint).toBeCloseTo(36 / 66, 12);
    expect(marginal * marginal).toBeGreaterThan(joint);
  });

  it("is certain when nothing is required", () => {
    expect(multivariateAtLeast([6, 6], [0, 0], 3)).toBeCloseTo(1, 12);
    expect(multivariateAtLeast([6, 6], [0, 0], 0)).toBeCloseTo(1, 12);
  });

  it("is impossible when the requirements exceed the draws", () => {
    expect(multivariateAtLeast([6, 6], [2, 2], 3)).toBe(0);
  });

  it("is impossible when a category cannot supply its minimum", () => {
    expect(multivariateAtLeast([1, 11], [2, 0], 6)).toBe(0);
  });

  it("handles more than two categories", () => {
    // Four each of three Domains; one of each in three draws.
    const expected = (4 * 4 * 4) / binomial(12, 3);
    expect(multivariateAtLeast([4, 4, 4], [1, 1, 1], 3)).toBeCloseTo(
      expected,
      12,
    );
  });

  it("is certain when every card is drawn", () => {
    expect(multivariateAtLeast([6, 6], [6, 6], 12)).toBeCloseTo(1, 12);
  });

  it("rejects mismatched or invalid inputs", () => {
    expect(() => multivariateAtLeast([6, 6], [1], 2)).toThrow(RangeError);
    expect(() => multivariateAtLeast([6, 6], [1, 1], 13)).toThrow(RangeError);
    expect(() => multivariateAtLeast([6, -1], [1, 1], 2)).toThrow(RangeError);
  });
});
