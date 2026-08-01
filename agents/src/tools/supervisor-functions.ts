/**
 * Supervisor Functions (Event-Driven)
 *
 * These are the same functions as supervisor.ts but callable directly,
 * not wrapped as LLM tools. Use these from event handlers.
 *
 * Architecture:
 *   User speaks → STT → UserInputTranscribed event
 *                              ↓
 *              ┌───────────────┴───────────────┐
 *              ↓                               ↓
 *        LLM responds                   runSupervisorAnalysis()
 *        (parallel)                     (async, parallel)
 *              ↓                               ↓
 *        TTS speaks                     Update DB + Goals
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, units, users, activeGoals, reviewLogs } from '../db/schema.js';
import { ContextManager } from '../lib/context.js';
import { fsrsReview, voiceToGrade, type FSRSGrade, type FSRSCard, type VoicePerformance } from '../lib/fsrs.js';
import { embedText, lexemeEmbedText } from '../lib/embedding.js';
import { passesDictionaryGate } from '../lib/dictionary.js';
import { nativeLanguageName } from '../config/languages.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Closed-class / function-word POS tags. Words with these POS do NOT get
 * a target-language placeholder created when the user substitutes their
 * native equivalent (e.g. saying "how" instead of "como" in a PT session).
 *
 * The cross-language penalty model is for *content* words — words with
 * discrete vocabulary meaning that can be learned. Function words (pronouns,
 * determiners, conjunctions, prepositions, auxiliaries, particles) are
 * language-specific and high-frequency by definition, so the placeholder
 * model produces noise rather than pedagogical signal.
 */
const FUNCTION_WORD_POS = new Set([
  'PRON',     // pronouns (I, you, he, ela, eu, tu)
  'DET',      // determiners (the, a, este)
  'CONJ',     // conjunctions (and, but, e, mas)
  'PREP',     // prepositions (in, of, em, de)
  'AUX',      // auxiliaries (do, have, will)
  'PART',     // particles (not, only, já, pois)
  'INTJ',     // interjections (yes, hi, oi)
  'CCONJ',    // coordinating conjunctions
  'SCONJ',    // subordinating conjunctions
  // NUM (numerals) intentionally excluded — numbers are core learnable
  // vocabulary at pre-A1/A1 and were previously discarded as noise.
]);

/**
 * Quick heuristic for "is this lemma mostly non-alphabetic or trivial?"
 * Used to skip placeholder creation for short, generic tokens that the LLM
 * might emit but which have no real target-language analogue to track
 * (e.g. "n't", "uh", "um").
 *
 * IMPORTANT: this only filters TRULY trivial tokens. Common 2-letter English
 * content words like "go", "be", "do" are content words with real PT
 * equivalents ("ir", "ser/estar", "fazer") and must be tracked. Only length-1
 * tokens ("a", "I", "é") and a few specific contractions are filtered.
 */
function isLikelyFunctionToken(lemma: string): boolean {
  if (!lemma) return true;
  const cleaned = lemma.toLowerCase().trim();
  if (cleaned.length <= 1) return true;  // "a", "I", "y" — always function
  if (cleaned === "n't" || cleaned === "'s" || cleaned === "'m" || cleaned === "'re" || cleaned === "'ve" || cleaned === "'ll" || cleaned === "'d") return true;
  return false;
}

// ============================================================================
// TYPES
// ============================================================================

export interface LexemeAnalysis {
  lemma: string;
  form: string;
  pos: string;
  /**
   * ISO 639-1 code of the language this specific word is in — always the
   * user's target or native code, enforced by the JSON schema's enum
   * (see buildUtteranceAnalysisSchema). Required, not inferred: an earlier
   * version made this optional and fell back to guessing, which is exactly
   * how ~half of a test account's "Portuguese" vocabulary ended up being
   * English/Russian words filed under language='pt' (confirmed live,
   * 2026-07-02) — the target/native branch in updateSRSFromAnalysis had no
   * per-word language to check against. Mixed utterances ("I want привет")
   * need this per-word, not just the utterance-level `language` field.
   */
  language: string;
  /**
   * ONE judgment per word — fluency folded into the correct_* variants
   * (2026-07-02 slim-down; the separate `confidence` field and per-word
   * pronunciation/grammarRule objects were cut). The processor is the
   * memory-writer for the FSRS system, not a second live critic — the
   * conversation agent hears the audio natively and corrects in the
   * moment; the only thing that must persist is which words, how well.
   *
   * Legacy labels (correct_use, scaffolded) may appear in old stored
   * analyses / the legacy supervisor.ts path — voiceToGrade still maps them.
   */
  performance:
    | 'correct' | 'correct_instant' | 'correct_struggled'
    | 'wrong_use' | 'recall_fail' | 'native_substitution' | 'wrong_tone'
    | 'correct_use' | 'scaffolded';
  /** Legacy two-field shape — no longer requested from the model. */
  confidence?: 'instant' | 'hesitant' | 'struggled';
  /**
   * Only for performance="native_substitution": the actual target-language
   * word the learner should have used, in its dictionary/lemma form — only
   * when you're confident of it from context (e.g. it was just taught, or
   * it's an obvious everyday word). Omit if you don't know it. This lets
   * the DB apply the FSRS penalty to a real target word instead of
   * inventing a placeholder — the old placeholder mechanism ("store the
   * native word under the target language, fix it later") never actually
   * got fixed later and is why ~half of a test account's target vocabulary
   * was contamination (confirmed live, 2026-07-02).
   */
  expectedTargetLemma?: string;
  /** Legacy — no longer requested from the model; structuredErrors carries a synthetic rule instead. */
  grammarRule?: { rule: string; example: string };
}

export interface UtteranceAnalysis {
  language: string;
  lexemes: LexemeAnalysis[];
  /**
   * ONE optional short sentence when something notable recurred this turn —
   * a grammar pattern or a pronunciation issue worth deliberate practice.
   * Replaces the old grammarHints[] + pronunciationNotes + per-word
   * grammarRule trio: the conversation agent already corrects live, so the
   * only consumer here is the planner/prompt-tail, which wants at most one
   * line anyway.
   */
  note?: string;
  /** Legacy field name — populated from `note` for old consumers. */
  grammarHints?: string[];
  /**
   * Immediate-action triggers detected by the processor. When non-empty,
   * the pipeline dispatches the supervisor immediately (no waiting for
   * the timer cycle). Each trigger has a type and optional value/reason.
   */
  supervisorTriggers?: SupervisorTrigger[];
}

export interface SupervisorTrigger {
  type: 'language_change' | 'difficulty_adjustment' | 'goal_change' | 'session_feedback' | 'persona_update' | 'onboarding_signal' | 'curriculum_advance' | 'session_mode_change';
  /** For language_change: ISO code. For difficulty_adjustment: 'easier'|'harder'.
   *  For persona_update: natural-language description.
   *  For session_feedback: "wants_to_end" when the user signals they're wrapping up (goodbye, gotta go).
   *  For onboarding_signal: JSON string with keys: priorStudy?, studyDetails?, goals?, goalDetails?, selfRatedLevel?
   *  For curriculum_advance: unused — presence of the trigger is the signal.
   *  For session_mode_change: 'review'|'new'|'mixed' — see design doc §10. */
  value?: string;
  /** Human-readable reason the trigger fired (for logging/dashboard). */
  reason?: string;
}

export interface SupervisorResult {
  analysis: UtteranceAnalysis | null;
  srsUpdates: { lexemeId: string; oldState: number; newState: number; grade: number }[];
  goalUpdate: string | null;
  errors: string[];
  structuredErrors?: { lemma: string; grammarRule?: { rule: string; example: string } }[];
  grammarHints?: string[];
}

// ============================================================================
// ANALYSIS FUNCTION
// ============================================================================

/**
 * Build the analysis prompt. One prompt for all models — the 12B fills
 * every role today (see spec §11); shrinking to smaller models later is a
 * config + eval-fixture change, not a second prompt to maintain.
 * Exported so supervisor.ts can import it instead of duplicating.
 *
 * When the user provides audio (audio_url content in the user message), the
 * model is also asked to score pronunciation, tag recall confidence per
 * lexeme, and emit a sentence-level pronunciationNotes string. For
 * text-only inputs the model omits those fields.
 */
// Languages where tone is phonemic — the same segmental sounds mean
// different words depending on pitch contour (Mandarin's mā/má/mǎ/mà).
// Gates the tone-grading category below so non-tonal languages never see
// tone language in their grading prompt — a `wrong_tone` option with no
// tones to judge would just be a hallucination slot.
const TONAL_LANGUAGE_ISOS = new Set(['zh']);

export function buildFullPrompt(targetLanguage: string, nativeLanguage: string = 'English', targetIso: string = 'ru', nativeIso: string = 'en'): string {
  const tonal = TONAL_LANGUAGE_ISOS.has(targetIso);
  return `Listen to a ${nativeLanguage}→${targetLanguage} learner's utterance. Identify the ${targetLanguage} words they actually said and grade each one. Return JSON only.

Your output becomes permanent spaced-repetition records. Precision beats coverage: if the audio is unclear, silent, or you can't make out real words, return an empty lexemes array. Never invent words you didn't clearly hear.

Tag ONLY these words:
- ${targetLanguage} words the learner said: language="${targetIso}".
- ${nativeLanguage} content words used IN PLACE of an expected ${targetLanguage} word: performance="native_substitution", language="${nativeIso}". If you're confident which ${targetLanguage} word they should have used (it was just taught, or it's an obvious everyday word), add expectedTargetLemma in dictionary form — omit if unsure, don't guess.
Do NOT tag ${nativeLanguage} words otherwise. A learner just chatting in ${nativeLanguage} → empty lexemes array (triggers below still apply). Every "language" field is exactly "${targetIso}" or "${nativeIso}", nothing else.

performance — one judgment per word:
- correct_instant: fluent, immediate, clean
- correct: produced correctly (default; always use this for text-only input)
- correct_struggled: got it, but with hesitation, self-correction, stutter, or a long pause
- wrong_use: wrong form or usage
- recall_fail: tried and failed to produce it
- native_substitution: see above${tonal ? `
- wrong_tone: the word/lemma choice was RIGHT but the tone was wrong (e.g. said "mǎ" (horse) when "mā" (mother) was meant) — this is a pronunciation error, not a recall failure, so don't use wrong_use/recall_fail for a tone-only mistake` : ''}
${tonal ? `\nThis is Mandarin — tone is phonemic. Judge tone separately from word choice: right word + wrong tone = wrong_tone, not wrong_use. Only mark wrong_tone when you can actually hear a tone that doesn't match the intended word, not as a default guess.\n` : ''}
Meta-language is not performance: when the learner talks ABOUT words — "I don't know that word", "what does X mean?", "your words are strange" — the words INSIDE that meta-comment are being used correctly, not failed. "Я не знаю это слово" is a correct use of знать and слово, not a recall_fail on them. Only the word they're asking about (if they name one) failed — and only if they actually attempted it.

note (optional): ONE short sentence if something notable recurred this turn — a grammar pattern or pronunciation issue worth deliberate practice later. Omit otherwise.

supervisorTriggers (empty array if none):
- language_change: user wants different language. value=ISO code of the language they are asking FOR (never the language they're already learning).
- difficulty_adjustment: too easy/hard. Fire "easier" whenever the learner says they can't understand, feels overwhelmed, or asks for more ${nativeLanguage}. value="easier"|"harder"
- goal_change: topic/skill focus within current language. value=topic.
- session_feedback: user signals they're wrapping up (goodbye, gotta go, that's enough for today). value="wants_to_end".
- onboarding_signal: user reveals background or goals. value=JSON with any of: priorStudy ("none"|"self_taught"|"class"|"immersion"|"heritage"), studyDetails (free text), goals (array: "travel"|"work"|"heritage"|"media"|"academic"|"other"), goalDetails (free text), selfRatedLevel ("pre_a1"|"a1"|"a2"|"b1"|"b2"|"c1"|"c2"). Only fire when user explicitly states something — don't infer.
- curriculum_advance: user explicitly asks to move to the next chapter/lesson, says they already know this material, or asks to skip ahead. Only on a clear, explicit request — never inferred from them just doing well.
- session_mode_change: user explicitly asks to focus on review/practice ("let's just review", "quiz me on old words") → value="review". User explicitly asks for new material/vocabulary ("teach me something new", "I want new words today") → value="new". User asks to go back to normal → value="mixed". Only on an explicit request — never inferred from performance.

Example 1 — ${targetLanguage} speech with one substitution ("Я хочу пить water", said fluently except a pause before "пить"):
{"language":"ru","lexemes":[{"lemma":"я","form":"я","pos":"PRON","language":"ru","performance":"correct_instant"},{"lemma":"хотеть","form":"хочу","pos":"VERB","language":"ru","performance":"correct_instant"},{"lemma":"пить","form":"пить","pos":"VERB","language":"ru","performance":"correct_struggled"},{"lemma":"water","form":"water","pos":"NOUN","language":"en","performance":"native_substitution","expectedTargetLemma":"вода"}],"supervisorTriggers":[]}

Example 2 — pure ${nativeLanguage} chatter with a request ("I want to learn Portuguese"): no lexemes, just the trigger:
{"language":"en","lexemes":[],"supervisorTriggers":[{"type":"language_change","value":"pt","reason":"User wants to learn Portuguese"}]}${tonal ? `

Example 3 — Mandarin with a tone error ("我要买马" meant as "我要买妈" — wanted "mā" (mother/a term of address here) but said "mǎ" (horse)):
{"language":"zh","lexemes":[{"lemma":"我","form":"我","pos":"PRON","language":"zh","performance":"correct_instant"},{"lemma":"要","form":"要","pos":"VERB","language":"zh","performance":"correct_instant"},{"lemma":"买","form":"买","pos":"VERB","language":"zh","performance":"correct_instant"},{"lemma":"妈","form":"马","pos":"NOUN","language":"zh","performance":"wrong_tone"}],"supervisorTriggers":[]}` : ''}`;
}

/**
 * JSON schema for constrained decoding. Mirrors UtteranceAnalysis.
 * Constrained decoding replaces the old ~55-line regex repair kit + retry
 * loop: every parse failure used to silently drop FSRS grades, so making
 * the shape structurally guaranteed is worth more than any amount of
 * regex cleanup.
 *
 * Parameterized by targetIso/nativeIso so `language` (top-level and
 * per-lexeme) is enum-constrained to exactly those two values — a plain
 * `{type:'string'}` let the model emit anything, which is how ~half of a
 * test account's "Portuguese" vocabulary ended up being English/Russian
 * words filed under language='pt' (confirmed live, 2026-07-02). Making the
 * field required (not just present-if-the-model-feels-like-it) closes the
 * other half of that gap — see LexemeAnalysis.language.
 */
function buildUtteranceAnalysisSchema(targetIso: string, nativeIso: string) {
  const languageEnum = [targetIso, nativeIso] as const;
  // wrong_tone is only offered for tonal target languages — an enum value
  // with no tones to judge is just a hallucination slot for every other
  // language (same reasoning as the persona_update omission below).
  const performanceEnum = TONAL_LANGUAGE_ISOS.has(targetIso)
    ? ['correct', 'correct_instant', 'correct_struggled', 'wrong_use', 'recall_fail', 'native_substitution', 'wrong_tone']
    : ['correct', 'correct_instant', 'correct_struggled', 'wrong_use', 'recall_fail', 'native_substitution'];
  return {
    type: 'object',
    properties: {
      language: { type: 'string', enum: languageEnum },
      lexemes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lemma: { type: 'string' },
            form: { type: 'string' },
            pos: { type: 'string' },
            language: { type: 'string', enum: languageEnum },
            performance: {
              type: 'string',
              enum: performanceEnum,
            },
            expectedTargetLemma: { type: 'string' },
          },
          required: ['lemma', 'form', 'pos', 'language', 'performance'],
        },
      },
      note: { type: 'string' },
      supervisorTriggers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              // persona_update deliberately absent: it was never documented in
              // the prompt, so the model was never told when to emit it —
              // an enum value with no semantics is just a hallucination slot.
              enum: ['language_change', 'difficulty_adjustment', 'goal_change', 'session_feedback', 'onboarding_signal', 'curriculum_advance', 'session_mode_change'],
            },
            value: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['type'],
        },
      },
    },
    required: ['language', 'lexemes'],
  } as const;
}

/**
 * Extract JSON from a response that may be wrapped in a markdown code
 * fence. No regex repair beyond fence-stripping — constrained decoding is
 * what makes this reliable now, not string surgery.
 */
function parseJsonResponse(raw: string): UtteranceAnalysis | null {
  let jsonStr = raw.trim();
  if (jsonStr.includes('```')) {
    const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    jsonStr = match?.[1]?.trim() ?? jsonStr;
  }
  try {
    return JSON.parse(jsonStr) as UtteranceAnalysis;
  } catch {
    return null;
  }
}

// Minimal ASR-only system prompt, per Gemma 4's documented audio guidance
// (google/gemma-4-12B-it model card): output the transcription only, no
// other text, no line breaks, numerals as digits not spelled out. A lean
// prompt here matters — Gemma 4 12B's audio attention degrades once the
// system prompt gets large (r/LocalLLaMA reports of ~18-27k-token agent
// prompts causing the model to stop attending to audio and hallucinate a
// generic reply instead). Keeping this pass's prompt tiny is what makes it
// fast AND keeps audio attention intact, unlike the much larger grading
// prompt in buildFullPrompt().
export function buildTranscriptionOnlyPrompt(targetLanguage: string, nativeLanguage: string): string {
  // 2026-07-10: the "whichever language(s)" phrasing left the model free to
  // decide it heard a THIRD language — live zh session, Mandarin audio,
  // transcript came back in Thai script. The languages are now stated as a
  // closed set. (A deterministic foreign-script rejection also backs this
  // up at the call site — prompts don't bind.)
  //
  // 2026-07-10 later, REVISED AGAIN: the first closed-set wording said
  // "if a word sounds like some other language, it is imperfectly-
  // pronounced ${targetLanguage} — transcribe it as the closest
  // ${targetLanguage}". On the 12B that coercion tipped EVERYTHING toward
  // the target language: a user speaking plain English got their sentence
  // TRANSLATED into fluent Chinese ("Why do you think I just said a bunch
  // of Chinese..." → "为什么你觉得我刚才说了一堆中文..."), confirmed live.
  // The rule must be symmetric between the two allowed languages and
  // explicitly anti-translation, with no "when in doubt, pick the target"
  // bias in either direction.
  // 2026-07-12: restructured to mirror the documented Gemma 4 12B ASR
  // template ("Transcribe the following speech segment..." +
  // "Follow these specific instructions for formatting the answer:" +
  // bullet list) as closely as possible, instead of one free-form
  // paragraph — the model card has no template for bilingual code-switch
  // ASR (only monolingual ASR and single-direction AST), so this smuggles
  // the closed-two-language requirement in as one more bullet rather than
  // reframing the whole instruction. A/B'd against 6 real dumped clips
  // (3 known-hard: silent/noisy/refusal-prone, 3 known-good) at temp=0: on
  // the hard clips, prompt structure made no difference at all — this
  // version, the old paragraph version, and the model card's prompt
  // verbatim all failed identically, so those failures are an audio/model
  // ceiling, not a prompt bug. On the good clips, THIS structure won on
  // the merits: the old paragraph prompt was reliably violating its own
  // "never translate" rule (appending English glosses after the Russian
  // transcript on a clean clip — "Один кофе... Small coffee, please, with
  // milk... I want honey"), and got a real word wrong (холодет, not a
  // word) where this version got it right (холодец, an actual dish) on
  // the same clip.
  return `Transcribe the following speech segment. The speaker may switch between ${nativeLanguage} and ${targetLanguage} mid-sentence; transcribe each word into whichever of these two languages it was actually spoken in.
Follow these specific instructions for formatting the answer:
* Only output the transcription, with no newlines.
* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.
* Do not translate between ${nativeLanguage} and ${targetLanguage} — transcribe only, in the language actually spoken. If they spoke ${nativeLanguage}, the transcript is ${nativeLanguage}, even in a ${targetLanguage} lesson.
* Never output any language or script other than ${nativeLanguage} or ${targetLanguage}.
* Do not repeat a word or phrase more times than it was actually said.
* If the audio is silent or unintelligible, output nothing.`;
}

/**
 * Cascade pass 1: a fast, minimal-prompt transcription-only call. Returns
 * the transcript so pass 2 (grading) can use it as a known anchor for
 * "what was said" instead of re-deriving word identity from scratch while
 * also judging pronunciation/tone/hesitation in the same breath — see
 * analyzeUtteranceWithLocalLLM's cascade comment for why this split exists.
 */
export async function transcribeAudioWithLocalLLM(
  historyMessages: any[],
  llmUrl: string,
  llmModel: string,
  llmKey: string,
  targetLanguage: string,
  nativeLanguage: string,
): Promise<string | null> {
  const sysPrompt = buildTranscriptionOnlyPrompt(targetLanguage, nativeLanguage);
  const messages = [{ role: 'system', content: sysPrompt }, ...historyMessages];
  const timeoutMs = 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llmKey) headers['Authorization'] = `Bearer ${llmKey}`;
    const startTime = Date.now();
    const response = await fetch(`${llmUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: llmModel,
        messages,
        temperature: 0.0,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[Supervisor] Transcription pass failed: ${response.status}`);
      return null;
    }
    const data = await response.json() as any;
    // 2026-07-06: this checkpoint's chat template leaks a literal "thought"
    // line before the real content even with the no-think template and
    // reasoning=null in the response — not a proper reasoning_content field,
    // just a stray token. It repeats once per audio turn in the history
    // (confirmed: two audio turns → "thought\nthought\n<real text>"), so a
    // leading-only strip isn't enough — strip every standalone "thought"
    // line, wherever it falls, so a fake extra "word" never corrupts the
    // ground-truth anchor handed to the grading pass.
    // 2026-07-08: found live — when "thought" is the ENTIRE response (no
    // real content followed, e.g. silent/unclear audio), the old regex's
    // required trailing `\n+` never matched, so "thought" itself leaked
    // through as if it were a real one-word transcript. Now matches a
    // trailing newline OR end-of-string.
    let transcript = (data.choices?.[0]?.message?.content || '').trim();
    transcript = transcript.replace(/^\s*thought\s*(\n+|$)/gim, '').trim();

    // Degenerate-loop guard (2026-07-10, live: a clipping-loud clip came
    // back as "快点" repeated 25 times over 5.9s of decode). A phrase
    // looping ≥5 times consecutively means the decoder fell into
    // repetition, not that the user said it 25 times — the whole
    // transcript is untrustworthy at that point, so reject it (null →
    // placeholder-only fallback) rather than trying to salvage a prefix.
    const chunks = transcript.split(/[\s,，。.!！?？;；]+/).filter((c: string) => c.length >= 2);
    let runLength = 1;
    for (let i = 1; i < chunks.length; i++) {
      runLength = chunks[i] === chunks[i - 1] ? runLength + 1 : 1;
      if (runLength >= 5) {
        console.warn(`[Supervisor] Transcription rejected — degenerate repetition of "${chunks[i]}" (${Date.now() - startTime}ms)`);
        return null;
      }
    }

    // Refusal/meta-commentary guard (2026-07-11, live on FP8: 3 clips came
    // back as "I'm sorry, but I cannot fulfill this request. I am unable
    // to process or transcribe audio files." / "I'm not sure what you're
    // trying to say." — the model dropping out of ASR mode into its
    // assistant persona). Undetectable by the degenerate-loop guard (no
    // repetition) or the foreign-script guard (pure English) — this is
    // English prose that LOOKS like a valid transcript but is the model
    // talking about the task instead of doing it. Worse than empty: it
    // got spliced into a real turn's text ("...transcribe it for you.
    // [audio key=X] Я"), corrupting a legitimate second segment. A short
    // first-person prefix naming the task itself is the tell — real
    // Russian/English speech doesn't self-describe as an inability to
    // transcribe.
    const REFUSAL_PATTERN = /^(i'?m (sorry|not sure)|i (can'?t|cannot|am unable to|don'?t)\b.{0,40}\b(hear|understand|process|transcribe|fulfill))/i;
    if (REFUSAL_PATTERN.test(transcript)) {
      console.warn(`[Supervisor] Transcription rejected — looks like a refusal, not a transcript: "${transcript.slice(0, 100)}"`);
      return null;
    }

    console.log(`[Supervisor] Transcription pass (${Date.now() - startTime}ms): "${transcript.slice(0, 80)}"`);
    return transcript || null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[Supervisor] Transcription pass timed out after ${timeoutMs}ms`);
    } else {
      console.error('[Supervisor] Transcription pass error:', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Analyze an utterance using the local LLM (SGLang). Single attempt —
 * constrained decoding (response_format json_schema) makes retries
 * unnecessary; a malformed response now means the endpoint itself is
 * broken, which a retry with the same prompt wouldn't fix.
 *
 * Cascading two-pass design for audio input (2026-07-06): pass 1
 * (transcribeAudioWithLocalLLM) transcribes with a minimal prompt so audio
 * attention stays intact; pass 2 (this function's own grading call) then
 * gets the transcript as a known anchor for word identity, so it only has
 * to judge performance (pronunciation, tone, hesitation, correctness)
 * against audio it's already been told the words for, instead of solving
 * transcription and grading simultaneously in one overloaded call.
 */
export async function analyzeUtteranceWithLocalLLM(
  utterance: string,
  context: string,
  llmUrl: string = 'http://localhost:8082/v1',
  llmModel?: string,
  targetLanguage: string = 'Russian',
  recentHistory?: string,
  llmKey?: string,
  historyMessages?: any[],
  nativeLanguage: string = 'English',
  targetIso: string = 'ru',
  nativeIso: string = 'en',
  knownTranscript?: string,
): Promise<UtteranceAnalysisResult> {
  const model = llmModel || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';
  const historyLine = recentHistory
    ? `\n\nRecent conversation (for scaffolded detection):\n${recentHistory}`
    : '';
  const userPrompt = `Analyze: "${utterance}"${historyLine}`;

  // If the caller passed audio-aware history (recent user audio as audio_url),
  // we send the audio turns as part of the prompt so the LLM can analyze
  // pronunciation and confidence. Otherwise we fall back to the legacy
  // flat-text path.
  const hasAudioMessages = !!historyMessages && historyMessages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'audio_url'),
  );

  console.log(
    `[Supervisor] Analyzing with ${model} (${hasAudioMessages ? 'audio' : 'text'}-mode, native=${nativeLanguage})`,
  );

  const apiKey = llmKey || process.env.PROCESSOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '';

  // Cascade pass 1 — transcribe first with a minimal prompt (see
  // buildTranscriptionOnlyPrompt), then hand pass 2 the transcript as a
  // known anchor so it grades performance instead of also solving "what
  // were the words" from scratch. Only worth the extra round-trip for
  // audio turns — text-mode input already has ground-truth words.
  // 2026-07-10: skipped entirely when the caller already has a transcript
  // (the STT node's inline transcription) — same anchor, one less call.
  let transcript: string | null = knownTranscript?.trim() || null;
  if (!transcript && hasAudioMessages) {
    transcript = await transcribeAudioWithLocalLLM(historyMessages!, llmUrl, model, apiKey, targetLanguage, nativeLanguage);
  }

  const sysPrompt = buildFullPrompt(targetLanguage, nativeLanguage, targetIso, nativeIso)
    + (transcript
      ? `\n\nThe most recent audio has already been transcribed as: "${transcript}". Treat this as the verified ground truth for which words were said — your job is to judge performance (pronunciation, tone, hesitation, correctness) from the audio, not to re-derive the words.`
      : '');

  const timeoutMs = 15000;
  try {
    const startTime = Date.now();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const messages: any[] = hasAudioMessages
      ? [{ role: 'system', content: sysPrompt }, ...historyMessages!]
      : [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }];

    // 2026-07-04: a live session hit a 32s processor response that came back
    // truncated mid-JSON (schema-constrained decoding notwithstanding) —
    // the processor's own prompt is minimal (getLatestTurnMessages caps it
    // at one audio clip), so this reads as vLLM-side contention/latency
    // (the conversational agent's own, much larger call hits the same
    // vLLM instance) rather than this call's own context growing too large.
    // A hard timeout turns a silent multi-second hang + garbage output into
    // a fast, loud failure instead — doesn't fix the underlying GPU/vLLM
    // contention, but stops one slow request from quietly eating a turn's
    // grading with no clear signal in the logs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${llmUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: 800,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'utterance_analysis', schema: buildUtteranceAnalysisSchema(targetIso, nativeIso) },
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[Supervisor] LLM request failed: ${response.status}`);
      return { analysis: null, rawPrompt: sysPrompt + '\n' + userPrompt, transcript: transcript ?? undefined };
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';

    console.log(`[Supervisor] LLM responded in ${elapsed}ms`);

    const analysis = parseJsonResponse(content);
    if (analysis) {
      console.log(
        `[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes` +
        (analysis.note ? `, note: "${analysis.note.slice(0, 60)}"` : ''),
      );
      return { analysis, rawPrompt: sysPrompt + '\n' + userPrompt, rawResponse: content, transcript: transcript ?? undefined };
    }

    console.error(`[Supervisor] JSON parse failed despite schema-constrained decoding. Raw: ${content.substring(0, 150)}`);
    return { analysis: null, rawPrompt: sysPrompt + '\n' + userPrompt, rawResponse: content, transcript: transcript ?? undefined };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[Supervisor] LLM request timed out after ${timeoutMs}ms — skipping this turn's grading`);
    } else {
      console.error('[Supervisor] Analysis error:', err);
    }
    return { analysis: null, rawPrompt: sysPrompt + '\n' + userPrompt, transcript: transcript ?? undefined };
  }
}

/**
 * Analyze an utterance using Gemini API (more accurate but requires API key)
 */
export async function analyzeUtteranceWithGemini(
  utterance: string,
  context: string,
  targetLanguage: string = 'Russian',
  recentHistory?: string,
  nativeLanguage: string = 'English',
  targetIso: string = 'ru',
  nativeIso: string = 'en',
): Promise<UtteranceAnalysisResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[Supervisor] No GOOGLE_API_KEY, skipping Gemini analysis');
    return { analysis: null };
  }

  const historyLine = recentHistory
    ? `\n\nRecent conversation (for scaffolded detection):\n${recentHistory}`
    : '';

  const promptText = `${buildFullPrompt(targetLanguage, nativeLanguage, targetIso, nativeIso)}\n\nContext: ${context}${historyLine}\nUser said: "${utterance}"`;

  try {
    console.log('[Supervisor] Analyzing with Gemini...');
    const startTime = Date.now();

    // Dynamic import to avoid loading if not needed
    const { GoogleGenAI } = await import('@google/genai');
    const genAI = new GoogleGenAI({ apiKey });

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{ text: promptText }]
      }]
    });

    const elapsed = Date.now() - startTime;
    console.log(`[Supervisor] Gemini responded in ${elapsed}ms`);

    const responseText = result.text || '';

    const analysis = parseJsonResponse(responseText);
    if (analysis) {
      console.log(`[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes`);
      return { analysis, rawPrompt: promptText, rawResponse: responseText };
    }

    console.warn('[Supervisor] Gemini JSON parse failed');
    return { analysis: null, rawPrompt: promptText, rawResponse: responseText };

  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn(`[Supervisor] Gemini analysis error: ${msg.slice(0, 120)}`);
    return { analysis: null, rawPrompt: promptText };
  }
}

// ============================================================================
// AUTO-EMBEDDING
// ============================================================================

/**
 * Embed a newly created lexeme asynchronously.
 * Does not block the caller — fires and forgets.
 * If the embedding service is down, the lexeme just won't have a vector
 * (semantic ripple and neighbors won't work for it, but FSRS still does).
 */
function autoEmbedLexeme(lexemeId: string, lemma: string, language: string, translation: string): void {
  // Fire and forget — don't await
  embedText(lexemeEmbedText(lemma, language, translation))
    .then(async (embedding) => {
      if (embedding.length > 0) {
        await db.update(lexemes)
          .set({ embedding })
          .where(eq(lexemes.id, lexemeId));
        console.log(`[Embed] Embedded lexeme: ${lemma} (${language})`);
      }
    })
    .catch((err) => {
      console.warn(`[Embed] Failed to embed ${lemma}: ${String(err).slice(0, 80)}`);
    });
}

// ============================================================================
// CROSS-LANGUAGE HELPERS
// ============================================================================

/**
 * When a user says a native word instead of the target word, find or
 * create the REAL target-language equivalent to apply the FSRS penalty.
 *
 * 2026-07-02: this used to fall back to creating a placeholder lexeme
 * that stored the *native* word's text under the target language (e.g.
 * "this" filed as pt:this:DET) with a comment promising it would be
 * "overwritten when the actual target word is learned" — nothing in the
 * codebase ever did that overwrite, so these were permanent zombies.
 * Confirmed live: ~half of a test account's "Portuguese" vocabulary was
 * this pattern, surfacing as real vocabulary in scaffolding lines and
 * skewing level inference. That fallback is gone. If we don't know the
 * real target word, we don't invent one — the caller already handles a
 * null return by tracking the native-language habit only, no fake DB row.
 *
 * Strategy (all against `expectedTargetLemma`, the model's stated guess at
 * the real target word — see LexemeAnalysis.expectedTargetLemma):
 * 1. Look up an existing target lexeme by that lemma+language (same
 *    exact/GENERAL-pos/any-pos fallback chain as a normal target word).
 * 2. Not found — create it for real, using the actual target-language
 *    lemma, with nativeLemma linked back for cross-reference (safe now:
 *    lemma !== nativeLemma, so this can never match the zombie pattern
 *    lib/learner-view.ts filters on).
 * 3. No expectedTargetLemma supplied at all — give up, return null.
 */
async function findOrCreateTargetEquiv(
  _userId: string,
  nativeLemma: string,
  nativePos: string,
  targetLang: string,
  nativeLexemeId: string,
  expectedTargetLemma?: string,
): Promise<typeof lexemes.$inferSelect | null | undefined> {
  const targetLemma = (expectedTargetLemma || '').trim();
  if (!targetLemma) return null;

  let existing = await db.query.lexemes.findFirst({
    where: and(
      eq(lexemes.lemma, targetLemma),
      eq(lexemes.pos, nativePos),
      eq(lexemes.language, targetLang),
    ),
  });
  if (!existing) {
    existing = await db.query.lexemes.findFirst({
      where: and(eq(lexemes.lemma, targetLemma), eq(lexemes.language, targetLang)),
    });
  }

  if (existing) {
    if (!existing.nativeLemma) {
      await db.update(lexemes).set({ nativeLemma }).where(eq(lexemes.id, existing.id));
    }
    return existing;
  }

  const targetLexemeId = `${targetLang}:${targetLemma.toLowerCase()}:${nativePos}`;
  console.log(`[Processor] Creating target lexeme "${targetLemma}" [${targetLang}] (expected word for native substitution "${nativeLemma}")`);
  await db.insert(lexemes).values({
    id: targetLexemeId,
    lemma: targetLemma,
    pos: nativePos,
    language: targetLang,
    translation: nativeLemma,
    unitId: null,
    gender: null,
    morphFeatures: null,
    nativeLemma,
  }).onConflictDoNothing();

  autoEmbedLexeme(targetLexemeId, targetLemma, targetLang, nativeLemma);

  return await db.query.lexemes.findFirst({
    where: eq(lexemes.id, targetLexemeId),
  });
}

// ============================================================================
// SRS UPDATE FUNCTION
// ============================================================================

/**
 * Update FSRS state based on analysis results.
 * Maps LLM performance labels to FSRS grades, applies the FSRS algorithm,
 * logs reviews, and applies semantic ripple effects.
 *
 * Cross-language tracking:
 * - When a word is detected in the user's native language (not target),
 *   we still create a lexeme for it in the native language AND link it
 *   to the target-language equivalent via nativeLemma.
 * - native_substitution increments a counter on the target word — so
 *   we can track when users fall back to English instead of using the
 *   target word they've been taught.
 */
/**
 * Tracking status for each lexeme in the analysis. The processor's UI emit
 * uses this to color-code words in the dashboard:
 * - 'tracked': the user_vocabulary table was created or updated (color by performance)
 * - 'analyzed': the LLM classified this word but no DB row was written (function words,
 *               dropped for pedagogical reasons). Still displayed, but as a neutral chip.
 * - 'noop': the lexeme was looked up but no row was modified (e.g. unknown word with no
 *           auto-create). Still displayed.
 *
 * The list is parallel to `analysis.lexemes` — tracking[i] corresponds to lexeme i.
 */
export type LexemeTrackingStatus = 'tracked' | 'analyzed' | 'noop' | 'exposed';

export interface SRSUpdate {
  lexemeId: string;
  oldState: number;
  newState: number;
  grade: FSRSGrade;
  /** Index into the source `analysis.lexemes` array — lets the caller match updates back to lexemes. */
  lexemeIndex: number;
  /**
   * True when this graded use created the learner's first record for the
   * word. Combined with the echo gate above it separates the two cases a
   * learner actually cares about seeing: a word the tutor handed them
   * (echoed → `exposed`, never reaches here) from one they produced on
   * their own for the first time (spontaneous, graded, brand new).
   */
  isNew: boolean;
}

/**
 * Canonical Universal-Dependencies-style tag for a POS the LLM produced.
 *
 * Lexeme identity is `lang:lemma:pos`, and the lemma was already lowercased
 * while the tag was passed through raw — so `es:casa:NOUN` and `es:casa:noun`
 * were two different primary keys for one word, splitting a learner's SRS
 * state across two rows and showing the planner two half-known words instead
 * of one known one.
 *
 * The tag is free text from a language model, and it drifts in three ways at
 * once: case (`noun`), spelled-out names (`adjective`), and competing
 * schemes (`INTERJ` vs `INTJ`, `ADP` vs `PREP`). One live row even came back
 * as `trợ_verb`, the model answering in Vietnamese. Uppercasing alone
 * therefore isn't enough; the aliases have to collapse too.
 *
 * Unknown tags are uppercased and kept rather than forced to GENERAL: a tag
 * this doesn't know is still a real distinction most of the time, and
 * flattening it would merge genuinely different words.
 */
const POS_ALIASES: Record<string, string> = {
  ADVERB: 'ADV', ADJECTIVE: 'ADJ',
  INTERJ: 'INTJ', INTERJECTION: 'INTJ', NUMERAL: 'NUM', NUMBER: 'NUM',
  ADP: 'PREP', PREPOSITION: 'PREP', PRONOUN: 'PRON', CONJUNCTION: 'CONJ',
  DETERMINER: 'DET', ARTICLE: 'ART', PARTICLE: 'PART', AUXILIARY: 'AUX',
  PROPERNOUN: 'PROPN', PROPER_NOUN: 'PROPN',
};

export function normalizePos(raw: string | null | undefined): string {
  const t = (raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!t) return 'GENERAL';
  return POS_ALIASES[t] ?? t;
}

/**
 * Deterministic echo test — learner-field spec §3.3. Word-boundary,
 * case-insensitive containment of the lemma OR surface form in the tutor's
 * recent text. Deliberately simple (no stemming/fuzzy match): a false
 * negative just means the word grades normally (safe — spontaneous use is
 * supposed to grade), a false positive costs one exposure-only turn instead
 * of a grade (also safe — it'll grade on the next genuine production).
 */
function wasEchoed(lemma: string, form: string, tutorRecentText: string | undefined): boolean {
  if (!tutorRecentText) return false;
  const haystack = tutorRecentText.toLowerCase();
  for (const needle of [form, lemma]) {
    const w = (needle || '').trim().toLowerCase();
    if (!w) continue;
    // \b doesn't understand Cyrillic/CJK word boundaries reliably, so use a
    // simple non-alphanumeric-neighbor check instead of a \b regex.
    const idx = haystack.indexOf(w);
    if (idx === -1) continue;
    const before = idx === 0 ? '' : haystack[idx - 1];
    const after = idx + w.length >= haystack.length ? '' : haystack[idx + w.length];
    const isBoundary = (ch: string | undefined) => !ch || !/[\p{L}\p{N}]/u.test(ch);
    if (isBoundary(before) && isBoundary(after)) return true;
  }
  return false;
}

export async function updateSRSFromAnalysis(
  userId: string,
  analysis: UtteranceAnalysis,
  tutorRecentText?: string,
  provenance: 'probe' | 'conversation' = 'conversation',
): Promise<{
  updates: SRSUpdate[];
  /** Parallel to analysis.lexemes — tracking status per lexeme for the UI. */
  tracking: LexemeTrackingStatus[];
}> {
  const updates: SRSUpdate[] = [];
  const tracking: LexemeTrackingStatus[] = [];

  // Get user's target language
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  const targetLang = user?.targetLanguage || analysis.language || 'ru';
  const nativeLang = user?.nativeLanguage || 'en';

  for (let idx = 0; idx < analysis.lexemes.length; idx++) {
    const item = analysis.lexemes[idx]!;

    // === DICTIONARY-EXISTENCE GATE (lib/dictionary.ts) ===
    // The LLM provably invents words ("кост", "янный" written to FSRS as
    // fluent nouns, live 2026-07-02). A word reaches spaced repetition
    // only if hunspell recognizes its surface form or lemma. Languages
    // without a bundled dictionary pass through ungated. Cost: legitimate
    // proper nouns get dropped from SRS — acceptable, we don't schedule
    // reviews for someone's name.
    const wordLang = item.language || targetLang;
    if (!(await passesDictionaryGate(item.form || item.lemma, item.lemma, wordLang))) {
      console.log(`[Processor] Dictionary gate: dropping "${item.form || item.lemma}" (${wordLang}) — not a recognized word`);
      tracking[idx] = 'analyzed';
      continue;
    }

    // Determine which language this word actually belongs to.
    // Priority: explicit `performance: "native_substitution"` label from
    // the LLM (per-word judgment — "the user said this English word INSTEAD
    // OF the target word, on purpose").
    //
    // 2026-06-25: removed the previous fallback that fired on per-lemma
    // language tag and on whole-utterance language. Those fallbacks marked
    // every English word in an all-English utterance as native_substitution
    // and tried to find/create a target-language placeholder, which
    // contaminated the target table with garbage (e.g. "okay" → "ru:okay:INTJ"
    // placeholder, "tell" → "ru:tell:VERB" placeholder). A user speaking
    // English is not "substituting" English for Russian — they're just
    // speaking English. Substitution is a per-word judgment, and the LLM
    // is the only place that judgment exists.
    const isNativeWord = item.performance === 'native_substitution';

    if (isNativeWord) {
      // === NATIVE LANGUAGE SUBSTITUTION ===
      // The user used a native-language word instead of the target word.
      // 1. Create/track the native-language lexeme (for the habit record)
      // 2. Find or create the target-language equivalent and link them
      // 3. Increment nativeSubstitutionCount on the target word
      //
      // Function-word filter: for closed-class POS (pronouns, prepositions,
      // conjunctions, determiners, auxiliaries, particles, interjections,
      // numerals) and trivially short tokens, we do NOT create a target-
      // language placeholder. The cross-language penalty model is for content
      // words with discrete vocabulary meaning — function words are
      // language-specific and high-frequency by definition, so the
      // placeholder produced noise (e.g. "how" → "como" as a "thing the
      // user is learning") rather than pedagogical signal. We still log the
      // native-side lexeme for the habit record and skip the FSRS penalty
      // for the target side.
      const safeLemma = (item.lemma || '').trim();
      const safePos = normalizePos(item.pos);
      const isFunctionWord = FUNCTION_WORD_POS.has(safePos) || isLikelyFunctionToken(safeLemma);

      if (isFunctionWord) {
        console.log(
          `[Processor] Skipping function-word native substitution: "${safeLemma}" (${safePos}) — ` +
          `closed-class word, no target equivalent tracked`,
        );
        tracking[idx] = 'analyzed';
        continue;
      }
      const nativeLexemeId = `${nativeLang}:${safeLemma.toLowerCase()}:${safePos}`;

      // Find or create the native-language lexeme
      let nativeLexeme = await db.query.lexemes.findFirst({
        where: eq(lexemes.id, nativeLexemeId),
      });

      if (!nativeLexeme) {
        console.log(`[Processor] Auto-creating native lexeme: ${safeLemma} (${safePos}) [${nativeLang}]`);
        await db.insert(lexemes).values({
          id: nativeLexemeId,
          lemma: safeLemma,
          pos: safePos,
          language: nativeLang,
          translation: '', // native words don't need translations
          unitId: null,
          gender: null,
          morphFeatures: null,
        }).onConflictDoNothing();

        autoEmbedLexeme(nativeLexemeId, safeLemma, nativeLang, safeLemma);

        nativeLexeme = await db.query.lexemes.findFirst({
          where: eq(lexemes.id, nativeLexemeId),
        });
      }

      // Create a user_vocab entry for the native word so we can track substitutions
      if (nativeLexeme) {
        let nativeVocab = await db.query.userVocabulary.findFirst({
          where: and(
            eq(userVocabulary.userId, userId),
            eq(userVocabulary.lexemeId, nativeLexeme.id)
          )
        });

        if (nativeVocab) {
          // Increment substitution count on the native word itself
          await db.update(userVocabulary)
            .set({ nativeSubstitutionCount: sql`${userVocabulary.nativeSubstitutionCount} + 1` })
            .where(eq(userVocabulary.id, nativeVocab.id));
        } else {
          // First time seeing this native word — create a record (no FSRS grading, just tracking)
          await db.insert(userVocabulary).values({
            userId,
            lexemeId: nativeLexeme.id,
            state: 0,
            due: new Date(),
            stability: 0,
            difficulty: 0,
            scheduledDays: 0,
            reps: 0,
            lapses: 0,
            nativeSubstitutionCount: 1,
            lastReview: new Date(),
          });
        }
      }

      // Now find or create the TARGET language equivalent and apply a penalty
      // (native_substitution = grade 1 on the target word they should have used)
      const targetLexeme = await findOrCreateTargetEquiv(userId, safeLemma, safePos, targetLang, nativeLexemeId, item.expectedTargetLemma);

      if (targetLexeme) {
        const grade: FSRSGrade = 1; // Again — failed to produce target word

        const currentVocab = await db.query.userVocabulary.findFirst({
          where: and(
            eq(userVocabulary.userId, userId),
            eq(userVocabulary.lexemeId, targetLexeme.id)
          )
        });

        const oldState = currentVocab?.state ?? 0;
        const card: FSRSCard = currentVocab ? {
          state: currentVocab.state as 0 | 1 | 2 | 3,
          difficulty: currentVocab.difficulty,
          stability: currentVocab.stability,
          elapsedDays: currentVocab.elapsedDays,
          scheduledDays: currentVocab.scheduledDays,
          reps: currentVocab.reps,
          lapses: currentVocab.lapses,
          due: currentVocab.due,
          lastReview: currentVocab.lastReview,
        } : {
          state: 0, difficulty: 0, stability: 0, elapsedDays: 0,
          scheduledDays: 0, reps: 0, lapses: 0, due: new Date(), lastReview: null,
        };

        const result = fsrsReview(card, grade);

        let vocabId: string;
        if (currentVocab) {
          vocabId = currentVocab.id;
          await db.update(userVocabulary)
            .set({
              state: result.state,
              difficulty: result.difficulty,
              stability: result.stability,
              scheduledDays: result.scheduledDays,
              due: result.due,
              reps: result.reps,
              lapses: result.lapses,
              lastReview: new Date(),
              nativeSubstitutionCount: sql`${userVocabulary.nativeSubstitutionCount} + 1`,
            })
            .where(eq(userVocabulary.id, currentVocab.id));
        } else {
          const inserted = await db.insert(userVocabulary).values({
            userId,
            lexemeId: targetLexeme.id,
            state: result.state,
            due: result.due,
            stability: result.stability,
            difficulty: result.difficulty,
            scheduledDays: result.scheduledDays,
            reps: result.reps,
            lapses: result.lapses,
            nativeSubstitutionCount: 1,
            lastReview: new Date(),
          }).returning({ id: userVocabulary.id });
          vocabId = inserted[0]!.id;
        }

        await db.insert(reviewLogs).values({
          userVocabularyId: vocabId,
          userId,
          grade,
          state: card.state,
          stability: card.stability,
          difficulty: card.difficulty,
          elapsedDays: card.elapsedDays,
          scheduledDays: card.scheduledDays,
          provenance,
        });

        updates.push({
          lexemeId: targetLexeme.id,
          oldState,
          newState: result.state,
          grade,
          lexemeIndex: idx,
          isNew: !currentVocab,
        });
        tracking[idx] = 'tracked';

        console.log(`[Processor] Native substitution: "${safeLemma}" → "${targetLexeme.lemma}" (${targetLang}) grade 1, substitution count incremented`);
      } else {
        console.log(`[Processor] Native substitution: "${safeLemma}" but no target equivalent found, skipping FSRS`);
        tracking[idx] = 'noop';
      }

      continue; // Skip the normal flow for native words
    }

    // Safety net: the LLM sometimes tags a word's per-lexeme `language` as
    // native while leaving `performance` as correct_use/wrong_use/etc
    // instead of native_substitution — e.g. "how do you say 'this is' in
    // Portuguese?" gets "this"/"is" filed as pt:this:DET, pt:is:VERB,
    // polluting the target vocabulary table with English lemmas under a pt
    // language tag. This is NOT the removed 2026-06-25 fallback (which
    // reclassified every native word as native_substitution and tried to
    // create target placeholders for it) — this only fires when the LLM's
    // own per-word tag explicitly disagrees with the target language, and
    // it skips tracking entirely rather than guessing a reclassification.
    const itemLang = (item.language || '').toLowerCase();
    if (itemLang && itemLang !== targetLang.toLowerCase() && itemLang === nativeLang.toLowerCase()) {
      console.log(
        `[Processor] Skipping mistagged word: "${item.lemma}" tagged language="${itemLang}" ` +
        `(native) with performance="${item.performance}" (not native_substitution) — target is ${targetLang}. Not tracking.`,
      );
      tracking[idx] = 'analyzed';
      continue;
    }

    // === TARGET LANGUAGE WORD ===
    // Find matching lexeme in database - try exact POS first
    let existingLexeme = await db.query.lexemes.findFirst({
      where: and(
        eq(lexemes.lemma, item.lemma),
        eq(lexemes.pos, item.pos),
        eq(lexemes.language, targetLang)
      )
    });

    // Fallback: try GENERAL pos
    if (!existingLexeme) {
      existingLexeme = await db.query.lexemes.findFirst({
        where: and(
          eq(lexemes.lemma, item.lemma),
          eq(lexemes.pos, 'GENERAL'),
          eq(lexemes.language, targetLang)
        )
      });
    }

    // Fallback: match by lemma+language regardless of POS (LLMs often disagree on POS tags)
    if (!existingLexeme) {
      existingLexeme = await db.query.lexemes.findFirst({
        where: and(
          eq(lexemes.lemma, item.lemma),
          eq(lexemes.language, targetLang)
        )
      });
    }

    if (!existingLexeme) {
      // Auto-create target-language lexeme
      const safeLemma = (item.lemma || '').trim();
      const safePos = normalizePos(item.pos);
      const lexemeId = `${targetLang}:${safeLemma.toLowerCase()}:${safePos}`;

      console.log(`[Processor] Auto-creating lexeme: ${safeLemma} (${safePos}) [${targetLang}]`);

      // Check if there's a native-language lexeme with the same lemma to link
      const nativeLexemeId = `${nativeLang}:${safeLemma.toLowerCase()}:${safePos}`;
      const nativeEquiv = await db.query.lexemes.findFirst({
        where: eq(lexemes.id, nativeLexemeId),
      });

      await db.insert(lexemes).values({
        id: lexemeId,
        lemma: safeLemma,
        pos: safePos,
        language: targetLang,
        translation: nativeEquiv ? safeLemma : '', // use the lemma as translation hint if native word exists
        unitId: null,
        gender: null,
        morphFeatures: null,
        nativeLemma: nativeEquiv ? safeLemma : null, // link back to native word
      }).onConflictDoNothing();

      autoEmbedLexeme(lexemeId, safeLemma, targetLang, nativeEquiv ? safeLemma : safeLemma);

      existingLexeme = await db.query.lexemes.findFirst({
        where: eq(lexemes.id, lexemeId),
      });

      if (!existingLexeme) {
        console.warn(`[Processor] Failed to auto-create lexeme: ${lexemeId}`);
        continue;
      }
    }

    // Get current vocabulary state
    const currentVocab = await db.query.userVocabulary.findFirst({
      where: and(
        eq(userVocabulary.userId, userId),
        eq(userVocabulary.lexemeId, existingLexeme.id)
      )
    });

    // === ECHO GATE (learner-field spec §3.3) ===
    // A word's FIRST-EVER record grades normally UNLESS it was just spoken
    // by the tutor — parroting the tutor's own word is not production
    // evidence. Spontaneous first use (not echoed) grades normally: it's
    // real evidence of knowledge acquired outside this conversation.
    // Deterministic and code-only — this is what actually protects the
    // data; prompt instructions alone don't bind (confirmed repeatedly in
    // this codebase's history).
    if (!currentVocab && wasEchoed(item.lemma, item.form || item.lemma, tutorRecentText)) {
      console.log(`[Processor] Echo gate: "${item.form || item.lemma}" just said by tutor — exposure only, not graded`);
      await db.insert(userVocabulary).values({
        userId,
        lexemeId: existingLexeme.id,
        state: 0,
        due: new Date(),
        stability: 0,
        difficulty: 0,
        scheduledDays: 0,
        reps: 0,
        lapses: 0,
        receptiveExposures: 1,
        lastExposure: new Date(),
      }).onConflictDoUpdate({
        target: [userVocabulary.userId, userVocabulary.lexemeId],
        set: {
          receptiveExposures: sql`${userVocabulary.receptiveExposures} + 1`,
          lastExposure: new Date(),
        },
      });
      tracking[idx] = 'exposed';
      continue;
    }

    // Map performance to FSRS grade — confidence (audio-only) refines
    // correct_use/scaffolded onto the full Again/Hard/Good/Easy scale.
    let grade = voiceToGrade({
      performance: item.performance,
      confidence: item.confidence,
    });

    // Echo cap for KNOWN words (spec §3.3's second half, 2026-07-11): the
    // echo gate above only protects a word's FIRST record — repeating a
    // known word right after the tutor said it ("say Я хочу место" →
    // parroted → three grade-4s) still counted as fluent independent
    // production. Confirmed live as the main source of grade-4 volume
    // inflation. Echoed production of a known word is scaffolded imitation
    // at best — cap at Hard (2). Failures (grade 1) pass through: failing
    // even WITH the tutor's model just spoken is real signal.
    if (grade > 2 && wasEchoed(item.lemma, item.form || item.lemma, tutorRecentText)) {
      console.log(`[Processor] Echo cap: "${item.form || item.lemma}" just said by tutor — grade ${grade}→2 (scaffolded)`);
      grade = 2;
    }

    const oldState = currentVocab?.state ?? 0;

    // Build FSRS card from current state
    const card: FSRSCard = currentVocab ? {
      state: currentVocab.state as 0 | 1 | 2 | 3,
      difficulty: currentVocab.difficulty,
      stability: currentVocab.stability,
      elapsedDays: currentVocab.elapsedDays,
      scheduledDays: currentVocab.scheduledDays,
      reps: currentVocab.reps,
      lapses: currentVocab.lapses,
      due: currentVocab.due,
      lastReview: currentVocab.lastReview,
    } : {
      state: 0,
      difficulty: 0,
      stability: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      due: new Date(),
      lastReview: null,
    };

    // Apply FSRS algorithm
    const result = fsrsReview(card, grade);

    // Update or create vocabulary record FIRST (we need the ID for review_logs)
    let vocabId: string;
    if (currentVocab) {
      vocabId = currentVocab.id;
      await db.update(userVocabulary)
        .set({
          state: result.state,
          difficulty: result.difficulty,
          stability: result.stability,
          scheduledDays: result.scheduledDays,
          due: result.due,
          reps: result.reps,
          lapses: result.lapses,
          lastReview: new Date(),
        })
        .where(eq(userVocabulary.id, currentVocab.id));
    } else {
      const inserted = await db.insert(userVocabulary).values({
        userId,
        lexemeId: existingLexeme.id,
        state: result.state,
        due: result.due,
        stability: result.stability,
        difficulty: result.difficulty,
        scheduledDays: result.scheduledDays,
        reps: result.reps,
        lapses: result.lapses,
        lastReview: new Date(),
      }).returning({ id: userVocabulary.id });
      vocabId = inserted[0]!.id;
    }

    // Increment scaffoldedCount for scaffolded items (correct but prompted)
    if (item.performance === 'scaffolded') {
      await db.update(userVocabulary)
        .set({ scaffoldedCount: sql`${userVocabulary.scaffoldedCount} + 1` })
        .where(and(
          eq(userVocabulary.userId, userId),
          eq(userVocabulary.lexemeId, existingLexeme.id)
        ));
    }

    // Log the review
    await db.insert(reviewLogs).values({
      userVocabularyId: vocabId,
      userId,
      grade,
      state: card.state,
      stability: card.stability,
      difficulty: card.difficulty,
      elapsedDays: card.elapsedDays,
      scheduledDays: card.scheduledDays,
      provenance,
    });

    // Apply semantic ripple effect
    if (existingLexeme.embedding) {
      try {
        await applySemanticRipple(userId, existingLexeme.id, grade, existingLexeme.embedding);
      } catch (err) {
        console.warn(`[Supervisor] Ripple effect failed for ${existingLexeme.lemma}:`, err);
      }
    }

    updates.push({
      lexemeId: existingLexeme.id,
      oldState,
      newState: result.state,
      grade,
      lexemeIndex: idx,
      isNew: !currentVocab,
    });
    tracking[idx] = 'tracked';

  }

  if (updates.length > 0) {
    console.log(`[Supervisor] FSRS updated ${updates.length} word(s): ${updates.map(u => `${u.lexemeId}:${u.oldState}→${u.newState}`).join(', ')}`);
  }

  // Fill in any lexemes that didn't explicitly set tracking (e.g. target word branch
  // may have hit an early return or the lexeme wasn't reached). Default to 'analyzed'
  // for the visible-but-not-stored case, 'noop' as a fallback.
  for (let i = 0; i < analysis.lexemes.length; i++) {
    if (tracking[i] === undefined) tracking[i] = 'analyzed';
  }

  return { updates, tracking };
}

/**
 * Semantic ripple: when a word is reviewed, apply fractional micro-boosts/penalties
 * to its nearest semantic neighbors via pgvector HNSW.
 */
async function applySemanticRipple(
  userId: string,
  lexemeId: string,
  grade: FSRSGrade,
  embedding: number[],
): Promise<void> {
  const embeddingStr = JSON.stringify(embedding);

  // Find nearest semantic neighbors via HNSW
  const neighbors = await db.execute(sql`
    SELECT id, lemma, embedding <=> ${embeddingStr}::vector AS distance
    FROM lexemes
    WHERE id != ${lexemeId}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT 5
  `);

  // Apply fractional micro-boost (grade 3-4) or penalty (grade 1-2)
  for (const neighbor of neighbors as any[]) {
    const microAdjust = grade >= 3 ? 0.02 : -0.02;
    // Closer words get stronger ripple
    const rippleStrength = microAdjust * (1 - neighbor.distance);

    await db.update(userVocabulary)
      .set({ stability: sql`stability * (1 + ${rippleStrength}::real)` })
      .where(and(
        eq(userVocabulary.userId, userId),
        eq(userVocabulary.lexemeId, neighbor.id)
      ));
  }
}

// ============================================================================
// PROCESSOR (DB population)
// ============================================================================

export interface UtteranceAnalysisResult {
  analysis: UtteranceAnalysis | null;
  rawPrompt?: string;
  rawResponse?: string;
  /** Cascade pass 1's transcript, when audio was analyzed — see analyzeUtteranceWithLocalLLM. */
  transcript?: string;
}

export interface ProcessorResult {
  analysis: UtteranceAnalysis | null;
  rawPrompt?: string;
  rawResponse?: string;
  /** Cascade pass 1's transcript, when audio was analyzed — see analyzeUtteranceWithLocalLLM. */
  transcript?: string;
  srsUpdates: { lexemeId: string; oldState: number; newState: number; grade: number }[];
  errors: string[];
  structuredErrors?: { lemma: string; grammarRule?: { rule: string; example: string } }[];
  grammarHints?: string[];
  /** Immediate-action triggers from the processor (e.g. language change request). */
  supervisorTriggers?: SupervisorTrigger[];
}

/**
 * Processor pipeline:
 * 1) Analyze utterance (Gemini or local LLM)
 * 2) Update DB (auto-create lexemes, update SRS)
 *
 * NOTE: This should be cheap + fast-ish and run on every user turn.
 * Goal selection / "what to teach" is the Supervisor's job.
 */
export async function runProcessor(
  userId: string,
  utterance: string,
  context: string,
  options: {
    useGemini?: boolean;
    llmUrl?: string;
    llmModel?: string;
    llmKey?: string;
    recentHistory?: string;
    /**
     * Audio-aware chat history (recent user audio as audio_url content, older
     * audio collapsed). When provided, the Processor uses this for analysis
     * so it can critique pronunciation in addition to lexemes/grammar.
     */
    historyMessages?: any[];
    /**
     * Hard ceiling on how many lexemes this turn can physically contain
     * (audio duration × ~3 words/sec, or the transcript's word count).
     * An analysis exceeding it is a hallucination and is dropped wholesale —
     * the prompt states the same ceiling, but prompt instructions have
     * repeatedly failed to bind the 12B (confirmed live 2026-07-02: a 0.64s
     * clip returned 4 invented lexemes despite a stated ~2-word ceiling),
     * so the enforcement lives here in code.
     */
    maxLexemes?: number;
    /**
     * Plain text of the tutor's last 1-2 turns — for the deterministic echo
     * gate in updateSRSFromAnalysis (learner-field spec §3.3). Matched in
     * code only, never placed in the grading LLM's prompt.
     */
    tutorRecentText?: string;
    /**
     * Evidence weight tag for this call's graded lexemes (spec §3.2).
     * 'probe': deliberate elicitation (onboarding staircase) — highest
     * trust. 'conversation' (default): passive inference from open dialogue.
     */
    provenance?: 'probe' | 'conversation';
    /**
     * 2026-07-10: transcript already produced by the STT node's inline
     * transcription (GemmaAudioSTT.configureTranscription). When present,
     * the grading pass uses it as the verified word-identity anchor and
     * skips its own pass-1 transcription call — one less GPU round-trip,
     * and grading stays anchored to the SAME text the conversation saw.
     */
    knownTranscript?: string;
  } = {}
): Promise<ProcessorResult> {
  const result: ProcessorResult = {
    analysis: null,
    srsUpdates: [],
    errors: [],
  };

  console.log(`[Processor] Processing: "${utterance.substring(0, 50)}..."`);

  // Fetch user's languages for prompt injection.
  // Both target and native are passed so the LLM can disambiguate mixed
  // utterances (e.g. "I went to the praia" → "praia" is pt, rest is en).
  let targetLanguage = 'Russian';
  let nativeLanguage = 'English';
  let targetIso = 'ru';
  let nativeIso = 'en';
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    // Names come from config/languages.ts, not a local map. The map that
    // used to live here had no 'el', so a Greek learner's grading prompt
    // read "Identify the el words" — and "el" is the Spanish article, so
    // the utterances came back analysed as Spanish.
    if (user?.targetLanguage) {
      targetIso = user.targetLanguage;
      targetLanguage = nativeLanguageName(user.targetLanguage);
    }
    if (user?.nativeLanguage) {
      nativeIso = user.nativeLanguage;
      nativeLanguage = nativeLanguageName(user.nativeLanguage);
    }
  } catch { /* non-fatal — fall back to defaults */ }

  // 1) Analyze utterance
  let analysisResult: UtteranceAnalysisResult | null = null;
  if (options.useGemini !== false && process.env.GOOGLE_API_KEY) {
    analysisResult = await analyzeUtteranceWithGemini(utterance, context, targetLanguage, options.recentHistory, nativeLanguage, targetIso, nativeIso);
  }

  if (!analysisResult?.analysis) {
    analysisResult = await analyzeUtteranceWithLocalLLM(
      utterance,
      context,
      options.llmUrl,
      options.llmModel,
      targetLanguage,
      options.recentHistory,
      options.llmKey,
      options.historyMessages,
      nativeLanguage,
      targetIso,
      nativeIso,
      options.knownTranscript,
    );
  }

  if (analysisResult) {
    result.analysis = analysisResult.analysis;
    result.rawPrompt = analysisResult.rawPrompt;
    result.rawResponse = analysisResult.rawResponse;
    result.transcript = analysisResult.transcript;
  }

  if (!result.analysis) {
    result.errors.push('Failed to analyze utterance');
    console.warn('[Processor] Analysis failed, skipping SRS update');
    return result;
  }

  // 1.2) Physical-plausibility gate: more lexemes than words that could fit
  // in the clip means the model transcribed sounds that weren't there. Drop
  // the whole lexeme set (a partial slice would keep hallucinated words too —
  // there's no way to know which ones are real). Triggers are kept: they're
  // suspect on a hallucinated turn, but dropping a real "switch to Spanish"
  // request costs more than a spurious trigger the handler can survive.
  if (
    options.maxLexemes != null &&
    result.analysis.lexemes.length > options.maxLexemes
  ) {
    console.warn(
      `[Processor] Dropping ${result.analysis.lexemes.length} lexemes — exceeds physical ceiling ` +
      `of ${options.maxLexemes} for this turn (hallucination guard). Triggers kept.`,
    );
    result.errors.push(`hallucination_guard: ${result.analysis.lexemes.length} lexemes > ceiling ${options.maxLexemes}`);
    result.analysis.lexemes = [];
  }

  // 1.5) Extract structured errors + the per-turn note for goal system / tutor.
  // native_substitution included: falling back to a native word is a real
  // error signal the goal-seeking system should see (e.g. "keeps saying
  // 'this' instead of the Portuguese word"), not just wrong_use/recall_fail.
  result.structuredErrors = result.analysis.lexemes
    .filter(l => l.performance === 'wrong_use' || l.performance === 'recall_fail' || l.performance === 'native_substitution' || l.performance === 'wrong_tone')
    .map(l => ({
      lemma: l.lemma,
      grammarRule: l.grammarRule ?? (l.performance === 'native_substitution'
        ? { rule: 'native_substitution', example: `used native word "${l.lemma}" instead of the target-language word` }
        : l.performance === 'wrong_tone'
        ? { rule: 'wrong_tone', example: `right word, wrong tone on "${l.lemma}"` }
        : undefined),
    }));

  // The single per-turn note replaced grammarHints[]/pronunciationNotes;
  // downstream consumers (prompt tail, goal system, session stats) all take
  // string[] so the note rides the existing grammarHints plumbing.
  result.grammarHints = result.analysis.note
    ? [result.analysis.note]
    : (result.analysis.grammarHints || []);

  // Extract supervisor triggers for immediate pipeline action
  result.supervisorTriggers = result.analysis.supervisorTriggers || [];
  if (result.supervisorTriggers.length > 0) {
    console.log(`[Processor] ${result.supervisorTriggers.length} supervisor trigger(s): ${result.supervisorTriggers.map(t => `${t.type}${t.value ? '=' + t.value : ''}`).join(', ')}`);
  }

  // 2) Update SRS levels
  try {
    const srsResult = await updateSRSFromAnalysis(userId, result.analysis, options.tutorRecentText, options.provenance);
    result.srsUpdates = srsResult.updates;
    // tracking[i] tells the dashboard which lexemes were stored vs just displayed;
    // expose it on the analysis for the UI emit in tutor-event-driven.ts.
    if (result.analysis) {
      (result.analysis as UtteranceAnalysis & { tracking?: LexemeTrackingStatus[] }).tracking = srsResult.tracking;
    }
  } catch (err) {
    result.errors.push(`SRS update failed: ${err}`);
  }

  console.log(`[Processor] Complete: ${result.srsUpdates.length} SRS updates`);
  return result;
}

// ============================================================================
// MAIN SUPERVISOR FUNCTION
// ============================================================================

/**
 * Run the full supervisor pipeline:
 * 1. Analyze utterance (Gemini or local LLM)
 * 2. Update SRS levels
 * 3. Check/update goals
 *
 * This should be called from the UserInputTranscribed event handler,
 * NOT as an LLM tool call.
 */
export async function runSupervisor(
  userId: string,
  utterance: string,
  context: string,
  options: {
    useGemini?: boolean;
    llmUrl?: string;
    llmModel?: string;
    llmKey?: string;
    recentHistory?: string;
  } = {}
): Promise<SupervisorResult> {
  const result: SupervisorResult = {
    analysis: null,
    srsUpdates: [],
    goalUpdate: null,
    errors: [],
  };

  console.log(`[Supervisor] Processing: "${utterance.substring(0, 50)}..."`);

  // 1-2. Run processor (analysis + DB updates)
  const proc = await runProcessor(userId, utterance, context, options);
  result.analysis = proc.analysis;
  result.srsUpdates = proc.srsUpdates;
  result.errors.push(...proc.errors);
  result.structuredErrors = proc.structuredErrors;
  result.grammarHints = proc.grammarHints;

  // 3. Update goals with structured errors from analysis
  try {
    result.goalUpdate = await ContextManager.updateGoals(userId,
      proc.structuredErrors
        ? { errors: proc.structuredErrors, grammarHints: proc.grammarHints || [] }
        : undefined
    );
  } catch (err) {
    result.errors.push(`Goal check failed: ${err}`);
  }

  console.log(`[Supervisor] Complete: ${result.srsUpdates.length} SRS updates, ` +
    `goal: ${result.goalUpdate ? 'changed' : 'no change'}`);

  return result;
}
