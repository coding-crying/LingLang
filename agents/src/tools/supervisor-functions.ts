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

import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { learningProgress, lexemes, units, users, activeGoals } from '../db/schema.js';
import { ContextManager } from '../lib/context.js';

// ============================================================================
// TYPES
// ============================================================================

export interface LexemeAnalysis {
  lemma: string;
  form: string;
  pos: string;
  performance: 'introduced' | 'correct_use' | 'wrong_use' | 'recall_fail';
  grammarRule?: { rule: string; example: string };
}

export interface UtteranceAnalysis {
  language: string;
  lexemes: LexemeAnalysis[];
  grammarHints: string[];
}

export interface SupervisorResult {
  analysis: UtteranceAnalysis | null;
  srsUpdates: { lexemeId: string; oldLevel: number; newLevel: number }[];
  goalUpdate: string | null;
  errors: string[];
}

// ============================================================================
// ANALYSIS FUNCTION
// ============================================================================

// Simplified prompt for small local models (gemma3:4b, phi3, etc.)
const ANALYSIS_PROMPT_SIMPLE = `Extract words from the user's utterance and auto-detect the language. Return JSON only.

Format:
{"language":"ISO-639-1 code","lexemes":[{"lemma":"word","pos":"NOUN","performance":"correct_use"}]}

pos: NOUN, VERB, ADJ, ADV, PRON, PREP, CONJ, NUM
performance: correct_use (used correctly), wrong_use (error made)

IMPORTANT: Detect which language is being used (ru, es, fr, pt, ar, etc.) and return its ISO code in the "language" field.

Example:
Input: "Я хочу воду"
Output: {"language":"ru","lexemes":[{"lemma":"я","pos":"PRON","performance":"correct_use"},{"lemma":"хотеть","pos":"VERB","performance":"correct_use"},{"lemma":"вода","pos":"NOUN","performance":"correct_use"}]}`;

// Full prompt for more capable models (Gemini, GPT-4, Ministral)
const ANALYSIS_PROMPT_FULL = `You are a comprehensive language learning analysis expert.
Your role is to extract detailed grammatical information for building an intelligent graph-based learning system.

# Output Format
Return ONLY a JSON object with this structure:
{
  "language": "auto-detected ISO code (ru, es, fr, etc.)",
  "lexemes": [
    {
      "lemma": "string (root form)",
      "form": "string (used form)",
      "pos": "NOUN|VERB|ADJ...",
      "performance": "introduced|correct_use|wrong_use|recall_fail",
      "grammarRule": { "rule": "string", "example": "string" } (optional)
    }
  ],
  "grammarHints": ["string"]
}

Performance values:
- "introduced": First time user encountered this word
- "correct_use": User used the word correctly in context
- "wrong_use": User made an error with this word (wrong form, wrong meaning)
- "recall_fail": User couldn't remember or struggled with the word`;

/**
 * Analyze an utterance using the local LLM (Ollama)
 * Uses simplified prompt for small models like gemma3:4b
 * Falls back gracefully if analysis fails
 */
export async function analyzeUtteranceWithLocalLLM(
  utterance: string,
  context: string,
  llmUrl: string = 'http://localhost:11434/v1'
): Promise<UtteranceAnalysis | null> {
  const model = process.env.LOCAL_LLM_MODEL || 'gemma3:4b';

  // Use simple prompt for small models, full prompt for larger ones
  const isSmallModel = model.includes('gemma3:4b') || model.includes('phi') || model.includes('qwen2:1');
  const prompt = isSmallModel ? ANALYSIS_PROMPT_SIMPLE : ANALYSIS_PROMPT_FULL;

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
          { role: 'user', content: `Analyze: "${utterance}"` }
        ],
        temperature: 0.1, // Low temperature for consistent JSON
        max_tokens: 500,  // Don't need long responses
      }),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[Supervisor] LLM request failed: ${response.status}`);
      return null;
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
      return null;
    }

    // Clean up common JSON formatting issues from LLMs
    let cleanJson = jsonMatch[0]
      // Remove comments
      .replace(/\/\/.*$/gm, '')                    // Remove // comments
      .replace(/\/\*[\s\S]*?\*\//g, '')           // Remove /* */ comments
      // Fix trailing commas
      .replace(/,(\s*[}\]])/g, '$1')              // Remove trailing commas
      // Quote unquoted keys (but not inside strings)
      .replace(/([{,]\s*)(\w+)(\s*):/g, '$1"$2"$3:')  // Quote keys
      // Fix quotes
      .replace(/:\s*'([^']*)'/g, ': "$1"')        // Replace single quotes with double
      // Remove extra whitespace
      .replace(/\s+/g, ' ')                       // Normalize whitespace
      .trim();

    let analysis: UtteranceAnalysis;
    try {
      analysis = JSON.parse(cleanJson) as UtteranceAnalysis;
    } catch (parseErr) {
      // Log the actual malformed JSON for debugging
      console.error('[Supervisor] Malformed JSON:', cleanJson.substring(0, 500));
      console.error('[Supervisor] Parse error:', parseErr);
      return null;
    }

    console.log(`[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes`);
    return analysis;

  } catch (err) {
    console.error('[Supervisor] Analysis error:', err);
    return null;
  }
}

/**
 * Analyze an utterance using Gemini API (more accurate but requires API key)
 */
export async function analyzeUtteranceWithGemini(
  utterance: string,
  context: string
): Promise<UtteranceAnalysis | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[Supervisor] No GOOGLE_API_KEY, skipping Gemini analysis');
    return null;
  }

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
        parts: [{ text: `${ANALYSIS_PROMPT_FULL}\n\nContext: ${context}\nUser said: "${utterance}"` }]
      }]
    });

    const elapsed = Date.now() - startTime;
    console.log(`[Supervisor] Gemini responded in ${elapsed}ms`);

    const responseText = result.text || '';
    const cleanedText = responseText.replace(/^```json\s*/, '').replace(/```$/, '').trim();

    const analysis = JSON.parse(cleanedText) as UtteranceAnalysis;
    console.log(`[Supervisor] Extracted ${analysis.lexemes?.length || 0} lexemes`);

    return analysis;

  } catch (err) {
    console.error('[Supervisor] Gemini analysis error:', err);
    return null;
  }
}

// ============================================================================
// SRS UPDATE FUNCTION
// ============================================================================

/**
 * Update SRS levels based on analysis results
 */
export async function updateSRSFromAnalysis(
  userId: string,
  analysis: UtteranceAnalysis
): Promise<{ lexemeId: string; oldLevel: number; newLevel: number }[]> {
  const updates: { lexemeId: string; oldLevel: number; newLevel: number }[] = [];

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

    // Fallback: try GENERAL pos for Duolingo words
    if (!existingLexeme) {
      existingLexeme = await db.query.lexemes.findFirst({
        where: and(
          eq(lexemes.lemma, item.lemma),
          eq(lexemes.pos, 'GENERAL'),
          eq(lexemes.language, targetLang)
        )
      });
    }

    if (!existingLexeme) {
      // Could auto-create lexeme here, or skip
      console.log(`[Supervisor] Unknown lexeme: ${item.lemma} (${item.pos})`);
      continue;
    }

    // Get current progress
    const currentProgress = await db.query.learningProgress.findFirst({
      where: and(
        eq(learningProgress.userId, userId),
        eq(learningProgress.lexemeId, existingLexeme.id)
      )
    });

    const oldLevel = currentProgress?.srsLevel || 0;
    let newLevel = oldLevel;

    // Apply Leitner box logic
    switch (item.performance) {
      case 'correct_use':
        newLevel = Math.min(oldLevel + 1, 5);
        break;
      case 'wrong_use':
      case 'recall_fail':
        newLevel = 1; // Back to box 1
        break;
      case 'introduced':
        newLevel = 0; // New word starts at 0
        break;
    }

    // Calculate next review (exponential backoff)
    const daysToAdd = Math.pow(2, newLevel); // 1, 2, 4, 8, 16, 32 days
    const nextReview = Date.now() + (daysToAdd * 24 * 60 * 60 * 1000);

    // Update or create progress record
    if (currentProgress) {
      await db.update(learningProgress)
        .set({
          srsLevel: newLevel,
          nextReview,
          lastSeen: Date.now(),
          encounters: (currentProgress.encounters || 0) + 1,
          correctUses: (currentProgress.correctUses || 0) +
            (item.performance === 'correct_use' ? 1 : 0),
        })
        .where(eq(learningProgress.id, currentProgress.id));
    } else {
      await db.insert(learningProgress).values({
        userId,
        lexemeId: existingLexeme.id,
        srsLevel: newLevel,
        nextReview,
        lastSeen: Date.now(),
        encounters: 1,
        correctUses: item.performance === 'correct_use' ? 1 : 0,
      });
    }

    updates.push({
      lexemeId: existingLexeme.id,
      oldLevel,
      newLevel,
    });

    console.log(`[Supervisor] SRS update: ${item.lemma} ${oldLevel} → ${newLevel}`);
  }

  return updates;
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
  } = {}
): Promise<SupervisorResult> {
  const result: SupervisorResult = {
    analysis: null,
    srsUpdates: [],
    goalUpdate: null,
    errors: [],
  };

  console.log(`[Supervisor] Processing: "${utterance.substring(0, 50)}..."`);

  // 1. Analyze utterance
  if (options.useGemini !== false && process.env.GOOGLE_API_KEY) {
    result.analysis = await analyzeUtteranceWithGemini(utterance, context);
  }

  // Fallback to local LLM if Gemini failed or wasn't used
  if (!result.analysis) {
    result.analysis = await analyzeUtteranceWithLocalLLM(
      utterance,
      context,
      options.llmUrl
    );
  }

  // Check if using curriculum mode (needed in multiple places)
  const useCurriculum = process.env.USE_CURRICULUM === 'true';

  if (!result.analysis) {
    result.errors.push('Failed to analyze utterance');
    console.warn('[Supervisor] Analysis failed, skipping SRS update');
  } else {
    // 2. Update SRS levels (skip if using curriculum mode)
    if (!useCurriculum) {
      try {
        result.srsUpdates = await updateSRSFromAnalysis(userId, result.analysis);
      } catch (err) {
        result.errors.push(`SRS update failed: ${err}`);
      }
    } else {
      console.log('[Supervisor] Curriculum mode - skipping SRS updates');
    }
  }

  // 2.5. Check curriculum progress (if using curriculum mode)
  if (useCurriculum) {
    try {
      const { CurriculumProgress } = await import('../lib/curriculum-progress.js');
      const progress = await CurriculumProgress.checkGoalProgress(userId, utterance, context);

      if (progress.completed) {
        console.log(`[Supervisor] Goal completed: ${progress.goalTopic}`);
        result.goalUpdate = `COMPLETED: Great job! You completed "${progress.goalTopic}"`;
      }
    } catch (err) {
      result.errors.push(`Curriculum progress check failed: ${err}`);
    }
  }

  // 3. Check goals (always runs, even if analysis failed)
  if (!result.goalUpdate) {  // Only check if not already set by curriculum
    try {
      result.goalUpdate = await ContextManager.getDynamicGoal(userId);
    } catch (err) {
      result.errors.push(`Goal check failed: ${err}`);
    }
  }

  console.log(`[Supervisor] Complete: ${result.srsUpdates.length} SRS updates, ` +
    `goal: ${result.goalUpdate ? 'changed' : 'no change'}`);

  return result;
}
