// Multi-signal level inference for LingLang.
//
// Runs on every session start. Reads all available signals from the DB
// (vocabulary, grammar, sessions, lapse rate) and produces a CEFR level
// estimate per language. Adaptive — more data means more resolution, not
// bucketed into A1/A2 by hard thresholds on a single feature.
//
// Falls back to userLanguageLevels row (manual override) if source='manual'
// with high confidence. Otherwise writes back the inferred level.

import { db } from '../db/index.js';
import {
  users,
  userLanguageLevels,
  userVocabulary,
  lexemes,
  sessionSummaries,
} from '../db/schema.js';
import { and, eq, sql, count } from 'drizzle-orm';

export type Level = 'pre_a1' | 'a1' | 'a2' | 'b1' | 'b2' | 'c1' | 'c2';

const LEVELS: Level[] = ['pre_a1', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2'];

export interface LevelSignals {
  // Vocabulary
  vocabSeen: number;           // total unique lexemes touched
  vocabReview: number;         // state=2 (stable)
  vocabLearning: number;       // state=1
  vocabRelearning: number;     // state=3
  avgReps: number;
  avgLapses: number;
  lapseRate: number;           // lapses / max(1, reps)
  // Grammar
  // Grammar / review quality proxy — derived from review_logs avg grade.
  // 0 when no reviews; scales with review count × quality (0..100 cap).
  grammarRulesSeen: number;
  // Engagement
  sessionsForLanguage: number; // distinct session_summaries
  daysSinceLastSession: number;
  // Self-reported
  selfReportedLevel: Level;
}

export interface LevelEstimate {
  level: Level;
  score: number;               // continuous 0..~500
  confidence: number;          // 0..1
  signals: LevelSignals;
  source: 'manual' | 'onboarding' | 'inferred' | 'borrowed' | 'cold_start';
}

/**
 * Read all relevant signals from the DB for one (user, language).
 * One round-trip, no LLM, pure SQL.
 */
export async function readLevelSignals(
  userId: string,
  languageCode: string,
): Promise<LevelSignals> {
  // Vocab state distribution per language
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
  const totalReps = vocabRows.reduce((acc, r) => acc + r.reps, 0);
  const totalLapses = vocabRows.reduce((acc, r) => acc + r.lapses, 0);
  const avgReps = vocabSeen > 0 ? totalReps / vocabSeen : 0;
  const avgLapses = vocabSeen > 0 ? totalLapses / vocabSeen : 0;
  const lapseRate = totalReps > 0 ? totalLapses / totalReps : 0;

  // Grammar / review quality signal — grammar_rules table is curriculum-only
  // (no per-user tracking). Use review_logs as a proxy: avg grade and
  // pronunciation score reflect phonological + morphological competence.
  // grade: 1=Again, 2=Hard, 3=Good, 4=Easy. Avg > 3.0 = solid recall.
  const rqRows = await db.execute(sql`
    SELECT
      AVG(rl.grade)::float              AS avg_grade,
      AVG(rl.pronunciation_score)::float AS avg_pronunciation,
      COUNT(rl.id)::int                 AS review_count
    FROM review_logs rl
    JOIN user_vocabulary uv ON rl.user_vocabulary_id = uv.id
    JOIN lexemes l ON uv.lexeme_id = l.id
    WHERE uv.user_id = ${userId}
      AND l.language = ${languageCode}
  `);
  const rqRow = (rqRows as unknown as Record<string, unknown>[])[0];
  const avgGrade = Number(rqRow?.avg_grade ?? 0);
  const reviewCount = Number(rqRow?.review_count ?? 0);
  // Map to a 0..N "grammar-equivalent" score: each review above grade 1
  // weighted by quality. Cap at 100 to avoid dominating vocab signal.
  const grammarRulesSeen = reviewCount > 0
    ? Math.min(100, Math.round(reviewCount * Math.max(0, (avgGrade - 1) / 3)))
    : 0;

  // Session count + recency — session_summaries has no language column.
  // Use review_logs recency as a proxy for last active date in this language,
  // and count all sessions for the user (sessions aren't language-tagged).
  const sessionResult = await db
    .select({
      c: count(),
      lastAt: sql<string>`MAX(created_at)`,
    })
    .from(sessionSummaries)
    .where(eq(sessionSummaries.userId, userId));

  // Last review date for THIS language (more accurate than session recency)
  const lastReviewResult = await db.execute(sql`
    SELECT MAX(rl.review_date)::text AS last_review
    FROM review_logs rl
    JOIN user_vocabulary uv ON rl.user_vocabulary_id = uv.id
    JOIN lexemes l ON uv.lexeme_id = l.id
    WHERE uv.user_id = ${userId} AND l.language = ${languageCode}
  `);
  const lastReviewRow = (lastReviewResult as unknown as Record<string, unknown>[])[0];
  const lastReviewAt = lastReviewRow?.last_review as string | null;

  const sessionsForLanguage = Number(sessionResult[0]?.c ?? 0);
  // Prefer language-specific review recency; fall back to session recency
  const lastAt = lastReviewAt || sessionResult[0]?.lastAt;
  const daysSinceLastSession = lastAt
    ? Math.floor((Date.now() - new Date(lastAt).getTime()) / (24 * 60 * 60 * 1000))
    : 999;

  // Self-reported (fallback default)
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const selfReportedLevel = ((user?.proficiencyLevel as Level) || 'pre_a1') as Level;

  return {
    vocabSeen,
    vocabReview,
    vocabLearning,
    vocabRelearning,
    avgReps,
    avgLapses,
    lapseRate,
    grammarRulesSeen,
    sessionsForLanguage,
    daysSinceLastSession,
    selfReportedLevel,
  };
}

/**
 * Map signals to a continuous score, then bucket to CEFR.
 * The score is a weighted blend of vocabulary mastery, grammar coverage,
 * stability (lapse rate), and engagement. Bucketing thresholds are
 * tunable — the function is the documented "we tried this and it works"
 * baseline.
 */
export function scoreToLevel(score: number): Level {
  if (score < 5) return 'pre_a1';
  if (score < 25) return 'a1';
  if (score < 70) return 'a2';
  if (score < 160) return 'b1';
  if (score < 320) return 'b2';
  if (score < 550) return 'c1';
  return 'c2';
}

export function signalsToScore(s: LevelSignals): number {
  // Vocabulary component — mastered vocab is the dominant signal
  const vocabScore =
    s.vocabReview * 1.0 +
    s.vocabLearning * 0.3 +
    s.vocabRelearning * 0.15;

  // Review quality proxy (was: grammar rules seen).
  // Capped at 100, weight 0.8 — lower than the original 4.0 because this
  // is a noisy proxy (review count × grade quality), not discrete grammar rules.
  const grammarScore = s.grammarRulesSeen * 0.8;

  // Stability — low lapse rate is a big signal of competence
  const stabilityScore = s.avgReps * (1 - s.lapseRate) * 0.5;

  // Engagement — sessions, but cap so 1000 sessions of pre_a1 doesn't fake it
  const engagementScore = Math.min(s.sessionsForLanguage, 30) * 0.8;

  // Recency decay — old sessions count less
  const recencyWeight = s.daysSinceLastSession < 30
    ? 1.0
    : s.daysSinceLastSession < 90
      ? 0.7
      : 0.4;

  return (vocabScore + grammarScore + stabilityScore + engagementScore) * recencyWeight;
}

// CEFR ordinal — used to take the max across languages when borrowing
// a prior. Higher number = more advanced.
const LEVEL_ORDINAL: Record<Level, number> = {
  pre_a1: 0, a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6,
};

/**
 * Look at the user's other languages and return the highest inferred
 * level found. Used as a sanity floor when a user starts a new language
 * — a polyglot starting a 5th language isn't really "pre-A1" in the
 * absolute sense, they just haven't built vocabulary in this one yet.
 *
 * 2026-06-25: New. Handles the "new user who's already good" case.
 * Returns null if the user has no signal in any other language.
 */
export async function inferPriorFromOtherLanguages(
  userId: string,
  excludeLanguageCode: string,
): Promise<Level | null> {
  const rows = await db
    .select()
    .from(userLanguageLevels)
    .where(eq(userLanguageLevels.userId, userId));

  let best: Level | null = null;
  let bestOrdinal = -1;
  for (const row of rows) {
    if (row.languageCode === excludeLanguageCode) continue;
    const lvl = row.proficiencyLevel as Level;
    const ord = LEVEL_ORDINAL[lvl] ?? 0;
    if (ord > bestOrdinal) {
      bestOrdinal = ord;
      best = lvl;
    }
  }
  return best;
}

/**
 * Public API. Reads signals, computes score, buckets to CEFR, and
 * writes back to userLanguageLevels (unless a manual override is set).
 *
 * Returns the estimate AND the source of the level. The tutor uses
 * source='manual' or 'onboarding' with high confidence as a hard override.
 */
export async function inferLevel(
  userId: string,
  languageCode: string,
): Promise<LevelEstimate> {
  // Check for existing row (manual override, onboarding result, or prior inference)
  const existing = await db.query.userLanguageLevels.findFirst({
    where: and(
      eq(userLanguageLevels.userId, userId),
      eq(userLanguageLevels.languageCode, languageCode),
    ),
  });

  const signals = await readLevelSignals(userId, languageCode);
  const score = signalsToScore(signals);
  const level = scoreToLevel(score);
  // Confidence scales with how much signal we have. 50+ vocab seen = high confidence.
  const confidence = Math.min(1, signals.vocabSeen / 50);

  // 2026-06-25: The old rule was "if source=manual, return it." That
  // short-circuited the algorithm even after the user had 458 vocab rows
  // — Will was stuck at pre_a1 because of a single session-1 manual
  // pin, even though his data clearly said A2.
  //
  // New rule: the override is a *placeholder* for cold start, not a
  // permanent declaration. It wins only while the algorithm hasn't
  // accumulated enough signal to be more trustworthy than the override.
  //
  //   vocabSeen < 20  → override still wins (cold start, no data to
  //                     contradict it). User could be a polyglot who
  //                     really is pre-A1 here, but also could be an
  //                     experienced learner of this language — either
  //                     way we don't have evidence to override them.
  //
  //   vocabSeen >= 20 → inferred wins. At 20+ words, the algorithm has
  //                     enough signal to be more trustworthy than a
  //                     session-1 guess. If the user later wants to
  //                     override it, they can re-pin via the dashboard.
  //
  // The "new user who is already really good" case is handled by
  // looking at OTHER languages' inferred levels as a prior: if the
  // user is A2 in Russian and just started PT, the algorithm's cold
  // start (pre-A1) is wrong — they have a real-world L2 acquisition
  // track record. We borrow their highest inferred level from any
  // other language as a sanity floor.
  // Onboarding anchor: holds until 100 vocab items, then decays.
  // Manual override: holds until 20 vocab items (legacy behaviour).
  // Rationale: onboarding is a deliberate calibration — we trust it more
  // than a session-1 manual pin. 100 words ≈ 3-5 sessions of real use,
  // enough for the inference to have its own opinion.
  const anchorThreshold = existing?.source === 'onboarding' ? 100 : 20;
  const hasEnoughSignal = signals.vocabSeen >= anchorThreshold;
  if (!hasEnoughSignal) {
    // Manual or onboarding override for THIS language wins
    if (existing?.source === 'manual' || existing?.source === 'onboarding') {
      return {
        level: existing.proficiencyLevel as Level,
        score,
        confidence: existing.confidence,
        signals,
        source: existing.source,
      };
    }
    // No override for this language — check if the user has signal in
    // ANY language. If so, don't drop them to pre_a1 from scratch.
    const otherLanguageLevel = await inferPriorFromOtherLanguages(userId, languageCode);
    if (otherLanguageLevel) {
      return {
        level: otherLanguageLevel,
        score,
        confidence: 0.5, // medium confidence — borrowed, not directly measured
        signals,
        source: 'borrowed',
      };
    }
    // Truly cold start — no override, no other languages. Default to A1
    // (not pre_a1) because the absence of data isn't evidence of
    // pre-literacy. The level will refine as soon as the user has 5+
    // vocab rows.
    return { level: 'a1', score, confidence: 0, signals, source: 'cold_start' };
  }

  // Write back the inferred level (debounced — only if changed or stale)
  if (!existing || existing.proficiencyLevel !== level || existing.source !== 'inferred') {
    await db
      .insert(userLanguageLevels)
      .values({
        userId,
        languageCode,
        proficiencyLevel: level,
        confidence,
        source: 'inferred',
        inferredAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userLanguageLevels.userId, userLanguageLevels.languageCode],
        set: {
          proficiencyLevel: level,
          confidence,
          source: 'inferred',
          inferredAt: new Date(),
        },
      });
  }

  return { level, score, confidence, signals, source: 'inferred' };
}

/**
 * Override the inferred level (e.g., from a manual dashboard toggle or
 * from the onboarding sub-agent). Sets source='manual' or 'onboarding'
 * so subsequent calls to inferLevel() respect the override.
 */
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
    })
    .onConflictDoUpdate({
      target: [userLanguageLevels.userId, userLanguageLevels.languageCode],
      set: {
        proficiencyLevel: level,
        confidence,
        source,
        inferredAt: new Date(),
      },
    });
}
