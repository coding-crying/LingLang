/**
 * Scheduling behaviour: does a card that keeps being recalled correctly ever
 * get scheduled FURTHER out?
 *
 * This file exists because it did not. `fsrsReview` read elapsed time from
 * `card.elapsedDays`, but no caller ever wrote that column — all 1929 rows in
 * the live DB were 0 — so retrievability() was asked about 0 days and returned
 * 1.0. That made the stability-growth term (exp((1-r)*w13) - 1) evaluate to
 * exactly 0, so stability was multiplied by 1 and never moved. Every card
 * re-scheduled at the same ~1 day forever (1157 rows at scheduled_days=1, and
 * nothing in three months of data above 3), which is not spaced repetition.
 *
 * The fix derives elapsed time from `lastReview`, which is the column that IS
 * maintained. These tests fail against the old behaviour.
 */

import { describe, expect, it } from 'vitest';
import { fsrsReview, type FSRSCard, type FSRSGrade } from './fsrs.js';

const DAY = 86_400_000;

/** A card that has graduated to Review, last seen `agoDays` ago. */
function reviewCard(overrides: Partial<FSRSCard> = {}): FSRSCard {
  return {
    state: 2,
    difficulty: 1.2145,
    stability: 1.3017,
    elapsedDays: 0, // <- stale column, as every live row was
    scheduledDays: 1,
    reps: 1,
    lapses: 0,
    due: new Date(),
    lastReview: new Date(Date.now() - DAY),
    ...overrides,
  };
}

describe('interval growth across repeated successful reviews', () => {
  it('grows the interval instead of pinning it at one day', () => {
    let card = reviewCard();
    const intervals: number[] = [];

    // Seven consecutive "Good" reviews, three days apart — a diligent learner.
    for (let i = 0; i < 7; i++) {
      const cardAtReview = {
        ...card,
        lastReview: new Date(Date.now() - 3 * DAY),
      };
      const result = fsrsReview(cardAtReview, 3 as FSRSGrade);
      intervals.push(result.scheduledDays);
      card = { ...cardAtReview, ...result, lastReview: cardAtReview.lastReview };
    }

    // The old code produced [1,1,1,1,1,1,1] here.
    expect(intervals.every((d) => d >= 1)).toBe(true);
    expect(intervals[intervals.length - 1]).toBeGreaterThan(30);
    // Monotonic: a card that keeps being recalled well must never come back sooner.
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]);
    }
  });

  it('derives elapsed time from lastReview, ignoring the stale elapsed_days column', () => {
    const overdue = reviewCard({ lastReview: new Date(Date.now() - 21 * DAY) });
    const result = fsrsReview(overdue, 3 as FSRSGrade);

    expect(result.elapsedDays).toBeGreaterThan(20.9);
    expect(result.elapsedDays).toBeLessThan(21.1);
    // Recalled successfully after a long gap => stability must be rewarded.
    expect(result.stability).toBeGreaterThan(overdue.stability);
  });

  it('reports elapsedDays on the lapse path too, so review_logs stop recording zero', () => {
    const card = reviewCard({ lastReview: new Date(Date.now() - 9 * DAY) });
    const result = fsrsReview(card, 1 as FSRSGrade);
    expect(result.elapsedDays).toBeGreaterThan(8.9);
  });

  it('a brand-new card reports zero elapsed days', () => {
    const fresh: FSRSCard = {
      state: 0, difficulty: 0, stability: 0, elapsedDays: 0,
      scheduledDays: 0, reps: 0, lapses: 0, due: new Date(), lastReview: null,
    };
    expect(fsrsReview(fresh, 3 as FSRSGrade).elapsedDays).toBe(0);
  });
});
