import { db } from '../db/index.js';
import { learningProgress, units, lexemes, users, activeGoals } from '../db/schema.js';
import { eq, and, asc, desc } from 'drizzle-orm';

export class ContextManager {
  
  static async getInitialContext(userId: string): Promise<string> {
    const currentUnit = await db.query.units.findFirst({
      orderBy: [asc(units.order)],
    });

    if (!currentUnit) return "No curriculum found.";

    const now = Date.now();
    const dueReviews = await db.query.learningProgress.findMany({
        where: and(
            eq(learningProgress.userId, userId)
        ),
        with: { lexeme: true },
        limit: 5,
    });

    const reviewList = dueReviews.map((p: typeof learningProgress.$inferSelect & { lexeme: typeof lexemes.$inferSelect }) => `${p.lexeme.lemma} (${p.lexeme.translation})`).join(', ');

    // 4. Get New Words to Introduce (from current Unit)
    // Logic: Lexemes in current unit that have NO progress record
    // This is a bit complex to query efficiently in one go with Drizzle's query builder, 
    // so we might fetch unit lexemes and filter.
    const unitLexemes = await db.query.lexemes.findMany({
        where: eq(lexemes.unitId, currentUnit.id),
        limit: 5,
    });
    
    // Simple filter: words not in dueReviews (rough approximation)
    const newWords = unitLexemes
        .filter((l: typeof lexemes.$inferSelect) => !dueReviews.find((r: typeof learningProgress.$inferSelect & { lexeme: typeof lexemes.$inferSelect }) => r.lexemeId === l.id))
        .slice(0, 3)
        .map((l: typeof lexemes.$inferSelect) => `${l.lemma} (${l.translation})`)
        .join(', ');

    return `
    User ID: ${userId}
    Current Goal: ${currentUnit.title}
    Description: ${currentUnit.description}
    
    Vocabulary to Review: ${reviewList || "None"}
    New Vocabulary to Introduce: ${newWords || "None"}
    `;
  }

  /**
   * "Goal Seeking Cycle" (Thesis Implementation)
   * Uses State Machine to avoid constant interference.
   */
  static async getDynamicGoal(userId: string): Promise<string | null> {
    const now = Date.now();

    // 1. Check for ACTIVE Goal
    const currentGoal = await db.query.activeGoals.findFirst({
        where: and(eq(activeGoals.userId, userId), eq(activeGoals.status, 'active')),
        orderBy: [desc(activeGoals.updatedAt)]
    });

    if (currentGoal) {
        // We have a goal. Has the user satisfied it?
        // Check learning progress for this target since the goal started.
        const progress = await db.query.learningProgress.findFirst({
            where: and(
                eq(learningProgress.userId, userId), 
                eq(learningProgress.lexemeId, currentGoal.targetId)
            ),
            with: { lexeme: true }
        });

        // If we find progress updated AFTER the goal was created, and it was correct...
        if (progress && progress.lastSeen > currentGoal.createdAt && progress.correctUses > 0) {
            // SUCCESS! Goal Completed.
            await db.update(activeGoals)
                .set({ status: 'completed', updatedAt: now })
                .where(eq(activeGoals.id, currentGoal.id));
            
            return `SYSTEM NOTE: The user successfully used "${progress.lexeme.lemma}".
            GOAL COMPLETED. Praise them briefly, then move to the next topic.`;
        }

        // If not completed, SILENCE (Let the Tutor work).
        return null;
    }

    // 2. No Active Goal? Pick a NEW one.
    
    // Priority A: Remediation (Recent failures)
    const recentFailure = await db.query.learningProgress.findFirst({
        where: and(eq(learningProgress.userId, userId), eq(learningProgress.srsLevel, 1)),
        orderBy: [desc(learningProgress.lastSeen)],
        with: { lexeme: true }
    });

    if (recentFailure) {
        // Create Remediation Goal
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

    // Priority B: New Vocabulary (from current unit)
    // (Simplified: just pick a word we haven't taught yet)
    // In real app, this logic would be smarter.
    
    return null; // Default to silence if nothing urgent.
  }
}
