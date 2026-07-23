/**
 * Curriculum coverage, advancement, and placement — see
 * docs/superpowers/specs/2026-07-06-curriculum-design.md §5/§6.
 *
 * Advancement is deterministic, never LLM-judged — same lesson as the
 * dictionary gate and maxLexemes ceiling: level inference was already
 * poisoned once by processor over-grading, so "is this chunk mastered" is
 * arithmetic over FSRS state, not a model's opinion. The planner may only
 * *suggest* skip/revisit; the write path here is the sole authority.
 *
 * Thresholds live here, nowhere else (same convention as frontier.ts).
 */

import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chunkLexemes, contentChunks, userVocabulary, userContentProgress } from '../db/schema.js';
import { invalidateLearnerView, readLearnerView } from './learner-view.js';
import { ensureChunkDistilled } from './ingest.js';

// A word counts as "known" once it has ever graduated past first-pass
// learning (FSRS state >= 2 — Review or a since-lapsed Relearning). Per
// fsrs.ts's initNewCard, a *single* non-"Again" grade on a brand-new word
// graduates it straight to state 2 — so this bar is not slow at the
// word level. There used to also be an `reps >= 2` fallback; removed —
// `reps` increments on every review including failures, so two wrong
// attempts could count as "known." state>=2 is the only real signal.
const FSRS_REVIEW_STATE = 2;

// Full-checklist bar: this many words (salience-weighted) individually
// graduated. Kept high because it's the "ideal, thorough" path — but it
// is not the ONLY path to advance (see evaluateAdvancement below). Fully
// gating chapter advancement on every word in a list being organically
// elicited in conversation is unrealistically rigid for a chat-paced
// tutor; a learner who's doing well overall shouldn't be trapped on one
// chunk by two stubborn words the conversation just hasn't touched yet.
export const ADVANCE_COVERAGE_THRESHOLD = 0.7;

// Adaptive/soft path: mirrors the frontier mechanic's own philosophy
// (lib/frontier.ts — trend-gated, not a checklist). If the learner is
// doing well OVERALL (global recentSuccess, not just this chunk) and the
// chunk has had a reasonable amount of real time to be worked through,
// advance even on partial coverage rather than waiting out the full list.
const SOFT_ADVANCE_MIN_COVERAGE = 0.35;
const SOFT_ADVANCE_MIN_SUCCESS = 0.8;
const SOFT_ADVANCE_MIN_DAYS_ACTIVE = 2;

export interface ChunkLexemeRef {
  lexemeId: string;
  salience: number;
}

export interface VocabStatus {
  state: number;
  reps: number;
}

/**
 * Salience-weighted fraction of a chunk's vocab the learner already knows.
 * Pure function — no DB access — so it's cheaply testable and reusable by
 * both the live coverage hook and the offline placement pass (§6).
 */
export function computeCoverage(
  chunkVocab: ChunkLexemeRef[],
  known: Map<string, VocabStatus>,
): number {
  if (chunkVocab.length === 0) return 1; // an empty chunk is trivially covered
  let totalWeight = 0;
  let coveredWeight = 0;
  for (const { lexemeId, salience } of chunkVocab) {
    const weight = Math.max(0.01, salience);
    totalWeight += weight;
    const status = known.get(lexemeId);
    if (status && status.state >= FSRS_REVIEW_STATE) {
      coveredWeight += weight;
    }
  }
  return totalWeight > 0 ? coveredWeight / totalWeight : 1;
}

export function isChunkMastered(coverage: number): boolean {
  return coverage >= ADVANCE_COVERAGE_THRESHOLD;
}

export type AdvanceReason = 'full_coverage' | 'adaptive' | null;

/**
 * Two ways to earn advancement: the full checklist, or the adaptive/soft
 * path when the learner is clearly doing fine overall and the chunk has
 * had real time to be worked through. Trend-gated like the frontier
 * mechanic, not a fixed list — see the constants above for why.
 */
export function evaluateAdvancement(
  coverage: number,
  recentSuccess: number | null,
  daysActive: number,
): AdvanceReason {
  if (isChunkMastered(coverage)) return 'full_coverage';
  if (
    coverage >= SOFT_ADVANCE_MIN_COVERAGE &&
    recentSuccess !== null &&
    recentSuccess >= SOFT_ADVANCE_MIN_SUCCESS &&
    daysActive >= SOFT_ADVANCE_MIN_DAYS_ACTIVE
  ) {
    return 'adaptive';
  }
  return null;
}

/** Fetch a chunk's linked vocab, for coverage computation. */
async function getChunkVocab(chunkId: string): Promise<ChunkLexemeRef[]> {
  const rows = await db.query.chunkLexemes.findMany({
    where: eq(chunkLexemes.chunkId, chunkId),
    columns: { lexemeId: true, salience: true },
  });
  return rows;
}

/** Fetch the learner's FSRS status for a specific set of lexemes. */
async function getKnownStatus(userId: string, lexemeIds: string[]): Promise<Map<string, VocabStatus>> {
  const known = new Map<string, VocabStatus>();
  if (lexemeIds.length === 0) return known;
  const rows = await db.query.userVocabulary.findMany({
    where: and(eq(userVocabulary.userId, userId), inArray(userVocabulary.lexemeId, lexemeIds)),
    columns: { lexemeId: true, state: true, reps: true },
  });
  for (const r of rows) known.set(r.lexemeId, { state: r.state, reps: r.reps });
  return known;
}

/**
 * Recompute one active chunk's coverage and, if the learner has crossed
 * the mastery threshold, advance them: mark this chunk done, activate the
 * next chunk in source order, and invalidate the learner view so the
 * frontier picks up the new chunk's vocab on the very next prompt build
 * (same "clearing the due queue mid-session" principle as §2 of the
 * adaptive-loop redesign).
 *
 * Call this from runProcessor's post-SRS-update hook — same place that
 * already invalidates the learner view for FSRS changes.
 *
 * Returns null if no chunk is active for this user (nothing to do).
 */
export async function recomputeActiveChunkCoverage(
  userId: string,
  targetLang: string,
): Promise<{ chunkId: string; coverage: number; advanced: boolean; reason: AdvanceReason } | null> {
  // Scope to sources in the current target language — a user studying
  // both Russian and Portuguese content shouldn't have a Portuguese
  // chunk's coverage recomputed by a Russian turn.
  const active = await db.query.userContentProgress.findFirst({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.status, 'active')),
    with: { chunk: { with: { source: true } } },
  });
  if (!active || active.chunk.source?.language !== targetLang) return null;

  const chunkVocab = await getChunkVocab(active.chunkId);
  const known = await getKnownStatus(userId, chunkVocab.map((v) => v.lexemeId));
  const coverage = computeCoverage(chunkVocab, known);

  await db.update(userContentProgress)
    .set({ coverage })
    .where(and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, active.chunkId)));

  const view = await readLearnerView(userId, targetLang);
  const daysActive = active.activatedAt
    ? (Date.now() - new Date(active.activatedAt).getTime()) / 86_400_000
    : 0;
  const reason = evaluateAdvancement(coverage, view.recentSuccess, daysActive);

  if (!reason) {
    return { chunkId: active.chunkId, coverage, advanced: false, reason: null };
  }

  await advanceChunk(userId, active.chunkId);
  invalidateLearnerView(userId, targetLang);
  return { chunkId: active.chunkId, coverage, advanced: true, reason };
}

/**
 * Explicit user override — "let's move on", "I already know this",
 * "skip ahead." No arithmetic check at all: if the learner asks to
 * advance, they advance. Same trust-the-user precedent as the existing
 * language_change/difficulty_adjustment triggers (tutor-event-driven.ts's
 * handleSupervisorTriggers) — a request to honor, not a teaching moment
 * to gate. Returns the chunk that was advanced, or null if none was active.
 */
export async function skipActiveChunk(userId: string, targetLang: string): Promise<string | null> {
  const active = await db.query.userContentProgress.findFirst({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.status, 'active')),
    with: { chunk: { with: { source: true } } },
  });
  if (!active || active.chunk.source?.language !== targetLang) return null;

  await advanceChunk(userId, active.chunkId);
  invalidateLearnerView(userId, targetLang);
  return active.chunkId;
}

/**
 * Mark `chunkId` done and activate the next chunk (by `ord`) in the same
 * source, if one exists and isn't already active/done. The sole write
 * path for chunk position — the planner's CURRENT: skip/revisit lines
 * (design doc §5) call this too, never mutate user_content_progress
 * directly.
 */
export async function advanceChunk(userId: string, chunkId: string): Promise<void> {
  const now = new Date();
  const chunk = await db.query.contentChunks.findFirst({ where: eq(contentChunks.id, chunkId) });
  if (!chunk) return;

  await db.update(userContentProgress)
    .set({ status: 'done', completedAt: now })
    .where(and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, chunkId)));

  const next = await db.query.contentChunks.findFirst({
    where: and(eq(contentChunks.sourceId, chunk.sourceId), sql`${contentChunks.ord} > ${chunk.ord}`),
    orderBy: [asc(contentChunks.ord)],
  });
  if (!next) return;

  const existing = await db.query.userContentProgress.findFirst({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, next.id)),
  });
  if (existing?.status === 'active' || existing?.status === 'done') return;

  // Best-effort: distill before activating so the very next prompt build
  // has a real card, not a null one — but never let a distillation hiccup
  // block advancing the pointer (ensureChunkDistilled swallows its own
  // errors; this call is itself already off the live-turn response path,
  // called fire-and-forget from tutor-event-driven.ts).
  await ensureChunkDistilled(next.id);

  if (existing) {
    await db.update(userContentProgress)
      .set({ status: 'active', activatedAt: now })
      .where(and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, next.id)));
  } else {
    await db.insert(userContentProgress).values({
      userId,
      chunkId: next.id,
      status: 'active',
      activatedAt: now,
    });
  }
}

export interface PlacementResult {
  chunkId: string;
  ord: number;
  coverage: number;
  status: 'done' | 'active' | 'queued';
}

/**
 * The knowledge diff (design doc §6): given a freshly-ingested source and
 * a learner, compute per-chunk coverage against what they already know and
 * place them at the first not-yet-mastered chunk — on arithmetic, not
 * vibes. Chunks already at/above threshold are marked done at placement
 * time; the rest queue in order behind the one active chunk.
 *
 * Idempotent: re-running for a user who already has progress rows for this
 * source only touches chunks that don't have a row yet (existing
 * active/done state is left alone — this is a placement pass, not a reset).
 */
export async function placeUserInSource(userId: string, sourceId: string): Promise<PlacementResult[]> {
  const chunks = await db.query.contentChunks.findMany({
    where: eq(contentChunks.sourceId, sourceId),
    orderBy: [asc(contentChunks.ord)],
  });
  if (chunks.length === 0) return [];

  const existingProgress = await db.query.userContentProgress.findMany({
    where: and(eq(userContentProgress.userId, userId), inArray(userContentProgress.chunkId, chunks.map((c) => c.id))),
  });
  const existingByChunk = new Map(existingProgress.map((p) => [p.chunkId, p]));

  // Retire any chunk still marked active in a DIFFERENT source — "active"
  // is meant to be a single pointer (readLearnerView's activeChunk query
  // does `findFirst` with no orderBy, so leaving two rows active makes
  // which one the planner sees nondeterministic). 'queued' rather than
  // 'done' — switching your reading isn't finishing it, it should still
  // be resumable from where you left off.
  const otherActive = await db.query.userContentProgress.findFirst({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.status, 'active')),
    with: { chunk: true },
  });
  if (otherActive && otherActive.chunk.sourceId !== sourceId) {
    await db.update(userContentProgress)
      .set({ status: 'queued' })
      .where(and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, otherActive.chunkId)));
  }

  const results: PlacementResult[] = [];
  let placedActive = existingProgress.some((p) => p.status === 'active');
  const now = new Date();

  for (const chunk of chunks) {
    const already = existingByChunk.get(chunk.id);
    if (already) {
      results.push({ chunkId: chunk.id, ord: chunk.ord, coverage: already.coverage, status: already.status as any });
      continue;
    }

    // Once the active chunk is found, stop distilling further ahead —
    // computing every remaining chunk's coverage (to see if it's ALSO
    // already mastered) would mean distilling the entire rest of the
    // source on first selection, which is exactly the up-front cost this
    // lazy design exists to avoid. Queue it plainly; its real coverage is
    // computed when the browser lists it or when advanceChunk/
    // activateChunk actually reaches it (see listSourceChunks/
    // ensureChunkDistilled).
    if (placedActive) {
      await db.insert(userContentProgress).values({
        userId, chunkId: chunk.id, status: 'queued', coverage: 0,
      }).onConflictDoNothing();
      results.push({ chunkId: chunk.id, ord: chunk.ord, coverage: 0, status: 'queued' });
      continue;
    }

    // Still walking toward the first not-yet-mastered chunk — this DOES
    // require distilling each chunk along the way (coverage can't be
    // known without vocab), but that walk is bounded by how much the
    // learner already knows, not by total book length.
    await ensureChunkDistilled(chunk.id);
    const chunkVocab = await getChunkVocab(chunk.id);
    const known = await getKnownStatus(userId, chunkVocab.map((v) => v.lexemeId));
    const coverage = computeCoverage(chunkVocab, known);
    const mastered = isChunkMastered(coverage);

    let status: 'done' | 'active' | 'queued';
    if (mastered) {
      status = 'done';
    } else {
      status = 'active';
      placedActive = true;
    }

    await db.insert(userContentProgress).values({
      userId,
      chunkId: chunk.id,
      status,
      coverage,
      activatedAt: status === 'active' ? now : null,
      completedAt: status === 'done' ? now : null,
    }).onConflictDoNothing();

    results.push({ chunkId: chunk.id, ord: chunk.ord, coverage, status });
  }

  return results;
}

// ── Manual navigation ────────────────────────────────────────────────────
//
// placeUserInSource above is the automatic path (coverage-based placement
// on first selecting a source). This section lets a learner override that
// and jump straight to a specific chunk — "I remember this part of the
// video, go there" — rather than only ever being able to move forward one
// chunk at a time via skipActiveChunk.

export interface ChunkNavItem {
  chunkId: string;
  ord: number;
  title: string;
  /** Null until ensureChunkDistilled has run for this chunk — most chunks
   *  in a long, partly-unread source stay in this state indefinitely. */
  summary: string | null;
  startSec: number | null;
  endSec: number | null;
  /** Computed live for any already-distilled chunk, even one the learner
   *  has never visited — this is what lets the picker show "82% known" on
   *  a chunk with no progress row at all, so a learner can tell which
   *  parts they can probably skim vs. which are actually new material,
   *  before jumping anywhere. Null (not 0, not the vacuous "1" an empty
   *  vocab list would compute) for a chunk that hasn't been distilled
   *  yet — there's no vocab to check coverage against, so "unknown" is
   *  the honest answer, not "100% known" or "0% known".
   */
  coverage: number | null;
  distilled: boolean;
  status: 'active' | 'done' | 'queued' | 'not_started';
}

/**
 * Every chunk in a source, in order, each annotated with the learner's
 * live vocab coverage (same computeCoverage arithmetic as placement/
 * advancement — never a separate "estimate") and their progress status if
 * any. Powers the chunk-browser sheet's "jump to any part" list.
 */
export async function listSourceChunks(userId: string, sourceId: string): Promise<ChunkNavItem[]> {
  const chunks = await db.query.contentChunks.findMany({
    where: eq(contentChunks.sourceId, sourceId),
    orderBy: [asc(contentChunks.ord)],
  });
  if (chunks.length === 0) return [];

  const chunkIds = chunks.map((c) => c.id);
  const vocabRows = await db.query.chunkLexemes.findMany({
    where: inArray(chunkLexemes.chunkId, chunkIds),
    columns: { chunkId: true, lexemeId: true, salience: true },
  });
  const vocabByChunk = new Map<string, ChunkLexemeRef[]>();
  for (const v of vocabRows) {
    const list = vocabByChunk.get(v.chunkId) ?? [];
    list.push({ lexemeId: v.lexemeId, salience: v.salience });
    vocabByChunk.set(v.chunkId, list);
  }
  const known = await getKnownStatus(userId, [...new Set(vocabRows.map((v) => v.lexemeId))]);

  const progressRows = await db.query.userContentProgress.findMany({
    where: and(eq(userContentProgress.userId, userId), inArray(userContentProgress.chunkId, chunkIds)),
  });
  const progressByChunk = new Map(progressRows.map((p) => [p.chunkId, p]));

  return chunks.map((c) => {
    const progress = progressByChunk.get(c.id);
    const distilled = c.distilledAt !== null;
    // A visited chunk's stored coverage can be stale between sessions
    // (only recomputeActiveChunkCoverage refreshes the ACTIVE row, mid-
    // session) — recomputing here instead of trusting the stored value
    // keeps the picker honest for queued/done chunks too, at the cost of
    // one coverage pass per chunk (cheap: pure in-memory arithmetic once
    // `known` is fetched, no extra query per chunk). Only meaningful once
    // distilled — an undistilled chunk has no chunk_lexemes rows at all,
    // and computeCoverage([], known) reads an empty vocab list as
    // trivially 100% covered, which would be a lie here (not "known",
    // just "not analyzed yet").
    const coverage = distilled ? computeCoverage(vocabByChunk.get(c.id) ?? [], known) : null;
    return {
      chunkId: c.id,
      ord: c.ord,
      title: c.title,
      summary: c.summary,
      startSec: c.startSec,
      endSec: c.endSec,
      coverage,
      distilled,
      status: (progress?.status as ChunkNavItem['status']) ?? 'not_started',
    };
  });
}

/** Demotes every OTHER chunk currently active for this user to 'queued' —
 *  the single-active-pointer invariant (see placeUserInSource's comment),
 *  generalized to a specific target chunk rather than a whole source, since
 *  a manual jump can land on a chunk in the source you're already on. */
async function retireActiveChunksExcept(userId: string, keepChunkId: string): Promise<void> {
  const actives = await db.query.userContentProgress.findMany({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.status, 'active')),
  });
  for (const row of actives) {
    if (row.chunkId === keepChunkId) continue;
    await db.update(userContentProgress)
      .set({ status: 'queued' })
      .where(and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, row.chunkId)));
  }
}

/**
 * Explicit "go here" — jumps the learner's active chunk to exactly the one
 * requested, regardless of coverage or reading order. Unlike
 * placeUserInSource (which never overwrites existing progress) this always
 * re-activates the target, even a previously 'done' one — same trust-the-
 * user precedent as skipActiveChunk. Returns null if the chunk doesn't
 * exist.
 */
export async function activateChunk(userId: string, chunkId: string): Promise<{ coverage: number } | null> {
  const chunk = await db.query.contentChunks.findFirst({
    where: eq(contentChunks.id, chunkId),
    with: { source: true },
  });
  if (!chunk) return null;

  await retireActiveChunksExcept(userId, chunkId);

  // An explicit jump — the learner picked this chunk by name, so
  // distilling it (unlike the "don't look ahead" restraint in
  // placeUserInSource) is exactly the material they're about to use.
  await ensureChunkDistilled(chunkId);

  const chunkVocab = await getChunkVocab(chunkId);
  const known = await getKnownStatus(userId, chunkVocab.map((v) => v.lexemeId));
  const coverage = computeCoverage(chunkVocab, known);
  const now = new Date();

  const existing = await db.query.userContentProgress.findFirst({
    where: and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, chunkId)),
  });
  if (existing) {
    await db.update(userContentProgress)
      .set({ status: 'active', coverage, activatedAt: now, completedAt: null })
      .where(and(eq(userContentProgress.userId, userId), eq(userContentProgress.chunkId, chunkId)));
  } else {
    await db.insert(userContentProgress).values({ userId, chunkId, status: 'active', coverage, activatedAt: now });
  }

  if (chunk.source?.language) invalidateLearnerView(userId, chunk.source.language);
  return { coverage };
}
