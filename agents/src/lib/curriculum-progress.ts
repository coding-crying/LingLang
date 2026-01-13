/**
 * Curriculum Progress Tracker
 *
 * Tracks which curriculum goals the user has completed
 * and determines the next goal to work on.
 */

import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getCurriculum, type CurriculumGoal } from '../config/curriculum.js';

export class CurriculumProgress {
  /**
   * Get the current active goal for a user
   */
  static async getCurrentGoal(userId: string): Promise<CurriculumGoal | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) return null;

    const curriculum = getCurriculum(user.targetLanguage);
    if (!curriculum) return null;

    // Get completed goal IDs from user metadata
    const completedGoals = this.getCompletedGoals(user);

    // Find first goal that isn't completed
    const currentGoal = curriculum.goals.find(goal => !completedGoals.includes(goal.id));

    return currentGoal || null;  // null means all goals completed!
  }

  /**
   * Mark a goal as completed
   */
  static async completeGoal(userId: string, goalId: string): Promise<void> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) return;

    const completedGoals = this.getCompletedGoals(user);

    // Add this goal if not already completed
    if (!completedGoals.includes(goalId)) {
      completedGoals.push(goalId);

      // Update user metadata
      const metadata = user.metadata ? JSON.parse(user.metadata) : {};
      metadata.completedGoals = completedGoals;

      await db.update(users)
        .set({
          metadata: JSON.stringify(metadata),
          updatedAt: Date.now()
        })
        .where(eq(users.id, userId));
    }
  }

  /**
   * Get formatted context about current goal for the tutor
   */
  static async getGoalContext(userId: string): Promise<string> {
    const currentGoal = await this.getCurrentGoal(userId);

    if (!currentGoal) {
      return 'CURRICULUM STATUS: All goals completed! Great job! Have free conversation.';
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    const completedCount = user ? this.getCompletedGoals(user).length : 0;
    const curriculum = user ? getCurriculum(user.targetLanguage) : null;
    const totalGoals = curriculum?.goals.length || 0;

    return `
CURRICULUM PROGRESS: Goal ${completedCount + 1}/${totalGoals}

CURRENT GOAL: ${currentGoal.topic}
Objective: ${currentGoal.objective}
Target Vocabulary: ${currentGoal.targetVocab.join(', ')}

TEACHING STRATEGY:
- Guide conversation naturally to use these words
- Don't drill or explicitly quiz
- Let them discover and practice organically
- When they've met the criteria, praise them and move to next goal
    `.trim();
  }

  /**
   * Check if user's utterance satisfies the current goal
   * Returns true if goal should be marked complete
   */
  static async checkGoalProgress(
    userId: string,
    userUtterance: string,
    conversationContext: string
  ): Promise<{ completed: boolean; goalId?: string; goalTopic?: string }> {
    const currentGoal = await this.getCurrentGoal(userId);

    if (!currentGoal) {
      return { completed: false };  // No active goal
    }

    // Simple heuristic: check if user used target vocabulary
    const utteranceLower = userUtterance.toLowerCase();
    const contextLower = conversationContext.toLowerCase();
    const recentText = utteranceLower + ' ' + contextLower.slice(-500);  // Last 500 chars of context

    // Count how many target words were used
    const usedWords = currentGoal.targetVocab.filter(word =>
      recentText.includes(word.toLowerCase())
    );

    // Simple completion logic: varies by goal type
    let completed = false;

    if (currentGoal.id.includes('greetings')) {
      // Need 3 different greetings
      completed = usedWords.length >= 3;
    } else if (currentGoal.id.includes('numbers')) {
      // Need 3 numbers
      completed = usedWords.length >= 3;
    } else if (currentGoal.id.includes('family')) {
      // Need 3 family words
      completed = usedWords.length >= 3;
    } else if (currentGoal.id.includes('colors')) {
      // Need 3 colors
      completed = usedWords.length >= 3;
    } else if (currentGoal.id.includes('food')) {
      // Need 4 food words
      completed = usedWords.length >= 4;
    } else if (currentGoal.id.includes('days') || currentGoal.id.includes('months')) {
      // Need 3 day/month names
      completed = usedWords.length >= 3;
    } else {
      // Default: need to use at least 3 target words
      completed = usedWords.length >= 3;
    }

    if (completed) {
      await this.completeGoal(userId, currentGoal.id);
      return {
        completed: true,
        goalId: currentGoal.id,
        goalTopic: currentGoal.topic
      };
    }

    return { completed: false };
  }

  /**
   * Helper: Extract completed goal IDs from user metadata
   */
  private static getCompletedGoals(user: any): string[] {
    if (!user.metadata) return [];

    try {
      const metadata = JSON.parse(user.metadata);
      return metadata.completedGoals || [];
    } catch {
      return [];
    }
  }
}
