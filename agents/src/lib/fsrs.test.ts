/**
 * The forgetting curve and its inverse.
 *
 * The defining property of FSRS stability: S is the interval at which
 * retrievability has decayed to the requested retention (0.9 by default).
 * `retrievability` and `nextInterval` are the two directions of that same
 * relationship, so they are tested together — a change to one that isn't
 * mirrored in the other is exactly the drift these tests exist to catch.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FSRS_PARAMS, nextInterval, retrievability } from './fsrs.js';

const S = 21; // a mature card's stability, in days

describe('retrievability', () => {
  it('equals the requested retention when elapsed time equals stability', () => {
    // This IS the definition of stability. Before the curve fix this
    // returned ~0.499, treating S as the 50%-retention horizon.
    expect(retrievability(S, S)).toBeCloseTo(DEFAULT_FSRS_PARAMS.requestRetention, 4);
  });

  it('is 1 immediately after review', () => {
    expect(retrievability(0, S)).toBeCloseTo(1, 6);
  });

  it('decays monotonically as time passes', () => {
    const points = [0, 1, 5, 21, 100, 365].map((t) => retrievability(t, S));
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeLessThan(points[i - 1]!);
    }
  });

  it('holds the defining property at any stability, not just 21', () => {
    for (const stability of [0.5, 3, 8, 60, 365]) {
      expect(retrievability(stability, stability)).toBeCloseTo(
        DEFAULT_FSRS_PARAMS.requestRetention,
        4,
      );
    }
  });
});

describe('nextInterval', () => {
  it('returns approximately the stability at the default 0.9 retention', () => {
    // Before the fix this returned ~2.3 days for a 21-day-stability card,
    // roughly 9x short, which is what kept due backlogs from draining.
    expect(nextInterval(S, DEFAULT_FSRS_PARAMS)).toBeCloseTo(S, 4);
  });

  it('inverts retrievability: scheduling an interval lands on the target retention', () => {
    for (const stability of [1, 8, 21, 90]) {
      const interval = nextInterval(stability, DEFAULT_FSRS_PARAMS);
      expect(retrievability(interval, stability)).toBeCloseTo(
        DEFAULT_FSRS_PARAMS.requestRetention,
        4,
      );
    }
  });

  it('schedules further out when the learner accepts more forgetting', () => {
    const cautious = nextInterval(S, { ...DEFAULT_FSRS_PARAMS, requestRetention: 0.95 });
    const aggressive = nextInterval(S, { ...DEFAULT_FSRS_PARAMS, requestRetention: 0.85 });
    expect(aggressive).toBeGreaterThan(cautious);
  });

  it('never schedules less than a day out', () => {
    expect(nextInterval(0.01, DEFAULT_FSRS_PARAMS)).toBe(1);
  });

  it('respects the maximum interval cap', () => {
    expect(nextInterval(100_000, DEFAULT_FSRS_PARAMS)).toBe(DEFAULT_FSRS_PARAMS.maximumInterval);
  });
});
