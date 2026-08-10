/**
 * Due-word slot allocation between earned reviews and unverified claims.
 *
 * Seeded claims are overdue by construction, so ordered purely by due date
 * they sort ahead of every genuinely earned review and crowd them out of the
 * window. See docs/superpowers/specs/2026-08-09-claim-vs-debt-design.md §3.3.
 */

import { describe, expect, it } from 'vitest';
import { selectDueWords, DUE_WORD_SLOTS, EARNED_SLOT_FLOOR } from './learner-view.js';
import type { WordRef } from './learner-view.js';

const words = (prefix: string, n: number): WordRef[] =>
  Array.from({ length: n }, (_, i) => ({ lemma: `${prefix}${i}`, translation: `t${i}` }));

const isEarned = (w: WordRef) => w.lemma.startsWith('e');

describe('selectDueWords', () => {
  it('reserves slots for earned reviews when claims would otherwise fill the window', () => {
    const out = selectDueWords(words('e', 20), words('c', 20));
    expect(out).toHaveLength(DUE_WORD_SLOTS);
    expect(out.filter(isEarned)).toHaveLength(EARNED_SLOT_FLOOR);
    expect(out.filter((w) => !isEarned(w))).toHaveLength(DUE_WORD_SLOTS - EARNED_SLOT_FLOOR);
  });

  it('lets claims take the spare slots when there are few earned reviews', () => {
    const out = selectDueWords(words('e', 1), words('c', 20));
    expect(out).toHaveLength(DUE_WORD_SLOTS);
    expect(out.filter(isEarned)).toHaveLength(1);
  });

  it('fills the whole window from earned reviews when there are no claims', () => {
    const out = selectDueWords(words('e', 20), []);
    expect(out).toHaveLength(DUE_WORD_SLOTS);
    expect(out.every(isEarned)).toBe(true);
  });

  it('fills the whole window from claims when there are no earned reviews', () => {
    const out = selectDueWords([], words('c', 20));
    expect(out).toHaveLength(DUE_WORD_SLOTS);
    expect(out.every((w) => !isEarned(w))).toBe(true);
  });

  it('preserves due order within each pool', () => {
    const out = selectDueWords(words('e', 20), words('c', 20));
    expect(out.filter(isEarned).map((w) => w.lemma)).toEqual(['e0', 'e1', 'e2']);
    expect(out.filter((w) => !isEarned(w)).map((w) => w.lemma)).toEqual(['c0', 'c1']);
  });

  it('returns everything available when both pools are short', () => {
    const out = selectDueWords(words('e', 1), words('c', 1));
    expect(out).toHaveLength(2);
  });

  it('returns an empty list when there is nothing due', () => {
    expect(selectDueWords([], [])).toEqual([]);
  });
});
