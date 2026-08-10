/**
 * Instrumentation for the core learning loop.
 *
 * The system's whole value is a feedback loop, and until now the loop had no
 * readout: a learner whose frontier had latched into 'consolidate' simply
 * stopped receiving new vocabulary, with no error, no failed request and no
 * metric. Nearly half of all user+language pairs were in that state before
 * anyone looked.
 *
 * Classification goes through computeFrontierBudget — the same function the
 * prompt builder calls — rather than re-deriving the thresholds here. A
 * report that maintains its own copy of the rules eventually disagrees with
 * the system it is reporting on, which is the failure this file exists to
 * catch.
 */

import { computeFrontierBudget, type FrontierState } from './frontier.js';

/** One learner, in one language, at one moment. */
export interface LoopSample {
  userId: string;
  language: string;
  /** Currently-due rows for this user in this language. */
  dueBacklog: number;
  /** Rolling grade success, or null when there are too few logs to judge. */
  recentSuccess: number | null;
}

export interface LoopReadout {
  /** How many user+language pairs the sample covers. */
  pairs: number;
  byState: Record<FrontierState, number>;
  /** Share of pairs receiving no new vocabulary at all, as a percentage. */
  throttledPct: number;
  medianBacklog: number;
  p90Backlog: number;
}

/** Nearest-rank percentile. Returns 0 for an empty set rather than NaN. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function summarizeLearningLoop(samples: LoopSample[]): LoopReadout {
  const byState: Record<FrontierState, number> = { consolidate: 0, balance: 0, expand: 0 };

  for (const s of samples) {
    const { state } = computeFrontierBudget(s.dueBacklog, s.recentSuccess);
    byState[state] += 1;
  }

  const backlogs = samples.map((s) => s.dueBacklog).sort((a, b) => a - b);
  const pairs = samples.length;

  return {
    pairs,
    byState,
    // 'consolidate' is exactly the state whose newWordBudget is 0.
    throttledPct: pairs === 0 ? 0 : Math.round((byState.consolidate / pairs) * 1000) / 10,
    medianBacklog: percentile(backlogs, 50),
    p90Backlog: percentile(backlogs, 90),
  };
}
