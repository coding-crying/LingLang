/**
 * Database Query Tools for LiveKit Agent
 *
 * LLM function-calling tools that let the planner and conversation tutor
 * query the database directly. Registered via llm.tool() on the voice.Agent.
 *
 * Tools:
 *   lookupLexeme     — find a word by lemma, get translation + FSRS state
 *   getDueReviews    — list words due for spaced repetition review
 *   getVocabularyOverview — summary of learner's vocabulary progress
 *   getSemanticNeighbors — find related words via pgvector
 *   getActiveGoals   — current teaching goals and their status
 */

import { eq, and, desc, asc, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, units, users, activeGoals } from '../db/schema.js';
import * as z from 'zod';
import { llm } from '@livekit/agents';

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
  const allDue = await db.query.userVocabulary.findMany({
    where: and(eq(userVocabulary.userId, userId), lte(userVocabulary.due, now)),
    with: { lexeme: true },
    orderBy: [asc(userVocabulary.due)],
    limit: limit * 3, // fetch more to account for filtering
  });

  // Filter to target-language entries only
  const reviews = allDue.filter(r => r.lexeme?.language === targetLang).slice(0, limit);

  const stateNames = ['New', 'Learning', 'Review', 'Relearning'] as const;

  return reviews.map(r => ({
    lexemeId: r.lexemeId,
    lemma: r.lexeme.lemma,
    translation: r.lexeme.translation,
    pos: r.lexeme.pos,
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
  const allVocab = await db.query.userVocabulary.findMany({
    where: eq(userVocabulary.userId, userId),
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

// ============================================================================
// LLM TOOL DEFINITIONS (LiveKit function-calling wrappers)
// ============================================================================

export const lookupLexemeTool = llm.tool({
  name: 'lookup_lexeme',
  description:
    'Look up a word (lemma) in the vocabulary database. Returns the translation, part of speech, and the learner\'s current FSRS memory state (stability, difficulty, due date, etc.). Use this to check if a word exists and how well the learner knows it.',
  parameters: z.object({
    lemma: z.string().describe('The word to look up (dictionary form, e.g. "привет", "casa")'),
    language: z.string().describe('ISO 639-1 language code (ru, es, fr, pt, ar, en)'),
  }),
  execute: async (args: { lemma: string; language: string }, opts: any) => {
    // Extract userId from the run context
    const userId = (opts as any).ctx?.userData?.userId || 'test-user';
    const result = await lookupLexemeWithFSRSQuery(args.lemma, args.language, userId);
    if (!result) return { found: false, lemma: args.lemma };
    return { found: true, ...result };
  },
});

export const getDueReviewsTool = llm.tool({
  name: 'get_due_reviews',
  description:
    'Get the learner\'s vocabulary words that are due for spaced repetition review right now. These are words the learner has seen before that need practice. Returns up to 10 due words with their FSRS state (stability, difficulty, state).',
  parameters: z.object({
    limit: z.number().optional().describe('Max words to return (default 10)').default(10),
  }),
  execute: async (args: { limit?: number }, opts: any) => {
    const userId = (opts as any).ctx?.userData?.userId || 'test-user';
    const reviews = await getDueReviewsQuery(userId, args.limit || 10);
    return { count: reviews.length, reviews };
  },
});

export const getVocabularyOverviewTool = llm.tool({
  name: 'get_vocab_overview',
  description:
    'Get a summary of the learner\'s vocabulary progress. Returns total words, breakdown by FSRS state (New/Learning/Review/Relearning), average stability, weakest words, and next curriculum words to introduce.',
  parameters: z.object({}),
  execute: async (_args: Record<string, never>, opts: any) => {
    const userId = (opts as any).ctx?.userData?.userId || 'test-user';
    return await getVocabularyOverviewQuery(userId);
  },
});

export const getSemanticNeighborsTool = llm.tool({
  name: 'get_semantic_neighbors',
  description:
    'Find semantically related words to a given word using vector similarity (pgvector). Useful for finding words that could reinforce or confuse the learner. Returns neighbor words with their distance (lower = more similar).',
  parameters: z.object({
    lemma: z.string().describe('The word to find neighbors for'),
    language: z.string().describe('ISO 639-1 language code'),
    limit: z.number().optional().describe('Max neighbors to return (default 5)').default(5),
  }),
  execute: async (args: { lemma: string; language: string; limit?: number }, opts: any) => {
    return await getSemanticNeighborsQuery(args.lemma, args.language, args.limit || 5);
  },
});

export const getActiveGoalsTool = llm.tool({
  name: 'get_active_goals',
  description:
    'Get the learner\'s current active teaching goals. These are words the system has identified as needing remediation (struggling) or new vocabulary to introduce. Each goal has a priority and optional grammar context.',
  parameters: z.object({}),
  execute: async (_args: Record<string, never>, opts: any) => {
    const userId = (opts as any).ctx?.userData?.userId || 'test-user';
    return await getActiveGoalsQuery(userId);
  },
});

/**
 * All DB tools for use with voice.Agent({ tools }). @livekit/agents 1.5.0
 * broke the old `Record<string, FunctionTool>` map shape — Agent({ tools })
 * now takes a flat array. Import and spread: `tools: [...dbTools]`
 */
export const dbTools = [
  lookupLexemeTool,
  getDueReviewsTool,
  getVocabularyOverviewTool,
  getSemanticNeighborsTool,
  getActiveGoalsTool,
] as const;