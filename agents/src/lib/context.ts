import { db } from '../db/index.js';
import { userVocabulary, units, lexemes, users, activeGoals, userNotes, sessionSummaries } from '../db/schema.js';
import { eq, and, asc, desc, lte, isNull, sql, isNotNull } from 'drizzle-orm';
import { isPlaceholderLexeme } from './learner-view.js';

export class ContextManager {

  static async getInitialContext(userId: string): Promise<string> {
    console.log(`[Context] Fetching context for ${userId}...`);

    // Get user to determine target language
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      return "No user profile found.";
    }

    const targetLang = user.targetLanguage || 'ru';
    console.log(`[Context] Target language: ${targetLang}`);

    const now = new Date();

    // FSRS: only show items that are actually due AND in the target language.
    console.log(`[Context] Querying due reviews...`);
    const allDue = await db.query.userVocabulary.findMany({
      where: and(
        eq(userVocabulary.userId, userId),
        lte(userVocabulary.due, now)
      ),
      with: { lexeme: true },
      orderBy: [asc(userVocabulary.due)],
      limit: 20,
    });
    // Filter to target-language lexemes only (native-language entries are substitution tracking, not learning targets).
    // Also drop native-substitution placeholder lexemes (lemma === its own
    // nativeLemma link) — the same contamination learner-view.ts already
    // filters for the conversation prompt; getInitialContext feeds the
    // planner and had no such filter, so contaminated placeholders could
    // still surface there even after the conversation-side fix.
    const dueReviews = allDue.filter((v: any) => v.lexeme?.language === targetLang && !isPlaceholderLexeme(v.lexeme)).slice(0, 5);
    console.log(`[Context] Found ${dueReviews.length} target-language reviews (filtered from ${allDue.length} total)`);

    const reviewList = dueReviews.map((p: any) => `${p.lexeme.lemma} (${p.lexeme.translation})`).join(', ');

    console.log(`[Context] Querying new words...`);
    // Pick new words by frequency rank (breadth-first, not unit-based)
    const allStartedVocab = await db.query.userVocabulary.findMany({
      where: eq(userVocabulary.userId, userId),
      columns: { lexemeId: true },
    });
    const startedLexemeIds = new Set(allStartedVocab.map((p: typeof userVocabulary.$inferSelect) => p.lexemeId));
    const newWordCandidates = await db.query.lexemes.findMany({
      where: and(
        eq(lexemes.language, targetLang),
      ),
      orderBy: [asc(lexemes.frequencyRank)],
      limit: 30,
    });
    console.log(`[Context] Found ${newWordCandidates.length} candidates`);

    // Filter: words not already in dueReviews or started vocab
    const newWords = newWordCandidates
        .filter((l: typeof lexemes.$inferSelect) => !startedLexemeIds.has(l.id) && !isPlaceholderLexeme(l))
        .slice(0, 3)
        .map((l: typeof lexemes.$inferSelect) => `${l.lemma} (${l.translation})`)
        .join(', ');

    const hasAnyProgress = (await db.query.userVocabulary.findFirst({
      where: eq(userVocabulary.userId, userId),
      columns: { id: true }
    })) != null;
    const isNewUser = !hasAnyProgress;

    return `
User ID: ${userId}
Target Language: ${targetLang}
Native Language: ${user.nativeLanguage}
NEW_USER: ${isNewUser ? 'true' : 'false'}

Vocabulary to Review (DUE by FSRS): ${reviewList || "None"}
New Vocabulary to Introduce (by frequency): ${newWords || "None"}
    `.trim();
  }

  /**
   * "Goal Seeking Cycle" (Thesis Implementation)
   * Uses State Machine to avoid constant interference.
   */
  static async getDynamicGoal(userId: string): Promise<string | null> {
    const now = new Date();
    console.log(`[GoalSeek] Searching for next goal for user ${userId}...`);

    // Legacy path (text-tutor script only) — still tag goals with the
    // language so it can't create unscoped rows.
    const goalUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const goalLang = goalUser?.targetLanguage || 'ru';

    // 1. Check for ACTIVE Goal
    const currentGoal = await db.query.activeGoals.findFirst({
        where: and(eq(activeGoals.userId, userId), eq(activeGoals.status, 'active')),
        orderBy: [desc(activeGoals.updatedAt)]
    });

    if (currentGoal) {
        console.log(`[GoalSeek] Active goal found: ${currentGoal.type} on target ${currentGoal.targetId}`);
        const progress = await db.query.userVocabulary.findFirst({
            where: and(
                eq(userVocabulary.userId, userId),
                eq(userVocabulary.lexemeId, currentGoal.targetId)
            ),
            with: { lexeme: true }
        });

        if (progress && progress.lastReview && progress.lastReview > currentGoal.createdAt && progress.reps > 0) {
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

    // Priority A: Remediation (Recent failures = state 1 Learning or state 3 Relearning)
    // Skip function words — they don't need drilling
    const FUNCTION_POS = new Set(['PRON', 'CONJ', 'PREP', 'DET', 'ART', 'NUM', 'INTJ']);
    const recentFailure = await db.query.userVocabulary.findFirst({
        where: and(
            eq(userVocabulary.userId, userId),
            eq(userVocabulary.state, 1),
        ),
        orderBy: [desc(userVocabulary.lastReview)],
        with: { lexeme: true }
    });

    if (recentFailure && !FUNCTION_POS.has(recentFailure.lexeme?.pos || '')) {
        console.log(`[GoalSeek] Remediation needed for "${recentFailure.lexeme.lemma}" (state ${recentFailure.state}, pos ${recentFailure.lexeme?.pos})`);
        await db.insert(activeGoals).values({
            userId,
            languageCode: goalLang,
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

    const startedLexemes = await db.query.userVocabulary.findMany({
        where: eq(userVocabulary.userId, userId),
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
        },
        orderBy: [asc(lexemes.frequencyRank)],
    });

    if (unstartedLexeme) {
        console.log(`[GoalSeek] Setting new vocabulary goal: "${unstartedLexeme.lemma}"`);
        await db.insert(activeGoals).values({
            userId,
            languageCode: goalLang,
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
   * Multi-goal system: maintain up to 3 active goals with priorities.
   * Never blocks — always returns ALL active goal messages for the tutor.
   */
  static async updateGoals(
    userId: string,
    recentAnalysis?: { errors: { lemma: string; grammarRule?: { rule: string; example: string } }[]; grammarHints: string[] },
  ): Promise<string | null> {
    const MAX_ACTIVE_GOALS = 3;
    const now = new Date();

    // Language scope for everything below. Goals used to be unscoped, so a
    // Portuguese remediation goal surfaced in a Russian session's planner
    // prompt (confirmed live 2026-07-02). Legacy rows with a null
    // language_code simply drop out of view.
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const targetLang = user?.targetLanguage || 'ru';
    const scoped = and(
      eq(activeGoals.userId, userId),
      eq(activeGoals.status, 'active'),
      eq(activeGoals.languageCode, targetLang),
    );

    // 1. Complete any goals whose target word was used correctly (sustained — at least 2 reps).
    // Also retire goals whose target lexeme no longer exists (contamination
    // cleanups delete lexemes; their goals used to linger active forever and
    // this loop re-queried every one of them on every user turn — 145 zombie
    // goals observed live, 2026-07-02).
    const activeGoalsList = await db.query.activeGoals.findMany({
      where: scoped,
      orderBy: [asc(activeGoals.priority)],
    });

    for (const goal of activeGoalsList) {
      const lexemeExists = await db.query.lexemes.findFirst({
        where: eq(lexemes.id, goal.targetId),
        columns: { id: true },
      });
      if (!lexemeExists) {
        await db.update(activeGoals)
          .set({ status: 'failed', updatedAt: now })
          .where(eq(activeGoals.id, goal.id));
        continue;
      }

      const progress = await db.query.userVocabulary.findFirst({
        where: and(
          eq(userVocabulary.userId, userId),
          eq(userVocabulary.lexemeId, goal.targetId),
        ),
        with: { lexeme: true },
      });

      if (progress && progress.state >= 2 && progress.reps >= 2 && progress.lastReview && progress.lastReview > goal.createdAt) {
        await db.update(activeGoals)
          .set({ status: 'completed', updatedAt: now })
          .where(eq(activeGoals.id, goal.id));
      }
    }

    // 2. Add new remediation goals from recent analysis errors
    // Skip function words — they're learned through exposure, not drilling
    const GOAL_FUNCTION_POS: Set<string> = new Set(['PRON', 'CONJ', 'PREP', 'DET', 'ART', 'NUM', 'INTJ']);
    if (recentAnalysis && recentAnalysis.errors.length > 0) {
      for (const error of recentAnalysis.errors) {
        // Find the lexeme to check POS before creating a goal
        const lexeme = await db.query.lexemes.findFirst({
          where: and(eq(lexemes.lemma, error.lemma), eq(lexemes.language, targetLang)),
        });

        if (!lexeme || GOAL_FUNCTION_POS.has(lexeme.pos)) continue;

        // Check if there's already an active goal for this word
        const existing = await db.query.activeGoals.findFirst({
          where: and(
            eq(activeGoals.userId, userId),
            eq(activeGoals.status, 'active'),
            eq(activeGoals.targetId, lexeme.id),
          ),
        });

        if (!existing) {
          // Remediation goals respect the same cap as vocab goals — they
          // used to be uncapped, which is how one account accumulated 145
          // simultaneously-"active" goals (each re-checked with its own DB
          // queries on every turn). Three goals is all the planner prompt
          // can act on anyway; older errors resurface through FSRS.
          const activeCount = await db.query.activeGoals.findMany({
            where: scoped,
            columns: { id: true },
          });
          if (activeCount.length >= MAX_ACTIVE_GOALS) break;

          await db.insert(activeGoals).values({
              userId,
              languageCode: targetLang,
              type: 'remediation',
              targetId: lexeme.id,
              status: 'active',
              priority: 1,
              grammarContext: error.grammarRule ? JSON.stringify(error.grammarRule) : null,
              pattern: error.grammarRule?.rule ? error.grammarRule.rule.split(' ').slice(0, 3).join('_') : null,
              createdAt: now,
              updatedAt: now,
            }).onConflictDoNothing();
          }
      }
    }

    // 3. If we have fewer than MAX_ACTIVE_GOALS, fill with vocab goals
    const currentActive = await db.query.activeGoals.findMany({
      where: scoped,
      orderBy: [asc(activeGoals.priority)],
    });

    if (currentActive.length < MAX_ACTIVE_GOALS) {
      const startedLexemes = await db.query.userVocabulary.findMany({
        where: eq(userVocabulary.userId, userId),
        columns: { lexemeId: true },
      });
      const activeTargets = new Set(currentActive.map(g => g.targetId));
      const startedIds = new Set(startedLexemes.map(p => p.lexemeId));

      // Try to find an unstarted lexeme that's not already an active goal
      // Pick by frequency rank (breadth-first, not semantic proximity)
      const excludeIds = [...startedIds, ...activeTargets].slice(0, 999);

      // Use frequency_rank to pick the most common word the user hasn't seen yet
      // This gives breadth coverage, not synonym clusters
      const allLexemes = await db.query.lexemes.findMany({
        where: eq(lexemes.language, targetLang),
        orderBy: [asc(lexemes.frequencyRank)],
        limit: 200,
      });

      const unstartedLexeme = allLexemes.find(l => !excludeIds.includes(l.id));

      if (unstartedLexeme && currentActive.length < MAX_ACTIVE_GOALS) {
        await db.insert(activeGoals).values({
          userId,
          languageCode: targetLang,
          type: 'vocab',
          targetId: unstartedLexeme.id,
          status: 'active',
          priority: 5,
          grammarContext: null,
          pattern: null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing();
      }
    }

    // 4. Build the goal message for the tutor — ALL active goals, not just one
    const allActive = await db.query.activeGoals.findMany({
      where: scoped,
      orderBy: [asc(activeGoals.priority)],
    });

    if (allActive.length === 0) return null;

    const goalMessages: string[] = [];
    for (const goal of allActive) {
      const lexeme = await db.query.lexemes.findFirst({ where: eq(lexemes.id, goal.targetId) });
      if (!lexeme) continue;

      if (goal.type === 'remediation') {
        const grammarStr = goal.grammarContext ? ` The grammar rule: ${goal.grammarContext}.` : '';
        goalMessages.push(`STRUGGLING: "${lexeme.lemma}" (${lexeme.translation}) — the learner keeps making errors with this word.${grammarStr} Weave practice into the conversation naturally, don't drill it explicitly.`);
      } else if (goal.type === 'vocab') {
        goalMessages.push(`NEW WORD: "${lexeme.lemma}" (${lexeme.translation}) — introduce it when the conversation naturally touches on the topic. Don't force it.`);
      }
    }

    return goalMessages.length > 0 ? goalMessages.join('\n') : null;
  }

  /**
   * Get semantic neighbors of a lexeme using pgvector HNSW index.
   */
  static async getSemanticNeighbors(lexemeId: string, limit: number = 5): Promise<{ id: string; lemma: string; distance: number }[]> {
    const result = await db.select({
      id: lexemes.id,
      lemma: lexemes.lemma,
    }).from(lexemes)
      .where(and(
        eq(lexemes.id, lexemeId) ? undefined : undefined, // just to ensure lexeme exists
      ))
      .limit(1);

    // We need the embedding first
    const lexeme = await db.query.lexemes.findFirst({
      where: eq(lexemes.id, lexemeId),
    });
    if (!lexeme?.embedding) return [];

    // Raw SQL for nearest-neighbor via HNSW
    const embeddingStr = JSON.stringify(lexeme.embedding);
    const neighbors = await db.execute(sql`
      SELECT id, lemma, embedding <=> ${embeddingStr}::vector AS distance
      FROM lexemes
      WHERE id != ${lexemeId}
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `);

    return neighbors as any;
  }

  // ============================================================================
  // USER NOTES (durable learner insights)
  // ============================================================================

  static readonly NOTE_CATEGORIES = ['preference', 'level', 'frustration', 'goal', 'engagement'] as const;
  static readonly MAX_NOTES_PER_CATEGORY = 3;

  /** Read all active (non-superseded) notes for a user. */
  static async getUserNotes(userId: string): Promise<Array<{ id: string; category: string; content: string; source: string }>> {
    const notes = await db.query.userNotes.findMany({
      where: and(
        eq(userNotes.userId, userId),
        isNull(userNotes.supersededById),
      ),
      orderBy: [asc(userNotes.createdAt)],
    });
    return notes.map(n => ({ id: n.id, category: n.category, content: n.content, source: n.source }));
  }

  /** Format notes for the planner context. */
  static async getNotesContext(userId: string): Promise<string> {
    const notes = await this.getUserNotes(userId);
    if (notes.length === 0) return '';
    return 'Learner Notes:\n' + notes.map(n => `- [${n.category}] ${n.content}`).join('\n');
  }

  /**
   * Write a new note. If the category is at cap, supersede the oldest note.
   * Returns the note ID or null if invalid.
   */
  static async writeNote(userId: string, category: string, content: string, source: string = 'observed'): Promise<string | null> {
    if (!(this.NOTE_CATEGORIES as readonly string[]).includes(category)) return null;
    if (!content || content.length > 200) return null;

    // Check for duplicate/similar content in this category
    const existing = await db.query.userNotes.findMany({
      where: and(
        eq(userNotes.userId, userId),
        eq(userNotes.category, category),
        isNull(userNotes.supersededById),
      ),
      orderBy: [asc(userNotes.createdAt)],
    });

    // Skip if a very similar note already exists (simple substring check)
    const trimmedContent = content.trim().toLowerCase();
    for (const note of existing) {
      const existingContent = note.content.toLowerCase();
      // Skip if the new note is nearly identical to an existing one
      if (existingContent === trimmedContent) return null;
      // Skip if one contains the other (handles paraphrases like "loves travel" vs "loves travel topics")
      if (existingContent.length > 10 && trimmedContent.length > 10 &&
          (existingContent.includes(trimmedContent) || trimmedContent.includes(existingContent))) {
        return null;
      }
    }

    let supersededId: string | null = null;
    if (existing.length >= this.MAX_NOTES_PER_CATEGORY && existing[0]) {
      // Supersede the oldest note in this category
      supersededId = existing[0].id;
    }

    const [inserted] = await db.insert(userNotes).values({
      userId,
      category,
      content: content.trim(),
      source,
      supersededById: null,
    }).returning({ id: userNotes.id });

    // Link superseded note to the new one
    if (supersededId && inserted) {
      await db.update(userNotes)
        .set({ supersededById: inserted.id })
        .where(eq(userNotes.id, supersededId));
    }

    return inserted?.id || null;
  }

  // ============================================================================
  // SESSION SUMMARIES (cross-session memory)
  // ============================================================================

  /**
   * Get last N session summaries for planner context, scoped to a single
   * target language. Cross-language bleed here (e.g. Russian vocabulary
   * hints surfacing in a Portuguese session) was a confirmed live bug —
   * pre-2026-07-02 rows have no language recorded and are excluded.
   */
  static async getRecentSummaries(userId: string, languageCode: string, limit: number = 3): Promise<Array<{ endedAt: Date; durationMinutes: number; topicsCovered: string | null; errorsPattern: string | null; summary: string; nextSessionHint: string | null }>> {
    const summaries = await db.query.sessionSummaries.findMany({
      where: and(eq(sessionSummaries.userId, userId), eq(sessionSummaries.languageCode, languageCode)),
      orderBy: [desc(sessionSummaries.endedAt)],
      limit,
    });
    return summaries;
  }

  /** Format recent summaries for the planner context, including time gap since last session. */
  static async getSummariesContext(userId: string, languageCode: string): Promise<string> {
    const summaries = await this.getRecentSummaries(userId, languageCode, 3);
    if (summaries.length === 0) return '';

    const now = new Date();
    const lastEnded = summaries[0].endedAt;
    const gapMs = now.getTime() - new Date(lastEnded).getTime();
    const gapHours = Math.round(gapMs / 3_600_000);
    let gapStr: string;
    if (gapHours < 1) gapStr = 'just now';
    else if (gapHours < 24) gapStr = `${gapHours} hour${gapHours !== 1 ? 's' : ''} ago`;
    else {
      const gapDays = Math.round(gapHours / 24);
      gapStr = `${gapDays} day${gapDays !== 1 ? 's' : ''} ago`;
    }

    const lines = summaries.map(s => {
      const date = s.endedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      let line = `- ${date} (${s.durationMinutes}min): ${s.summary}`;
      if (s.nextSessionHint) line += ` Next: ${s.nextSessionHint}`;
      return line;
    });
    return `Recent Sessions (last was ${gapStr}):\n` + lines.join('\n');
  }

  /** Write a session summary. */
  static async writeSessionSummary(userId: string, data: {
    languageCode: string;
    startedAt: Date; endedAt: Date; durationMinutes: number;
    topicsCovered: string | null; wordsWorked: string | null;
    errorsPattern: string | null; summary: string; nextSessionHint: string | null;
  }): Promise<string> {
    const [inserted] = await db.insert(sessionSummaries).values({
      userId,
      ...data,
    }).returning({ id: sessionSummaries.id });
    return inserted?.id || '';
  }
}

/**
 * TESTING ONLY: Simple placeholder goal system
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

  static getNextGoal(): string {
    const goal = this.TEST_GOALS[this.goalIndex];
    this.goalIndex = (this.goalIndex + 1) % this.TEST_GOALS.length;
    return goal.message;
  }

  static completeGoal(goalType: string): string {
    return `GOAL COMPLETED! The user successfully completed the ${goalType} goal. Briefly praise them and move on.`;
  }

  static reset(): void {
    this.goalIndex = 0;
  }
}