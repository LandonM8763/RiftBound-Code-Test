import { describe, expect, it } from 'vitest';

import { excludes, marginOf, summarize, wilsonInterval, Z_95 } from './statistics.js';

describe('wilsonInterval', () => {
  it('stays inside [0, 1]', () => {
    for (const [wins, n] of [
      [0, 10],
      [1, 10],
      [10, 10],
      [1, 3],
      [999, 1000],
    ] as const) {
      const interval = wilsonInterval(wins, n);
      expect(interval.low).toBeGreaterThanOrEqual(0);
      expect(interval.high).toBeLessThanOrEqual(1);
      expect(interval.low).toBeLessThanOrEqual(interval.high);
    }
  });

  it('does not claim certainty from a clean sweep', () => {
    // The whole reason this is not the textbook normal approximation: that one
    // gives 40/40 a zero-width interval and reports 100% ± 0%.
    const interval = wilsonInterval(40, 40);
    expect(interval.high).toBe(1);
    expect(interval.low).toBeLessThan(1);
    expect(interval.low).toBeGreaterThan(0.9);
  });

  it('does not claim certainty from a shutout either', () => {
    const interval = wilsonInterval(0, 40);
    expect(interval.low).toBe(0);
    expect(interval.high).toBeGreaterThan(0);
    expect(interval.high).toBeLessThan(0.1);
  });

  it('narrows as the sample grows', () => {
    const small = marginOf(wilsonInterval(30, 60));
    const large = marginOf(wilsonInterval(500, 1000));
    expect(large).toBeLessThan(small);
  });

  it('brackets the observed rate for a middling proportion', () => {
    const interval = wilsonInterval(500, 1000);
    expect(interval.low).toBeLessThan(0.5);
    expect(interval.high).toBeGreaterThan(0.5);
  });

  it('matches the closed form for a worked example', () => {
    // 6 of 10 at 95%. Worked through by hand rather than copied, since a wrong
    // magic literal here would pin the wrong formula:
    //   z² = 3.841459, denom = 1 + z²/10 = 1.384146
    //   centre = (0.6 + z²/20) / denom               = 0.572244
    //   spread = (z/denom)·√(0.6·0.4/10 + z²/400)    = 0.259573
    const interval = wilsonInterval(6, 10);
    expect(interval.low).toBeCloseTo(0.572244 - 0.259573, 5);
    expect(interval.high).toBeCloseTo(0.572244 + 0.259573, 5);
  });

  it('reports the confidence level its z implies', () => {
    expect(wilsonInterval(5, 10, Z_95).level).toBeCloseTo(0.95, 4);
    expect(wilsonInterval(5, 10, 2.5758293).level).toBeCloseTo(0.99, 4);
  });

  it('returns the whole range for no evidence', () => {
    expect(wilsonInterval(0, 0)).toMatchObject({ low: 0, high: 1 });
  });
});

describe('excludes', () => {
  it('answers "is this better than a coin flip?"', () => {
    expect(excludes(wilsonInterval(834, 1000), 0.5)).toBe(true);
    expect(excludes(wilsonInterval(52, 100), 0.5)).toBe(false);
  });

  it('is false for a value on the boundary', () => {
    const interval = wilsonInterval(6, 10);
    expect(excludes(interval, interval.low)).toBe(false);
    expect(excludes(interval, interval.high)).toBe(false);
  });
});

describe('summarize', () => {
  it('reports n, mean, range and sample deviation', () => {
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(summary.n).toBe(8);
    expect(summary.mean).toBe(5);
    expect(summary.min).toBe(2);
    expect(summary.max).toBe(9);
    // Sample (n-1) deviation, not population.
    expect(summary.stdev).toBeCloseTo(2.13809, 4);
  });

  it('gives a single sample no deviation', () => {
    expect(summarize([7])).toEqual({ n: 1, mean: 7, min: 7, max: 7, stdev: 0 });
  });

  it('handles no samples without dividing by zero', () => {
    expect(summarize([])).toEqual({ n: 0, mean: 0, min: 0, max: 0, stdev: 0 });
  });
});
