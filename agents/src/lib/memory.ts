/**
 * Discourse memory writes — see
 * docs/superpowers/specs/2026-07-06-curriculum-design.md §7.
 *
 * Phase M: record-only. Nothing reads these tables yet — canonical-tag
 * mapping (ruleText → grammar_rules.id via embeddings) and the planner
 * tools that query this data land later, once the planner moves to a
 * cloud model. Writing now means the data is already accumulating by
 * then. Both writers are fire-and-forget: a failure here must never
 * affect the live conversation loop (same fire-and-forget convention as
 * runProcessor's callers in tutor-event-driven.ts).
 */

import { db } from '../db/index.js';
import { utterances, errorObservations } from '../db/schema.js';
import { embedText } from './embedding.js';

export interface StructuredErrorInput {
  lemma: string;
  grammarRule?: { rule: string; example: string };
}

/**
 * Record one user turn. Embeds the transcript for future utterance search
 * (§8's search_utterances tool) — best-effort, an empty vector on failure
 * still leaves a usable row for exact/analysis-based queries.
 */
export async function recordUtterance(params: {
  userId: string;
  sessionId: string;
  turnSeq: number;
  language: string;
  transcript: string;
  analysis?: unknown;
}): Promise<string | null> {
  const { userId, sessionId, turnSeq, language, transcript, analysis } = params;
  if (!transcript?.trim()) return null;

  try {
    const embedding = await embedText(transcript);
    const [inserted] = await db.insert(utterances).values({
      userId,
      sessionId,
      turnSeq,
      language,
      transcript,
      analysis: analysis !== undefined ? JSON.stringify(analysis) : null,
      embedding: embedding.length > 0 ? embedding : null,
    }).returning({ id: utterances.id });
    return inserted?.id ?? null;
  } catch (err) {
    console.warn('[Memory] recordUtterance failed:', String(err).slice(0, 150));
    return null;
  }
}

/**
 * Record structured errors from one processor run against the utterance
 * they occurred in. ruleId (canonical grammar_rules mapping) is left null
 * — that mapping is a later addition (§7); writing ruleText now means the
 * backfill has real data to map once it lands.
 */
export async function recordErrorObservations(params: {
  userId: string;
  language: string;
  utteranceId: string | null;
  errors: StructuredErrorInput[];
}): Promise<void> {
  const { userId, language, utteranceId, errors } = params;
  if (errors.length === 0) return;

  try {
    await db.insert(errorObservations).values(
      errors
        .filter((e) => e.grammarRule?.rule)
        .map((e) => ({
          userId,
          language,
          ruleText: e.grammarRule!.rule,
          snippet: e.grammarRule!.example ?? null,
          utteranceId,
        })),
    );
  } catch (err) {
    console.warn('[Memory] recordErrorObservations failed:', String(err).slice(0, 150));
  }
}
