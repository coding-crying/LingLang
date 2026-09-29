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

import { eq, ne, or, and, asc, desc, lte, lt, gt, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, reviewLogs, userContentProgress, chunkLexemes, contentChunks, contentSources } from '../db/schema.js';
import { readPersona, type PersonaRow } from './persona.js';

const TTL_MS = 10_000;
const MIN_LOGS_FOR_SUCCESS_RATE = 5;

export interface WordRef {
  lemma: string;
  translation: string;
}

/** How many due words the prompt's scaffolding line carries. */
export const DUE_WORD_SLOTS = 5;

/**
 * Slots held for earned reviews before unverified claims may take any.
 *
 * Seeded claims are backdated and therefore overdue by construction, so a
 * single due-date ordering puts hundreds of them ahead of every genuinely
 * earned review. Reserving a floor keeps real reviews from being starved,
 * while leaving room for claims to keep surfacing and getting verified.
 */
export const EARNED_SLOT_FLOOR = 3;

/**
 * Fill the due-word window from two pools, each already in due order.
 *
 * Three passes: earned up to the floor, then claims, then top up with any
 * remaining earned. The final pass matters — with no claims available the
 * window must still fill completely from earned reviews.
 */
export function selectDueWords(
  earned: WordRef[],
  claims: WordRef[],
  slots: number = DUE_WORD_SLOTS,
): WordRef[] {
  const earnedTaken = Math.min(EARNED_SLOT_FLOOR, slots, earned.length);
  const picked = earned.slice(0, earnedTaken);
  picked.push(...claims.slice(0, slots - picked.length));
  picked.push(...earned.slice(earnedTaken, earnedTaken + (slots - picked.length)));
  return picked;
}

export interface LearnerView {
  targetLang: string;
  dueWords: WordRef[];
  newWords: WordRef[];
  /**
   * Words the learner just asked for by reaching for the native-language
   * equivalent mid-sentence (native_substitution — see
   * supervisor-functions.ts's findOrCreateTargetEquiv). These get an FSRS
   * "Again" grade on creation, which schedules them ~7 hours out (state 1
   * Learning) — invisible to dueWords until then, and once due they'd be
   * framed as "already know" scaffolding alongside real review words,
   * which is wrong: the learner has never successfully produced them.
   * Surfaced here immediately, correctly framed as "they just asked for
   * this," bypassing the due-date gate entirely — the moment of demand is
   * the highest-value moment to hand the word over, not 7 hours later.
   */
  demandWords: WordRef[];
  /** Count of currently-due user_vocabulary rows (not capped like dueWords). */
  dueBacklog: number;
  /** Fraction of grades >= Good over the last 20 review_logs, null if <5 logs. */
  recentSuccess: number | null;
  persona: PersonaRow & { merged: true };
  /**
   * The learner's active content_chunks row, if any — see design doc §4.
   * `card` renders in the conversation prompt's CORE (stable per chunk, so
   * it prefix-caches). `newWords` above already prefers this chunk's
   * vocab (by salience) over global frequency rank when active — this
   * field is purely for the card text itself and planner-facing context.
   */
  activeChunk: {
    chunkId: string;
    sourceId: string;
    sourceTitle: string;
    chunkTitle: string;
    /** Null if ensureChunkDistilled hasn't completed for this chunk yet
     *  (best-effort awaited wherever a chunk becomes active — see
     *  curriculum.ts — but not guaranteed if distillation itself failed). */
    card: string | null;
    coverage: number;
    /** Planner-facing (not shown to the learner) — distinct from `card`.
     *  Same nullability as `card`. */
    summary: string | null;
    ord: number;
    totalChunks: number;
    /** The next chunk's own distillation is NOT pre-warmed just for this
     *  preview (only the chunk that actually BECOMES active gets that) —
     *  summary is commonly null here for an unvisited chunk. */
    nextChunk: { title: string; summary: string | null } | null;
  } | null;
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

  // Scope every due-word fetch to the session language IN SQL. Filtering
  // after `limit: 20` silently returns nothing for a multi-language learner
  // whose other language happens to have the 20 soonest-due words — which is
  // how a learner with 137 due Russian words was being shown none of them.
  const inSessionLanguage = inArray(
    userVocabulary.lexemeId,
    db.select({ id: lexemes.id }).from(lexemes).where(eq(lexemes.language, lang)),
  );

  const [dueRows, dueBacklogRow, claimRows, startedVocab, recentLogs, persona, demandRows] = await Promise.all([
    // Earned reviews: anything the learner has actually been graded on.
    // Fetched separately from claims because a learner with hundreds of
    // overdue seeded rows would otherwise have every one of these 20 slots
    // taken by claims, leaving nothing to reserve earned slots from.
    db.query.userVocabulary.findMany({
      where: and(
        eq(userVocabulary.userId, userId),
        lte(userVocabulary.due, now),
        inSessionLanguage,
        or(ne(userVocabulary.origin, 'seeded'), gt(userVocabulary.reps, 0)),
      ),
      with: { lexeme: true },
      orderBy: [asc(userVocabulary.due)],
      limit: 20,
    }),
    // The backlog is REVIEW PRESSURE, and only earned cards create it. An
    // unreviewed seeded row is a claim about prior knowledge, not a debt the
    // learner owes — counting claims here drove the frontier straight into
    // 'consolidate' and stopped the curriculum dead. Language-scoped, so a
    // Russian session isn't throttled by a Portuguese queue.
    db.select({ c: sql<number>`count(*)::int` })
      .from(userVocabulary)
      .innerJoin(lexemes, eq(lexemes.id, userVocabulary.lexemeId))
      .where(and(
        eq(userVocabulary.userId, userId),
        lte(userVocabulary.due, now),
        eq(lexemes.language, lang),
        or(ne(userVocabulary.origin, 'seeded'), gt(userVocabulary.reps, 0)),
      )),
    // Unverified claims: seeded, never graded. Excluded from the backlog
    // above but still surfaced as scaffolding, because being USED in
    // conversation is how a claim gets confirmed or falsified.
    db.query.userVocabulary.findMany({
      where: and(
        eq(userVocabulary.userId, userId),
        lte(userVocabulary.due, now),
        inSessionLanguage,
        eq(userVocabulary.origin, 'seeded'),
        eq(userVocabulary.reps, 0),
      ),
      with: { lexeme: true },
      orderBy: [asc(userVocabulary.due)],
      limit: 20,
    }),
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
    // Substitution-demand words — not yet due (state 1, ~7h out per FSRS's
    // "Again" step), so the dueRows query above misses them entirely.
    // Not gated on `due` at all: the moment of demand is the point.
    db.query.userVocabulary.findMany({
      where: and(
        eq(userVocabulary.userId, userId),
        // Language filtered in SQL. Without it the 10 slots are filled by
        // whichever language has the highest substitution counts — for a
        // multi-language learner that is usually an older language, and the
        // JS filter below then drops them all, leaving no demand words at
        // all. Same shape of bug as getDueReviewsQuery had.
        inSessionLanguage,
        lt(userVocabulary.state, 2),
        gt(userVocabulary.nativeSubstitutionCount, 0),
      ),
      with: { lexeme: true },
      orderBy: [desc(userVocabulary.nativeSubstitutionCount)],
      limit: 10,
    }),
  ]);

  const toWordRefs = (rows: typeof dueRows): WordRef[] =>
    rows
      .filter((v) => v.lexeme?.language === lang && !isPlaceholderLexeme(v.lexeme))
      .map((v) => ({ lemma: v.lexeme!.lemma, translation: v.lexeme!.translation }));

  const dueWords: WordRef[] = selectDueWords(toWordRefs(dueRows), toWordRefs(claimRows));

  const dueLexemeIds = new Set(dueRows.map((v) => v.lexemeId));
  const demandWords: WordRef[] = demandRows
    .filter((v) => v.lexeme?.language === lang && !isPlaceholderLexeme(v.lexeme) && !dueLexemeIds.has(v.lexemeId))
    .slice(0, 3)
    .map((v) => ({ lemma: v.lexeme!.lemma, translation: v.lexeme!.translation }));

  const startedLexemeIds = new Set(startedVocab.map((v) => v.lexemeId));

  // Active chunk (design doc §4): when the learner has one, new-word
  // candidates prefer ITS vocab (by salience) over global frequency rank
  // — the curriculum is what's driving new-word selection now, not the
  // global list. Falls back to frequency rank when the chunk's vocab is
  // exhausted (all started) or there's no active chunk at all.
  const activeProgress = await db.query.userContentProgress.findFirst({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.status, 'active')),
    with: { chunk: { with: { source: true } } },
  });
  const hasMatchingActiveChunk = activeProgress && activeProgress.chunk.source?.language === lang;

  let newWords: WordRef[] = [];
  if (hasMatchingActiveChunk) {
    const chunkVocabRows = await db.query.chunkLexemes.findMany({
      where: eq(chunkLexemes.chunkId, activeProgress!.chunkId),
      with: { lexeme: true },
      orderBy: [desc(chunkLexemes.salience)],
    });
    newWords = chunkVocabRows
      .filter((v) => !startedLexemeIds.has(v.lexemeId) && v.lexeme && !isPlaceholderLexeme(v.lexeme))
      .slice(0, 3)
      .map((v) => ({ lemma: v.lexeme!.lemma, translation: v.lexeme!.translation }));
  }
  if (newWords.length < 3) {
    const newWordCandidates = await db.query.lexemes.findMany({
      where: eq(lexemes.language, lang),
      orderBy: [asc(lexemes.frequencyRank)],
      limit: 30,
    });
    const seenLemmas = new Set(newWords.map((w) => w.lemma));
    const fallback = newWordCandidates
      .filter((l) => !startedLexemeIds.has(l.id) && !isPlaceholderLexeme(l) && !seenLemmas.has(l.lemma))
      .slice(0, 3 - newWords.length)
      .map((l) => ({ lemma: l.lemma, translation: l.translation }));
    newWords = [...newWords, ...fallback];
  }

  let activeChunk: LearnerView['activeChunk'] = null;
  if (hasMatchingActiveChunk) {
    const siblings = await db.query.contentChunks.findMany({
      where: eq(contentChunks.sourceId, activeProgress!.chunk.sourceId),
      orderBy: [asc(contentChunks.ord)],
      columns: { id: true, ord: true, title: true, summary: true },
    });
    const myIdx = siblings.findIndex((s) => s.id === activeProgress!.chunkId);
    const next = myIdx >= 0 && myIdx + 1 < siblings.length ? siblings[myIdx + 1] : null;

    activeChunk = {
      chunkId: activeProgress!.chunkId,
      sourceId: activeProgress!.chunk.sourceId,
      sourceTitle: activeProgress!.chunk.source!.title,
      chunkTitle: activeProgress!.chunk.title,
      card: activeProgress!.cardOverride || activeProgress!.chunk.card,
      coverage: activeProgress!.coverage,
      summary: activeProgress!.chunk.summary,
      ord: activeProgress!.chunk.ord,
      totalChunks: siblings.length,
      nextChunk: next ? { title: next.title, summary: next.summary } : null,
    };
  }

  const dueBacklog = dueBacklogRow[0]?.c ?? 0;
  const recentSuccess = recentLogs.length >= MIN_LOGS_FOR_SUCCESS_RATE
    ? recentLogs.filter((r) => r.grade >= 3).length / recentLogs.length
    : null;

  return { targetLang: lang, dueWords, newWords, demandWords, dueBacklog, recentSuccess, persona, activeChunk };
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
export function isPlaceholderLexeme(l: { lemma: string; nativeLemma: string | null } | null | undefined): boolean {
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
