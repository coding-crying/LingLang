/**
 * Reconciliation: turning a completed content profile into placement and
 * SRS state — see docs/superpowers/specs/2026-08-08-content-provenance-design.md §4.
 *
 * This is where the three pieces meet. content-profile.ts collected what
 * the learner said; prior-knowledge.ts knows how to turn "studied on date
 * D" into an honest FSRS card; curriculum.ts already knows how to place a
 * learner in a source given their vocabulary. Reconciliation seeds the
 * vocabulary so that the placement curriculum.ts would have done anyway
 * comes out right — rather than adding a second, parallel placement path
 * that could disagree with the first.
 *
 * That ordering is the important design decision. It would be simpler to
 * just write `status='done'` on the chunks behind the learner and skip the
 * seeding. It would also be a lie: coverage would still read 0%, the
 * frontier would still offer lesson-1 vocabulary as brand new, and every
 * downstream consumer of user_vocabulary would still believe the learner
 * knows nothing. Seeding the words IS the feature; marking chunks done is
 * the cosmetic part.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  chunkLexemes,
  contentChunks,
  contentSources,
  userContentProgress,
  userSourceProfiles,
} from '../db/schema.js';
import { ensureChunkDistilled } from './ingest.js';
import type { ContentKind } from './ingest.js';
import { placeUserInSource } from './curriculum.js';
import { invalidateLearnerView } from './learner-view.js';
import {
  seedCardFromPriorStudy,
  writeSeededCards,
  type StudyIntensity,
} from './prior-knowledge.js';
import {
  evaluateProfile,
  resolveKnownThroughOrd,
  resolveLastStudiedAt,
  type ContentIntent,
  type ProfileAnswers,
  type ProfileQuestion,
  type ProfileStatus,
} from './content-profile.js';

/**
 * Assumed days between consecutive chunks, used to spread study dates
 * backwards from the last one the learner completed.
 *
 * This matters more than it looks. A learner on day 25 of Pimsleur did
 * lesson 1 twenty-five days ago and lesson 25 today — dating all 25 to the
 * same moment would either resurface everything at once (if dated old) or
 * nothing at all (if dated recent), and the whole point of capturing "when
 * did you last study it" is to get that gradient right. With the gradient,
 * early lessons come back for review and recent ones stay quiet, which is
 * exactly what a returning learner should experience.
 *
 * The pace is an assumption, not a measurement — we ask for one date, not a
 * study log. It's chosen per kind from how the material is actually
 * consumed: audio courses are built around a one-lesson-a-day protocol,
 * textbook chapters take a few days each, and a video or article is one
 * sitting (0 = every chunk shares the same date).
 */
const PACE_DAYS_PER_CHUNK: Record<ContentKind, number> = {
  audio: 1,
  textbook: 3,
  text: 0,
  youtube: 0,
  movie: 0,
};

/** Nothing gets dated further back than this, however many chunks there
 *  are — a 400-chunk textbook at 3 days/chunk would otherwise reach back
 *  three years and seed its early chapters as effectively unknown, which
 *  says more about the pace assumption than about the learner. */
const MAX_BACKDATE_DAYS = 540;

/** Distillations in flight at once. Each is a cloud LLM call; a learner
 *  who says "I finished this textbook" can trigger hundreds. Bounded so
 *  reconciliation is slow rather than a thundering herd — it runs in the
 *  background and nothing waits on it. */
const DISTILL_CONCURRENCY = 4;

export interface ReconcileResult {
  status: 'reconciled' | 'skipped';
  reason?: string;
  intent?: ContentIntent;
  /** Chunks marked done because the learner had already been through them. */
  chunksMarkedDone: number;
  /** Distinct lexemes given seeded FSRS cards. */
  lexemesSeeded: number;
  /** Of those, how many assert the word is known (the rest were too decayed
   *  to claim — see prior-knowledge.ts's retention floor). */
  lexemesClaimedKnown: number;
  /** Left alone because the learner already has real conversation history. */
  lexemesSkippedObserved: number;
  /** Chunk the learner ends up on, if any. */
  activeChunkOrd: number | null;
}

const EMPTY: Omit<ReconcileResult, 'status' | 'reason'> = {
  chunksMarkedDone: 0,
  lexemesSeeded: 0,
  lexemesClaimedKnown: 0,
  lexemesSkippedObserved: 0,
  activeChunkOrd: null,
};

/**
 * Apply a learner's profile for one source.
 *
 * Idempotent and safe to re-run: seeding refreshes only previously-seeded
 * rows, and placement (placeUserInSource) only fills in chunks with no
 * progress row. Re-running after a corrected answer ("actually it was 15
 * lessons, not 25") therefore moves the learner back without destroying
 * anything they've earned since.
 *
 * Never throws for ordinary reasons — it runs detached from the request
 * that triggered it, so a failure here must not take down anything else.
 */
export async function reconcileSourceProgress(userId: string, sourceId: string): Promise<ReconcileResult> {
  const profile = await db.query.userSourceProfiles.findFirst({
    where: and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.sourceId, sourceId)),
  });
  if (!profile) return { status: 'skipped', reason: 'no_profile', ...EMPTY };

  const source = await db.query.contentSources.findFirst({ where: eq(contentSources.id, sourceId) });
  if (!source) return { status: 'skipped', reason: 'no_source', ...EMPTY };
  if (source.status !== 'ready') {
    // Ingestion is still running (or failed). The profile stays valid and
    // gets reconciled when ingestion finishes — see onSourceReady.
    return { status: 'skipped', reason: `source_${source.status}`, ...EMPTY };
  }

  const kind = source.kind as ContentKind;
  const answers = (profile.answers ?? {}) as ProfileAnswers;
  const evaluation = evaluateProfile(kind, answers);
  if (evaluation.status !== 'complete' && profile.status !== 'skipped') {
    return { status: 'skipped', reason: 'profile_incomplete', ...EMPTY };
  }

  const intent = (profile.intent as ContentIntent) ?? 'study';

  const chunks = await db.query.contentChunks.findMany({
    where: eq(contentChunks.sourceId, sourceId),
    orderBy: [asc(contentChunks.ord)],
    columns: { id: true, ord: true },
  });
  if (chunks.length === 0) return { status: 'skipped', reason: 'no_chunks', ...EMPTY };

  // ── Aspirational content seeds nothing ──
  // "I want to get into this" is a statement about the future. Seeding
  // vocabulary from it would tell the frontier the learner knows words
  // they've never seen — the exact inversion of what they said. Placement
  // at the start is all that's needed; the source's own vocabulary becomes
  // new-word targets through the ordinary chunk_lexemes path.
  if (intent === 'aspire') {
    const placement = await placeUserInSource(userId, sourceId);
    await markReconciled(userId, sourceId);
    invalidateLearnerView(userId, source.language);
    return {
      status: 'reconciled',
      intent,
      ...EMPTY,
      activeChunkOrd: placement.find((p) => p.status === 'active')?.ord ?? null,
    };
  }

  // ── Studied content: how much of it is behind them ──
  const maxOrd = chunks[chunks.length - 1]!.ord;
  const knownThroughOrd = intent === 'known'
    ? maxOrd
    : resolveKnownThroughOrd(answers.known_through, chunks.length);

  // "Start over" means don't claim the chunks — but the words were still
  // learned once, so they're still seeded. The learner walks the material
  // again with review-strength vocabulary rather than cold, which is what
  // going back over something you half-know actually feels like.
  const restarting = answers.continue_or_restart === 'restart';

  if (knownThroughOrd === null) {
    const placement = await placeUserInSource(userId, sourceId);
    await markReconciled(userId, sourceId);
    invalidateLearnerView(userId, source.language);
    return {
      status: 'reconciled',
      intent,
      ...EMPTY,
      activeChunkOrd: placement.find((p) => p.status === 'active')?.ord ?? null,
    };
  }

  const intensity = (profile.intensity as StudyIntensity) ?? 'studied';
  const lastStudiedAt = profile.lastStudiedAt
    ?? resolveLastStudiedAt(answers.last_studied)
    // No recency answer at all (a 'skipped' profile). Treating it as today
    // would be the optimistic read; a month is the conservative one, and
    // conservative here means "surfaces for review sooner", which is the
    // cheap direction to be wrong in.
    ?? new Date(Date.now() - 30 * 86_400_000);

  const studied = chunks.filter((c) => c.ord <= knownThroughOrd);
  const pace = PACE_DAYS_PER_CHUNK[kind] ?? 0;

  // Distill only what we're about to seed. Undistilled chunks have no
  // chunk_lexemes rows, so seeding without this would silently seed
  // nothing — and worse, computeCoverage reads an empty vocab list as
  // trivially 100% covered (the reason distilledAt exists at all).
  await runBounded(studied, DISTILL_CONCURRENCY, async (chunk) => {
    try {
      await ensureChunkDistilled(chunk.id);
    } catch (err) {
      // One bad chunk shouldn't abandon the other 24. It simply seeds
      // nothing and stays queued rather than done.
      console.warn(`[Reconcile] Distillation failed for chunk ${chunk.id}:`, err);
    }
  });

  const totals = { seeded: 0, claimedKnown: 0, skippedObserved: 0 };
  const completedChunkIds: string[] = [];
  const now = new Date();

  for (const chunk of studied) {
    const vocabRows = await db.query.chunkLexemes.findMany({
      where: eq(chunkLexemes.chunkId, chunk.id),
      columns: { lexemeId: true },
    });
    if (vocabRows.length === 0) continue; // undistilled or genuinely empty

    // Per-chunk date: the gradient described at PACE_DAYS_PER_CHUNK.
    const daysBack = Math.min((knownThroughOrd - chunk.ord) * pace, MAX_BACKDATE_DAYS);
    const studiedAt = new Date(lastStudiedAt.getTime() - daysBack * 86_400_000);
    const card = seedCardFromPriorStudy(studiedAt, intensity, now);

    const result = await writeSeededCards(userId, vocabRows.map((v) => v.lexemeId), card);
    totals.seeded += result.seeded;
    totals.claimedKnown += result.claimedKnown;
    totals.skippedObserved += result.skippedObserved;

    if (!restarting) completedChunkIds.push(chunk.id);
  }

  // Mark the studied chunks done BEFORE placing — placeUserInSource only
  // fills chunks with no progress row, so these rows are what stop it
  // walking (and re-distilling) the material the learner already did.
  if (completedChunkIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < completedChunkIds.length; i += CHUNK) {
      const batch = completedChunkIds.slice(i, i + CHUNK);
      await db.insert(userContentProgress)
        .values(batch.map((chunkId) => ({
          userId, chunkId, status: 'done' as const, coverage: 1, completedAt: now,
        })))
        .onConflictDoNothing();
    }
  }

  const placement = await placeUserInSource(userId, sourceId);
  await markReconciled(userId, sourceId);
  invalidateLearnerView(userId, source.language);

  return {
    status: 'reconciled',
    intent,
    chunksMarkedDone: completedChunkIds.length,
    lexemesSeeded: totals.seeded,
    lexemesClaimedKnown: totals.claimedKnown,
    lexemesSkippedObserved: totals.skippedObserved,
    activeChunkOrd: placement.find((p) => p.status === 'active')?.ord ?? null,
  };
}

export interface ApplyAnswersResult {
  status: ProfileStatus;
  answers: ProfileAnswers;
  /** Required question ids still outstanding. */
  missing: string[];
  /** The next question to ask, or null when the profile is finished. */
  next: ProfileQuestion | null;
  /** True when this call completed the profile and kicked off reconciliation. */
  reconcileStarted: boolean;
}

/**
 * Merge answers into a learner's profile for one source and, once nothing
 * required is outstanding, start reconciliation.
 *
 * Shared by the HTTP route and the voice tools deliberately: the spoken
 * flow and the typed flow have to converge on identical state, and the
 * easiest way for them to diverge is two code paths that each decide for
 * themselves what "complete" means.
 *
 * Merges rather than replaces — voice answers arrive one or two per turn.
 * Reconciliation is fired detached (it distills every chunk behind the
 * learner, which for a finished textbook is hundreds of LLM calls) so
 * neither a request nor a conversation turn ever waits on it.
 */
export async function applyProfileAnswers(
  userId: string,
  sourceId: string,
  incoming: ProfileAnswers,
  opts: { skip?: boolean } = {},
): Promise<ApplyAnswersResult> {
  const source = await db.query.contentSources.findFirst({ where: eq(contentSources.id, sourceId) });
  if (!source) throw new Error(`No such source: ${sourceId}`);

  const existing = await db.query.userSourceProfiles.findFirst({
    where: and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.sourceId, sourceId)),
  });

  const answers: ProfileAnswers = { ...((existing?.answers ?? {}) as ProfileAnswers), ...incoming };
  const evaluation = evaluateProfile(source.kind as ContentKind, answers);
  const status: ProfileStatus = opts.skip ? 'skipped' : evaluation.status;

  const values = {
    intent: (answers.intent as ContentIntent) ?? (existing?.intent as ContentIntent) ?? 'study',
    status,
    answers,
    lastStudiedAt: resolveLastStudiedAt(answers.last_studied) ?? existing?.lastStudiedAt ?? null,
    intensity: (answers.intensity as StudyIntensity) ?? (existing?.intensity as StudyIntensity) ?? null,
    profiledAt: status === 'needed' ? null : new Date(),
    // Any change re-opens reconciliation, so correcting an answer
    // ("actually 15 lessons, not 25") actually takes effect.
    reconciledAt: null,
  };

  if (existing) {
    await db.update(userSourceProfiles).set(values)
      .where(and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.sourceId, sourceId)));
  } else {
    await db.insert(userSourceProfiles).values({ userId, sourceId, ...values });
  }

  let reconcileStarted = false;
  if (status !== 'needed' && source.status === 'ready') {
    reconcileStarted = true;
    void reconcileSourceProgress(userId, sourceId).then(
      (result) => console.log(`[Reconcile] ${userId}/${sourceId}: ${result.status}${result.reason ? ` (${result.reason})` : ''} -- ${result.lexemesSeeded} lexemes seeded (${result.lexemesClaimedKnown} as known), ${result.chunksMarkedDone} chunks done, active ord ${result.activeChunkOrd}`),
      (err) => console.error(`[Reconcile] Failed for ${userId}/${sourceId}:`, err),
    );
  }

  return { status, answers, missing: evaluation.missing, next: evaluation.next, reconcileStarted };
}

async function markReconciled(userId: string, sourceId: string): Promise<void> {
  await db.update(userSourceProfiles)
    .set({ reconciledAt: new Date() })
    .where(and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.sourceId, sourceId)));
}

/**
 * Ingestion and profiling race: a learner can finish answering while the
 * PDF is still being chunked, and reconciliation needs chunks to exist.
 * Whichever finishes second calls this, so the profile is applied exactly
 * once either way.
 */
export async function onSourceReady(sourceId: string): Promise<void> {
  const pending = await db.query.userSourceProfiles.findMany({
    where: and(eq(userSourceProfiles.sourceId, sourceId), inArray(userSourceProfiles.status, ['complete', 'skipped'])),
  });
  for (const profile of pending) {
    if (profile.reconciledAt) continue;
    try {
      const result = await reconcileSourceProgress(profile.userId, sourceId);
      console.log(`[Reconcile] ${profile.userId}/${sourceId}: ${result.status}${result.reason ? ` (${result.reason})` : ''} — ${result.lexemesSeeded} lexemes seeded, ${result.chunksMarkedDone} chunks done`);
    } catch (err) {
      console.error(`[Reconcile] Failed for ${profile.userId}/${sourceId}:`, err);
    }
  }
}

/** Minimal bounded-concurrency map. No dependency worth adding for this. */
async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
