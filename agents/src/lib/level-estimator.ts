// Conservative proficiency estimation from validated, independent learner evidence.
//
// This module intentionally does not inspect SRS state, review count, session
// count, tutor exposure, or vocabulary-row count. Those are useful product
// signals, but they do not establish independent language ability.
import type { Level } from './level-inference.js';

export interface IndependentEvidenceRecord {
  eventId: string;
  sessionId: string;
  lemma: string;
  grade: 1 | 3;
}

export interface IndependentEvidenceSummary {
  acceptedEvents: number;
  independentSessions: number;
  uniqueLexemes: number;
  successes: number;
  failures: number;
  observations: number;
  successRate: number;
  quality: number;
}

export interface ConservativeEstimate {
  level: Level;
  score: number;
  confidence: number;
  basis: 'no_independent_evidence' | 'independent_a1' | 'independent_a2' | 'legacy_low_level_prior';
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Summarize only already-authorized projections. De-duplicate observations
 * within an event/lemma so one observer cannot inflate breadth or recall.
 */
export function summarizeIndependentEvidence(
  records: readonly IndependentEvidenceRecord[],
): IndependentEvidenceSummary {
  const unique = new Map<string, IndependentEvidenceRecord>();
  for (const record of records) {
    const lemma = record.lemma.normalize('NFKC').trim().toLocaleLowerCase();
    if (!lemma) continue;
    const key = `${record.eventId}\u0000${lemma}`;
    const previous = unique.get(key);
    // Preserve a failure if duplicate assessment data disagrees; optimistic
    // merging would turn uncertainty into mastery.
    if (!previous || (previous.grade === 3 && record.grade === 1)) {
      unique.set(key, { ...record, lemma });
    }
  }

  const values = [...unique.values()];
  const successes = values.filter((r) => r.grade === 3).length;
  const failures = values.filter((r) => r.grade === 1).length;
  const attempts = successes + failures;
  const sessions = new Set(values.map((r) => r.sessionId));
  const lexemes = new Set(values.map((r) => r.lemma));
  const successRate = attempts ? successes / attempts : 0;

  // Confidence is evidence quality, not database volume. It requires breadth,
  // independent sessions, repeated successful production, and consistency.
  const breadth = clamp01(lexemes.size / 8);
  const repetition = clamp01(successes / 12);
  const sessionBreadth = clamp01(sessions.size / 4);
  const consistency = attempts >= 3 ? clamp01((successRate - 0.5) / 0.5) : 0;
  const quality = 0.25 * breadth + 0.35 * repetition + 0.2 * sessionBreadth + 0.2 * consistency;

  return {
    acceptedEvents: new Set(values.map((r) => r.eventId)).size,
    independentSessions: sessions.size,
    uniqueLexemes: lexemes.size,
    successes,
    failures,
    observations: values.length,
    successRate,
    quality,
  };
}

/**
 * Lexical evidence can safely establish beginner progress, but cannot prove
 * B1/B2/C-level communicative competence. Higher levels require a future
 * multi-dimensional assessment contract (grammar, comprehension, discourse,
 * and independent production), not more repetitions of the same word.
 */
export function estimateFromIndependentEvidence(
  summary: IndependentEvidenceSummary,
): ConservativeEstimate {
  const a2 =
    summary.successes >= 12 &&
    summary.uniqueLexemes >= 8 &&
    summary.independentSessions >= 4 &&
    summary.successRate >= 0.7;
  const a1 = summary.successes >= 3 && summary.uniqueLexemes >= 2;

  // No validated production evidence is not A1 evidence. Keep the operating
  // level below A1 until the learner demonstrates even basic comprehension.
  const level: Level = a2 ? 'a2' : a1 ? 'a1' : 'pre_a1';
  const basis = a2 ? 'independent_a2' : a1 ? 'independent_a1' : 'no_independent_evidence';

  // Keep a numeric diagnostic for existing logs/API consumers, but never use
  // it as a CEFR threshold. 0..100 represents evidence strength only.
  const score = Math.round(summary.quality * 1000) / 10;
  const confidenceCeiling = 0.2 + 0.65 * clamp01(summary.independentSessions / 4);
  return {
    level,
    score,
    // Confidence is additionally bounded by independent session breadth: one
    // marathon session cannot become certainty through repetition.
    confidence: Math.min(0.85, confidenceCeiling, Math.round(summary.quality * 100) / 100),
    basis,
  };
}
