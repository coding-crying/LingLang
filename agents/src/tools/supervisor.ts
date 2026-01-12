import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { learningProgress, lexemes, units, users, grammarRules } from '../db/schema.js';
import * as z from 'zod';
import { llm } from '@livekit/agents';
import { GoogleGenAI } from '@google/genai';

const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || "" });

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

export const analyzeConversationTurn = llm.tool({
  description: 'Analyzes the user\'s last utterance for detailed grammatical and morphological accuracy, and updates their learning progress.',
  parameters: z.object({
    userId: z.string().describe('The ID of the user'),
    userUtterance: z.string().describe('The exact sentence the user said'),
    context: z.string().describe('The immediate conversation context'),
  }),
  execute: async ({ userId, userUtterance, context }) => {
    console.log(`[Supervisor] Analyzing: "${userUtterance}" for user ${userId}`);

    // 1. Call Google Gemini for Analysis
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: `${learningAnalysisInstructions}\n\nContext: ${context}\nUser said: "${userUtterance}"` }]
        }
      ]
    });
    
    const responseText = result.text || "";
    
    // Clean up potential markdown code blocks (```json ... ```)
    const cleanedText = responseText.replace(/^```json\s*/, '').replace(/```$/, '');
    
    const analysis = JSON.parse(cleanedText || "{}");
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
    await db.insert(users).values({ id: userId, createdAt: Date.now() }).onConflictDoNothing();

    if (analysis.lexemes) {
        for (const item of analysis.lexemes) {
            // Match lexeme with correct language filter - try exact POS first
            let existingLexeme = await db.query.lexemes.findFirst({
                where: and(
                    eq(lexemes.lemma, item.lemma),
                    eq(lexemes.pos, item.pos),
                    eq(lexemes.language, analysis.language || user?.targetLanguage || 'ru')
                )
            });

            // Fallback: try GENERAL pos for Duolingo words
            if (!existingLexeme) {
                existingLexeme = await db.query.lexemes.findFirst({
                    where: and(
                        eq(lexemes.lemma, item.lemma),
                        eq(lexemes.pos, 'GENERAL'),
                        eq(lexemes.language, analysis.language || user?.targetLanguage || 'ru')
                    )
                });
            }

            if (existingLexeme) {
                // Update Progress
                // Simple Leitner Logic: Correct -> Level + 1, Wrong -> Level 1
                const currentProgress = await db.query.learningProgress.findFirst({
                    where: and(eq(learningProgress.userId, userId), eq(learningProgress.lexemeId, existingLexeme.id))
                });

                let newLevel = currentProgress?.srsLevel || 0;
                if (item.performance === 'correct_use') newLevel = Math.min(newLevel + 1, 5);
                else if (item.performance === 'wrong_use') newLevel = 1;

                // Calculate next review (exponential backoff)
                const daysToAdd = Math.pow(2, newLevel); // 1, 2, 4, 8, 16...
                const nextReview = Date.now() + (daysToAdd * 24 * 60 * 60 * 1000);

                if (currentProgress) {
                    await db.update(learningProgress)
                        .set({
                            srsLevel: newLevel,
                            nextReview: nextReview,
                            lastSeen: Date.now(),
                            encounters: (currentProgress.encounters || 0) + 1,
                            correctUses: (currentProgress.correctUses || 0) + (item.performance === 'correct_use' ? 1 : 0)
                        })
                        .where(eq(learningProgress.id, currentProgress.id));
                } else {
                    await db.insert(learningProgress).values({
                        userId,
                        lexemeId: existingLexeme.id,
                        srsLevel: newLevel,
                        nextReview: nextReview,
                        lastSeen: Date.now(),
                        encounters: 1,
                        correctUses: item.performance === 'correct_use' ? 1 : 0
                    });
                }
            }
        }
    }

    // 3. Return feedback to the Agent
    return {
      analysis: {
        feedback: analysis.grammarHints ? analysis.grammarHints.join(" ") : "Good job!",
        correction: null 
      }
    };
  },
});
