/**
 * The one read path prompt builders use: readLearnerView(userId, lang).
 *
 * Principle: the DB is the only truth, prompts are views. This function is
 * the single place that turns live DB state into what a prompt builder
 * needs — due/new words, frontier inputs, and the persona row. It replaces
 * the six ad-hoc in-memory caches that used to live in tutor-event-driven.ts
 * (wordsDue/wordsNew consts, cachedDbContext, currentStyleCache, etc).
 *
 * A short TTL bounds query cost against per-turn rebuild frequency — it is
 * not a second state store, just a debounce on this one query.
 *
 * See docs/superpowers/specs/2026-07-02-adaptive-loop-redesign-design.md §1.
 */

import { eq, and, asc, desc, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, reviewLogs } from '../db/schema.js';
import { readPersona, type PersonaRow } from './persona.js';

const TTL_MS = 10_000;
const MIN_LOGS_FOR_SUCCESS_RATE = 5;

export interface WordRef {
  lemma: string;
  translation: string;
}

export interface LearnerView {
  targetLang: string;
  dueWords: WordRef[];
  newWords: WordRef[];
  /** Count of currently-due user_vocabulary rows (not capped like dueWords). */
  dueBacklog: number;
  /** Fraction of grades >= Good over the last 20 review_logs, null if <5 logs. */
  recentSuccess: number | null;
  persona: PersonaRow & { merged: true };
}

const cache = new Map<string, { at: number; view: Promise<LearnerView> }>();

export async function readLearnerView(userId: string, lang: string): Promise<LearnerView> {
  const key = `${userId}:${lang}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.view;

  const view = buildLearnerView(userId, lang);
  cache.set(key, { at: Date.now(), view });
  // Don't cache a rejected promise — next call should retry the query.
  view.catch(() => cache.delete(key));
  return view;
}

async function buildLearnerView(userId: string, lang: string): Promise<LearnerView> {
  const now = new Date();

  const [dueRows, dueBacklogRow, startedVocab, recentLogs, persona] = await Promise.all([
    db.query.userVocabulary.findMany({
      where: and(eq(userVocabulary.userId, userId), lte(userVocabulary.due, now)),
      with: { lexeme: true },
      orderBy: [asc(userVocabulary.due)],
      limit: 20,
    }),
    db.select({ c: sql<number>`count(*)::int` })
      .from(userVocabulary)
      .where(and(eq(userVocabulary.userId, userId), lte(userVocabulary.due, now))),
    db.query.userVocabulary.findMany({
      where: eq(userVocabulary.userId, userId),
      columns: { lexemeId: true },
    }),
    db.query.reviewLogs.findMany({
      where: eq(reviewLogs.userId, userId),
      orderBy: [desc(reviewLogs.reviewDate)],
      limit: 20,
    }),
    readPersona(userId, lang),
  ]);

  const dueWords: WordRef[] = dueRows
    .filter((v) => v.lexeme?.language === lang && !isPlaceholderLexeme(v.lexeme))
    .slice(0, 5)
    .map((v) => ({ lemma: v.lexeme!.lemma, translation: v.lexeme!.translation }));

  const startedLexemeIds = new Set(startedVocab.map((v) => v.lexemeId));
  const newWordCandidates = await db.query.lexemes.findMany({
    where: eq(lexemes.language, lang),
    orderBy: [asc(lexemes.frequencyRank)],
    limit: 30,
  });
  const newWords: WordRef[] = newWordCandidates
    .filter((l) => !startedLexemeIds.has(l.id) && !isPlaceholderLexeme(l))
    .slice(0, 3)
    .map((l) => ({ lemma: l.lemma, translation: l.translation }));

  const dueBacklog = dueBacklogRow[0]?.c ?? 0;
  const recentSuccess = recentLogs.length >= MIN_LOGS_FOR_SUCCESS_RATE
    ? recentLogs.filter((r) => r.grade >= 3).length / recentLogs.length
    : null;

  return { targetLang: lang, dueWords, newWords, dueBacklog, recentSuccess, persona };
}

/**
 * A lexeme created by findOrCreateTargetEquiv's native-substitution
 * placeholder path (supervisor-functions.ts) — stores the learner's
 * native-language word under the target language, with a promise to
 * "overwrite when the actual target word is learned" that nothing in the
 * codebase actually does. Confirmed live: ~half of a test account's
 * "Portuguese" vocabulary was these placeholders (e.g. lemma "this" stored
 * as language 'pt'), surfacing as real target vocabulary in scaffolding
 * lines and skewing level inference. The signature — lemma equals its own
 * nativeLemma link — is exact and safe: a real lexeme only sets nativeLemma
 * when linking to a *different* native word.
 */
function isPlaceholderLexeme(l: { lemma: string; nativeLemma: string | null } | null | undefined): boolean {
  return !!l && l.nativeLemma !== null && l.nativeLemma === l.lemma;
}

export function formatWordList(words: WordRef[]): string {
  return words.map((w) => `${w.lemma} (${w.translation})`).join(', ');
}

/**
 * Drop the cached view for a user+language. Call this right after writing
 * something readLearnerView reads (e.g. writePersona) so the next prompt
 * build sees it immediately instead of waiting out the TTL.
 */
export function invalidateLearnerView(userId: string, lang: string): void {
  cache.delete(`${userId}:${lang}`);
}
