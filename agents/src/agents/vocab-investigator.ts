// Vocab investigator — sub-agent that picks the next words to teach.
//
// Runs async on a timer (or on-demand after a session). Reads the user's
// current state from the DB, asks the LLM to pick the next 3-5 words that
// would be most useful for this learner right now, and writes the picks
// back to the DB. The main conversation agent reads from the same table
// and weaves the chosen words into the conversation.
//
// Completely separate from the conversation prompt. Doesn't block the
// user's voice. The tutor doesn't even know it's running.

import { db } from '../db/index.js';
import {
  userLanguageLevels,
  userVocabulary,
  lexemes,
} from '../db/schema.js';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { readLevelSignals } from '../lib/level-inference.js';
import type { Level } from '../lib/level-inference.js';

export interface VocabPick {
  lexemeId: string;
  lemma: string;
  reason: string;             // one sentence: why this word, why now
  usageHint: string;          // one example sentence to anchor it
}

export interface VocabContext {
  userId: string;
  languageCode: string;       // 'pt', 'ru', 'es', ...
  level: Level;
  recentSessionTopics: string[];  // last 3-5 topics covered
  strugglingWords: string[];      // 5-10 lemmas with high lapse rate
  masteredCount: number;
  newCount: number;            // unseen words
  candidatePoolSize: number;   // how many lexemes are in scope
}

export function buildVocabInvestigatorPrompt(ctx: VocabContext): string {
  return `You are the vocab investigator for a ${ctx.languageCode} learner at CEFR level ${ctx.level}.

Your job: pick the next 3-5 words to introduce to this learner. You do NOT talk to the learner — you hand picks to the conversation agent, who weaves them in.

CONTEXT:
- Level: ${ctx.level} (${ctx.masteredCount} mastered, ${ctx.newCount} new so far)
- Recent session topics: ${ctx.recentSessionTopics.length > 0 ? ctx.recentSessionTopics.join(', ') : 'none yet'}
- Struggling (high lapse rate): ${ctx.strugglingWords.length > 0 ? ctx.strugglingWords.join(', ') : 'none'}
- Candidate pool: ${ctx.candidatePoolSize} lexemes available for this level

PRINCIPLES:
- High-frequency words first. Common verbs (ser, estar, ter, fazer, ir) and pronouns unlock more sentences than rare nouns.
- Don't re-teach mastered words. The conversation agent handles review.
- Don't introduce words wildly above the learner's level. If they're pre_a1, stick to greetings, basic verbs, common nouns.
- Prefer words that unlock NEW sentence patterns, not just new isolated meanings.
- If the learner is struggling, focus on reinforcing those — repetition over novelty.
- Match the conversation context. If recent topics were food, lean toward food vocab.

OUTPUT FORMAT (exactly this JSON, no extra text):
{
  "picks": [
    {
      "lemma": "olá",
      "reason": "Unlocks every greeting — most common Portuguese opener",
      "usageHint": "Olá! Como estás?"
    },
    ...
  ]
}

Return 3-5 picks. Each reason should be one short, specific sentence. Each usageHint should be a sentence the conversation agent can drop in directly. No preamble, no apology, no explanation.`;
}

/**
 * Fetch the current vocab context for a learner. The LLM call (with the
 * prompt above) runs separately in the orchestrator. This function is
 * just the data layer.
 */
export async function readVocabContext(
  userId: string,
  languageCode: string,
): Promise<Omit<VocabContext, 'level'>> {
  const levelRow = await db.query.userLanguageLevels.findFirst({
    where: and(
      eq(userLanguageLevels.userId, userId),
      eq(userLanguageLevels.languageCode, languageCode),
    ),
  });
  const level = (levelRow?.proficiencyLevel as Level) || 'pre_a1';

  // Struggling words: high lapse rate
  const strugglingRows = await db
    .select({ lemma: lexemes.lemma, lapses: userVocabulary.lapses, reps: userVocabulary.reps })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
    .where(and(
      eq(userVocabulary.userId, userId),
      eq(lexemes.language, languageCode),
      sql`${userVocabulary.lapses} > 0 AND ${userVocabulary.reps} > 0`,
    ))
    .orderBy(desc(sql`${userVocabulary.lapses}::float / GREATEST(${userVocabulary.reps}, 1)`))
    .limit(10);
  const strugglingWords = strugglingRows.map((r) => r.lemma);

  // Mastered + new counts
  const counts = await db
    .select({
      mastered: sql<number>`SUM(CASE WHEN ${userVocabulary.state} = 2 THEN 1 ELSE 0 END)::int`,
      newCount: sql<number>`SUM(CASE WHEN ${userVocabulary.state} = 0 THEN 1 ELSE 0 END)::int`,
    })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
    .where(and(eq(userVocabulary.userId, userId), eq(lexemes.language, languageCode)));
  const masteredCount = Number(counts[0]?.mastered ?? 0);
  const newCount = Number(counts[0]?.newCount ?? 0);

  // Candidate pool size (lexemes in the language)
  const poolResult = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(lexemes)
    .where(eq(lexemes.language, languageCode));
  const candidatePoolSize = Number(poolResult[0]?.c ?? 0);

  return {
    userId,
    languageCode,
    recentSessionTopics: [],    // populated from session_summaries (TBD)
    strugglingWords,
    masteredCount,
    newCount,
    candidatePoolSize,
  };
}
