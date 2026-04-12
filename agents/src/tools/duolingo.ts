import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  userVocabulary,
  lexemes,
  units,
  users,
  duolingoMetadata,
  grammarRules
} from '../db/schema.js';
import * as z from 'zod';
import { llm } from '@livekit/agents';
import { DuolingoClient } from '../lib/duolingoClient.js';

// Shared client instance (in production, could maintain pool per user)
const duoClient = new DuolingoClient();

/**
 * Map Duolingo strength (0.0 - 1.0) to approximate FSRS state and stability.
 */
function mapStrengthToFSRS(strength: number): { state: number; stability: number; difficulty: number; scheduledDays: number } {
  // Approximate mapping from Duolingo strength to FSRS params
  if (strength < 0.2) return { state: 0, stability: 0, difficulty: 0, scheduledDays: 0 }; // New
  if (strength < 0.4) return { state: 1, stability: 1, difficulty: 5, scheduledDays: 1 }; // Learning
  if (strength < 0.6) return { state: 2, stability: 3.5, difficulty: 4.5, scheduledDays: 3 }; // Early Review
  if (strength < 0.8) return { state: 2, stability: 7, difficulty: 4, scheduledDays: 7 }; // Review
  if (strength < 0.95) return { state: 2, stability: 15, difficulty: 3.5, scheduledDays: 15 }; // Strong
  return { state: 2, stability: 30, difficulty: 3, scheduledDays: 30 }; // Mastered
}

export interface SyncResult {
  success: boolean;
  message: string;
  stats?: {
    newWords: number;
    updatedWords: number;
    newSkills: number;
    newGrammar: number;
    totalVocab: number;
  };
}

/**
 * Simple HTML to Markdown converter to clean up Duolingo explanations
 */
function cleanHtml(html: string): string {
  if (!html) return '';
  
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '\n\n')
    .replace(/<\/p>/gi, '')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<ul[^>]*>/gi, '\n')
    .replace(/<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>/gi, '\n')
    .replace(/<\/ol>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // Clean up multiple newlines
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Core synchronization logic - extracted for use by tools and scripts
 */
export async function performDuolingoSync(userId: string): Promise<SyncResult> {
  console.log(`[Duolingo Sync] Starting sync for user ${userId}...`);

  try {
    // Get stored JWT
    const metadata = await db.query.duolingoMetadata.findFirst({
      where: eq(duolingoMetadata.userId, userId)
    });

    if (!metadata?.duolingoJWT) {
      return {
        success: false,
        message: 'Not authenticated with Duolingo. Please authenticate first using your username and password.',
      };
    }

    // Set JWT and fetch data
    duoClient.setJWT(metadata.duolingoJWT);
    const language = metadata.learningLanguage;

    console.log(`[Duolingo Sync] Fetching vocabulary for ${language}...`);
    const vocabItems = await duoClient.getVocabulary(language);

    console.log(`[Duolingo Sync] Fetching user data...`);
    let userData = await duoClient.getUserData(metadata.duolingoUserId!, metadata.duolingoUsername);
    
    // Check if we need to re-auth (if user data is too thin or JWT expired)
    // DISABLED: This is currently failing with "Duolingo session expired" during script runs.
    /*
    if (!userData.courses && metadata.duolingoPassword) {
        console.log(`[Duolingo Sync] Session might be limited. Attempting fresh login...`);
        const auth = await duoClient.authenticate(metadata.duolingoUsername, metadata.duolingoPassword);
        duoClient.setJWT(auth.jwt);
        userData = await duoClient.getUserData(metadata.duolingoUserId!);
    }
    */

    // Extraction Logic with Fallback
    let skills: any[] = [];
    if (userData.language_data?.[language]) {
        skills = userData.language_data[language].skills || [];
        console.log(`[Duolingo Sync] Found ${skills.length} skills in language_data`);
    } else if (userData.courses) {
        const course = userData.courses.find((c: any) => c.learningLanguage === language);
        if (course && course.skills) {
            skills = course.skills;
            console.log(`[Duolingo Sync] Found ${skills.length} skills in courses array`);
        } else if (course) {
             console.warn(`[Duolingo Sync] Found ${language} course but it has no skills array. keys:`, Object.keys(course));
        }
    }

    let newWords = 0;
    let updatedWords = 0;
    let newSkills = 0;
    let newGrammar = 0;

    // Sync Skills → Units & Grammar Rules & Vocabulary (from skill.words)
    console.log(`[Duolingo Sync] Processing ${skills.length} skills...`);
    for (const skill of skills) {
      const unitId = `duo-${language}-${skill.id}`;

      // 1. Upsert Unit
      const existing = await db.query.units.findFirst({
        where: eq(units.id, unitId)
      });

      if (!existing) {
        await db.insert(units).values({
          id: unitId,
          title: skill.title,
          description: `Duolingo skill: ${skill.title}`,
          language: language,
          order: skills.indexOf(skill),
          difficulty: 'beginner',
        });
        newSkills++;
      }

      // 2. Ingest Grammar Explanations (if available)
      if (skill.explanation) {
        const ruleId = `duo-grammar-${skill.id}`;
        const cleanedExplanation = cleanHtml(skill.explanation);
        
        // Check if rule exists
        const existingRule = await db.query.grammarRules.findFirst({
            where: eq(grammarRules.id, ruleId)
        });

        // Insert or Update
        if (!existingRule) {
            console.log(`[Duolingo Sync] Adding new grammar rule for: ${skill.title}`);
            await db.insert(grammarRules).values({
                id: ruleId,
                rule: `${skill.title} Grammar`,
                description: cleanedExplanation,
                unitId: unitId,
            });
            newGrammar++;
        } else {
             await db.update(grammarRules)
                .set({ description: cleanedExplanation })
                .where(eq(grammarRules.id, ruleId));
        }
      }

      // 3. Ingest Vocabulary from skill.words
      if (skill.words && Array.isArray(skill.words)) {
        for (const word of skill.words) {
            // We don't have POS tag from this list, so we'll append a generic suffix
            // Ideally we'd look this up or use the other endpoint, but this is a good fallback.
            const lexemeId = `duo-${language}-${word}-GENERAL`;
            
            const existingLexeme = await db.query.lexemes.findFirst({
                where: eq(lexemes.id, lexemeId)
            });

            if (!existingLexeme) {
                await db.insert(lexemes).values({
                    id: lexemeId,
                    lemma: word,
                    pos: 'GENERAL', // Placeholder
                    language: language,
                    translation: '(Duo Skill Word)', // We don't have translation here
                    unitId: unitId,
                }).onConflictDoNothing();
                newWords++;
                
                // Also initialize progress for this word if it's new
                // If the skill is "learned", we can assume some familiarity (SRS 2)
                // If not, it's new — create with FSRS initial state
                const initialState = skill.learned
                  ? { state: 2, stability: 3.5, difficulty: 4.5, scheduledDays: 3 }
                  : { state: 1, stability: 1, difficulty: 5, scheduledDays: 1 };

                await db.insert(userVocabulary).values({
                    userId,
                    lexemeId,
                    state: initialState.state,
                    stability: initialState.stability,
                    difficulty: initialState.difficulty,
                    scheduledDays: initialState.scheduledDays,
                    due: new Date(), // Due immediately for review/check
                    reps: 1,
                    lapses: 0,
                });
            }
        }
      }
    }

    // Sync Vocabulary → Lexemes + LearningProgress
    console.log(`[Duolingo Sync] Processing ${vocabItems.length} vocabulary items...`);
    for (const item of vocabItems) {
      const lexemeId = `duo-${language}-${item.word_string}-${item.pos}`;
      const skillName = item.skill?.replace(/\s+/g, '-').toLowerCase() || 'unknown';
      // Try to find the unit ID based on skill name match (imperfect, but best effort)
      // Ideally we'd map item.skill_id if available, but getVocabulary doesn't always provide it.
      // We'll fallback to a generic unit if not found, or just link to the skill-based unit ID constructed above if names match.
      // For now, let's just use the constructed ID pattern.
      const unitId = `duo-${language}-${skillName}`; 
      
      // Insert/update lexeme
      const existingLexeme = await db.query.lexemes.findFirst({
        where: eq(lexemes.id, lexemeId)
      });

      if (!existingLexeme) {
        await db.insert(lexemes).values({
          id: lexemeId,
          lemma: item.word_string,
          pos: item.pos,
          language: language,
          translation: '(Duolingo import - translation pending)',
          gender: item.gender,
          unitId: unitId, // This might not match a real unit if skill name differs from skill ID logic above
        }).onConflictDoNothing();
        newWords++;
      }

      // Insert/update vocabulary with FSRS state from Duolingo strength
      const fsrsState = mapStrengthToFSRS(item.strength);
      const lastSeen = item.last_practiced
        ? new Date(item.last_practiced)
        : new Date();
      const due = new Date(Date.now() + fsrsState.scheduledDays * 86400000);

      const existingProgress = await db.query.userVocabulary.findFirst({
        where: and(
          eq(userVocabulary.userId, userId),
          eq(userVocabulary.lexemeId, lexemeId)
        )
      });

      if (existingProgress) {
        // Only update if the voice tutor hasn't graded this word yet (reps === 0).
        // If we've already got real FSRS data from the tutor, Duolingo's aggregate
        // strength is coarser — don't overwrite the tutor-honed stability.
        if (existingProgress.reps === 0) {
          await db.update(userVocabulary)
            .set({
              state: fsrsState.state,
              stability: fsrsState.stability,
              difficulty: fsrsState.difficulty,
              scheduledDays: fsrsState.scheduledDays,
              due,
              lastReview: lastSeen,
            })
            .where(eq(userVocabulary.id, existingProgress.id));
          updatedWords++;
        }
        // If reps > 0, the voice tutor has already refined this word — skip.
      } else {
        await db.insert(userVocabulary).values({
          userId,
          lexemeId,
          state: fsrsState.state,
          stability: fsrsState.stability,
          difficulty: fsrsState.difficulty,
          scheduledDays: fsrsState.scheduledDays,
          due,
          lastReview: lastSeen,
          reps: 0,
          lapses: 0,
        });
      }
    }

    // Update sync timestamp
    await db.update(duolingoMetadata)
      .set({
        lastSyncTimestamp: new Date(),
        syncStatus: 'success',
        syncError: null,
        updatedAt: new Date(),
      })
      .where(eq(duolingoMetadata.userId, userId));

    console.log(`[Duolingo Sync] Completed: ${newWords} new, ${updatedWords} updated, ${newSkills} skills, ${newGrammar} grammar rules`);

    return {
      success: true,
      message: `Sync complete! Added ${newWords} new words, updated ${updatedWords} words, imported ${newSkills} new skills, and ${newGrammar} grammar rules from Duolingo.`,
      stats: {
        newWords,
        updatedWords,
        newSkills,
        newGrammar,
        totalVocab: vocabItems.length
      }
    };

  } catch (error: any) {
    console.error('[Duolingo Sync] Failed:', error);

    // Store error
    await db.update(duolingoMetadata)
      .set({
        syncStatus: 'failed',
        syncError: error.message,
        updatedAt: new Date(),
      })
      .where(eq(duolingoMetadata.userId, userId))
      .catch(() => {});

    return {
      success: false,
      message: `Sync failed: ${error.message}`,
    };
  }
}

// ============================================================================
// TOOL 1: Authenticate with Duolingo
// ============================================================================

export const authenticateDuolingo = llm.tool({
  description: 'Authenticate with Duolingo using username and password to enable data syncing. Call this once at the start of the session.',

  parameters: z.object({
    userId: z.string().describe('The LingLang user ID'),
    duolingoUsername: z.string().describe('Duolingo username or email'),
    duolingoPassword: z.string().describe('Duolingo password'),
    language: z.string().describe('Learning language code (e.g., "ru" for Russian, "es" for Spanish)'),
  }),

  execute: async ({ userId, duolingoUsername, duolingoPassword, language }) => {
    console.log(`[Duolingo Auth] Authenticating ${duolingoUsername} for user ${userId}...`);

    try {
      // Authenticate with Duolingo
      const { jwt, userId: duoUserId } = await duoClient.authenticate(
        duolingoUsername,
        duolingoPassword
      );

      // Ensure LingLang user exists
      await db.insert(users).values({
        id: userId,
        targetLanguage: language,
        nativeLanguage: 'en',
        proficiencyLevel: 'beginner',
      }).onConflictDoNothing();

      // Store metadata
      await db.insert(duolingoMetadata).values({
        userId,
        duolingoUsername,
        duolingoPassword,
        duolingoJWT: jwt,
        duolingoUserId: duoUserId,
        learningLanguage: language,
        syncStatus: 'pending',
      }).onConflictDoUpdate({
        target: duolingoMetadata.userId,
        set: {
          duolingoPassword,
          duolingoJWT: jwt,
          duolingoUserId: duoUserId,
          syncStatus: 'pending',
        }
      });

      console.log(`[Duolingo Auth] Successfully authenticated and stored credentials`);

      return {
        success: true,
        message: `Successfully connected to Duolingo as ${duolingoUsername}. You can now sync your vocabulary!`,
      };
    } catch (error: any) {
      console.error('[Duolingo Auth] Failed:', error);

      return {
        success: false,
        message: `Authentication failed: ${error.message}. Please check your credentials and try again.`,
      };
    }
  },
});

// ============================================================================
// TOOL 2: Sync Duolingo Data
// ============================================================================

export const syncDuolingoData = llm.tool({
  description: 'Fetch vocabulary, skills, and progress from Duolingo and sync to the learning database. This will populate your practice vocabulary.',

  parameters: z.object({
    userId: z.string().describe('The LingLang user ID'),
  }),

  execute: async ({ userId }) => {
    return await performDuolingoSync(userId);
  },
});

// ============================================================================
// TOOL 3: Get Weak Words for Practice
// ============================================================================

export const getDuolingoWeakWords = llm.tool({
  description: 'Get vocabulary words with low Duolingo strength (weak words that need practice). Use this to identify which words the student should focus on.',

  parameters: z.object({
    userId: z.string().describe('The LingLang user ID'),
    limit: z.number().default(5).describe('Maximum number of words to return'),
  }),

  execute: async ({ userId, limit }) => {
    console.log(`[Duolingo Weak Words] Fetching weak words for ${userId}...`);

    try {
      // Get words with low FSRS stability (weak = state 0-2)
      const weakWords = await db.query.userVocabulary.findMany({
        where: eq(userVocabulary.userId, userId),
        with: { lexeme: true },
        orderBy: [asc(userVocabulary.stability)],
        limit: limit,
      });

      // Filter to only include words with FSRS state 0-2 (new/learning)
      const filteredWords = weakWords.filter(p => p.state <= 2);

      const wordList = filteredWords.map(p => ({
        word: p.lexeme.lemma,
        translation: p.lexeme.translation,
        pos: p.lexeme.pos,
        state: p.state,
        strengthDescription: p.state === 0 ? 'New' :
                            p.state === 1 ? 'Learning' :
                            p.state === 3 ? 'Relearning' :
                            'Reviewing',
        lastSeen: p.lastReview ? new Date(p.lastReview).toISOString() : 'never',
      }));

      console.log(`[Duolingo Weak Words] Found ${wordList.length} weak words`);

      if (wordList.length === 0) {
        return {
          weakWords: [],
          count: 0,
          message: 'Great job! No weak words found. All vocabulary is at a good strength level.',
        };
      }

      return {
        weakWords: wordList,
        count: wordList.length,
        message: `Found ${wordList.length} words that need practice. Focus on these!`,
      };
    } catch (error: any) {
      console.error('[Duolingo Weak Words] Failed:', error);

      return {
        weakWords: [],
        count: 0,
        error: error.message,
        message: 'Could not fetch weak words. Make sure you have synced your Duolingo data first.',
      };
    }
  },
});
