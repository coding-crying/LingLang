// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export interface EvaluationSample {
  caseId: string;
  expected: string;
  actual: string | null;
  expectedGrade: number | null;
  actualGrade: number | null;
  status: string;
  elapsedMs: number;
}

export interface EvaluationCertification {
  certified: boolean;
  capabilities: string[];
  reason: string;
  repeats: number;
  summary: ReturnType<typeof summarizeEvaluation>;
}

/**
 * Decide whether a completed diagnostic run is safe to register as an
 * authority profile. This is intentionally stricter than merely producing
 * valid JSON: the full fixture set must be repeated, and no false independent
 * recall/failure may be credited.
 */
export function certifyEvaluation(rows: EvaluationSample[]): EvaluationCertification {
  const summary = summarizeEvaluation(rows);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.caseId, (counts.get(row.caseId) ?? 0) + 1);
  const repeats = counts.size ? Math.min(...counts.values()) : 0;
  const completeFixtureSet = counts.size === 12 && repeats >= 3 && rows.length >= 36;
  const safe =
    completeFixtureSet &&
    summary.falseRecallCredits === 0 &&
    summary.falseFailures === 0 &&
    summary.missedRecall === 0 &&
    summary.rejectedOrErrors === 0 &&
    summary.exactMatches / summary.total >= 0.9;
  return {
    certified: safe,
    capabilities: safe ? ['production', 'assistance'] : [],
    reason: safe
      ? 'Repeated diagnostic suite passed without unsafe independent-evidence credits'
      : completeFixtureSet
        ? 'Diagnostic suite did not meet the no-false-credit, no-error authority gate'
        : 'Full 12-case diagnostic suite must run at least 3 times before authority registration',
    repeats,
    summary,
  };
}

export function summarizeEvaluation(rows: EvaluationSample[]) {
  const outcomes = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = outcomes.get(r.caseId) ?? new Set<string>();
    set.add(JSON.stringify([r.status, r.actual, r.actualGrade]));
    outcomes.set(r.caseId, set);
  }
  const latency = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
  return {
    total: rows.length,
    exactMatches: rows.filter((r) => r.status === 'accepted' && r.actual === r.expected).length,
    falseRecallCredits: rows.filter((r) => r.expectedGrade !== 3 && r.actualGrade === 3).length,
    falseFailures: rows.filter((r) => r.expectedGrade !== 1 && r.actualGrade === 1).length,
    missedRecall: rows.filter((r) => r.expectedGrade === 3 && r.actualGrade !== 3).length,
    rejectedOrErrors: rows.filter((r) => r.status !== 'accepted').length,
    disagreeingCases: [...outcomes.values()].filter((s) => s.size > 1).length,
    latencyP50Ms: latency[Math.floor(latency.length * 0.5)] ?? null,
    latencyP95Ms: latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))] ?? null,
    certified: false,
    limitation:
      'Synthetic diagnostic fixtures; not human-reviewed certification or delayed-recall validation',
  };
}
