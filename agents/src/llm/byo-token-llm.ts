/**
 * ByoTokenLLM — openai.LLM subclass that taps the token stream into the
 * process-level llmEvents bus.
 *
 * Why: the stock @livekit/agents-plugin-openai LLM never emits to llmEvents,
 * so on BYO paths onLlmToken's isStart branch never fires,
 * currentExchangeTurnSeq stays 0 for every turn, and the frontend dedups
 * every agent.reply/user.transcript onto turnSeq 0 — the "doubling /
 * only-2-messages" bug (2026-09-03). Custom adapters (GemmaAudioLLM, Audex)
 * emit tokens themselves; BYO used the raw plugin class and got nothing.
 *
 * Mechanism: the plugin's LLMStream.run() pushes every ChatChunk through
 * `this.queue.put(chunk)` (base llm.LLMStream forwards queue -> output).
 * We wrap chat() and monkey-patch put()/close() on the returned stream
 * instance to mirror text deltas onto the bus. No fork of plugin internals.
 */

import * as openai from '@livekit/agents-plugin-openai';
import { llmEvents } from '../lib/llm-events.js';

export class ByoTokenLLM extends openai.LLM {
  private baseUrl: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(opts: any = {}) {
    super(opts);
    // 2026-09-08: vLLM endpoints serving Ling-3.0-tiny think BY DEFAULT
    // (~250 reasoning tokens, analysis leaks into the spoken reply, +1.5s).
    // Local vLLM gets enable_thinking:false; cloud endpoints go out bare —
    // OpenAI rejects unknown top-level params, and remote providers don't
    // use Ling's template kwarg anyway.
    this.baseUrl = opts?.baseURL || '';
  }

  chat(opts: Parameters<openai.LLM['chat']>[0]): any {
    const isLocal = this.baseUrl.includes('localhost') || this.baseUrl.includes('127.0.0.1');
    if (isLocal) {
      const prev = (opts as { extraKwargs?: { chat_template_kwargs?: Record<string, unknown> } }).extraKwargs;
      (opts as { extraKwargs?: unknown }).extraKwargs = {
        ...prev,
        chat_template_kwargs: { ...prev?.chat_template_kwargs, enable_thinking: false },
      };
    }
    const stream = super.chat(opts);

    const q: any = (stream as any).queue;
    if (!q || typeof q.put !== 'function') return stream;

    let tokenIndex = 0;
    const origPut = q.put.bind(q);
    q.put = (chunk: any) => {
      const text = chunk?.delta?.content;
      if (typeof text === 'string' && text.length > 0) {
        tokenIndex++;
        try {
          llmEvents.emitToken({
            text,
            index: tokenIndex,
            isStart: tokenIndex === 1,
            isEnd: false,
          });
        } catch {
          /* bus subscribers must never break the LLM stream */
        }
      }
      return origPut(chunk);
    };

    const origClose = q.close?.bind(q);
    if (origClose) {
      q.close = () => {
        if (tokenIndex > 0) {
          try {
            llmEvents.emitToken({
              text: '',
              index: tokenIndex,
              isStart: false,
              isEnd: true,
            });
          } catch { /* non-fatal */ }
        }
        return origClose();
      };
    }

    return stream;
  }
}
