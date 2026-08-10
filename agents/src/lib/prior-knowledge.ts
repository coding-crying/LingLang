/**
 * Seeding FSRS state from study that happened OUTSIDE this app — see
 * docs/superpowers/specs/2026-08-08-content-provenance-design.md §3.
 *
 * The problem this solves: curriculum.ts's placement is a "knowledge diff"
 * — it compares a source's vocab against user_vocabulary and drops the
 * learner at the first chunk they don't already know. That is exactly
 * right for knowledge earned here, and useless for a learner who arrives
 * having done 25 Pimsleur lessons, because their user_vocabulary is empty.
 * Coverage comes out 0% and they get placed at lesson 1.
 *
 * So: convert the learner's claim ("I did lessons 1-25, last one about
 * three weeks ago, and I drilled them") into user_vocabulary rows that are
 * *honest about time*. Not "they know these words" — that would make the
 * words invisible to review forever — but "they learned these words on
 * date D with strength S", and then let ordinary FSRS decay decide what's
 * still solid and what's due for review right now.
 *
 * That distinction is the whole design. A learner on day 25 of Pimsleur
 * should find lesson-1 vocabulary resurfacing (studied 25 days ago, past
 * its interval) while lesson-24 vocabulary stays quiet (studied yesterday).
 * Seeding with `due = now` for everything would dump 300 words into one
 * session; seeding with no due date at all would silently mark a year of
 * forgotten material as known. Backdating is what makes it come out right.
 *
 * Two hard rules:
 *   1. A seeded row is a CLAIM, not an observation. Rows carry
 *      origin='seeded' and a real conversation row is never overwritten by
 *      one (see writeSeededCards).
 *   2. Claims decay. Past a retention floor we refuse to assert knowledge
 *      at all and seed a weaker "you've met this before" state instead —
 *      otherwise "I did this textbook in 2019" would mark half a language
 *      known on the strength of a sentence.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary } from '../db/schema.js';
import { DEFAULT_FSRS_PARAMS, nextInterval, retrievability, type FSRSState } from './fsrs.js';

/** How hard the learner actually worked the material. */
export type StudyIntensity = 'drilled' | 'studied' | 'skimmed';

/**
 * Seed stability in days, by intensity — how durable one pass through this
 * material is assumed to have left a word.
 *
 * These are deliberately conservative relative to what a completed SRS
 * course "should" leave behind. Over-seeding is the expensive failure:
 * it marks words known, inflates chunk coverage, skips the learner past
 * material they actually need, and (unlike under-seeding) produces no
 * signal that anything went wrong — the words simply never come up. Under-
 * seeding just means a few extra reviews in week one, which self-corrects
 * on the first successful recall.
 *
 * 'drilled'  — a spaced-repetition audio course (Pimsleur, Anki deck) where
 *              each item was actively recalled several times across days.
 *              This is the only case with genuine spacing behind it.
 * 'studied'  — worked a textbook chapter properly: read it, did exercises.
 *              Real encoding, no spacing.
 * 'skimmed'  — read/watched once. Recognition at best.
 */
export const SEED_STABILITY: Record<StudyIntensity, number> = {
  drilled: 21,
  studied: 8,
  skimmed: 2.5,
};

/**
 * Seed difficulty (FSRS 1-10, lower = easier). We have no per-word signal
 * here, so everything lands mid-scale, nudged by how well it was learned.
 * The first real review replaces this with something earned.
 */
const SEED_DIFFICULTY: Record<StudyIntensity, number> = {
  drilled: 4.5,
  studied: 5.0,
  skimmed: 5.5,
};

/**
 * Below this predicted retention we stop claiming the word is known.
 *
 * 0.35 is chosen against what the number actually gates: coverage counts a
 * word at FSRS state >= 2, which is what lets placement skip a chunk. At
 * R=0.35 the learner would fail the word more often than not, so calling
 * it "covered" and skipping the chunk that teaches it is the wrong call —
 * but they HAVE seen it, and treating it as brand-new throws that away.
 * Hence the middle state below rather than a binary.
 */
const RETENTION_FLOOR = 0.35;

/**
 * Predicted retention of a card `elapsedDays` after its last review.
 *
 * Matches the curve fsrsReview() already uses internally (fsrs.ts) —
 * R = 1 / (1 + w13 * t/S) — rather than the canonical FSRS-5 power law, so
 * a seeded card and a reviewed card are scheduled by the same arithmetic.
 * Consistency with the live scheduler matters more here than fidelity to
 * upstream: these two numbers get compared against each other constantly.
 */
export function predictedRetention(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return retrievability(elapsedDays, stability);
}

export interface SeededCard {
  state: FSRSState;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  due: Date;
  lastReview: Date;
  /** Predicted retention at `now` — persisted as comprehensionSignal so the
   *  frontier can tell a shaky seed from a solid one. */
  retention: number;
  /** False once decayed past RETENTION_FLOOR: seeded as "met before"
   *  (state 1) rather than "known" (state 2), so it does NOT count toward
   *  chunk coverage. */
  claimsKnown: boolean;
}

/**
 * Turn "studied on date D, at intensity I" into an FSRS card as it would
 * stand today. Pure — no DB, no clock beyond the injected `now` — so the
 * decay behaviour is directly testable.
 */
export function seedCardFromPriorStudy(
  studiedAt: Date,
  intensity: StudyIntensity,
  now: Date = new Date(),
): SeededCard {
  const stability = SEED_STABILITY[intensity];
  const elapsedMs = Math.max(0, now.getTime() - studiedAt.getTime());
  const elapsedDays = elapsedMs / 86_400_000;
  const retention = predictedRetention(elapsedDays, stability);

  // The interval that pass would have earned — delegated to the scheduler
  // rather than reproduced here, so the two can never drift apart again.
  const scheduledDays = Math.max(1, Math.round(nextInterval(stability, DEFAULT_FSRS_PARAMS)));

  if (retention >= RETENTION_FLOOR) {
    // Still plausibly known. Due date is measured from when they actually
    // studied it, NOT from now — that backdating is what makes older
    // material surface first instead of everything arriving at once.
    return {
      state: 2,
      stability,
      difficulty: SEED_DIFFICULTY[intensity],
      elapsedDays: Math.round(elapsedDays),
      scheduledDays,
      due: new Date(studiedAt.getTime() + scheduledDays * 86_400_000),
      lastReview: studiedAt,
      retention,
      claimsKnown: true,
    };
  }

  // Too long ago to assert. Record the exposure without the claim: state 1
  // (learning) keeps it out of coverage — so the learner is NOT skipped
  // past the chunk that teaches it — while still marking it as ground
  // they've covered before, which the frontier prefers over cold vocabulary.
  return {
    state: 1,
    stability: Math.max(0.5, stability * retention),
    difficulty: SEED_DIFFICULTY[intensity],
    elapsedDays: Math.round(elapsedDays),
    scheduledDays: 1,
    due: new Date(now.getTime()),
    lastReview: studiedAt,
    retention,
    claimsKnown: false,
  };
}

export interface SeedResult {
  /** Rows written (inserted or refreshed). */
  seeded: number;
  /** Of those, how many assert the word is known (state 2). */
  claimedKnown: number;
  /** Skipped because the learner already has real conversation history for
   *  the word — observation always beats claim. */
  skippedObserved: number;
}

/**
 * Write seeded cards for a set of lexemes.
 *
 * Conflict policy, which is the part that matters: a row earned in
 * conversation is never touched. The learner actually said these words
 * here; we watched it happen. A profile answer — necessarily fuzzy, often
 * a round number over a whole course — must not overwrite that with an
 * average. Re-profiling DOES refresh previously-seeded rows, so correcting
 * "I did 25 lessons" to "actually 15" takes effect.
 */
export async function writeSeededCards(
  userId: string,
  lexemeIds: string[],
  card: SeededCard,
): Promise<SeedResult> {
  const unique = [...new Set(lexemeIds)].filter(Boolean);
  if (unique.length === 0) return { seeded: 0, claimedKnown: 0, skippedObserved: 0 };

  // Existing rows decide insert-vs-refresh-vs-leave-alone. One read rather
  // than a clever upsert because the three-way branch is worth being able
  // to see and count (the counts surface in the API response and the trace).
  const existing = await db.query.userVocabulary.findMany({
    where: and(eq(userVocabulary.userId, userId), inArray(userVocabulary.lexemeId, unique)),
    columns: { lexemeId: true, origin: true },
  });
  const existingByLexeme = new Map(existing.map((r) => [r.lexemeId, r]));

  const toInsert: string[] = [];
  const toRefresh: string[] = [];
  let skippedObserved = 0;

  for (const lexemeId of unique) {
    const row = existingByLexeme.get(lexemeId);
    if (!row) toInsert.push(lexemeId);
    else if (row.origin === 'seeded') toRefresh.push(lexemeId);
    else skippedObserved++;
  }

  const shared = {
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    due: card.due,
    lastReview: card.lastReview,
    // Not a rep: `reps` counts reviews we actually administered, and
    // review_logs has no row for any of this. Leaving it 0 keeps every
    // reps-based statistic honest about what was really observed.
    reps: 0,
    lapses: 0,
    // The exposure IS real even though the recall wasn't observed — this is
    // precisely what receptiveExposures exists for.
    receptiveExposures: 1,
    lastExposure: card.lastReview,
    comprehensionSignal: card.retention,
    origin: 'seeded' as const,
  };

  // Chunked to keep the parameter count under Postgres's 65535 ceiling —
  // a full textbook can seed several thousand lexemes at once.
  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    await db.insert(userVocabulary)
      .values(batch.map((lexemeId) => ({ userId, lexemeId, ...shared })))
      .onConflictDoNothing();
  }

  for (let i = 0; i < toRefresh.length; i += CHUNK) {
    const batch = toRefresh.slice(i, i + CHUNK);
    await db.update(userVocabulary)
      .set(shared)
      .where(and(
        eq(userVocabulary.userId, userId),
        inArray(userVocabulary.lexemeId, batch),
        // Re-checked in the WHERE, not just in the read above: a live
        // session could have converted the row to 'conversation' in between.
        eq(userVocabulary.origin, 'seeded'),
      ));
  }

  const seeded = toInsert.length + toRefresh.length;
  return {
    seeded,
    claimedKnown: card.claimsKnown ? seeded : 0,
    skippedObserved,
  };
}
