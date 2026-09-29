/**
 * Database Query Tools for LiveKit Agent
 *
 * LLM function-calling tools that let the planner and conversation tutor
 * query the database directly. Registered via llm.tool() on the voice.Agent.
 *
 * The queries themselves live in db-queries.ts, which is deliberately free of
 * any `@livekit/agents` import so non-agent callers (the dashboard's /internal
 * API) can use them without loading the SDK. This file is the LiveKit-facing
 * shell over those queries.
 *
 * Tools:
 *   lookupLexeme     — find a word by lemma, get translation + FSRS state
 *   getDueReviews    — list words due for spaced repetition review
 *   getVocabularyOverview — summary of learner's vocabulary progress
 *   getSemanticNeighbors — find related words via pgvector
 *   getActiveGoals   — current teaching goals and their status
 */

import * as z from 'zod';
import { llm } from '@livekit/agents';

import {
  lookupLexemeQuery,
  lookupLexemeWithFSRSQuery,
  getDueReviewsQuery,
  getVocabularyOverviewQuery,
  getSemanticNeighborsQuery,
  getActiveGoalsQuery,
} from './db-queries.js';

// Re-exported so existing import paths keep working.
export {
  lookupLexemeQuery,
  lookupLexemeWithFSRSQuery,
  getDueReviewsQuery,
  getVocabularyOverviewQuery,
  getSemanticNeighborsQuery,
  getActiveGoalsQuery,
};

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
