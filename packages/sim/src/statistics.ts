/**
 * The uncertainty half of every simulated statistic.
 *
 * A win rate with no sample size and no interval is not a statistic — it is a
 * number that looks like one. Everything this package reports carries both.
 */

export interface Interval {
  readonly low: number;
  readonly high: number;
  /** Confidence level, e.g. 0.95. */
  readonly level: number;
}

/** 95% two-sided normal quantile, the default for every interval here. */
export const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a proportion.
 *
 * Deliberately not the textbook `p ± z·√(p(1-p)/n)`. That normal approximation
 * degrades exactly where simulation results live: at p near 0 or 1 it produces
 * bounds outside [0, 1], and at p exactly 0 or 1 it collapses to zero width and
 * claims certainty from a handful of games. An agent that wins 40 of 40 is not
 * a 100% ± 0% agent, and Wilson says so.
 *
 * Rounds trials to a non-negative integer count; `trials === 0` yields the
 * whole interval, which is the honest answer for no evidence.
 */
export function wilsonInterval(successes: number, trials: number, z: number = Z_95): Interval {
  const level = 2 * normalCdf(z) - 1;
  if (trials <= 0) {
    return { low: 0, high: 1, level };
  }

  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const spread =
    (z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));

  return {
    low: Math.max(0, center - spread),
    high: Math.min(1, center + spread),
    level,
  };
}

/** Half-width of an interval, the "±" a reader expects. */
export function marginOf(interval: Interval): number {
  return (interval.high - interval.low) / 2;
}

/**
 * True when the interval excludes `value`.
 *
 * The question "is this agent actually better than 50%?" is exactly this, and
 * asking it explicitly beats eyeballing two overlapping numbers.
 */
export function excludes(interval: Interval, value: number): boolean {
  return value < interval.low || value > interval.high;
}

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  /** Sample standard deviation (n-1), 0 when there are fewer than 2 samples. */
  readonly stdev: number;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    return { n: 0, mean: 0, min: 0, max: 0, stdev: 0 };
  }

  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const value of values) {
    total += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const mean = total / values.length;
  let sumSquares = 0;
  for (const value of values) {
    sumSquares += (value - mean) ** 2;
  }
  const stdev = values.length < 2 ? 0 : Math.sqrt(sumSquares / (values.length - 1));

  return { n: values.length, mean, min, max, stdev };
}

/**
 * Φ(x), via the Abramowitz & Stegun 7.1.26 error-function approximation.
 *
 * Only used to label an interval with the confidence level its z implies, so
 * ~1e-7 absolute error is far better than needed.
 */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}
