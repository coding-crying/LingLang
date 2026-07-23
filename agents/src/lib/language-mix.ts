/**
 * Comprehensible-input controller — how much of the tutor's speech should
 * be in the target language vs the learner's native language.
 *
 * 2026-07-02: born from a live session where the tutor walled an A1
 * learner in full-paragraph Russian, complied for one turn when they
 * complained in English, then reverted. Nothing in the prompt stack said
 * anything about language mix, and (session-long lesson) standing prose
 * doesn't bind the conversation model anyway. So this is a feedback
 * controller: a level-derived target share, a per-reply measurement of
 * what the tutor actually spoke, and a tail line rebuilt every turn that
 * escalates with the measured number when the tutor overshoots.
 */

/** Target-language share of tutor speech by CEFR level. */
export function targetShareForLevel(level: string): number {
  switch ((level || '').toLowerCase()) {
    case 'pre_a1': return 0.15;
    case 'a1': return 0.25;
    case 'a2': return 0.4;
    case 'b1': return 0.6;
    case 'b2': return 0.8;
    default: return 0.9; // c1, c2, unknown-high
  }
}

/**
 * Cap for learners we have almost no grading evidence on (fewer than 5
 * review logs → recentSuccess is null). Even a self-reported A2 starts
 * mostly-native and earns immersion — knowing vocabulary and following
 * spoken sentences are different skills, and the cost of starting too
 * easy is one slightly slow session; the cost of starting too hard is
 * the foreign-language wall.
 */
export const NEW_LEARNER_SHARE_CAP = 0.3;

/** How much one distress notch removes from the target share. */
const THROTTLE_STEP = 0.15;
export const MAX_THROTTLE_NOTCHES = 2;
const MIN_SHARE = 0.1;

export interface MixTargetInputs {
  userLevel: string;
  /** null when the learner has <5 review logs — triggers the new-learner cap. */
  recentSuccess: number | null;
  /** Session-local distress notches (0..MAX_THROTTLE_NOTCHES). */
  throttleNotches: number;
}

export function computeTargetShare(inputs: MixTargetInputs): number {
  let share = targetShareForLevel(inputs.userLevel);
  if (inputs.recentSuccess === null) share = Math.min(share, NEW_LEARNER_SHARE_CAP);
  share -= inputs.throttleNotches * THROTTLE_STEP;
  return Math.max(MIN_SHARE, share);
}

// Script ranges for languages whose writing system is distinct from the
// (Latin-script) native language. Latin-script targets (es, pt, fr, de…)
// can't be measured this cheaply — measureTargetShare returns null and
// the controller degrades to directive-only (no escalation).
// Exported 2026-07-10: lexical-lint.ts reuses these to score only
// target-script tokens (an all-English reply used to read as 100% OOV).
export const SCRIPT_RANGES: Record<string, RegExp> = {
  th: /[฀-๿]/,
  ru: /[Ѐ-ӿ]/,
  uk: /[Ѐ-ӿ]/,
  bg: /[Ѐ-ӿ]/,
  sr: /[Ѐ-ӿ]/,
  el: /[Ͱ-Ͽ]/,
  he: /[֐-׿]/,
  ar: /[؀-ۿ]/,
  hi: /[ऀ-ॿ]/,
  ko: /[가-힯ᄀ-ᇿ]/,
  ja: /[぀-ヿ一-鿿]/,
  zh: /[一-鿿]/,
};

const LATIN = /[A-Za-z]/;
const MIN_LETTERS_FOR_MEASUREMENT = 10;

/**
 * Fraction of a tutor reply written in the target language's script,
 * or null when unmeasurable (Latin-script target, or too little text).
 */
export function measureTargetShare(text: string, targetLangCode: string): number | null {
  const script = SCRIPT_RANGES[(targetLangCode || '').toLowerCase()];
  if (!script) return null;
  let target = 0;
  let native = 0;
  for (const ch of text) {
    if (script.test(ch)) target++;
    else if (LATIN.test(ch)) native++;
  }
  const total = target + native;
  if (total < MIN_LETTERS_FOR_MEASUREMENT) return null;
  return target / total;
}

/**
 * Find the first letter in `text` that belongs to neither the target
 * language's script, nor Latin (the native-English side), nor
 * digits/punctuation. Returns that char, or null if the text is clean.
 *
 * 2026-07-10: added as the deterministic guard behind the STT node's
 * transcription — the ASR prompt names both allowed languages, but the
 * model emitted actual THAI SCRIPT for a Mandarin utterance anyway
 * (live, zh session: "เรียนศิษย์บูชา"). A transcript in a script the
 * session can't contain is a hallucination by definition — the caller
 * rejects it and falls back to placeholder-only behavior, which is
 * strictly safer than anchoring the conversation on hallucinated Thai.
 */
export function findForeignScriptChar(text: string, targetIso: string): string | null {
  const target = SCRIPT_RANGES[(targetIso || '').toLowerCase()];
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;                    // not a letter — fine
    if (/[a-zA-ZÀ-ɏ]/.test(ch)) continue;      // Latin (+ extensions) — native side
    if (target?.test(ch)) continue;                       // target script — fine
    return ch;                                            // letter in some OTHER script
  }
  return null;
}

/** Overshoot margin beyond which the tail line escalates to a hard corrective. */
const OVERSHOOT_MARGIN = 0.25;
/** Undershoot margin (only enforced for immersion-level learners). */
const UNDERSHOOT_MARGIN = 0.3;

export interface MixLineInputs {
  targetShare: number;
  /** Measured share of the tutor's previous reply, or null if unmeasurable. */
  lastMeasuredShare: number | null;
  targetLanguage: string; // "Russian"
  nativeLanguage: string; // "English"
}

/**
 * The per-turn tail line. Normal form states the mix concretely for the
 * current band; when the last reply overshot the target badly, it becomes
 * a hard corrective carrying the measured percentage — a computed number,
 * not a request, per the pattern that actually binds this model.
 */
export function buildMixLine(inputs: MixLineInputs): string {
  const { targetShare, lastMeasuredShare, targetLanguage, nativeLanguage } = inputs;

  if (lastMeasuredShare !== null && lastMeasuredShare > targetShare + OVERSHOOT_MARGIN) {
    const pct = Math.round(lastMeasuredShare * 100);
    return `Your last reply was ${pct}% ${targetLanguage} — far too much for this learner; they understood little of it. This turn, speak ${nativeLanguage}. Keep ${targetLanguage} to the specific words you are teaching, each followed immediately by its ${nativeLanguage} meaning.`;
  }

  if (
    lastMeasuredShare !== null &&
    targetShare >= 0.6 &&
    lastMeasuredShare < targetShare - UNDERSHOOT_MARGIN
  ) {
    return `Your last reply was almost all ${nativeLanguage}. This learner can handle more — hold the conversation in ${targetLanguage}, dropping to ${nativeLanguage} only when they are clearly lost.`;
  }

  if (targetShare < 0.35) {
    return `Speak ${nativeLanguage}, not ${targetLanguage}. Bring in ${targetLanguage} only for the words and phrases you are teaching — one at a time, each followed immediately by its ${nativeLanguage} meaning. Never say a full ${targetLanguage} sentence they haven't already understood piece by piece.`;
  }
  if (targetShare < 0.65) {
    return `Mix languages: frame and explain in ${nativeLanguage}, and carry the exchanges you know they can follow in ${targetLanguage}. Never stack two ${targetLanguage} sentences in a row without checking they followed the first.`;
  }
  if (targetShare < 0.85) {
    return `Speak mostly ${targetLanguage}, in simple short sentences. Switch to ${nativeLanguage} the moment they show signs of not following.`;
  }
  return `Stay in ${targetLanguage}. Use ${nativeLanguage} only if they are clearly lost.`;
}
