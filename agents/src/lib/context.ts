import { db } from '../db/index.js';
import { learningProgress, units, lexemes, users, activeGoals, duolingoMetadata } from '../db/schema.js';
import { eq, and, asc, desc } from 'drizzle-orm';

export class ContextManager {

  static async getInitialContext(userId: string): Promise<string> {
    console.log(`[Context] Fetching context for ${userId}...`);

    // Check if curriculum mode is enabled
    const useCurriculum = process.env.USE_CURRICULUM === 'true';

    if (useCurriculum) {
      console.log(`[Context] Using curriculum-based learning.`);
      const { CurriculumProgress } = await import('./curriculum-progress.js');
      return CurriculumProgress.getGoalContext(userId);
    }

    // Check if user has Duolingo data linked
    const metadata = await db.query.duolingoMetadata.findFirst({
      where: eq(duolingoMetadata.userId, userId)
    });

    if (metadata) {
      console.log(`[Context] User has Duolingo metadata, using Duolingo context.`);
      return this.getInitialContextForDuolingo(userId);
    }

    // Get user to determine target language
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      return "No user profile found.";
    }

    const targetLang = user.targetLanguage || 'ru';
    console.log(`[Context] Target language: ${targetLang}`);

    // Get current unit FOR THIS LANGUAGE
    const currentUnit = await db.query.units.findFirst({
      where: eq(units.language, targetLang),
      orderBy: [asc(units.order)],
    });
    console.log(`[Context] Current unit: ${currentUnit?.title}`);

    if (!currentUnit) return "No curriculum found.";

    const now = Date.now();
    console.log(`[Context] Querying reviews...`);
    const dueReviews = await db.query.learningProgress.findMany({
        where: and(
            eq(learningProgress.userId, userId)
        ),
        with: { lexeme: true },
        limit: 5,
    });
    console.log(`[Context] Found ${dueReviews.length} reviews`);

    const reviewList = dueReviews.map((p: any) => `${p.lexeme.lemma} (${p.lexeme.translation})`).join(', ');

    console.log(`[Context] Querying new words...`);
    const unitLexemes = await db.query.lexemes.findMany({
        where: and(
            eq(lexemes.unitId, currentUnit.id),
            eq(lexemes.language, targetLang)
        ),
        limit: 5,
    });
    console.log(`[Context] Found ${unitLexemes.length} unit lexemes`);
    
    // Simple filter: words not in dueReviews (rough approximation)
    const newWords = unitLexemes
        .filter((l: typeof lexemes.$inferSelect) => !dueReviews.find((r: typeof learningProgress.$inferSelect & { lexeme: typeof lexemes.$inferSelect }) => r.lexemeId === l.id))
        .slice(0, 3)
        .map((l: typeof lexemes.$inferSelect) => `${l.lemma} (${l.translation})`)
        .join(', ');

    return `
    User ID: ${userId}
    Target Language: ${targetLang}
    Native Language: ${user.nativeLanguage}
    Proficiency Level: ${user.proficiencyLevel}

    Current Goal: ${currentUnit.title}
    Description: ${currentUnit.description}

    Vocabulary to Review: ${reviewList || "None"}
    New Vocabulary to Introduce: ${newWords || "None"}
    `;
  }

  /**
   * "Goal Seeking Cycle" (Thesis Implementation)
   * Uses State Machine to avoid constant interference.
   * This is the SRS-based goal system.
   */
  static async getOrCreateGoal(userId: string): Promise<string | null> {
    const now = Date.now();
    console.log(`[GoalSeek] Searching for next goal for user ${userId}...`);

    // 1. Check for ACTIVE Goal
    const currentGoal = await db.query.activeGoals.findFirst({
        where: and(eq(activeGoals.userId, userId), eq(activeGoals.status, 'active')),
        orderBy: [desc(activeGoals.updatedAt)]
    });

    if (currentGoal) {
        console.log(`[GoalSeek] Active goal found: ${currentGoal.type} on target ${currentGoal.targetId}`);
        // We have a goal. Has the user satisfied it?
        const progress = await db.query.learningProgress.findFirst({
            where: and(
                eq(learningProgress.userId, userId), 
                eq(learningProgress.lexemeId, currentGoal.targetId)
            ),
            with: { lexeme: true }
        });

        if (progress && progress.lastSeen > currentGoal.createdAt && progress.correctUses > 0) {
            console.log(`[GoalSeek] Goal COMPLETED: user successfully used "${progress.lexeme.lemma}"`);
            await db.update(activeGoals)
                .set({ status: 'completed', updatedAt: now })
                .where(eq(activeGoals.id, currentGoal.id));
            
            return `SYSTEM NOTE: The user successfully used "${progress.lexeme.lemma}".
            GOAL COMPLETED. Praise them briefly, then move to the next topic.`;
        }

        console.log(`[GoalSeek] Goal still active. No interference.`);
        return null;
    }

    // 2. No Active Goal? Pick a NEW one.
    console.log(`[GoalSeek] No active goal. Checking for remediation...`);
    
    // Priority A: Remediation (Recent failures)
    const recentFailure = await db.query.learningProgress.findFirst({
        where: and(eq(learningProgress.userId, userId), eq(learningProgress.srsLevel, 1)),
        orderBy: [desc(learningProgress.lastSeen)],
        with: { lexeme: true }
    });

    if (recentFailure) {
        console.log(`[GoalSeek] Remediation needed for "${recentFailure.lexeme.lemma}" (SRS level 1)`);
        await db.insert(activeGoals).values({
            userId,
            type: 'remediation',
            targetId: recentFailure.lexemeId,
            status: 'active',
            createdAt: now,
            updatedAt: now
        });
        
        return `NEW GOAL: The user is struggling with "${recentFailure.lexeme.lemma}". Help them use it correctly in a sentence.`;
    }

    console.log(`[GoalSeek] No remediation needed. Looking for new vocabulary...`);

    // Priority B: New Vocabulary (from current unit)
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const targetLang = user?.targetLanguage || 'ru';

    const startedLexemes = await db.query.learningProgress.findMany({
        where: eq(learningProgress.userId, userId),
        columns: { lexemeId: true }
    });
    const startedLexemeIds = new Set(startedLexemes.map(p => p.lexemeId));

    const unstartedLexeme = await db.query.lexemes.findFirst({
        where: (lexemes, { and, eq, notInArray }) => {
            const base = eq(lexemes.language, targetLang);
            if (startedLexemeIds.size > 0) {
                return and(base, notInArray(lexemes.id, Array.from(startedLexemeIds).slice(0, 999))); 
            }
            return base;
        }
    });

    if (unstartedLexeme) {
        console.log(`[GoalSeek] Setting new vocabulary goal: "${unstartedLexeme.lemma}"`);
        await db.insert(activeGoals).values({
            userId,
            type: 'vocab',
            targetId: unstartedLexeme.id,
            status: 'active',
            createdAt: now,
            updatedAt: now
        });
        
        return `NEW GOAL: Introduce the new word "${unstartedLexeme.lemma}" (${unstartedLexeme.translation}). Help the user use it in a sentence.`;
    }
    
    console.log(`[GoalSeek] No candidates for new goals found.`);
    return null; 
  }

  /**
   * Get dynamic goal - uses curriculum if enabled, otherwise SRS
   */
  static async getDynamicGoal(userId: string): Promise<string | null> {
    // Check if curriculum mode is enabled
    const useCurriculum = process.env.USE_CURRICULUM === 'true';

    if (useCurriculum) {
      // Use curriculum-based goals
      const { CurriculumProgress } = await import('./curriculum-progress.js');
      const currentGoal = await CurriculumProgress.getCurrentGoal(userId);

      if (currentGoal) {
        const user = await db.query.users.findFirst({
          where: eq(users.id, userId)
        });
        const completedCount = user?.metadata
          ? (JSON.parse(user.metadata).completedGoals || []).length
          : 0;

        return `NEW GOAL: ${currentGoal.topic} (Goal ${completedCount + 1})\nObjective: ${currentGoal.objective}\nTarget words: ${currentGoal.targetVocab.slice(0, 5).join(', ')}${currentGoal.targetVocab.length > 5 ? '...' : ''}`;
      }

      return null;  // All curriculum goals completed
    }

    // Use SRS-based goals (existing logic)
    return this.getOrCreateGoal(userId);
  }

  /**
   * Get initial context specifically for Duolingo-powered tutoring
   * Checks if user has Duolingo data and formats it appropriately
   */
  static async getInitialContextForDuolingo(userId: string): Promise<string> {
    console.log(`[Context] Fetching Duolingo context for ${userId}...`);

    // Check if user has Duolingo data
    const metadata = await db.query.duolingoMetadata.findFirst({
      where: eq(duolingoMetadata.userId, userId)
    });

    if (!metadata) {
      return `
User ID: ${userId}
Data Source: Duolingo (Not Yet Connected)

IMPORTANT: This user wants to use Duolingo as their learning source.
Please ask for their Duolingo username and password to get started.
Use the authenticateDuolingo tool to connect their account.
      `.trim();
    }

    const language = metadata.learningLanguage;
    const lastSync = metadata.lastSyncTimestamp
      ? new Date(metadata.lastSyncTimestamp).toLocaleString()
      : 'Never';

    // Get words needing practice (low SRS levels)
    const weakWords = await db.query.learningProgress.findMany({
      where: eq(learningProgress.userId, userId),
      with: { lexeme: true },
      orderBy: [asc(learningProgress.srsLevel)],
      limit: 10,
    });

    // Filter to weak words (SRS level 0-2)
    const filteredWeakWords = weakWords.filter(p => p.srsLevel <= 2);

    const reviewList = filteredWeakWords
      .map(p => `${p.lexeme.lemma} (${p.lexeme.translation}) [${
        p.srsLevel === 0 ? 'New' :
        p.srsLevel === 1 ? 'Learning' :
        'Reviewing'
      }]`)
      .join(', ');

    // Get upcoming content: units with no progress yet
    const allUnits = await db.query.units.findMany({
        where: eq(units.language, language),
        orderBy: [asc(units.order)],
    });

    const startedLexemes = await db.query.learningProgress.findMany({
        where: eq(learningProgress.userId, userId),
        columns: { lexemeId: true }
    });
    const startedLexemeIds = new Set(startedLexemes.map(p => p.lexemeId));

    // Find first unit where at least some lexemes haven't been started
    let nextUnit = null;
    for (const unit of allUnits) {
        const unitLexemes = await db.query.lexemes.findMany({
            where: eq(lexemes.unitId, unit.id),
            limit: 1
        });
        if (unitLexemes.length > 0 && !startedLexemeIds.has(unitLexemes[0].id)) {
            nextUnit = unit;
            break;
        }
    }

    // Get total vocabulary count
    const totalVocab = await db.query.learningProgress.findMany({
      where: eq(learningProgress.userId, userId)
    });

    // Get sync status
    const syncStatusMsg = metadata.syncStatus === 'success'
      ? 'Up to date'
      : metadata.syncStatus === 'failed'
      ? `Failed (${metadata.syncError})`
      : 'Pending';

    return `
User ID: ${userId}
Data Source: Duolingo
Learning Language: ${language.toUpperCase()}
Last Sync: ${lastSync}
Sync Status: ${syncStatusMsg}
Total Vocabulary: ${totalVocab.length} words

Words Needing Practice (low strength): ${reviewList || "None identified yet - sync data first!"}

Next Lesson/Skill: ${nextUnit ? `${nextUnit.title} - ${nextUnit.description}` : "All known skills mastered!"}

STRATEGY: Focus on conversational practice using weak vocabulary items. 
If the user seems comfortable, bridge into the next topic: ${nextUnit?.title || "advanced conversation"}.
    `.trim();
  }
}

/**
 * TESTING ONLY: Simple placeholder goal system
 * Returns rotating goals without database dependency
 */
export class PlaceholderGoals {
  private static goalIndex = 0;

  private static readonly TEST_GOALS = [
    {
      type: 'vocab',
      message: 'NEW GOAL: Introduce the word "привет" (hello) naturally in conversation.'
    },
    {
      type: 'grammar',
      message: 'NEW GOAL: Help the user practice forming questions in Russian.'
    },
    {
      type: 'conversation',
      message: 'NEW GOAL: Have a 3-turn exchange about food preferences.'
    },
    {
      type: 'vocab',
      message: 'NEW GOAL: Teach "спасибо" (thank you) and get the user to use it.'
    },
    {
      type: 'review',
      message: 'NEW GOAL: Review vocabulary from the previous session.'
    },
  ];

  /**
   * Get next placeholder goal in rotation
   * Call this every 3-5 turns to test goal injection
   */
  static getNextGoal(): string {
    const goal = this.TEST_GOALS[this.goalIndex];
    this.goalIndex = (this.goalIndex + 1) % this.TEST_GOALS.length;
    return goal.message;
  }

  /**
   * Simulate goal completion
   */
  static completeGoal(goalType: string): string {
    return `GOAL COMPLETED! The user successfully completed the ${goalType} goal. Briefly praise them and move on.`;
  }

  /**
   * Reset rotation (for testing)
   */
  static reset(): void {
    this.goalIndex = 0;
  }
}
