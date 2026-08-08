/**
 * Voice tools for content provenance — see
 * docs/superpowers/specs/2026-08-08-content-provenance-design.md §5.
 *
 * A learner who has just added a textbook needs to answer four questions
 * before the system can place them in it. A form asking those four
 * questions is a chore. A tutor asking "how far did you get with it?" is
 * just a tutor talking — and it gets better answers, because "I think I
 * stopped somewhere around chapter nine, ages ago, and honestly I skimmed
 * most of it" is a sentence people say out loud and would never type into
 * three dropdowns.
 *
 * So the conversation is a first-class input path for the profile, not a
 * fallback. Both tools here go through the same applyProfileAnswers as the
 * HTTP route (lib/content-reconcile.ts) — one definition of what
 * "complete" means, one reconciliation trigger, no drift between what the
 * learner said out loud and what the library page thinks they said.
 *
 * The parsing is deliberately lenient: record_content_answer takes the
 * learner's words verbatim and lets normalizeSpokenAnswers extract
 * whatever they actually addressed. The tutor is not asked to structure
 * the answer, because making a conversational model fill a schema mid-turn
 * is how you get invented values.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { llm } from '@livekit/agents';
import { db } from '../db/index.js';
import { contentSources, userSourceProfiles, contentChunks } from '../db/schema.js';
import {
  evaluateProfile,
  normalizeSpokenAnswers,
  questionsFor,
  type ContentIntent,
  type ContentKind,
  type ProfileAnswers,
} from '../lib/content-profile.js';
import { applyProfileAnswers } from '../lib/content-reconcile.js';

export interface PendingProfileItem {
  sourceId: string;
  title: string;
  kind: string;
  /** Chunks the source was split into — context for "how far did you get". */
  chunkCount: number;
  /** The single next question, phrased the way a tutor would say it. */
  ask: string;
  questionId: string;
  remaining: number;
}

/**
 * Sources this learner has added but not yet described.
 *
 * Only 'ready' sources: asking "how far did you get in it?" about a PDF
 * that is still being chunked invites an answer we can't act on, and the
 * chunk count the learner's answer gets measured against doesn't exist yet.
 */
export async function listPendingProfilesQuery(
  userId: string,
  language?: string,
): Promise<PendingProfileItem[]> {
  const profiles = await db.query.userSourceProfiles.findMany({
    where: and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.status, 'needed')),
    orderBy: [desc(userSourceProfiles.createdAt)],
  });
  if (profiles.length === 0) return [];

  const sources = await db.query.contentSources.findMany({
    where: inArray(contentSources.id, profiles.map((p) => p.sourceId)),
  });
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const items: PendingProfileItem[] = [];
  for (const profile of profiles) {
    const source = sourceById.get(profile.sourceId);
    if (!source || source.status !== 'ready') continue;
    if (language && source.language !== language) continue;

    const answers = (profile.answers ?? {}) as ProfileAnswers;
    const evaluation = evaluateProfile(source.kind as ContentKind, answers);
    if (!evaluation.next) continue;

    const chunkRows = await db.select({ id: contentChunks.id })
      .from(contentChunks)
      .where(eq(contentChunks.sourceId, source.id));

    items.push({
      sourceId: source.id,
      title: source.title,
      kind: source.kind,
      chunkCount: chunkRows.length,
      ask: evaluation.next.spoken,
      questionId: evaluation.next.id,
      remaining: evaluation.missing.length,
    });
  }
  return items;
}

export const listContentNeedingInfoTool = llm.tool({
  name: 'list_content_needing_info',
  description:
    "Check whether the learner has added any study material (a textbook, an audio course, a video) that you haven't asked them about yet. Each item comes back with ONE question to ask, already phrased for speech. Call this when there's a natural opening — the start of a session, or a lull — not in the middle of an exercise. If it returns nothing, say nothing about it. Until these questions are answered the material can't be used in lessons, so it's worth asking, but ask conversationally, one question at a time, and drop it if the learner isn't interested.",
  parameters: z.object({}),
  execute: async (_args: Record<string, never>, opts: any) => {
    const userId = (opts as any).ctx?.userData?.userId;
    if (!userId) return { pending: [] };
    const language = (opts as any).ctx?.userData?.targetLanguage;
    const pending = await listPendingProfilesQuery(userId, language);
    return {
      count: pending.length,
      pending: pending.map((p) => ({
        sourceId: p.sourceId,
        title: p.title,
        kind: p.kind,
        sections: p.chunkCount,
        ask: p.ask,
        questionsRemaining: p.remaining,
      })),
    };
  },
});

export const recordContentAnswerTool = llm.tool({
  name: 'record_content_answer',
  description:
    "Record what the learner just told you about a piece of their study material. Pass their reply in their OWN WORDS, verbatim — do not tidy it up, convert it, or turn it into categories; the system parses it. One reply can answer several questions at once ('I did the first twenty lessons, finished about a month ago, drilled them properly') and that's fine. Returns the next question to ask, or tells you the material is ready to use. If the learner says they don't want to answer, pass skip: true instead.",
  parameters: z.object({
    sourceId: z.string().describe('The sourceId from list_content_needing_info'),
    reply: z.string().describe("The learner's answer, word for word as they said it"),
    skip: z.boolean().optional().describe("True if the learner declined to answer — don't ask again"),
  }),
  execute: async (args: { sourceId: string; reply: string; skip?: boolean }, opts: any) => {
    const userId = (opts as any).ctx?.userData?.userId;
    if (!userId) return { ok: false, note: 'No learner in context.' };

    const source = await db.query.contentSources.findFirst({
      where: eq(contentSources.id, args.sourceId),
    });
    if (!source) return { ok: false, note: 'No such material — check list_content_needing_info again.' };
    // Owned-or-shared, same rule the HTTP routes enforce. A tool argument
    // is model-supplied and reaches here without passing through auth.
    if (source.ownerId && source.ownerId !== userId) {
      return { ok: false, note: "That material isn't theirs." };
    }

    if (args.skip) {
      const result = await applyProfileAnswers(userId, args.sourceId, {}, { skip: true });
      return {
        ok: true,
        done: true,
        note: `Fine — "${source.title}" is set up on best guesses. Move on, and don't raise it again.`,
        reconciling: result.reconcileStarted,
      };
    }

    const profile = await db.query.userSourceProfiles.findFirst({
      where: and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.sourceId, args.sourceId)),
    });
    const answers = (profile?.answers ?? {}) as ProfileAnswers;
    const evaluation = evaluateProfile(source.kind as ContentKind, answers);

    const chunkRows = await db.select({ id: contentChunks.id })
      .from(contentChunks)
      .where(eq(contentChunks.sourceId, args.sourceId));

    // Parse against every still-applicable question, not just the one that
    // was asked — learners routinely answer three at once, and throwing
    // the extras away would mean asking questions they already answered.
    const pending = questionsFor(source.kind as ContentKind, (answers.intent as ContentIntent) ?? null)
      .filter((q) => evaluation.missing.includes(q.id) || !(q.id in answers));

    const parsed = await normalizeSpokenAnswers(args.reply, pending, chunkRows.length);
    if (Object.keys(parsed).length === 0) {
      return {
        ok: false,
        note: "Couldn't tell what they meant — ask once more, plainly, then let it go.",
        ask: evaluation.next?.spoken ?? null,
      };
    }

    const result = await applyProfileAnswers(userId, args.sourceId, parsed);
    if (result.next) {
      return { ok: true, done: false, recorded: parsed, ask: result.next.spoken };
    }
    return {
      ok: true,
      done: true,
      recorded: parsed,
      reconciling: result.reconcileStarted,
      note: `"${source.title}" is set up. It'll start showing up in your lessons — don't announce that, just carry on.`,
    };
  },
});

/** Spread into voice.Agent({ tools }) alongside dbTools. */
export const contentTools = [
  listContentNeedingInfoTool,
  recordContentAnswerTool,
] as const;
