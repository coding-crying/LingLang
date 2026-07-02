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
  'NUM',      // numerals (one, two, um, dois)
  'CCONJ',    // coordinating conjunctions
  'SCONJ',    // subordinating conjunctions
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
   * ISO 639-1 code of the language this specific word is in. Critical for
   * mixed utterances ("I want привет") where the LLM must tag "want" as
   * the user's native language and "привет" as the target language. If
   * omitted, the processor falls back to the utterance-level `language`
   * field and the legacy `performance === 'native_substitution'` check.
   */
  language?: string;
  performance: 'correct_use' | 'wrong_use' | 'recall_fail' | 'scaffolded' | 'native_substitution';
  grammarRule?: { rule: string; example: string };
  /**
   * Pronunciation notes for the lexeme in this turn. Only present when the
   * user spoke (audio available) AND the LLM observed something noteworthy
   * (wrong stress, vowel quality, palatalization, devoicing, etc.).
   * Use "clear" or omit for normal/correct pronunciation.
   */
  pronunciation?: {
    stress: 'correct' | 'wrong' | 'unclear';
    notes?: string;  // short human-readable observation
  };
}

export interface UtteranceAnalysis {
  language: string;
  lexemes: LexemeAnalysis[];
  grammarHints: string[];
  /**
   * Per-turn pronunciation summary (only present when audio was available).
   * Captures things that aren't tied to a specific lexeme — intonation,
   * hesitation, sentence-level rhythm, vowel reduction, etc.
   */
  pronunciationNotes?: string;
  /**
   * Immediate-action triggers detected by the processor. When non-empty,
   * the pipeline dispatches the supervisor immediately (no waiting for
   * the timer cycle). Each trigger has a type and optional value/reason.
   */
  supervisorTriggers?: SupervisorTrigger[];
  /**
   * Style signals observed in this turn — used for personality mirroring.
   * The LLM tags the user's style on each turn; the processor EMA's these
   * into the user's `user_style` table.
   *
   * Keys:
   * - humor: 'none' | 'dry' | 'sarcastic' | 'warm' | 'literal'
   * - pacing: 'fast' | 'medium' | 'slow' (turn length, terseness, response rhythm)
   * - register: 'formal' | 'casual' | 'profane' (slang, contractions, profanity)
   * - profanity: 'no' | 'mild' | 'heavy' (count of swear words)
   * - preamble: 'low' | 'medium' | 'high' (does the user tolerate or expect the tutor's intro lines?)
   * - bsCallouts: 'tolerant' | 'neutral' | 'skeptical' (does the user push back on wrong info?)
   */
  styleSignals?: Record<string, string>;
}

export interface SupervisorTrigger {
  type: 'language_change' | 'difficulty_adjustment' | 'goal_change' | 'session_feedback' | 'persona_update' | 'onboarding_signal';
  /** For language_change: ISO code. For difficulty_adjustment: 'easier'|'harder'.
   *  For persona_update: natural-language description.
   *  For onboarding_signal: JSON string with keys: priorStudy?, studyDetails?, goals?, goalDetails?, selfRatedLevel? */
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
 * Build the simplified analysis prompt for small local models.
 * Injects the target language hint so the LLM can verify its auto-detection.
 */
function buildSimplePrompt(targetLanguage: string, nativeLanguage: string = 'English'): string {
  // Now identical to buildFullPrompt — the full prompt is lean enough for all models
  return buildFullPrompt(targetLanguage, nativeLanguage);
}

/**
 * Build the full analysis prompt for capable models (gemma4-26b and up).
 * Includes few-shot examples and function-word guidance.
 * Exported so supervisor.ts can import it instead of duplicating.
 *
 * When the user provides audio (audio_url content in the user message), the
 * model is also asked to score pronunciation on each lexeme and emit a
 * sentence-level pronunciationNotes string. For text-only inputs the model
 * skips those fields.
 */
export function buildFullPrompt(targetLanguage: string, nativeLanguage: string = 'English'): string {
  return `Tag lexemes in a ${nativeLanguage}→${targetLanguage} learner's utterance. Return JSON only.

Tag EACH word's language individually — a ${targetLanguage} word in an ${nativeLanguage} sentence gets "language":"${targetLanguage}". The top-level "language" is the dominant one.

Performance: correct_use | wrong_use | recall_fail | scaffolded | native_substitution
- wrong_use: include grammarRule with rule + example
- native_substitution: language = native code. Applies when learner uses native content word where target word was expected.
- Function words default to correct_use. Only use these 5 labels.

supervisorTriggers (empty array if none):
- language_change: user wants different language. value=ISO code.
- difficulty_adjustment: too easy/hard. value="easier"|"harder"
- goal_change: topic/skill focus within current language. value=topic.
- session_feedback: frustration, want to stop. No value needed.
- onboarding_signal: user reveals background or goals. value=JSON with any of: priorStudy ("none"|"self_taught"|"class"|"immersion"|"heritage"), studyDetails (free text), goals (array: "travel"|"work"|"heritage"|"media"|"academic"|"other"), goalDetails (free text), selfRatedLevel ("pre_a1"|"a1"|"a2"|"b1"|"b2"|"c1"|"c2"). Only fire when user explicitly states something — don't infer.

Example 1 — correct with grammar note:
"Я хочу пить воду"
{"language":"ru","lexemes":[{"lemma":"я","form":"я","pos":"PRON","language":"ru","performance":"correct_use"},{"lemma":"хотеть","form":"хочу","pos":"VERB","language":"ru","performance":"correct_use"},{"lemma":"пить","form":"пить","pos":"VERB","language":"ru","performance":"correct_use"},{"lemma":"вода","form":"воду","pos":"NOUN","language":"ru","performance":"correct_use","grammarRule":{"rule":"accusative for direct objects","example":"вода → воду"}}],"grammarHints":[],"supervisorTriggers":[]}

Example 2 — mixed language + trigger:
"I want to learn Portuguese"
{"language":"en","lexemes":[{"lemma":"I","form":"I","pos":"PRON","language":"en","performance":"correct_use"},{"lemma":"want","form":"want","pos":"VERB","language":"en","performance":"correct_use"},{"lemma":"to","form":"to","pos":"PART","language":"en","performance":"correct_use"},{"lemma":"learn","form":"learn","pos":"VERB","language":"en","performance":"correct_use"},{"lemma":"Portuguese","form":"Portuguese","pos":"NOUN","language":"en","performance":"correct_use"}],"grammarHints":[],"supervisorTriggers":[{"type":"language_change","value":"pt","reason":"User wants to learn Portuguese"}]}

If you observe the user's communication style in this turn, append a "styleSignals" object with at most these keys (omit any you can't observe — don't guess):
- "humor": "none"|"dry"|"warm"  — jokes, irony, plain?
- "pacing": "fast"|"slow"  — terse or long-winded?
- "register": "formal"|"casual"  — slang, contractions?
- "bsCallouts": "tolerant"|"skeptical"  — accepts your responses or pushes back?`;
}

/** Backward-compatible alias: the full prompt template with a default language. */
export const ANALYSIS_PROMPT_FULL = buildFullPrompt('Russian', 'English');

/**
 * Attempt to clean and parse JSON from an LLM response.
 * Handles common formatting issues from smaller/quantized models.
 * Returns parsed object or null if unparseable.
 */
function cleanAndParseJSON(raw: string): UtteranceAnalysis | null {
  // Extract JSON from markdown code blocks
  let jsonStr = raw;
  if (raw.includes('```')) {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    jsonStr = match?.[1] ?? raw;
  }

  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let cleanJson = jsonMatch[0]
    .replace(/,(\s*[}\]])/g, '$1')           // Remove trailing commas
    .replace(/([{,]\s*)(\w+):/g, '$1"$2":')  // Quote unquoted keys
    .replace(/:\s*'([^']*)'/g, ': "$1"')     // Replace single quotes with double
    .replace(/\}\s*\{/g, '},{')             // Missing commas between objects in arrays
    .replace(/\]\s*\{/g, '],{')             // Missing commas between array elements (obj after array)
    .replace(/\}\s*\]/g, '}]')              // Missing commas before closing array
    .replace(/"\s*\n\s*"/g, '","')           // Missing commas between string values
    .replace(/\\\n/g, '\\n')                // Fix escaped newlines in strings
    // Fix missing commas between consecutive string array elements: "word1" "word2"
    .replace(/"\s+"(?=[\wА-яЁё])/g, '","')
    // Fix missing commas between consecutive object array elements: }{ or } {
    .replace(/\}\s+,?\s*\{/g, '},{')
    // Remove single-line comments (// ...) inside JSON
    .replace(/\/\/[^\n"]*/g, '');

  // Attempt balanced brace matching — sometimes the LLM generates extra closing braces
  // Find the shortest valid JSON object by counting brace depth
  let depth = 0;
  let endIdx = -1;
  for (let i = 0; i < cleanJson.length; i++) {
    if (cleanJson[i] === '{') depth++;
    else if (cleanJson[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx >= 0) {
    cleanJson = cleanJson.substring(0, endIdx + 1);
  }

  try {
    return JSON.parse(cleanJson) as UtteranceAnalysis;
  } catch {
    // Last resort: try to fix unescaped quotes inside strings by using JSON5-like approach
    // Replace any inner double quotes that break parsing (rare but happens with examples)
    try {
      // Try progressively: remove grammarRule objects that might contain problematic quotes
      const simplified = cleanJson.replace(/"grammarRule"\s*:\s*\{[^}]*\}/g, '"grammarRule":null');
      return JSON.parse(simplified) as UtteranceAnalysis;
    } catch {
      return null;
    }
  }
}

/**
 * Analyze an utterance using the local LLM (llama-swap)
 * Uses simplified prompt for small models like gemma3:4b
 * Retries with simplified prompt on JSON parse failure
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
): Promise<UtteranceAnalysisResult> {
  const model = llmModel || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';

  // Use simple prompt for small models, full prompt for larger ones
  // Models with <4B params or explicit :4b quant tags use simple prompt
  const isSmallModel = model.includes(':4b') || model.includes(':1b') || model.includes(':0.5b') || model.includes('phi3:');
  const prompt = isSmallModel
    ? buildSimplePrompt(targetLanguage, nativeLanguage)
    : buildFullPrompt(targetLanguage, nativeLanguage);
  const historyLine = recentHistory
    ? `\n\nRecent conversation (for scaffolded detection):\n${recentHistory}`
    : '';
  const userPrompt = `Analyze: "${utterance}"${historyLine}`;

  // If the caller passed audio-aware history (recent user audio as audio_url),
  // we send the audio turns as part of the prompt so the LLM can analyze
  // pronunciation. The user message then becomes audio_url (when the latest
  // turn is audio) or text (when it's text-only). Otherwise we fall back to
  // the legacy flat-text path.
  const hasAudioMessages = !!historyMessages && historyMessages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'audio_url'),
  );

  console.log(
    `[Supervisor] Analyzing with ${model} (${isSmallModel ? 'simple' : 'full'} prompt, ` +
    `${hasAudioMessages ? 'audio' : 'text'}-mode, native=${nativeLanguage})`,
  );

  // Try with full prompt first, then retry with simplified prompt if parse fails
  for (let attempt = 0; attempt < 2; attempt++) {
    const useSimple = attempt > 0;
    const sysPrompt = useSimple
      ? buildSimplePrompt(targetLanguage, nativeLanguage)
      : prompt;

    try {
      const startTime = Date.now();

      const apiKey = llmKey || process.env.PROCESSOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      // Build messages: prefer the audio-aware history if we have it, else legacy.
      let messages: any[];
      if (hasAudioMessages) {
        // The history already includes the latest user turn as audio_url when
        // applicable. Use it as-is and just prepend the system prompt.
        messages = [
          { role: 'system', content: sysPrompt },
          ...historyMessages!,
        ];
      } else {
        messages = [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
        ];
      }

      const response = await fetch(`${llmUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: useSimple ? 400 : 800,
          response_format: { type: 'json_object' },
        }),
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        console.error(`[Supervisor] LLM request failed: ${response.status}`);
        return { analysis: null, rawPrompt: sysPrompt + '\n' + userPrompt };
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      console.log(`[Supervisor] LLM responded in ${elapsed}ms (attempt ${attempt + 1})`);

      const analysis = cleanAndParseJSON(content);
      if (analysis) {
        console.log(
          `[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes` +
          (analysis.pronunciationNotes ? `, pronunciationNotes: "${analysis.pronunciationNotes.slice(0, 60)}"` : ''),
        );
        return { analysis, rawPrompt: sysPrompt + '\n' + userPrompt, rawResponse: content };
      }

      // Parse failed — log and retry with simpler prompt
      if (attempt === 0) {
        console.warn(`[Supervisor] JSON parse failed, retrying with simplified prompt. Raw: ${content.substring(0, 150)}`);
      } else {
        console.error(`[Supervisor] JSON parse failed on retry too. Raw: ${content.substring(0, 150)}`);
        return { analysis: null, rawPrompt: sysPrompt + '\n' + userPrompt, rawResponse: content };
      }

    } catch (err) {
      if (attempt === 0) {
        console.warn(`[Supervisor] Analysis error (will retry): ${String(err).substring(0, 120)}`);
      } else {
        console.error('[Supervisor] Analysis error (retry also failed):', err);
        return { analysis: null, rawPrompt: sysPrompt + '\n' + userPrompt };
      }
    }
  }

  return { analysis: null };
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
): Promise<UtteranceAnalysisResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[Supervisor] No GOOGLE_API_KEY, skipping Gemini analysis');
    return { analysis: null };
  }

  const historyLine = recentHistory
    ? `\n\nRecent conversation (for scaffolded detection):\n${recentHistory}`
    : '';

  const promptText = `${buildFullPrompt(targetLanguage, nativeLanguage)}\n\nContext: ${context}${historyLine}\nUser said: "${utterance}"`;

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

    const analysis = cleanAndParseJSON(responseText);
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
 * When a user says an English word instead of the target word, we need to find
 * or create the target-language equivalent to apply the FSRS penalty.
 *
 * Strategy:
 * 1. Look for a target-language lexeme whose `nativeLemma` matches the English word
 * 2. Look for a target-language lexeme whose `translation` contains the English word
 * 3. Give up — no target equivalent known yet (returns null)
 */
async function findOrCreateTargetEquiv(
  _userId: string,
  nativeLemma: string,
  nativePos: string,
  targetLang: string,
  nativeLexemeId: string,
): Promise<typeof lexemes.$inferSelect | null | undefined> {
  // 1. Check if any target-language lexeme already links to this native word
  const linked = await db.query.lexemes.findFirst({
    where: and(
      eq(lexemes.language, targetLang),
      eq(lexemes.nativeLemma, nativeLemma),
    ),
  });

  if (linked) return linked;

  // 2. Check if any target-language lexeme has this native word as its translation
  const byTranslation = await db.query.lexemes.findFirst({
    where: and(
      eq(lexemes.language, targetLang),
      sql`${lexemes.translation} ILIKE ${'%' + nativeLemma + '%'}`,
    ),
  });

  if (byTranslation) {
    // Backfill the nativeLemma link
    await db.update(lexemes)
      .set({ nativeLemma })
      .where(eq(lexemes.id, byTranslation.id));
    return byTranslation;
  }

  // 3. No target equivalent known. Create a placeholder target lexeme
  //    with the nativeLemma link so we can track when the user DOES learn it.
  const targetLexemeId = `${targetLang}:${nativeLemma.toLowerCase()}:${nativePos}`;
  const exists = await db.query.lexemes.findFirst({
    where: eq(lexemes.id, targetLexemeId),
  });

  if (exists) {
    // Update the nativeLemma if not set
    if (!exists.nativeLemma) {
      await db.update(lexemes)
        .set({ nativeLemma })
        .where(eq(lexemes.id, exists.id));
    }
    return exists;
  }

  console.log(`[Processor] Creating placeholder target lexeme for native word "${nativeLemma}" → [${targetLang}]`);
  await db.insert(lexemes).values({
    id: targetLexemeId,
    lemma: nativeLemma, // temporary — will be overwritten when the actual target word is learned
    pos: nativePos,
    language: targetLang,
    translation: nativeLemma, // native word as "translation" placeholder
    unitId: null,
    gender: null,
    morphFeatures: null,
    nativeLemma: nativeLemma, // link to the native word
  }).onConflictDoNothing();

  autoEmbedLexeme(targetLexemeId, nativeLemma, targetLang, nativeLemma);

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
export type LexemeTrackingStatus = 'tracked' | 'analyzed' | 'noop';

export interface SRSUpdate {
  lexemeId: string;
  oldState: number;
  newState: number;
  grade: FSRSGrade;
  /** Index into the source `analysis.lexemes` array — lets the caller match updates back to lexemes. */
  lexemeIndex: number;
}

export async function updateSRSFromAnalysis(
  userId: string,
  analysis: UtteranceAnalysis
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
      const safePos = (item.pos || 'GENERAL').trim() || 'GENERAL';
      const isFunctionWord = FUNCTION_WORD_POS.has(safePos.toUpperCase()) || isLikelyFunctionToken(safeLemma);

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
      const targetLexeme = await findOrCreateTargetEquiv(userId, safeLemma, safePos, targetLang, nativeLexemeId);

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
        });

        updates.push({
          lexemeId: targetLexeme.id,
          oldState,
          newState: result.state,
          grade,
          lexemeIndex: idx,
        });
        tracking[idx] = 'tracked';

        console.log(`[Processor] Native substitution: "${safeLemma}" → "${targetLexeme.lemma}" (${targetLang}) grade 1, substitution count incremented`);
      } else {
        console.log(`[Processor] Native substitution: "${safeLemma}" but no target equivalent found, skipping FSRS`);
        tracking[idx] = 'noop';
      }

      continue; // Skip the normal flow for native words
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
      const safePos = (item.pos || 'GENERAL').trim() || 'GENERAL';
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

    // Map performance to FSRS grade
    const grade = voiceToGrade({
      performance: item.performance,
    });

    // Get current vocabulary state
    const currentVocab = await db.query.userVocabulary.findFirst({
      where: and(
        eq(userVocabulary.userId, userId),
        eq(userVocabulary.lexemeId, existingLexeme.id)
      )
    });

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
}

export interface ProcessorResult {
  analysis: UtteranceAnalysis | null;
  rawPrompt?: string;
  rawResponse?: string;
  srsUpdates: { lexemeId: string; oldState: number; newState: number; grade: number }[];
  errors: string[];
  structuredErrors?: { lemma: string; grammarRule?: { rule: string; example: string } }[];
  grammarHints?: string[];
  /** Immediate-action triggers from the processor (e.g. language change request). */
  supervisorTriggers?: SupervisorTrigger[];
  /** Style signals observed in this turn (echoed for the dashboard / event log). */
  styleSignals?: Record<string, string>;
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
    const langNames: Record<string, string> = {
      ru: 'Russian', es: 'Spanish', fr: 'French', pt: 'Portuguese',
      ar: 'Arabic', de: 'German', zh: 'Chinese', ja: 'Japanese',
      ko: 'Korean', it: 'Italian', en: 'English',
    };
    if (user?.targetLanguage) {
      targetIso = user.targetLanguage;
      targetLanguage = langNames[user.targetLanguage] || user.targetLanguage;
    }
    if (user?.nativeLanguage) {
      nativeIso = user.nativeLanguage;
      nativeLanguage = langNames[user.nativeLanguage] || user.nativeLanguage;
    }
  } catch { /* non-fatal — fall back to defaults */ }

  // 1) Analyze utterance
  let analysisResult: UtteranceAnalysisResult | null = null;
  if (options.useGemini !== false && process.env.GOOGLE_API_KEY) {
    analysisResult = await analyzeUtteranceWithGemini(utterance, context, targetLanguage, options.recentHistory, nativeLanguage);
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
    );
  }

  if (analysisResult) {
    result.analysis = analysisResult.analysis;
    result.rawPrompt = analysisResult.rawPrompt;
    result.rawResponse = analysisResult.rawResponse;
  }

  if (!result.analysis) {
    result.errors.push('Failed to analyze utterance');
    console.warn('[Processor] Analysis failed, skipping SRS update');
    return result;
  }

  // 1.5) Extract structured errors and grammar hints for goal system / tutor
  result.structuredErrors = result.analysis.lexemes
    .filter(l => l.performance === 'wrong_use' || l.performance === 'recall_fail')
    .map(l => ({ lemma: l.lemma, grammarRule: l.grammarRule }));

  result.grammarHints = result.analysis.grammarHints || [];

  // Extract supervisor triggers for immediate pipeline action
  result.supervisorTriggers = result.analysis.supervisorTriggers || [];
  if (result.supervisorTriggers.length > 0) {
    console.log(`[Processor] ${result.supervisorTriggers.length} supervisor trigger(s): ${result.supervisorTriggers.map(t => `${t.type}${t.value ? '=' + t.value : ''}`).join(', ')}`);
  }

  // 2a) Update user style profile from this turn's styleSignals
  if (result.analysis.styleSignals) {
    try {
      const { updateUserStyle } = await import('../lib/user-style.js');
      await updateUserStyle(userId, result.analysis.styleSignals);
      result.styleSignals = result.analysis.styleSignals;
    } catch (err) {
      console.warn(`[Processor] Style update failed: ${err}`);
    }
  }

  // 2) Update SRS levels
  try {
    const srsResult = await updateSRSFromAnalysis(userId, result.analysis);
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
