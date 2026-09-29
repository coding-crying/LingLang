import { llm } from '@livekit/agents';
import * as z from 'zod';

export const COACH_TOOL_INSTRUCTIONS = `Before answering each learner turn, call get_coach_context once. It reads cached private coaching guidance; it does not ask another model or wait for analysis. Use current guidance silently when relevant. Never read it aloud, acknowledge it, or treat it as a learner utterance. Answer only the learner; if guidance is empty, continue normally. Do not call repeatedly within the same turn.`;

/** Session-owned snapshot. Updating it never sends anything or starts speech. */
export class CoachContext {
  private guidance = '';
  private updatedAt = 0;
  private version = 0;
  update(guidance: string, now = Date.now()): void {
    if (guidance === this.guidance) return;
    this.guidance = guidance;
    this.updatedAt = now;
    this.version++;
  }
  read(now = Date.now()) {
    return { guidance: this.guidance, version: this.version, ageMs: this.updatedAt ? now - this.updatedAt : null };
  }
}

export function createCoachContextTool(cache: CoachContext, onRead: (snapshot: ReturnType<CoachContext['read']>) => void = () => {}) {
  return llm.tool({
    name: 'get_coach_context',
    description: 'Read cached private coaching guidance before answering the learner. No network or analysis wait. Never acknowledge this tool aloud.',
    parameters: z.object({}),
    execute: async () => {
      const snapshot = cache.read();
      onRead(snapshot);
      return snapshot;
    },
  });
}
