// Conservative, per-language proficiency inference.
//
// SRS tables remain authoritative for scheduling. They are deliberately not
// authoritative for CEFR: exposure, tutor repetition, review volume, and
// database state do not prove independent language ability.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { lexemes, userLanguageLevels, userVocabulary, users } from '../db/schema.js';
import {
  estimateFromIndependentEvidence,
  summarizeIndependentEvidence,
} from './level-estimator.js';
import type {
  ConservativeEstimate,
  IndependentEvidenceRecord,
  IndependentEvidenceSummary,
} from './level-estimator.js';

export type Level = 'pre_a1' | 'a1' | 'a2' | 'b1' | 'b2' | 'c1' | 'c2';

export interface LevelSignals {
  // Legacy SRS diagnostics. These are retained for dashboard callers and
  // investigation, but none of them can raise inferred proficiency.
  vocabSeen: number;
  vocabReview: number;
  vocabLearning: number;
  vocabRelearning: number;
  avgReps: number;
  avgLapses: number;
  lapseRate: number;
  grammarRulesSeen: number;
  sessionsForLanguage: number;
  daysSinceLastSession: number;
  selfReportedLevel: Level;

  // Authorized evidence only: accepted, validated, independent production
  // projections from the additive evidence ledger.
  independentEvidence: IndependentEvidenceSummary;
}

export interface LevelEstimate {
  level: Level;
  // Diagnostic evidence strength, not a CEFR score. Kept for API compatibility.
  score: number;
  confidence: number;
  signals: LevelSignals;
  source: 'manual' | 'onboarding' | 'inferred' | 'borrowed' | 'cold_start';
  basis?:
    | ConservativeEstimate['basis']
    | 'native_language_profile'
    | 'legacy_low_level_prior'
    | 'onboarding_anchor';
}

function resultRows(result: unknown): Record<string, unknown>[] {
  const value = result as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  return Array.isArray(value) ? value : (value.rows ?? []);
}

/**
 * Read the only evidence allowed to increase inferred proficiency.
 *
 * The SQL filters both tenant and target language. A projection must have
 * passed the evidence policy's capability gate; raw accepted observations or
 * legacy SRS rows are not enough.
 */
export async function readIndependentEvidence(
  userId: string,
  languageCode: string,
): Promise<IndependentEvidenceRecord[]> {
  try {
    const result = await db.execute(sql`
      SELECT e.id AS event_id, e.session_id, p.lemma, p.grade
      FROM learning_evidence_events e
      JOIN LATERAL (
        SELECT a.projections
        FROM learning_evidence_assessments a
        WHERE a.event_id = e.id AND a.status = 'accepted'
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1
      ) latest ON true
      CROSS JOIN LATERAL jsonb_array_elements(latest.projections) projection
      CROSS JOIN LATERAL jsonb_to_record(projection) AS p(lemma text, grade integer, reason text)
      WHERE e.user_id = ${userId}
        AND e.language = ${languageCode}
        AND p.grade IN (1, 3)
        AND p.reason = 'Supported independent lexical outcome'
    `);
    return resultRows(result).flatMap((row) => {
      const grade = Number(row.grade);
      const lemma = typeof row.lemma === 'string' ? row.lemma.trim() : '';
      const eventId = typeof row.event_id === 'string' ? row.event_id : '';
      const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
      return lemma && eventId && sessionId && (grade === 1 || grade === 3)
        ? [{ eventId, sessionId, lemma, grade: grade as 1 | 3 }]
        : [];
    });
  } catch {
    // A missing/unmigrated ledger must fail closed to beginner, never fall
    // back to the retired SRS formula.
    return [];
  }
}

/** Read language-scoped diagnostics. Diagnostics do not drive CEFR inference. */
export async function readLevelSignals(
  userId: string,
  languageCode: string,
): Promise<LevelSignals> {
  const vocabRows = await db
    .select({
      state: userVocabulary.state,
      reps: userVocabulary.reps,
      lapses: userVocabulary.lapses,
    })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
    .where(and(eq(userVocabulary.userId, userId), eq(lexemes.language, languageCode)));

  const vocabSeen = vocabRows.length;
  const vocabReview = vocabRows.filter((r) => r.state === 2).length;
  const vocabLearning = vocabRows.filter((r) => r.state === 1).length;
  const vocabRelearning = vocabRows.filter((r) => r.state === 3).length;
  const totalReps = vocabRows.reduce((sum, row) => sum + row.reps, 0);
  const totalLapses = vocabRows.reduce((sum, row) => sum + row.lapses, 0);

  const reviewResult = await db.execute(sql`
    SELECT AVG(rl.grade)::float AS avg_grade, COUNT(rl.id)::int AS review_count
    FROM review_logs rl
    JOIN user_vocabulary uv ON rl.user_vocabulary_id = uv.id
    JOIN lexemes l ON uv.lexeme_id = l.id
    WHERE uv.user_id = ${userId} AND l.language = ${languageCode}
  `);
  const review = resultRows(reviewResult)[0] ?? {};
  const avgGrade = Number(review.avg_grade ?? 0);
  const reviewCount = Number(review.review_count ?? 0);

  const evidenceRecords = await readIndependentEvidence(userId, languageCode);
  const independentEvidence = summarizeIndependentEvidence(evidenceRecords);

  const lastReviewResult = await db.execute(sql`
    SELECT MAX(rl.review_date)::text AS last_review
    FROM review_logs rl
    JOIN user_vocabulary uv ON rl.user_vocabulary_id = uv.id
    JOIN lexemes l ON uv.lexeme_id = l.id
    WHERE uv.user_id = ${userId} AND l.language = ${languageCode}
  `);
  const lastReview = resultRows(lastReviewResult)[0]?.last_review as string | null;
  const daysSinceLastSession = lastReview
    ? Math.max(0, Math.floor((Date.now() - new Date(lastReview).getTime()) / 86_400_000))
    : 999;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  return {
    vocabSeen,
    vocabReview,
    vocabLearning,
    vocabRelearning,
    avgReps: vocabSeen ? totalReps / vocabSeen : 0,
    avgLapses: vocabSeen ? totalLapses / vocabSeen : 0,
    lapseRate: totalReps ? totalLapses / totalReps : 0,
    // Kept as a diagnostic only. It is intentionally not used by inferLevel.
    grammarRulesSeen: reviewCount ? Math.round(avgGrade * 10) / 10 : 0,
    // This is now evidence-session count, not all sessions for the user.
    sessionsForLanguage: independentEvidence.independentSessions,
    daysSinceLastSession,
    // Global users.proficiencyLevel is not language-specific and is never an
    // inference anchor. Keep it only for legacy display compatibility.
    selfReportedLevel: ((user?.proficiencyLevel as Level) || 'pre_a1') as Level,
    independentEvidence,
  };
}

/**
 * Deprecated compatibility helper. The numeric value is evidence strength,
 * not a CEFR score, and cannot produce B1/B2/C levels.
 */
export function signalsToScore(s: LevelSignals): number {
  return Math.round(s.independentEvidence.quality * 1000) / 10;
}

/** Deprecated compatibility helper with conservative semantics. */
export function scoreToLevel(score: number): Level {
  return score >= 50 ? 'a2' : 'a1';
}

/**
 * Infer one target language. Manual dashboard overrides remain explicit and
 * hard; every inferred result is based solely on validated independent
 * production evidence for this exact language.
 */
export async function inferLevel(userId: string, languageCode: string): Promise<LevelEstimate> {
  const existing = await db.query.userLanguageLevels.findFirst({
    where: and(
      eq(userLanguageLevels.userId, userId),
      eq(userLanguageLevels.languageCode, languageCode),
    ),
  });
  const [user] = await db
    .select({ nativeLanguage: users.nativeLanguage })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const signals = await readLevelSignals(userId, languageCode);

  // Native language is a profile fact, not something the estimator should
  // attempt to rediscover from learner evidence. Keep the existing CEFR-shaped
  // value for API compatibility while guaranteeing confidence and avoiding a
  // destructive downgrade to beginner on future recalculations.
  if (user?.nativeLanguage?.toLowerCase() === languageCode.toLowerCase()) {
    return {
      // CEFR has no `native` value in this compatibility type. C2 is the
      // conservative maximum-shaped representation when no legacy row exists;
      // never invent a beginner level for a native-language profile.
      level: (existing?.proficiencyLevel as Level) || 'c2',
      score: 100,
      confidence: 1,
      signals,
      source: 'inferred',
      basis: 'native_language_profile',
    };
  }

  if (existing?.source === 'manual') {
    return {
      level: existing.proficiencyLevel as Level,
      score: signalsToScore(signals),
      confidence: existing.confidence,
      signals,
      source: 'manual',
      basis: 'independent_a1',
    };
  }

  if (
    existing?.source === 'onboarding' &&
    (existing.proficiencyLevel === 'a1' || existing.proficiencyLevel === 'a2')
  ) {
    return {
      level: existing.proficiencyLevel as Level,
      score: signalsToScore(signals),
      confidence: Math.min(0.75, existing.confidence),
      signals,
      source: 'onboarding',
      basis: 'onboarding_anchor',
    };
  }

  let estimate: ConservativeEstimate = estimateFromIndependentEvidence(signals.independentEvidence);

  // Low-level historical values are safe as a temporary operating prior: they
  // cannot create an advanced learner and preserve known-good A1/A2 placement
  // while the observer capability is being calibrated. They are never counted
  // as evidence and are capped at low confidence. Any historical B1+ value is
  // intentionally discarded because the old scorer could manufacture it.
  if (
    estimate.basis === 'no_independent_evidence' &&
    existing?.estimatorVersion === 'legacy-srs-v1' &&
    (existing.proficiencyLevel === 'a1' || existing.proficiencyLevel === 'a2')
  ) {
    estimate = {
      ...estimate,
      level: existing.proficiencyLevel,
      confidence: Math.min(0.35, existing.confidence),
      basis: 'legacy_low_level_prior',
    };
  }
  const shouldWrite =
    !existing ||
    existing.proficiencyLevel !== estimate.level ||
    existing.source !== 'inferred' ||
    existing.estimatorVersion !== 'independent-evidence-v1' ||
    existing.estimatorBasis !== estimate.basis ||
    existing.independentEvidenceCount !== signals.independentEvidence.observations ||
    existing.independentSessionCount !== signals.independentEvidence.independentSessions ||
    Math.abs(existing.confidence - estimate.confidence) >= 0.01;

  if (shouldWrite) {
    await db
      .insert(userLanguageLevels)
      .values({
        userId,
        languageCode,
        proficiencyLevel: estimate.level,
        confidence: estimate.confidence,
        source: 'inferred',
        inferredAt: new Date(),
        estimatorVersion: 'independent-evidence-v1',
        estimatorBasis: estimate.basis,
        independentEvidenceCount: signals.independentEvidence.observations,
        independentSessionCount: signals.independentEvidence.independentSessions,
      })
      .onConflictDoUpdate({
        target: [userLanguageLevels.userId, userLanguageLevels.languageCode],
        set: {
          proficiencyLevel: estimate.level,
          confidence: estimate.confidence,
          source: 'inferred',
          inferredAt: new Date(),
          estimatorVersion: 'independent-evidence-v1',
          estimatorBasis: estimate.basis,
          independentEvidenceCount: signals.independentEvidence.observations,
          independentSessionCount: signals.independentEvidence.independentSessions,
        },
      });
  }

  return { ...estimate, signals, source: 'inferred' };
}

/** Explicit user/dashboard placement. This is the only non-inferred anchor. */
export async function setLevel(
  userId: string,
  languageCode: string,
  level: Level,
  source: 'manual' | 'onboarding',
  confidence = 0.9,
): Promise<void> {
  await db
    .insert(userLanguageLevels)
    .values({
      userId,
      languageCode,
      proficiencyLevel: level,
      confidence,
      source,
      inferredAt: new Date(),
      estimatorVersion: source === 'manual' ? 'manual-v1' : 'onboarding-v1',
      estimatorBasis: source === 'manual' ? 'manual_override' : 'onboarding_claim',
      independentEvidenceCount: 0,
      independentSessionCount: 0,
    })
    .onConflictDoUpdate({
      target: [userLanguageLevels.userId, userLanguageLevels.languageCode],
      set: {
        proficiencyLevel: level,
        confidence,
        source,
        inferredAt: new Date(),
        estimatorVersion: source === 'manual' ? 'manual-v1' : 'onboarding-v1',
        estimatorBasis: source === 'manual' ? 'manual_override' : 'onboarding_claim',
        independentEvidenceCount: 0,
        independentSessionCount: 0,
      },
    });
}
