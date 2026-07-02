/**
 * Onboarding state helpers.
 *
 * The onboarding flow runs through the normal agent loop — no separate mode.
 * The supervisor reads onboarding state and injects nudges; the processor
 * detects background/goal statements and fires onboarding_signal triggers;
 * this module writes the results to user_onboarding and commits the level
 * anchor to user_language_levels with source='onboarding'.
 *
 * Two paths write to the same tables:
 *   - Voice: processor fires onboarding_signal → supervisor accumulates →
 *     commitOnboardingLevel() called when supervisor has enough signal
 *   - UI form: POST /api/users/:id/onboarding/:lang → saveOnboardingData()
 *     + commitOnboardingLevel() directly
 */

import { db } from '../db/index.js';
import { userOnboarding, userLanguageLevels } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
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
  await db
    .insert(userOnboarding)
    .values({ userId, languageCode, ...data })
    .onConflictDoUpdate({
      target: [userOnboarding.userId, userOnboarding.languageCode],
      set: data,
    });
}

/**
 * Commit the anchored level to user_language_levels with source='onboarding'.
 * This is the high-confidence anchor that level inference respects.
 * Also marks the onboarding row as complete.
 */
export async function commitOnboardingLevel(
  userId: string,
  languageCode: string,
  level: Level,
  confidence: number,
  evidence: string,
  path: 'voice' | 'ui' = 'voice',
): Promise<void> {
  await db
    .insert(userLanguageLevels)
    .values({
      userId,
      languageCode,
      proficiencyLevel: level,
      confidence,
      source: 'onboarding',
      inferredAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userLanguageLevels.userId, userLanguageLevels.languageCode],
      set: {
        proficiencyLevel: level,
        confidence,
        source: 'onboarding',
        inferredAt: new Date(),
      },
    });

  await saveOnboardingData(userId, languageCode, {
    anchoredLevel: level,
    anchorConfidence: confidence,
    anchorEvidence: evidence,
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
