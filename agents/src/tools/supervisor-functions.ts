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

// ============================================================================
// TYPES
// ============================================================================

export interface LexemeAnalysis {
  lemma: string;
  form: string;
  pos: string;
  performance: 'not_assessed' | 'correct_use' | 'wrong_use' | 'recall_fail' | 'scaffolded'; // not_assessed kept for backward compat
  grammarRule?: { rule: string; example: string };
}

export interface UtteranceAnalysis {
  language: string;
  lexemes: LexemeAnalysis[];
  grammarHints: string[];
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
function buildSimplePrompt(targetLanguage: string): string {
  return `Extract words from the user's utterance. The user is learning ${targetLanguage}. Auto-detect the language and use the hint as ground truth. Return JSON only.

Format:
{"language":"ISO-639-1 code","lexemes":[{"lemma":"word","pos":"NOUN","performance":"correct_use"}]}

pos: NOUN, VERB, ADJ, ADV, PRON, PREP, CONJ, NUM
performance:
- correct_use: used correctly (default for common function words like articles, basic prepositions, pronouns, conjunctions)
- wrong_use: error made (wrong form, wrong case, wrong agreement)
- recall_fail: user couldn't remember the word
- scaffolded: user used the word correctly BUT the tutor had just asked them to use this specific word, or they repeated the tutor's correction verbatim — this is prompted correctness, not independent mastery

IMPORTANT: List ALL words including function words. Tag common function words (articles, basic prepositions, pronouns, conjunctions) as correct_use by default — they're trivially correct. Only tag a function word as wrong_use if the user clearly misused it (e.g. wrong case after a preposition). Do NOT tag any word as "introduced" — you cannot know if a word was introduced for the first time.

Example:
Input: "Я хочу воду"
Output: {"language":"ru","lexemes":[{"lemma":"я","pos":"PRON","performance":"correct_use"},{"lemma":"хотеть","pos":"VERB","performance":"correct_use"},{"lemma":"вода","pos":"NOUN","performance":"correct_use"}]}`;
}

/**
 * Build the full analysis prompt for capable models (Gemini, GPT-4, Ministral, etc.).
 * Includes few-shot examples and function-word guidance.
 * Exported so supervisor.ts can import it instead of duplicating.
 */
export function buildFullPrompt(targetLanguage: string): string {
  return `You are a comprehensive language learning analysis expert.
Your role is to extract detailed grammatical information for building an intelligent graph-based learning system.

The user is learning ${targetLanguage}. Auto-detect the language from the utterance but use this hint as ground truth — if the detected language differs, flag it.

# Output Format
Return ONLY a JSON object with this structure:
{
  "language": "auto-detected ISO code (ru, es, fr, etc.)",
  "lexemes": [
    {
      "lemma": "string (root form)",
      "form": "string (used form)",
      "pos": "NOUN|VERB|ADJ...",
      "performance": "correct_use|wrong_use|recall_fail",
      "grammarRule": { "rule": "string", "example": "string" } (optional)
    }
  ],
  "grammarHints": ["string"]
}

# Performance Labels
- "correct_use": User used the word correctly in context. This is the default for common function words (articles, basic prepositions, pronouns, conjunctions) — they're trivially correct, tag them as correct_use.
- "wrong_use": User made an error with this word (wrong form, wrong meaning, wrong case, wrong gender agreement). Even function words can be wrong_use if misused (e.g. wrong case after a preposition).
- "recall_fail": User couldn't remember or struggled with the word (long pause, incomplete attempt, gave up).
- "scaffolded": User used the word correctly BUT the tutor had just asked them to use this specific word, or they repeated the tutor's correction verbatim. This is prompted correctness, not independent mastery.

DO NOT use any performance label other than the four above. In particular, do NOT use "introduced" or "not_assessed" — you cannot determine whether a word was encountered for the first time, and every word the user produces should be evaluated.

# Function Word Guidance
List ALL words the user said, including function words. Tag common function words (articles, basic prepositions, pronouns, conjunctions) as correct_use by default — they are trivially correct and not worth nitpicking for errors. Only tag a function word as wrong_use if the user clearly misused it (e.g. "в магазине" when they meant direction "в магазин").

Examples of words to tag correct_use by default: и, а, но, в, на, с, к, я, ты, он, мы, el, la, le, les, un, une, y, o, en, de, the, a, an, and, but, in, on, I, you, he, she.

# Few-Shot Examples

Example 1 — Correct Russian sentence:
Input: "Я хочу пить воду"
Output:
{"language":"ru","lexemes":[{"lemma":"я","form":"я","pos":"PRON","performance":"correct_use"},{"lemma":"хотеть","form":"хочу","pos":"VERB","performance":"correct_use"},{"lemma":"пить","form":"пить","pos":"VERB","performance":"correct_use"},{"lemma":"вода","form":"воду","pos":"NOUN","performance":"correct_use","grammarRule":{"rule":"accusative case for direct objects","example":"вода → воду (nominative → accusative)"}}],"grammarHints":[]}

Example 2 — Sentence with an error:
Input: "Я хочеть воду"
Output:
{"language":"ru","lexemes":[{"lemma":"я","form":"я","pos":"PRON","performance":"correct_use"},{"lemma":"хотеть","form":"хочеть","pos":"VERB","performance":"wrong_use","grammarRule":{"rule":"1st person singular conjugation of хотеть","example":"я хочу (not хочеть)"}},{"lemma":"вода","form":"воду","pos":"NOUN","performance":"correct_use"}],"grammarHints":["хотеть conjugation: я хочу, ты хочешь, он хочет, мы хотим, вы хотите, они хотят"]}

Example 3 — Mixed correct and incorrect usage:
Input: "Вчера я шёл в магазине"
Output:
{"language":"ru","lexemes":[{"lemma":"вчера","form":"вчера","pos":"ADV","performance":"correct_use"},{"lemma":"я","form":"я","pos":"PRON","performance":"correct_use"},{"lemma":"идти","form":"шёл","pos":"VERB","performance":"correct_use"},{"lemma":"в","form":"в","pos":"PREP","performance":"correct_use"},{"lemma":"магазин","form":"магазине","pos":"NOUN","performance":"wrong_use","grammarRule":{"rule":"в + accusative for direction (movement toward), not prepositional","example":"в магазин (to the store) vs. в магазине (at the store)"}}],"grammarHints":["в + accusative = direction of movement (в магазин), в + prepositional = location (в магазине)"]}

Example 4 — Scaffolded correct use:
Context: Tutor just said "Try saying: Я хочу кофе"
Input: "Я хочу кофе"
Output:
{"language":"ru","lexemes":[{"lemma":"я","form":"я","pos":"PRON","performance":"correct_use"},{"lemma":"хотеть","form":"хочу","pos":"VERB","performance":"scaffolded","grammarRule":{"rule":"tutor prompted this exact construction","example":"tutor: 'Try saying: Я хочу кофе' → learner repeated it"}},{"lemma":"кофе","form":"кофе","pos":"NOUN","performance":"scaffolded"}],"grammarHints":[]}`;
}

/** Backward-compatible alias: the full prompt template with a default language. */
export const ANALYSIS_PROMPT_FULL = buildFullPrompt('Russian');

/**
 * Analyze an utterance using the local LLM (llama-swap)
 * Uses simplified prompt for small models like gemma3:4b
 * Falls back gracefully if analysis fails
 */
export async function analyzeUtteranceWithLocalLLM(
  utterance: string,
  context: string,
  llmUrl: string = 'http://localhost:8082/v1',
  llmModel?: string,
  targetLanguage: string = 'Russian',
  recentHistory?: string,
): Promise<UtteranceAnalysisResult> {
  const model = llmModel || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';

  // Use simple prompt for small models, full prompt for larger ones
  // Models with <4B params or explicit :4b quant tags use simple prompt
  const isSmallModel = model.includes(':4b') || model.includes(':1b') || model.includes(':0.5b') || model.includes('phi3:');
  const prompt = isSmallModel ? buildSimplePrompt(targetLanguage) : buildFullPrompt(targetLanguage);
  const historyLine = recentHistory
    ? `\n\nRecent conversation (for scaffolded detection):\n${recentHistory}`
    : '';
  const userPrompt = `Analyze: "${utterance}"${historyLine}`;

  console.log(`[Supervisor] Analyzing with ${model} (${isSmallModel ? 'simple' : 'full'} prompt)`);

  try {
    const startTime = Date.now();

    const response = await fetch(`${llmUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1, // Low temperature for consistent JSON
        max_tokens: 800,  // Enough for detailed analysis with grammarRule
      }),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[Supervisor] LLM request failed: ${response.status}`);
      return { analysis: null, rawPrompt: prompt + '\n' + userPrompt };
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';

    console.log(`[Supervisor] LLM responded in ${elapsed}ms`);

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = content;
    if (content.includes('```')) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      jsonStr = match ? match[1] : content;
    }

    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Supervisor] No JSON in response:', content.substring(0, 100));
      return { analysis: null, rawPrompt: prompt + '\n' + userPrompt, rawResponse: content };
    }

    // Clean up common JSON formatting issues from LLMs
    let cleanJson = jsonMatch[0]
      .replace(/,(\s*[}\]])/g, '$1')  // Remove trailing commas
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":')  // Quote unquoted keys
      .replace(/:\s*'([^']*)'/g, ': "$1"')  // Replace single quotes with double
      .replace(/\]\s*\{/g, '],{')  // Fix missing commas between array elements
      .replace(/\}\s*\{/g, '},{')  // Fix missing commas between objects in arrays
      .replace(/"\s*\n\s*"/g, '","')  // Fix missing commas between string values
      .replace(/\\\n/g, '\\n');  // Fix escaped newlines in strings

    const analysis = JSON.parse(cleanJson) as UtteranceAnalysis;
    console.log(`[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes`);

    return { analysis, rawPrompt: prompt + '\n' + userPrompt, rawResponse: content };

  } catch (err) {
    console.error('[Supervisor] Analysis error:', err);
    return { analysis: null, rawPrompt: prompt + '\n' + userPrompt };
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
): Promise<UtteranceAnalysisResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[Supervisor] No GOOGLE_API_KEY, skipping Gemini analysis');
    return { analysis: null };
  }

  const historyLine = recentHistory
    ? `\n\nRecent conversation (for scaffolded detection):\n${recentHistory}`
    : '';

  const promptText = `${buildFullPrompt(targetLanguage)}\n\nContext: ${context}${historyLine}\nUser said: "${utterance}"`;

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
    const cleanedText = responseText.replace(/^```json\s*/, '').replace(/```$/, '').trim();

    const analysis = JSON.parse(cleanedText) as UtteranceAnalysis;
    console.log(`[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes`);

    return { analysis, rawPrompt: promptText, rawResponse: responseText };

  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn(`[Supervisor] Gemini analysis error: ${msg.slice(0, 120)}`);
    return { analysis: null, rawPrompt: promptText };
  }
}

// ============================================================================
// SRS UPDATE FUNCTION
// ============================================================================

/**
 * Update FSRS state based on analysis results.
 * Maps LLM performance labels to FSRS grades, applies the FSRS algorithm,
 * logs reviews, and applies semantic ripple effects.
 */
export async function updateSRSFromAnalysis(
  userId: string,
  analysis: UtteranceAnalysis
): Promise<{ lexemeId: string; oldState: number; newState: number; grade: FSRSGrade }[]> {
  const updates: { lexemeId: string; oldState: number; newState: number; grade: FSRSGrade }[] = [];

  // Get user's target language
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  const targetLang = user?.targetLanguage || analysis.language || 'ru';

  for (const item of analysis.lexemes) {
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
      // Auto-create lexeme
      const safeLemma = (item.lemma || '').trim();
      const safePos = (item.pos || 'GENERAL').trim() || 'GENERAL';
      const lexemeId = `${targetLang}:${safeLemma.toLowerCase()}:${safePos}`;

      console.log(`[Processor] Auto-creating lexeme: ${safeLemma} (${safePos}) [${targetLang}]`);

      await db.insert(lexemes).values({
        id: lexemeId,
        lemma: safeLemma,
        pos: safePos,
        language: targetLang,
        translation: '',
        unitId: null,
        gender: null,
        morphFeatures: null,
      }).onConflictDoNothing();

      existingLexeme = await db.query.lexemes.findFirst({
        where: eq(lexemes.id, lexemeId),
      });

      if (!existingLexeme) {
        console.warn(`[Processor] Failed to auto-create lexeme: ${lexemeId}`);
        continue;
      }
    }

    // Map performance to FSRS grade
    // Treat 'not_assessed' as 'correct_use' (trivially correct) — the prompt tells
    // the LLM to use correct_use for function words, but we handle legacy output too.
    const grade = voiceToGrade({
      performance: item.performance === 'not_assessed' ? 'correct_use' : item.performance,
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
    });

    console.log(`[Supervisor] FSRS update: ${item.lemma} state ${oldState} → ${result.state} (grade ${grade}, stability ${result.stability.toFixed(2)}, due in ${result.scheduledDays}d)`);
  }

  return updates;
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
    recentHistory?: string;
  } = {}
): Promise<ProcessorResult> {
  const result: ProcessorResult = {
    analysis: null,
    srsUpdates: [],
    errors: [],
  };

  console.log(`[Processor] Processing: "${utterance.substring(0, 50)}..."`);

  // Fetch user's target language for prompt injection
  let targetLanguage = 'Russian';
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    if (user?.targetLanguage) {
      // Convert ISO code to display name if needed
      const langNames: Record<string, string> = {
        ru: 'Russian', es: 'Spanish', fr: 'French', pt: 'Portuguese',
        ar: 'Arabic', de: 'German', zh: 'Chinese', ja: 'Japanese',
        ko: 'Korean', it: 'Italian',
      };
      targetLanguage = langNames[user.targetLanguage] || user.targetLanguage;
    }
  } catch { /* non-fatal — fall back to default */ }

  // 1) Analyze utterance
  let analysisResult: UtteranceAnalysisResult | null = null;
  if (options.useGemini !== false && process.env.GOOGLE_API_KEY) {
    analysisResult = await analyzeUtteranceWithGemini(utterance, context, targetLanguage, options.recentHistory);
  }

  if (!analysisResult?.analysis) {
    analysisResult = await analyzeUtteranceWithLocalLLM(
      utterance,
      context,
      options.llmUrl,
      options.llmModel,
      targetLanguage,
      options.recentHistory,
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

  // 2) Update SRS levels
  try {
    result.srsUpdates = await updateSRSFromAnalysis(userId, result.analysis);
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
