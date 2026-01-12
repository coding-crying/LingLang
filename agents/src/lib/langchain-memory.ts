/**
 * LingLangMemory: Enhanced conversation memory for LingLang
 *
 * Phase 1 Implementation: Buffer-based memory with summarization
 *
 * This replaces the simple 10-turn sliding window with a smarter buffer
 * that maintains recent turns and can summarize older context.
 *
 * Future: Will integrate full LangChain ConversationSummaryBufferMemory
 * once langchain.js package structure is stable.
 */

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class LingLangMemory {
  private turns: ConversationTurn[] = [];
  private turnCount = 0;
  private pendingUserInput: string | null = null;
  private maxRecentTurns = 15;  // Increased from 10 for better context
  private summary: string = '';

  constructor() {
    console.log('[LingLangMemory] Initialized with buffer size:', this.maxRecentTurns);
  }

  /**
   * Add a complete conversation turn (both user and assistant)
   */
  async addTurn(userContent: string, assistantContent: string): Promise<void> {
    this.turnCount++;

    this.turns.push({
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    });

    this.turns.push({
      role: 'assistant',
      content: assistantContent,
      timestamp: Date.now(),
    });

    // Trim to maxRecentTurns, keeping summary of older context
    if (this.turns.length > this.maxRecentTurns) {
      await this.trimAndSummarize();
    }
  }

  /**
   * Add only a user message (for event-driven architecture)
   */
  async addUserTurn(content: string): Promise<void> {
    if (!this.pendingUserInput) {
      this.pendingUserInput = content;
    }
  }

  /**
   * Add only an assistant message (completes the turn)
   */
  async addAssistantTurn(content: string): Promise<void> {
    if (this.pendingUserInput) {
      await this.addTurn(this.pendingUserInput, content);
      this.pendingUserInput = null;
    } else {
      console.warn('[LingLangMemory] Assistant turn without preceding user turn');
    }
  }

  /**
   * Trim older turns and create summary
   * TODO: Use LLM to generate intelligent summary
   */
  private async trimAndSummarize(): Promise<void> {
    const oldTurns = this.turns.slice(0, -this.maxRecentTurns);
    const recentTurns = this.turns.slice(-this.maxRecentTurns);

    // Simple summarization: just note how many older turns exist
    // TODO: Replace with LLM-based summarization
    if (oldTurns.length > 0 && !this.summary) {
      this.summary = `[Earlier in conversation: ${Math.floor(oldTurns.length / 2)} exchanges]`;
    }

    this.turns = recentTurns;
    console.log(`[LingLangMemory] Trimmed to ${this.turns.length} recent turns, ${oldTurns.length} summarized`);
  }

  /**
   * Get formatted conversation context for LLM prompt
   */
  async getContext(): Promise<string> {
    const parts: string[] = [];

    // Add summary of older context if exists
    if (this.summary) {
      parts.push(this.summary);
    }

    // Add recent turns
    const recentContext = this.turns
      .map(t => `${t.role === 'user' ? 'User' : 'Tutor'}: ${t.content}`)
      .join('\n');

    if (recentContext) {
      parts.push(recentContext);
    }

    return parts.join('\n\n');
  }

  /**
   * Get brief summary of recent conversation
   */
  async getSummary(): Promise<string> {
    const recentContent = this.turns
      .slice(-5)
      .map(t => t.content)
      .join(' ');

    return recentContent.substring(0, 500);  // Limit length
  }

  /**
   * Get most recent user message
   */
  async getLastUserTurn(): Promise<string | null> {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn && turn.role === 'user') {
        return turn.content;
      }
    }
    return null;
  }

  /**
   * Get total turn count
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Clear all memory
   */
  async clear(): Promise<void> {
    this.turns = [];
    this.turnCount = 0;
    this.summary = '';
    this.pendingUserInput = null;
  }
}
