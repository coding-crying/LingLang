/**
 * The seeding math, tested against the scenario it exists for: a learner
 * who arrives having done 25 Pimsleur lessons, one a day.
 *
 * Everything here is the pure half (seedCardFromPriorStudy /
 * predictedRetention). The DB half is exercised by the integration script
 * described in the design doc §7.
 */

import { describe, expect, it } from 'vitest';
import { SEED_STABILITY, predictedRetention, seedCardFromPriorStudy } from './prior-knowledge.js';

const DAY = 86_400_000;
const NOW = new Date('2026-08-08T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe('predictedRetention', () => {
  it('is 1 the moment the card is reviewed and decays monotonically', () => {
    expect(predictedRetention(0, 21)).toBe(1);
    const curve = [1, 7, 21, 60, 365].map((d) => predictedRetention(d, 21));
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeLessThan(curve[i - 1]!);
    }
    expect(curve.at(-1)!).toBeGreaterThan(0);
  });

  it('holds a more stable card above a less stable one at the same age', () => {
    expect(predictedRetention(14, SEED_STABILITY.drilled))
      .toBeGreaterThan(predictedRetention(14, SEED_STABILITY.skimmed));
  });

  it('treats a zero-stability card as fully forgotten rather than dividing by zero', () => {
    expect(predictedRetention(5, 0)).toBe(0);
  });
});

describe('seedCardFromPriorStudy', () => {
  it('claims recent drilled study as known, in review state', () => {
    const card = seedCardFromPriorStudy(daysAgo(1), 'drilled', NOW);
    expect(card.claimsKnown).toBe(true);
    expect(card.state).toBe(2);
    expect(card.stability).toBe(SEED_STABILITY.drilled);
  });

  it('backdates the due date to the study date, not to now', () => {
    // This is the property the whole feature rests on. A card studied 25
    // days ago with a ~21-day interval must already be overdue; dating it
    // from `now` would hide it for another three weeks.
    const studiedAt = daysAgo(25);
    const card = seedCardFromPriorStudy(studiedAt, 'drilled', NOW);
    expect(card.due.getTime()).toBeLessThan(NOW.getTime());
    expect(card.due.getTime()).toBeGreaterThan(studiedAt.getTime());
    expect(card.lastReview).toEqual(studiedAt);
  });

  it('leaves material studied yesterday quiet while surfacing week-old material', () => {
    // The gradient across a course: early lessons come back, recent ones
    // don't. Without this a returning learner either reviews everything at
    // once or reviews nothing.
    const recent = seedCardFromPriorStudy(daysAgo(1), 'drilled', NOW);
    const older = seedCardFromPriorStudy(daysAgo(25), 'drilled', NOW);
    expect(recent.due.getTime()).toBeGreaterThan(NOW.getTime());
    expect(older.due.getTime()).toBeLessThan(NOW.getTime());
    expect(older.retention).toBeLessThan(recent.retention);
  });

  it('refuses to claim knowledge once retention has collapsed', () => {
    // "I did this textbook back in 2019." Asserting that as known would
    // skip the learner past material they have genuinely lost.
    const card = seedCardFromPriorStudy(daysAgo(1200), 'studied', NOW);
    expect(card.claimsKnown).toBe(false);
    expect(card.state).toBe(1);
    expect(card.due.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('still records the exposure when it refuses the claim', () => {
    // Not-claimed is not the same as never-seen: state 1 keeps it out of
    // coverage while marking it as ground the learner has covered before.
    const card = seedCardFromPriorStudy(daysAgo(1200), 'studied', NOW);
    expect(card.stability).toBeGreaterThan(0);
    expect(card.lastReview).toEqual(daysAgo(1200));
  });

  it('drops a skimmed pass below the floor far sooner than a drilled one', () => {
    const skimmed = seedCardFromPriorStudy(daysAgo(30), 'skimmed', NOW);
    const drilled = seedCardFromPriorStudy(daysAgo(30), 'drilled', NOW);
    expect(skimmed.claimsKnown).toBe(false);
    expect(drilled.claimsKnown).toBe(true);
  });

  it('never reports negative elapsed time for a future date', () => {
    const card = seedCardFromPriorStudy(new Date(NOW.getTime() + 5 * DAY), 'studied', NOW);
    expect(card.elapsedDays).toBe(0);
    expect(card.retention).toBe(1);
  });

  it('records zero reps — nothing here was actually administered', () => {
    // reps/review_logs describe reviews the system ran. A profile answer is
    // a claim about the past, and inflating reps would corrupt every
    // statistic built on them.
    const card = seedCardFromPriorStudy(daysAgo(10), 'drilled', NOW);
    expect(card).not.toHaveProperty('reps');
  });
});
