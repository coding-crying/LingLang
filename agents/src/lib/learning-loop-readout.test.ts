/**
 * The learning-loop readout.
 *
 * This exists because a silent failure ran in production unnoticed: nearly
 * half of all user+language pairs sat in 'consolidate', so their tutor was
 * introducing no new vocabulary, and nothing anywhere reported it. The
 * summary deliberately classifies with computeFrontierBudget rather than
 * re-deriving thresholds, so the report can never disagree with what the
 * tutor actually does.
 */

import { describe, expect, it } from 'vitest';
import { summarizeLearningLoop, type LoopSample } from './learning-loop-readout.js';

const sample = (over: Partial<LoopSample> = {}): LoopSample => ({
  userId: 'u',
  language: 'ru',
  dueBacklog: 0,
  recentSuccess: 0.9,
  ...over,
});

describe('summarizeLearningLoop', () => {
  it('classifies a large backlog as throttled, matching the live frontier', () => {
    const out = summarizeLearningLoop([sample({ dueBacklog: 230 })]);
    expect(out.byState.consolidate).toBe(1);
    expect(out.throttledPct).toBe(100);
  });

  it('classifies a clear learner as expanding', () => {
    const out = summarizeLearningLoop([sample({ dueBacklog: 2, recentSuccess: 0.95 })]);
    expect(out.byState.expand).toBe(1);
    expect(out.throttledPct).toBe(0);
  });

  it('reports the share of pairs that are throttled', () => {
    const out = summarizeLearningLoop([
      sample({ dueBacklog: 230 }),
      sample({ dueBacklog: 190 }),
      sample({ dueBacklog: 1 }),
      sample({ dueBacklog: 2 }),
    ]);
    expect(out.pairs).toBe(4);
    expect(out.byState.consolidate).toBe(2);
    expect(out.throttledPct).toBe(50);
  });

  it('reports median and p90 backlog by nearest rank', () => {
    // Nearest-rank: p50 of 10 values is the 5th smallest, p90 the 9th. The
    // lone 100 is the max, deliberately NOT the p90 — a single outlier
    // should not be able to make the report look like a systemic problem.
    const out = summarizeLearningLoop(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((n) => sample({ dueBacklog: n })),
    );
    expect(out.medianBacklog).toBe(5);
    expect(out.p90Backlog).toBe(9);
  });

  it('returns zeros rather than NaN when there is no data', () => {
    const out = summarizeLearningLoop([]);
    expect(out.pairs).toBe(0);
    expect(out.throttledPct).toBe(0);
    expect(out.medianBacklog).toBe(0);
    expect(out.p90Backlog).toBe(0);
    expect(out.byState.consolidate).toBe(0);
  });

  it('counts a pair with too few reviews to judge, rather than dropping it', () => {
    // recentSuccess === null means fewer than MIN_LOGS_FOR_SUCCESS_RATE logs.
    // Those learners still have a frontier state and must appear in the report.
    const out = summarizeLearningLoop([sample({ recentSuccess: null, dueBacklog: 0 })]);
    expect(out.pairs).toBe(1);
    expect(out.byState.consolidate + out.byState.balance + out.byState.expand).toBe(1);
  });
});
