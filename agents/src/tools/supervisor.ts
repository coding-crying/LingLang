import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, units, users, grammarRules } from '../db/schema.js';
import * as z from 'zod';
import { llm } from '@livekit/agents';
import OpenAI from 'openai';
import { buildFullPrompt } from './supervisor-functions.js';
import { nativeLanguageName } from '../config/languages.js';

// Lazy init — avoids reading env vars before dotenv.config() runs in tutor.ts
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: process.env.SUPERVISOR_LLM_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.SUPERVISOR_LLM_KEY || '',
      timeout: 15000,
    });
  }
  return _client;
}

interface TurnInput {
  userId: string;
  userUtterance: string;
  context: string;
}

/**
 * Core analysis logic — callable directly from event handlers.
 */
export async function analyzeTurn({ userId, userUtterance, context }: TurnInput) {
  console.log(`[Supervisor] Analyzing: "${userUtterance}" for user ${userId}`);

  // Look up user's target language for the analysis prompt
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  // Same single source of truth as everywhere else. The local map this
  // replaces defaulted to 'Russian', so any language it didn't list — Greek
  // included — was silently analysed as Russian.
  const targetLangName = nativeLanguageName(user?.targetLanguage || 'ru');
  const nativeLangName = nativeLanguageName(user?.nativeLanguage || 'en');

  // 1. Call Step 3.5 Flash via OpenRouter for Analysis
  const model = process.env.SUPERVISOR_LLM_MODEL || 'stepfun/step-3.5-flash:free';
  const result = await getClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: buildFullPrompt(targetLangName, nativeLangName) },
      { role: 'user', content: `Context: ${context}\nUser said: "${userUtterance}"` },
    ],
    temperature: 0.3,
  });

  const responseText = result.choices[0]?.message?.content ?? '';

  // Extract JSON — handle bare JSON or ```json ... ``` code blocks
  let jsonText = responseText.trim();
  const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock?.[1]) jsonText = codeBlock[1].trim();

  let analysis: any = {};
  try {
    analysis = JSON.parse(jsonText || '{}');
  } catch {
    console.warn('[Supervisor] Failed to parse analysis response as JSON');
    return { analysis: { feedback: 'ok', correction: null } };
  }
  console.log("[Supervisor] Analysis result:", JSON.stringify(analysis, null, 2));

  // Validate detected language matches user's target language
  if (user && analysis.language && analysis.language !== user.targetLanguage) {
    console.warn(
      `[Supervisor] Language mismatch! User learning ${user.targetLanguage}, ` +
      `but spoke ${analysis.language}`
    );
  }

  // 2. Update DB
  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  // Per-lemma language routing: don't trust analysis.language (utterance-level)
  // for native substitution checks. Prefer the per-lexeme `item.language` field
  // the new prompt emits. Fall back to user's targetLanguage for the lexeme
  // lookup since we need to know which language's lexeme table to search.
  const targetLang = user?.targetLanguage || 'ru';
  const nativeLang = user?.nativeLanguage || 'en';

  if (analysis.lexemes) {
    for (const item of analysis.lexemes) {
      // Per-lexeme language (may be undefined for old LLM responses that
      // don't yet emit it). When present, it overrides the utterance-level
      // signal for both lexeme lookup and native-substitution classification.
      const itemLang = (item.language || '').toLowerCase().trim();
      const isNative = (itemLang && itemLang === nativeLang) || item.performance === 'native_substitution';
      // Lookup language: for native words, the lexeme lives in nativeLang;
      // for target words, in targetLang.
      const lookupLang = isNative ? nativeLang : targetLang;

      // Match lexeme with correct language filter - try exact POS first
      let existingLexeme = await db.query.lexemes.findFirst({
        where: and(
          eq(lexemes.lemma, item.lemma),
          eq(lexemes.pos, item.pos),
          eq(lexemes.language, lookupLang)
        )
      });

      // Fallback: try GENERAL pos
      if (!existingLexeme) {
        existingLexeme = await db.query.lexemes.findFirst({
          where: and(
            eq(lexemes.lemma, item.lemma),
            eq(lexemes.pos, 'GENERAL'),
            eq(lexemes.language, lookupLang)
          )
        });
      }

      // Fallback: match by lemma+language regardless of POS (LLMs disagree on POS tags)
      if (!existingLexeme) {
        existingLexeme = await db.query.lexemes.findFirst({
          where: and(
            eq(lexemes.lemma, item.lemma),
            eq(lexemes.language, lookupLang)
          )
        });
      }

      if (existingLexeme) {
        // Use FSRS algorithm via supervisor-functions
        const { updateSRSFromAnalysis } = await import('../tools/supervisor-functions.js');
        // Pass the per-lexeme language through so updateSRSFromAnalysis can
        // apply the function-word filter and per-lemma native-detection logic.
        await updateSRSFromAnalysis(userId, { language: lookupLang, lexemes: [{ ...item, language: lookupLang }], grammarHints: analysis.grammarHints || [] });
      }
    }
  }

  return {
    analysis: {
      feedback: analysis.grammarHints ? (analysis.grammarHints as string[]).join(' ') : 'Good job!',
      correction: null
    }
  };
}

/** llm.tool wrapper — registers analyzeTurn as an agent-callable tool. */
export const analyzeConversationTurn = llm.tool({
  name: 'analyze_conversation_turn',
  description: "Analyzes the user's last utterance for grammatical accuracy and updates their learning progress.",
  parameters: z.object({
    userId: z.string().describe('The ID of the user'),
    userUtterance: z.string().describe('The exact sentence the user said'),
    context: z.string().describe('The immediate conversation context'),
  }),
  execute: analyzeTurn,
});
