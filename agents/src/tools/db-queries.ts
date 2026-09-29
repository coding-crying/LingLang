/**
 * Database queries backing the agent's DB tools.
 *
 * Split out of db-tools.ts so that callers which only need the data can get
 * it without importing `@livekit/agents`. db-tools.ts imports `llm` from the
 * SDK at module top, so any import from it — even of a plain function — pulls
 * the whole agents framework into the importing process. The dashboard's
 * /internal API needs these queries and must stay SDK-free, hence this file.
 *
 * Pure functions over Postgres. No LiveKit, no LLM, no request context.
 */

import { eq, and, desc, asc, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, units, users, activeGoals } from '../db/schema.js';

// ============================================================================
// CORE QUERIES (plain functions — testable without LiveKit)
// ============================================================================

export async function lookupLexemeQuery(
  lemma: string,
  language: string,
): Promise<{
  id: string;
  lemma: string;
  pos: string;
  translation: string;
  unitId: string | null;
  fsrsState: { state: number; stability: number; difficulty: number; reps: number; lapses: number; due: string; lastReview: string | null } | null;
} | null> {
  const lexeme = await db.query.lexemes.findFirst({
    where: and(eq(lexemes.lemma, lemma), eq(lexemes.language, language)),
  });
  if (!lexeme) return null;

  // Get FSRS state if the user has started this word
  // NOTE: user-specific FSRS requires a userId; lookupLexemeQuery returns
  // lexeme data only. Use getVocabularyOverview or getDueReviews for per-user FSRS.
  return {
    id: lexeme.id,
    lemma: lexeme.lemma,
    pos: lexeme.pos,
    translation: lexeme.translation,
    unitId: lexeme.unitId,
    fsrsState: null, // per-user — not available without userId
  };
}

export async function lookupLexemeWithFSRSQuery(
  lemma: string,
  language: string,
  userId: string,
): Promise<{
  id: string;
  lemma: string;
  pos: string;
  translation: string;
  gender: string | null;
  fsrsState: { state: number; stability: number; difficulty: number; reps: number; lapses: number; due: string; lastReview: string | null } | null;
} | null> {
  // Try exact match first, then fallback to lemma+language
  let lexeme = await db.query.lexemes.findFirst({
    where: and(eq(lexemes.lemma, lemma), eq(lexemes.pos, 'NOUN'), eq(lexemes.language, language)),
  });
  if (!lexeme) {
    lexeme = await db.query.lexemes.findFirst({
      where: and(eq(lexemes.lemma, lemma), eq(lexemes.language, language)),
    });
  }
  if (!lexeme) return null;

  const vocab = await db.query.userVocabulary.findFirst({
    where: and(eq(userVocabulary.userId, userId), eq(userVocabulary.lexemeId, lexeme.id)),
  });

  const stateNames = ['New', 'Learning', 'Review', 'Relearning'] as const;

  return {
    id: lexeme.id,
    lemma: lexeme.lemma,
    pos: lexeme.pos,
    translation: lexeme.translation,
    gender: lexeme.gender,
    fsrsState: vocab ? {
      state: vocab.state,
      // Human-readable state name for the LLM
      _stateName: stateNames[vocab.state as 0 | 1 | 2 | 3] || 'Unknown',
      stability: Math.round(vocab.stability * 100) / 100,
      difficulty: Math.round(vocab.difficulty * 100) / 100,
      reps: vocab.reps,
      lapses: vocab.lapses,
      due: vocab.due.toISOString(),
      lastReview: vocab.lastReview?.toISOString() || null,
    } as any : null,
  };
}

export async function getDueReviewsQuery(
  userId: string,
  limit: number = 10,
): Promise<Array<{
  lexemeId: string;
  lemma: string;
  translation: string;
  pos: string;
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  due: string;
}>> {
  // Get user's target language to filter out native-language substitution entries
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const targetLang = user?.targetLanguage;
  if (!targetLang) return [];

  const now = new Date();

  // Language is filtered in SQL, not in JS after the fact. This used to fetch
  // the `limit * 3` oldest-due rows and then drop the ones whose language
  // didn't match, which silently returned NOTHING for any learner whose due
  // list is dominated by another language: native-language tracking rows are
  // permanently due (see BACKLOG "native-language tracking rows becoming
  // permanently due"), so for a real account they filled the whole window
  // before the filter ran. Measured on a live user: 438 rows due, the first
  // target-language row ranked 152nd, so every fetch window was pure English
  // and the tutor was told there was nothing to review at all.
  const rows = await db
    .select({
      lexemeId: userVocabulary.lexemeId,
      lemma: lexemes.lemma,
      translation: lexemes.translation,
      pos: lexemes.pos,
      state: userVocabulary.state,
      stability: userVocabulary.stability,
      difficulty: userVocabulary.difficulty,
      reps: userVocabulary.reps,
      lapses: userVocabulary.lapses,
      due: userVocabulary.due,
    })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(lexemes.id, userVocabulary.lexemeId))
    .where(
      and(
        eq(userVocabulary.userId, userId),
        lte(userVocabulary.due, now),
        eq(lexemes.language, targetLang),
      ),
    )
    .orderBy(asc(userVocabulary.due))
    .limit(limit);

  const reviews = rows;

  const stateNames = ['New', 'Learning', 'Review', 'Relearning'] as const;

  return reviews.map(r => ({
    lexemeId: r.lexemeId,
    lemma: r.lemma,
    translation: r.translation,
    pos: r.pos,
    state: r.state,
    stateName: stateNames[r.state as 0 | 1 | 2 | 3] || 'Unknown',
    stability: Math.round(r.stability * 100) / 100,
    difficulty: Math.round(r.difficulty * 100) / 100,
    reps: r.reps,
    lapses: r.lapses,
    due: r.due.toISOString(),
  })) as any;
}

export async function getVocabularyOverviewQuery(
  userId: string,
): Promise<{
  totalWords: number;
  byState: Record<string, number>;
  avgStability: number;
  weakestWords: Array<{ lemma: string; translation: string; stability: number; state: number }>;
  nextUnitWords: Array<{ lemma: string; translation: string }>;
}> {
  // Scoped to the learner's target language. Unscoped, this counted every
  // row the account has ever accumulated: a Portuguese learner was told they
  // had 438 words when 230 were English native-substitution tracking rows,
  // 137 Russian and 16 Chinese from earlier languages. That number is read
  // by the tutor, so it was actively misinforming the model about how much
  // the learner knows — and avgStability was dragged down by the English
  // rows, which sit near zero by construction.
  //
  // An unset target language means onboarding hasn't finished; that case
  // keeps the old unscoped behavior rather than reporting an empty
  // vocabulary to a half-onboarded account.
  const overviewUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const overviewLang = overviewUser?.targetLanguage;

  const allVocab = await db.query.userVocabulary.findMany({
    where: overviewLang
      ? and(
          eq(userVocabulary.userId, userId),
          inArray(
            userVocabulary.lexemeId,
            db.select({ id: lexemes.id }).from(lexemes).where(eq(lexemes.language, overviewLang)),
          ),
        )
      : eq(userVocabulary.userId, userId),
    with: { lexeme: true },
  });

  const byState: Record<string, number> = { New: 0, Learning: 0, Review: 0, Relearning: 0 };
  const stateNames = ['New', 'Learning', 'Review', 'Relearning'] as const;

  for (const v of allVocab) {
    const name = stateNames[v.state as 0 | 1 | 2 | 3] || 'New';
    byState[name] = (byState[name] || 0) + 1;
  }

  const avgStability = allVocab.length > 0
    ? Math.round((allVocab.reduce((sum, v) => sum + v.stability, 0) / allVocab.length) * 100) / 100
    : 0;

  // Weakest 5 words (lowest stability, excluding state 0 / New)
  const weakest = allVocab
    .filter(v => v.state !== 0 && v.stability > 0)
    .sort((a, b) => a.stability - b.stability)
    .slice(0, 5)
    .map(v => ({
      lemma: v.lexeme.lemma,
      translation: v.lexeme.translation,
      stability: Math.round(v.stability * 100) / 100,
      state: v.state,
    }));

  // Next unit's unstarted words. An unset language means onboarding is
  // incomplete; keep the overview useful without inventing Russian progress.
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const targetLang = user?.targetLanguage;

  const startedIds = new Set(allVocab.map(v => v.lexemeId));

  const currentUnit = targetLang
    ? await db.query.units.findFirst({
        where: eq(units.language, targetLang),
        orderBy: [asc(units.order)],
      })
    : undefined;

  let nextUnitWords: Array<{ lemma: string; translation: string }> = [];
  if (targetLang && currentUnit) {
    const unitWords = await db.query.lexemes.findMany({
      where: and(eq(lexemes.unitId, currentUnit.id), eq(lexemes.language, targetLang)),
      limit: 8,
    });
    nextUnitWords = unitWords
      .filter(l => !startedIds.has(l.id))
      .slice(0, 5)
      .map(l => ({ lemma: l.lemma, translation: l.translation }));
  }

  return {
    totalWords: allVocab.length,
    byState,
    avgStability,
    weakestWords: weakest,
    nextUnitWords,
  };
}

export async function getSemanticNeighborsQuery(
  lemma: string,
  language: string,
  limit: number = 5,
): Promise<Array<{ lemma: string; translation: string; pos: string; distance: number }>> {
  const lexeme = await db.query.lexemes.findFirst({
    where: and(eq(lexemes.lemma, lemma), eq(lexemes.language, language)),
  });
  if (!lexeme?.embedding) return [];

  const embeddingStr = JSON.stringify(lexeme.embedding);
  const neighbors = await db.execute(sql`
    SELECT id, lemma, translation, pos, embedding <=> ${embeddingStr}::vector AS distance
    FROM lexemes
    WHERE id != ${lexeme.id} AND language = ${language}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `);

  return (neighbors as any[]).map(n => ({
    lemma: n.lemma,
    translation: n.translation,
    pos: n.pos,
    distance: Math.round(n.distance * 1000) / 1000,
  }));
}

export async function getActiveGoalsQuery(
  userId: string,
): Promise<Array<{
  id: number;
  type: string;
  targetId: string;
  targetLemma: string | null;
  targetTranslation: string | null;
  priority: number;
  grammarContext: string | null;
  status: string;
}>> {
  const goals = await db.query.activeGoals.findMany({
    where: and(eq(activeGoals.userId, userId), eq(activeGoals.status, 'active')),
    orderBy: [asc(activeGoals.priority)],
  });

  const result = [];
  for (const goal of goals) {
    const lexeme = await db.query.lexemes.findFirst({
      where: eq(lexemes.id, goal.targetId),
    });
    result.push({
      id: goal.id,
      type: goal.type,
      targetId: goal.targetId,
      targetLemma: lexeme?.lemma || null,
      targetTranslation: lexeme?.translation || null,
      priority: goal.priority,
      grammarContext: goal.grammarContext,
      status: goal.status,
    });
  }
  return result;
}
