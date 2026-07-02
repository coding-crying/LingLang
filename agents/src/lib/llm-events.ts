/**
 * LLM token stream — process-level event bus.
 *
 * The LLM provider (e.g. gemma-audio-llm.ts) emits one event per token as
 * it streams. Subscribers (typically tutor-event-driven.ts) translate these
 * into the dashboard's `emitEvent('llm.token', ...)` so the UI can show
 * streaming text synchronized with audio.
 *
 * The bus is intentionally minimal — just a Node.js EventEmitter under a
 * typed interface. We don't include room/userId in the events because the
 * LLM stream doesn't know its caller; the subscriber attaches context.
 */

import { EventEmitter } from 'node:events';

export interface LlmTokenEvent {
  /** Text fragment from this delta. May be empty for usage-only chunks. */
  text: string;
  /** Token index within the current response. */
  index: number;
  /** True on the first non-empty text delta of the response. */
  isStart: boolean;
  /** True on the last delta (the LLM stream closed). */
  isEnd: boolean;
}

class LlmEventBus extends EventEmitter {
  emitToken(event: LlmTokenEvent): void {
    this.emit('token', event);
  }
}

// Single process-wide bus. Note: if the agent runs in a child process per
// job (LiveKit worker mode), this bus is per-child — which is what we want,
// since each child handles one session.
export const llmEvents = new LlmEventBus();
llmEvents.setMaxListeners(50);
