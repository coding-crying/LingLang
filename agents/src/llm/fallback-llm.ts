/**
 * Fallback LLM — tries primary (local), falls back to cloud on failure.
 * Also truncates chat context to keep TTFT fast as conversations grow.
 *
 * Implements the LiveKit Agents LLM.chat() interface, which returns an
 * LLMStream (sync) that the framework pipes into TTS for pipeline replies.
 *
 * Key insight: openai.LLM.chat() is synchronous — it returns an LLMStream
 * immediately. The actual API request runs async inside the stream's
 * mainTask. Errors (network, abort, cold-swap timeout) surface as
 * `llm_error` events on the LLM object, NOT as thrown exceptions.
 *
 * Strategy: listen for `llm_error` on the primary LLM. When it fires,
 * set a flag so the next chat() call skips the primary and goes straight
 * to fallback. The current call's stream is already dead — LiveKit's
 * generate_reply will re-invoke chat() automatically.
 */

import { llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { emitEvent } from '../lib/trace.js';

const MAX_CONTEXT_ITEMS = 24; // Keep last N items (+ system/instructions always kept)

/**
 * Truncate a ChatContext to the most recent items, preserving instructions.
 * ChatContext.items can be ChatMessage, FunctionCall, FunctionOutput, etc.
 */
function truncateContext(chatCtx: llm.ChatContext, maxItems: number): llm.ChatContext {
  const items = chatCtx.items;
  if (items.length <= maxItems + 2) return chatCtx; // +2 buffer

  // Separate instructions (system-level) from conversation items
  const instructionItems = items.filter((item: any) =>
    item.type === 'instructions' || (item.role === 'system')
  );
  const conversationItems = items.filter((item: any) =>
    item.type !== 'instructions' && item.role !== 'system'
  );

  // Keep all instructions + last N conversation items
  const kept = conversationItems.slice(-maxItems);

  const newCtx = llm.ChatContext.empty();
  for (const item of instructionItems) newCtx.insert(item);
  for (const item of kept) newCtx.insert(item);
  return newCtx;
}

export class FallbackLLM extends llm.LLM {
  primary: openai.LLM;
  fallback: openai.LLM;
  private _useFallback = false;
  private _fallbackUntil = 0; // timestamp — skip primary until this time
  private _primaryErrorCount = 0;

  constructor(opts: {
    primaryBaseURL: string;
    primaryModel: string;
    primaryApiKey: string;
    fallbackBaseURL: string;
    fallbackModel: string;
    fallbackApiKey: string;
  }) {
    super();
    this.primary = new openai.LLM({
      baseURL: opts.primaryBaseURL,
      model: opts.primaryModel,
      apiKey: opts.primaryApiKey,
    });
    this.fallback = new openai.LLM({
      baseURL: opts.fallbackBaseURL,
      model: opts.fallbackModel,
      apiKey: opts.fallbackApiKey,
    });

    // Listen for errors on the primary LLM. When the primary's stream
    // fails (abort, timeout, network), LiveKit emits `llm_error` here.
    // We mark the primary as down so the next chat() goes to fallback.
    (this.primary as any).on('error', (ev: any) => {
      if (ev.type === 'llm_error') {
        this._primaryErrorCount++;
        const cooldownMs = Math.min(30_000, 5_000 * this._primaryErrorCount); // 5s, 10s, 15s... up to 30s
        this._fallbackUntil = Date.now() + cooldownMs;
        const errMsg = ev.error?.message || String(ev.error || '');
        console.warn(
          `[FallbackLLM] Primary error (#${this._primaryErrorCount}, recoverable=${ev.recoverable}): ` +
          `${errMsg}. Using fallback for ${cooldownMs / 1000}s`
        );
        try {
          emitEvent('llm.routing', {
            path: 'fallback',
            reason: 'primary_error',
            error: errMsg.substring(0, 200),
            cooldownMs,
            errorCount: this._primaryErrorCount,
          });
        } catch { /* trace unavailable — non-fatal */ }
      }
    });

    // Also listen on fallback — if fallback fails, reset primary so we retry it
    (this.fallback as any).on('error', (ev: any) => {
      if (ev.type === 'llm_error') {
        const errMsg = ev.error?.message || String(ev.error || '');
        console.warn(`[FallbackLLM] Fallback error: ${errMsg}. Resetting primary.`);
        this._primaryErrorCount = 0;
        this._fallbackUntil = 0;
        try {
          emitEvent('llm.routing', {
            path: 'reset_primary',
            reason: 'fallback_error',
            error: errMsg.substring(0, 200),
          });
        } catch { /* trace unavailable */ }
      }
    });

    console.log(`[FallbackLLM] Primary: ${opts.primaryModel} @ ${opts.primaryBaseURL}`);
    console.log(`[FallbackLLM] Fallback: ${opts.fallbackModel} @ ${opts.fallbackBaseURL}`);
    console.log(`[FallbackLLM] Context truncation: last ${MAX_CONTEXT_ITEMS} items`);
  }

  /**
   * Returns an LLMStream for the framework to consume.
   * Truncates context, then delegates to primary LLM (or fallback on error).
   * This is synchronous — openai.LLM.chat() returns an LLMStream directly.
   */
  chat({
    chatCtx,
    toolCtx,
    connOptions,
    parallelToolCalls,
    toolChoice,
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: llm.APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    const trimmed = truncateContext(chatCtx, MAX_CONTEXT_ITEMS);
    const itemCount = trimmed.items.length;
    const origCount = chatCtx.items.length;
    if (origCount > itemCount + 2) {
      console.log(`[FallbackLLM] Context truncated: ${origCount} → ${itemCount} items`);
    }

    const usePrimary = Date.now() >= this._fallbackUntil;
    const cooldownRemaining = this._fallbackUntil - Date.now();

    if (usePrimary) {
      try {
        const t0 = Date.now();
        const stream = this.primary.chat({
          chatCtx: trimmed,
          toolCtx,
          connOptions,
          parallelToolCalls,
          toolChoice,
          extraKwargs,
        });
        const syncMs = Date.now() - t0;
        // Primary returned a stream — if it works, reset error count
        this._primaryErrorCount = 0;
        try {
          emitEvent('llm.routing', {
            path: 'primary',
            reason: 'normal',
            items: itemCount,
            syncMs,
          });
        } catch { /* trace unavailable */ }
        return stream;
      } catch (err: any) {
        const errMsg = err.message || String(err);
        console.warn(`[FallbackLLM] Primary threw synchronously: ${errMsg}, switching to fallback`);
        // Don't set cooldown — synchronous throw means the model is truly unreachable
        this._fallbackUntil = Date.now() + 60_000;
        try {
          emitEvent('llm.routing', {
            path: 'fallback',
            reason: 'primary_sync_throw',
            error: errMsg.substring(0, 200),
            cooldownMs: 60_000,
          });
        } catch { /* trace unavailable */ }
      }
    } else {
      console.log(`[FallbackLLM] Skipping primary (cooldown ${Math.ceil(cooldownRemaining / 1000)}s remaining)`);
      try {
        emitEvent('llm.routing', {
          path: 'fallback',
          reason: 'cooldown',
          cooldownMs: cooldownRemaining,
        });
      } catch { /* trace unavailable */ }
    }

    // Fallback path
    try {
      const t0 = Date.now();
      const stream = this.fallback.chat({
        chatCtx: trimmed,
        toolCtx,
        connOptions,
        parallelToolCalls,
        toolChoice,
        extraKwargs,
      });
      const syncMs = Date.now() - t0;
      try {
        emitEvent('llm.routing', {
          path: 'fallback',
          reason: 'fallback_active',
          items: itemCount,
          syncMs,
        });
      } catch { /* trace unavailable */ }
      return stream;
    } catch (err: any) {
      // Fallback also failed — reset primary cooldown so we try it next time
      const errMsg = err.message || String(err);
      console.error(`[FallbackLLM] Fallback also failed: ${errMsg}`);
      this._fallbackUntil = 0;
      try {
        emitEvent('llm.routing', {
          path: 'both_failed',
          reason: 'fallback_throw',
          error: errMsg.substring(0, 200),
        });
      } catch { /* trace unavailable */ }
      throw err;
    }
  }
}
