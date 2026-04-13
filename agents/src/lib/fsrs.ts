/**
 * FSRS (Free Spaced Repetition Scheduler) implementation for LingLang.
 *
 * Maps voice conversation performance to FSRS grades (1-4) and applies
 * the FSRS algorithm to compute new stability/difficulty/due date.
 *
 * Based on the FSRS v5 algorithm parameters from open-spaced-repetition.
 */

// ============================================================================
// TYPES
// ============================================================================

export type FSRSGrade = 1 | 2 | 3 | 4;
// 1 = Again (failed), 2 = Hard, 3 = Good, 4 = Easy

export type FSRSState = 0 | 1 | 2 | 3;
// 0 = New, 1 = Learning, 2 = Review, 3 = Relearning

export interface FSRSParams {
  /** Requested retention (0-1), default 0.9 */
  requestRetention: number;
  /** Maximum interval in days */
  maximumInterval: number;
  /** W18: Initial stability for Again (new card) */
  w0: number;
  /** W1: Initial stability for Hard */
  w1: number;
  /** W2: Initial stability for Good */
  w2: number;
  /** W3: Initial stability for Easy */
  w3: number;
  /** W4: Initial difficulty for Again */
  w4: number;
  /** W5: Initial difficulty shift per grade */
  w5: number;
  /** W6: Mean reversion to D0(4) */
  w6: number;
  /** W7: Difficulty decay */
  w7: number;
  /** W8: Hard stability multiplier */
  w8: number;
  /** W9: Easy stability multiplier */
  w9: number;
  /** W10: Stability penalty on lapse */
  w10: number;
  /** W11: Stability growth base */
  w11: number;
  /** W12: Stability growth factor */
  w12: number;
  /** W13: Retrievability decay */
  w13: number;
  /** W14: Elapsed days multiplier */
  w14: number;
  /** W15: Learning step (days) */
  w15: number;
  /** W16: Relearning step (days) */
  w16: number;
  /** W17: Hard interval modifier */
  w17: number;
}

export interface FSRSCard {
  state: FSRSState;
  difficulty: number;
  stability: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  due: Date;
  lastReview: Date | null;
}

export interface FSRSResult {
  state: FSRSState;
  difficulty: number;
  stability: number;
  scheduledDays: number;
  due: Date;
  reps: number;
  lapses: number;
}

// ============================================================================
// DEFAULT FSRS PARAMETERS (v5, tuned for language learning)
// ============================================================================

export const DEFAULT_FSRS_PARAMS: FSRSParams = {
  requestRetention: 0.9,
  maximumInterval: 365,
  // Default w values from FSRS v5 research
  w0: 0.4872, w1: 0.5818, w2: 1.3017, w3: 3.4296,
  w4: 1.2145, w5: 0.0492, w6: 1.0526, w7: 0.0335,
  w8: 1.0166, w9: 1.2074, w10: 0.0, w11: 1.6073,
  w12: 0.1477, w13: 1.0048, w14: 0.0, w15: 0.2987,
  w16: 0.3907, w17: 0.6354,
};

// ============================================================================
// CORE FSRS ALGORITHM
// ============================================================================

/**
 * Apply an FSRS review to a card and return the updated state.
 */
export function fsrsReview(card: FSRSCard, grade: FSRSGrade, params: FSRSParams = DEFAULT_FSRS_PARAMS): FSRSResult {
  const now = new Date();

  if (card.state === 0) {
    // New card — initialize from parameters
    return initNewCard(grade, now, params);
  }

  const elapsedDays = card.elapsedDays || 0;
  const retrievability = Math.pow(1 + (elapsedDays / (card.stability || 0.01)) * params.w13, -1);

  let newDifficulty = constrainDifficulty(
    card.difficulty - params.w5 * (grade - 3)
  );
  // Mean reversion toward D0(4)
  newDifficulty = constrainDifficulty(
    (1 - params.w6) * params.w4 + params.w6 * newDifficulty
  );

  let newStability: number;
  let newState: FSRSState;
  let newLapses = card.lapses;

  if (grade === 1) {
    // Again — lapse
    newState = card.state === 2 ? 3 : card.state === 1 ? 1 : 1;
    newStability = Math.max(0.01, card.stability * Math.pow(params.w10, card.lapses + 1));
    // Apply relearning step
    const step = newState === 3 ? params.w16 : params.w15;
    newLapses = card.lapses + 1;
    return {
      state: newState,
      difficulty: newDifficulty,
      stability: newStability,
      scheduledDays: Math.round(step),
      due: new Date(now.getTime() + step * 86400000),
      reps: card.reps + 1,
      lapses: newLapses,
    };
  }

  // Successful review — calculate new stability
  if (card.state === 1 || card.state === 3) {
    // Learning / Relearning → graduating
    const initStab = grade <= 2 ? params.w1 : grade === 3 ? params.w2 : params.w3;
    newStability = initStab;
  } else {
    // Review — apply stability formula
    const hardPenalty = grade === 2 ? params.w8 : 1;
    const easyBonus = grade === 4 ? params.w9 : 1;
    newStability = card.stability * (
      1 + Math.exp(params.w11) *
      (11 - newDifficulty) *
      Math.pow(card.stability, -params.w12) *
      (Math.exp((1 - retrievability) * params.w13) - 1) *
      hardPenalty * easyBonus
    );
  }

  newState = 2; // Review
  const interval = nextInterval(newStability, params);
  const scheduledDays = Math.round(interval);

  return {
    state: newState,
    difficulty: newDifficulty,
    stability: newStability,
    scheduledDays,
    due: new Date(now.getTime() + scheduledDays * 86400000),
    reps: card.reps + 1,
    lapses: card.lapses,
  };
}

function initNewCard(grade: FSRSGrade, now: Date, params: FSRSParams): FSRSResult {
  const initialStability: Record<number, number> = { 1: params.w0, 2: params.w1, 3: params.w2, 4: params.w3 };
  const stability = initialStability[grade]!;
  const difficulty = constrainDifficulty(params.w4 - params.w5 * (grade - 3));

  if (grade === 1) {
    // Again on new — still learning, short step
    return {
      state: 1,
      difficulty,
      stability: Math.max(0.01, stability),
      scheduledDays: 1,
      due: new Date(now.getTime() + params.w15 * 86400000),
      reps: 1,
      lapses: 0,
    };
  }

  // Hard/Good/Easy on new card — graduate to review
  const interval = nextInterval(stability, params);
  return {
    state: 2,
    difficulty,
    stability,
    scheduledDays: Math.round(interval),
    due: new Date(now.getTime() + Math.round(interval) * 86400000),
    reps: 1,
    lapses: 0,
  };
}

function nextInterval(stability: number, params: FSRSParams): number {
  const interval = stability * (1 / params.requestRetention - 1) / params.w13;
  return Math.min(Math.max(1, interval), params.maximumInterval);
}

function constrainDifficulty(d: number): number {
  return Math.max(1, Math.min(10, d));
}

// ============================================================================
// VOICE-TO-FSRS GRADE MAPPING
// ============================================================================

export interface VoicePerformance {
  /** How the user performed: correct_use, wrong_use, recall_fail, scaffolded */
  performance: 'correct_use' | 'wrong_use' | 'recall_fail' | 'scaffolded';
  /** Escalation level used (1=natural, 2=nudge, 3=direct correction) */
  escalationLevel?: number;
  /** Pronunciation confidence from ASR (0-1) */
  pronunciationScore?: number;
  /** Milliseconds to respond / latency */
  durationMs?: number;
  /** Whether the word was used completely unprompted */
  unprompted?: boolean;
}

/**
 * Map voice conversation performance to FSRS grade (1-4).
 *
 * Grade 1 (Again): Completely wrong, or failed even after direct correction.
 * Grade 2 (Hard):  Got it but only after nudge, or with poor pronunciation/long latency.
 * Grade 3 (Good):  Natural use at escalation level 1 — the default pass.
 * Grade 4 (Easy):  Unprompted use with fluent pronunciation.
 */
export function voiceToGrade(perf: VoicePerformance): FSRSGrade {
  switch (perf.performance) {
    case 'recall_fail':
    case 'wrong_use':
      if (perf.escalationLevel === 3) return 1; // Failed even with direct correction
      return 1;

    case 'scaffolded':
      return 2; // Correct but prompted — lower stability boost than independent use

    case 'correct_use':
    default:
      // correct_use is the default; also handles any legacy 'not_assessed' labels
      if (perf.unprompted && (perf.pronunciationScore ?? 1) > 0.8) return 4; // Easy
      if (perf.escalationLevel === 2) return 2; // Needed a nudge
      if ((perf.pronunciationScore ?? 1) < 0.5) return 2; // Poor pronunciation
      if (perf.durationMs && perf.durationMs > 3000) return 2; // Long latency
      return 3; // Good — the default
  }
}

/**
 * Convert a legacy Leitner box level (0-5) to approximate FSRS initial state.
 * Used only during migration.
 */
export function leitnerToFSRS(level: number): { state: FSRSState; stability: number; difficulty: number; scheduledDays: number } {
  switch (level) {
    case 0: return { state: 0, stability: 0, difficulty: 0, scheduledDays: 0 };
    case 1: return { state: 1, stability: 1, difficulty: 5, scheduledDays: 1 };
    case 2: return { state: 2, stability: 3.5, difficulty: 4.5, scheduledDays: 3 };
    case 3: return { state: 2, stability: 7, difficulty: 4, scheduledDays: 7 };
    case 4: return { state: 2, stability: 15, difficulty: 3.5, scheduledDays: 15 };
    case 5: return { state: 2, stability: 30, difficulty: 3, scheduledDays: 30 };
    default: return { state: 0, stability: 0, difficulty: 0, scheduledDays: 0 };
  }
}