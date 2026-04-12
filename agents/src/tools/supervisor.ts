import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userVocabulary, lexemes, units, users, grammarRules } from '../db/schema.js';
import * as z from 'zod';
import { llm } from '@livekit/agents';
import OpenAI from 'openai';

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

const learningAnalysisInstructions = `You are a comprehensive language learning analysis expert.
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
}`;

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

  // 1. Call Step 3.5 Flash via OpenRouter for Analysis
  const model = process.env.SUPERVISOR_LLM_MODEL || 'stepfun/step-3.5-flash:free';
  const result = await getClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: learningAnalysisInstructions },
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
    console.warn('[Supervisor] Failed to parse LLM response as JSON:', jsonText.slice(0, 200));
    return { analysis: { feedback: 'ok', correction: null } };
  }
  console.log("[Supervisor] Analysis result:", JSON.stringify(analysis, null, 2));

  // Validate detected language matches user's target language
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  if (user && analysis.language && analysis.language !== user.targetLanguage) {
    console.warn(
      `[Supervisor] Language mismatch! User learning ${user.targetLanguage}, ` +
      `but spoke ${analysis.language}`
    );
  }

  // 2. Update SQLite DB
  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  const targetLang = analysis.language || user?.targetLanguage || 'ru';

  if (analysis.lexemes) {
    for (const item of analysis.lexemes) {
      // Match lexeme with correct language filter - try exact POS first
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

      if (existingLexeme) {
        // Use FSRS algorithm via supervisor-functions
        const { updateSRSFromAnalysis } = await import('../tools/supervisor-functions.js');
        await updateSRSFromAnalysis(userId, { language: targetLang, lexemes: [item] });
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
  description: "Analyzes the user's last utterance for grammatical accuracy and updates their learning progress.",
  parameters: z.object({
    userId: z.string().describe('The ID of the user'),
    userUtterance: z.string().describe('The exact sentence the user said'),
    context: z.string().describe('The immediate conversation context'),
  }),
  execute: analyzeTurn,
});
