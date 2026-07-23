/**
 * Onboarding state helpers.
 *
 * The onboarding flow runs through the normal agent loop — no separate mode.
 * The supervisor reads onboarding state and injects nudges; the processor
 * detects background/goal statements and fires onboarding_signal triggers;
 * this module writes the results to user_onboarding.
 *
 * 2026-07-10, learner-field spec §6.5: this module no longer writes a level
 * override for the voice path. The intake conversation elicits real
 * target-language production (buildOnboardingInstructions), graded by the
 * same processor pipeline as normal conversation (provenance='probe') —
 * level-inference.ts's coverage-curve inference reads that evidence
 * directly. completeOnboarding() just marks the row done.
 *
 * Two paths write to user_onboarding:
 *   - Voice: processor fires onboarding_signal → supervisor accumulates
 *     background/goals; submit_onboarding_verdict tool calls
 *     completeOnboarding() to end the intake conversation
 *   - UI form: POST /api/users/:id/onboarding/:lang → saveOnboardingData()
 *     + setLevel(source='manual') (a direct self-report, unlike the voice
 *     path's graded evidence) + completeOnboarding()
 */

import { db } from '../db/index.js';
import { userOnboarding, userLanguageLevels, lexemes } from '../db/schema.js';
import { eq, and, asc, gte, lte, isNotNull, ne } from 'drizzle-orm';
import type { Level } from './level-inference.js';

export interface OnboardingState {
  userId: string;
  languageCode: string;
  uiComplete: boolean;
  voiceComplete: boolean;
  isComplete: boolean;          // either path done
  anchoredLevel: Level | null;
  anchorConfidence: number;
  anchorEvidence: string | null;
  priorStudy: string | null;
  studyDetails: string | null;
  goals: string[];
  goalDetails: string | null;
  selfRatedLevel: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

/** Returns null if no onboarding row exists yet (never started). */
export async function getOnboardingState(
  userId: string,
  languageCode: string,
): Promise<OnboardingState | null> {
  const row = await db.query.userOnboarding.findFirst({
    where: and(
      eq(userOnboarding.userId, userId),
      eq(userOnboarding.languageCode, languageCode),
    ),
  });
  if (!row) return null;
  return {
    userId,
    languageCode,
    uiComplete: row.uiComplete,
    voiceComplete: row.voiceComplete,
    isComplete: row.uiComplete || row.voiceComplete,
    anchoredLevel: (row.anchoredLevel as Level) ?? null,
    anchorConfidence: row.anchorConfidence ?? 0,
    anchorEvidence: row.anchorEvidence ?? null,
    priorStudy: row.priorStudy ?? null,
    studyDetails: row.studyDetails ?? null,
    goals: row.goals ?? [],
    goalDetails: row.goalDetails ?? null,
    selfRatedLevel: row.selfRatedLevel ?? null,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
  };
}

/** Upsert onboarding row. Called by both voice (processor signals) and UI paths. */
export async function saveOnboardingData(
  userId: string,
  languageCode: string,
  data: Partial<Omit<typeof userOnboarding.$inferInsert, 'userId' | 'languageCode'>>,
): Promise<void> {
  // Empty data means "ensure the row exists" (e.g. the entry() call that
  // seeds an onboarding row before the intake flow runs) — with a real
  // conflict, Drizzle's onConflictDoUpdate throws "No values to set" on an
  // empty set, which crashed a live session (2026-07-02) the moment a
  // second language's onboarding row already existed. Nothing to update
  // means nothing to do, not an error.
  const insert = db.insert(userOnboarding).values({ userId, languageCode, ...data });
  if (Object.keys(data).length === 0) {
    await insert.onConflictDoNothing();
  } else {
    await insert.onConflictDoUpdate({
      target: [userOnboarding.userId, userOnboarding.languageCode],
      set: data,
    });
  }
}

/**
 * Mark onboarding complete WITHOUT writing a level override.
 *
 * 2026-07-10, learner-field spec §6.5: replaces commitOnboardingLevel. The
 * old version wrote source='onboarding' to user_language_levels as a
 * trusted anchor the tutor's own self-declared CEFR guess held until 100
 * vocab items — an assessment based on the model's vibes about a 5-8 turn
 * chat, not graded evidence. Onboarding's job now is only to CAPTURE real
 * evidence: the intake conversation elicits target-language production
 * across increasing difficulty (see buildOnboardingInstructions), and that
 * gets graded by the exact same processor pipeline as normal conversation
 * (echo-gated, provenance='probe' — see runProcessor's onboarding flag).
 * level-inference.ts's coverage-curve/row-count inference reads that
 * evidence directly; there is no separate anchor tier to maintain.
 *
 * selfRatedLevel is kept as informational color only (shown in the
 * dashboard) — it never sets proficiencyLevel.
 */
export async function completeOnboarding(
  userId: string,
  languageCode: string,
  path: 'voice' | 'ui' = 'voice',
): Promise<void> {
  await saveOnboardingData(userId, languageCode, {
    voiceComplete: path === 'voice' ? true : undefined,
    uiComplete: path === 'ui' ? true : undefined,
    completedAt: new Date(),
  });
}

/**
 * Build a compact onboarding context string for the supervisor prompt.
 * Returns null if onboarding is already complete (supervisor doesn't need it).
 */
export function buildOnboardingContext(state: OnboardingState | null): string | null {
  if (!state) {
    return `ONBOARDING: not started. No background or goals captured yet.`;
  }
  if (state.isComplete) return null; // supervisor doesn't need to drive onboarding

  const parts: string[] = ['ONBOARDING: in progress.'];
  if (state.priorStudy) {
    parts.push(`Prior study: ${state.priorStudy}${state.studyDetails ? ` (${state.studyDetails})` : ''}.`);
  } else {
    parts.push('Prior study: not yet captured.');
  }
  if (state.goals.length > 0) {
    parts.push(`Goals: ${state.goals.join(', ')}${state.goalDetails ? ` — ${state.goalDetails}` : ''}.`);
  } else {
    parts.push('Goals: not yet captured.');
  }
  if (state.selfRatedLevel) {
    parts.push(`Self-rated level: ${state.selfRatedLevel}.`);
  } else {
    parts.push('Self-rated level: not yet captured.');
  }
  return parts.join(' ');
}

/**
 * Map a self-rated level string to a CEFR Level + confidence.
 * Used by the UI path where the user picks their own level.
 */
export function selfRatedLevelToAnchor(selfRated: string): { level: Level; confidence: number } {
  if (selfRated === 'none' || selfRated === 'pre_a1') return { level: 'pre_a1', confidence: 0.9 };
  const validLevels: Level[] = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
  if (validLevels.includes(selfRated as Level)) {
    return { level: selfRated as Level, confidence: 0.6 }; // self-report, not probed
  }
  return { level: 'pre_a1', confidence: 0.5 };
}

export interface LadderWord {
  lemma: string;
  translation: string;
  rank: number;
}

// Same bands as level-inference.ts's FREQUENCY_BANDS (kept as a separate
// literal, not imported, since this is a display/prompt concern with its
// own tuning — e.g. wanting exactly one word per rung — not the scoring
// concern that file owns).
const LADDER_BANDS: Array<{ lo: number; hi: number }> = [
  { lo: 1, hi: 15 },
  { lo: 50, hi: 150 },
  { lo: 300, hi: 600 },
  { lo: 1000, hi: 2500 },
];

/**
 * Real words from the validated frequency_rank data (learner-field spec §9),
 * one per band, for the onboarding staircase to actually climb — 2026-07-10,
 * closing a gap found while auditing the prompts: the staircase asked the
 * model to invent a frequency ladder from its own trained sense of the
 * language, with zero access to the frequency data we'd just built and
 * validated. Grounding beats trusting recall when we have real data.
 *
 * Returns [] for languages with no frequency backfill yet (spec §9 — only
 * ru/zh so far) — buildOnboardingInstructions falls back to today's
 * "think of common words yourself" phrasing in that case, not an error.
 */
export async function getOnboardingLadder(languageCode: string): Promise<LadderWord[]> {
  const ladder: LadderWord[] = [];
  for (const band of LADDER_BANDS) {
    // Requires a non-empty translation — many auto-created lexemes (from
    // the normal conversation ingestion path) never got one glossed
    // (`translation: ''` when no native equivalent existed at creation
    // time — see updateSRSFromAnalysis). A ladder word with no gloss is
    // worse than useless for the tutor, so a band with only glossless
    // candidates is skipped (a shorter, correct ladder beats a longer,
    // broken one) rather than filled with a bad entry.
    const row = await db.query.lexemes.findFirst({
      where: and(
        eq(lexemes.language, languageCode),
        isNotNull(lexemes.frequencyRank),
        gte(lexemes.frequencyRank, band.lo),
        lte(lexemes.frequencyRank, band.hi),
        ne(lexemes.translation, ''),
      ),
      orderBy: [asc(lexemes.frequencyRank)],
    });
    if (row?.frequencyRank != null) {
      ladder.push({ lemma: row.lemma, translation: row.translation, rank: row.frequencyRank });
    }
  }
  return ladder;
}
