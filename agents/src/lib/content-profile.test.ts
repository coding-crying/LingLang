/**
 * Question routing, completeness, and the answer→ord conversion.
 * Pure functions only — no DB, no LLM (inferSource's model fallback is
 * covered by the rule path here; the LLM branch degrades to a low-confidence
 * 'text' guess by construction and is exercised live).
 */

import { describe, expect, it } from 'vitest';
import {
  RECENCY_BUCKETS,
  evaluateProfile,
  inferSourceByRule,
  questionsFor,
  resolveKnownThroughOrd,
  resolveLastStudiedAt,
} from './content-profile.js';

describe('questionsFor', () => {
  it('asks only about intent until intent is known', () => {
    const qs = questionsFor('textbook', null);
    expect(qs.map((q) => q.id)).toEqual(['intent']);
  });

  it('asks aspirational content nothing about prior study', () => {
    const ids = questionsFor('textbook', 'aspire').map((q) => q.id);
    expect(ids).not.toContain('known_through');
    expect(ids).not.toContain('last_studied');
    expect(ids).not.toContain('intensity');
  });

  it('drops "how far did you get" for material already finished', () => {
    const ids = questionsFor('textbook', 'known').map((q) => q.id);
    expect(ids).not.toContain('known_through');
    expect(ids).toContain('last_studied');
  });

  it('only offers exercises for textbooks and depth for media', () => {
    expect(questionsFor('textbook', 'study').map((q) => q.id)).toContain('do_exercises');
    expect(questionsFor('youtube', 'study').map((q) => q.id)).not.toContain('do_exercises');
    expect(questionsFor('youtube', 'study').map((q) => q.id)).toContain('depth');
    expect(questionsFor('textbook', 'study').map((q) => q.id)).not.toContain('depth');
  });
});

describe('evaluateProfile', () => {
  it('starts incomplete with intent outstanding', () => {
    const result = evaluateProfile('textbook', {});
    expect(result.status).toBe('needed');
    expect(result.missing).toEqual(['intent']);
    expect(result.next?.id).toBe('intent');
  });

  it('completes an aspirational profile as soon as intent is given', () => {
    // Deliberate: there is no prior study to date or measure, so further
    // questions would be friction with nothing behind them.
    const result = evaluateProfile('textbook', { intent: 'aspire' });
    expect(result.status).toBe('complete');
    expect(result.next).toBeNull();
  });

  it('walks a partway-through profile question by question', () => {
    let answers: Record<string, unknown> = { intent: 'study' };
    expect(evaluateProfile('textbook', answers).next?.id).toBe('known_through');

    answers = { ...answers, known_through: { count: 9 } };
    expect(evaluateProfile('textbook', answers).next?.id).toBe('last_studied');

    answers = { ...answers, last_studied: 'this_month' };
    expect(evaluateProfile('textbook', answers).next?.id).toBe('intensity');

    answers = { ...answers, intensity: 'studied' };
    const done = evaluateProfile('textbook', answers);
    expect(done.status).toBe('complete');
    expect(done.missing).toEqual([]);
  });

  it('does not treat optional questions as blocking', () => {
    const result = evaluateProfile('textbook', {
      intent: 'study', known_through: 'all', last_studied: 'today', intensity: 'drilled',
    });
    expect(result.status).toBe('complete');
  });

  it('ignores an empty string as an answer', () => {
    expect(evaluateProfile('textbook', { intent: '' as never }).missing).toEqual(['intent']);
  });
});

describe('resolveKnownThroughOrd', () => {
  it('converts "the first 25 lessons" to the ord of the 25th', () => {
    // Counts are 1-based, ords are 0-based. Getting this wrong silently
    // skips or repeats a lesson.
    expect(resolveKnownThroughOrd({ count: 25 }, 30)).toBe(24);
  });

  it('maps all/none to the ends', () => {
    expect(resolveKnownThroughOrd('all', 30)).toBe(29);
    expect(resolveKnownThroughOrd('none', 30)).toBeNull();
    expect(resolveKnownThroughOrd(undefined, 30)).toBeNull();
  });

  it('rounds a fraction down', () => {
    // Under-claiming costs one revisit; over-claiming skips material
    // silently, so ties go downward.
    expect(resolveKnownThroughOrd({ fraction: 0.5 }, 30)).toBe(14);
    expect(resolveKnownThroughOrd({ fraction: 1 }, 30)).toBe(29);
    expect(resolveKnownThroughOrd({ fraction: 0 }, 30)).toBeNull();
  });

  it('clamps a claim beyond the end of the source', () => {
    expect(resolveKnownThroughOrd({ count: 500 }, 30)).toBe(29);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(resolveKnownThroughOrd({ count: -3 }, 30)).toBeNull();
    expect(resolveKnownThroughOrd('halfway', 30)).toBeNull();
    expect(resolveKnownThroughOrd({ count: 5 }, 0)).toBeNull();
  });
});

describe('resolveLastStudiedAt', () => {
  it('turns each bucket into a date in the past, oldest last', () => {
    const now = new Date('2026-08-08T00:00:00Z');
    const dates = RECENCY_BUCKETS.map((b) => resolveLastStudiedAt(b.value, now)!);
    expect(dates.every((d) => d.getTime() < now.getTime())).toBe(true);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]!.getTime()).toBeLessThan(dates[i - 1]!.getTime());
    }
  });

  it('returns null for an unknown bucket instead of defaulting to now', () => {
    expect(resolveLastStudiedAt('last_tuesday')).toBeNull();
    expect(resolveLastStudiedAt(undefined)).toBeNull();
  });
});

describe('inferSourceByRule', () => {
  it('recognises YouTube across its host forms', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc123',
      'https://youtu.be/abc123',
      'https://music.youtube.com/watch?v=abc123',
    ]) {
      expect(inferSourceByRule(url)?.kind).toBe('youtube');
    }
  });

  it('reads the kind off a file extension and cleans up the title', () => {
    expect(inferSourceByRule('/uploads/teach_yourself_russian.pdf')).toMatchObject({
      kind: 'textbook', title: 'teach yourself russian',
    });
    expect(inferSourceByRule('pimsleur_lesson_03.mp3')?.kind).toBe('audio');
    expect(inferSourceByRule('movie.srt')?.kind).toBe('movie');
  });

  it('treats pasted prose as text', () => {
    const pasted = 'Первый день\nЯ пошёл в магазин и купил хлеб.';
    expect(inferSourceByRule(pasted)).toMatchObject({ kind: 'text', title: 'Первый день' });
  });

  it('declines a bare title so the caller can decide to ask the model', () => {
    expect(inferSourceByRule('Pimsleur Spanish 1')).toBeNull();
    expect(inferSourceByRule('')).toBeNull();
  });

  it('declines an arbitrary web page rather than guessing a kind that would fail at ingest', () => {
    expect(inferSourceByRule('https://example.com/some/article')).toBeNull();
  });
});
