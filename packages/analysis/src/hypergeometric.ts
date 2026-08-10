/**
 * Hypergeometric distribution: drawing without replacement.
 *
 * This is the mathematical core of every analytic statistic here. Drawing cards
 * from a deck is sampling without replacement, so the binomial distribution —
 * the one people reach for by habit — is the wrong model and overstates the
 * odds of repeats.
 *
 * Everything is computed through log-factorials. The direct formula multiplies
 * binomial coefficients that overflow a double well before a 40-card deck runs
 * out of interesting questions, and the logarithmic form stays exact enough
 * that the error is far below anything a deck builder would notice.
 */

const LOG_FACTORIAL: number[] = [0, 0];

/** `ln(n!)`, memoised. Deck-sized inputs, so the table stays tiny. */
export function logFactorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`logFactorial needs a non-negative integer, got ${n}`);
  }
  for (let i = LOG_FACTORIAL.length; i <= n; i += 1) {
    LOG_FACTORIAL.push((LOG_FACTORIAL[i - 1] as number) + Math.log(i));
  }
  return LOG_FACTORIAL[n] as number;
}

/** `ln(C(n, k))`, or `-Infinity` when the coefficient is zero. */
export function logBinomial(n: number, k: number): number {
  if (k < 0 || k > n) {
    return Number.NEGATIVE_INFINITY;
  }
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

export interface HypergeometricParams {
  /** Total cards to draw from, e.g. the 40-card main deck. */
  readonly population: number;
  /** How many of those are the card you care about, e.g. 3 copies. */
  readonly successes: number;
  /** How many cards you get to see. */
  readonly draws: number;
}

function validate({ population, successes, draws }: HypergeometricParams): void {
  for (const [name, value] of [
    ['population', population],
    ['successes', successes],
    ['draws', draws],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
    }
  }
  if (successes > population) {
    throw new RangeError(`successes (${successes}) cannot exceed population (${population})`);
  }
  if (draws > population) {
    throw new RangeError(`draws (${draws}) cannot exceed population (${population})`);
  }
}

/** Probability of seeing exactly `observed` of the wanted card. */
export function exactly(params: HypergeometricParams, observed: number): number {
  validate(params);
  const { population, successes, draws } = params;

  if (observed < 0 || observed > successes || observed > draws) {
    return 0;
  }
  if (draws - observed > population - successes) {
    return 0;
  }

  const log =
    logBinomial(successes, observed) +
    logBinomial(population - successes, draws - observed) -
    logBinomial(population, draws);

  return clampProbability(Math.exp(log));
}

/** Probability of seeing at least `minimum` of the wanted card. */
export function atLeast(params: HypergeometricParams, minimum: number): number {
  validate(params);
  if (minimum <= 0) {
    return 1;
  }

  const upper = Math.min(params.successes, params.draws);
  if (minimum > upper) {
    return 0;
  }

  // Sum the shorter tail: fewer terms means less accumulated error.
  const lowerTerms = minimum;
  const upperTerms = upper - minimum + 1;

  if (upperTerms <= lowerTerms) {
    let total = 0;
    for (let k = minimum; k <= upper; k += 1) {
      total += exactly(params, k);
    }
    return clampProbability(total);
  }

  let complement = 0;
  for (let k = 0; k < minimum; k += 1) {
    complement += exactly(params, k);
  }
  return clampProbability(1 - complement);
}

/** Probability of seeing at most `maximum` of the wanted card. */
export function atMost(params: HypergeometricParams, maximum: number): number {
  validate(params);
  if (maximum < 0) {
    return 0;
  }
  return clampProbability(1 - atLeast(params, maximum + 1));
}

/** Expected number of the wanted card among the drawn cards. */
export function mean(params: HypergeometricParams): number {
  validate(params);
  if (params.population === 0) {
    return 0;
  }
  return (params.draws * params.successes) / params.population;
}

/** `C(n, k)` as a float. Exact enough for deck-sized inputs. */
export function binomial(n: number, k: number): number {
  const log = logBinomial(n, k);
  return log === Number.NEGATIVE_INFINITY ? 0 : Math.exp(log);
}

/**
 * Multivariate hypergeometric: several categories drawn together.
 *
 * Answers "drawing `draws` cards, what is the chance of getting at least
 * `minimums[i]` from category `i`, for every category at once?" The categories
 * are not independent — every Fury Rune drawn is one fewer slot for a Calm
 * Rune — so multiplying the single-category probabilities together is wrong.
 * This sums over every valid split exactly, via a small dynamic program.
 *
 * Used for Power costs that demand more than one Domain: a cost of one Fury
 * and one Calm is a joint question, not two separate ones.
 */
export function multivariateAtLeast(
  counts: readonly number[],
  minimums: readonly number[],
  draws: number,
): number {
  if (counts.length !== minimums.length) {
    throw new RangeError(
      `counts (${counts.length}) and minimums (${minimums.length}) must describe the same categories`,
    );
  }
  for (const value of [...counts, ...minimums, draws]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Category sizes, minimums and draws must be non-negative integers`);
    }
  }

  const population = counts.reduce((sum, value) => sum + value, 0);
  if (draws > population) {
    throw new RangeError(`draws (${draws}) cannot exceed population (${population})`);
  }
  if (minimums.reduce((sum, value) => sum + value, 0) > draws) {
    return 0;
  }

  // ways[r] = weighted count of ways to fill r of the draws from the categories
  // handled so far, each way weighted by its number of card combinations.
  let ways = new Array<number>(draws + 1).fill(0);
  ways[0] = 1;

  for (let category = 0; category < counts.length; category += 1) {
    const size = counts[category] as number;
    const required = minimums[category] as number;
    const next = new Array<number>(draws + 1).fill(0);

    for (let used = 0; used <= draws; used += 1) {
      const weight = ways[used] ?? 0;
      if (weight === 0) {
        continue;
      }
      const most = Math.min(size, draws - used);
      for (let take = required; take <= most; take += 1) {
        next[used + take] = (next[used + take] ?? 0) + weight * binomial(size, take);
      }
    }
    ways = next;
  }

  const total = binomial(population, draws);
  if (total === 0) {
    return 0;
  }
  return clampProbability((ways[draws] ?? 0) / total);
}

/** Floating point can land a hair outside [0, 1]; a probability never should. */
function clampProbability(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
