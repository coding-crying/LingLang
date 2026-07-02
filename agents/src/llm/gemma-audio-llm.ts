import { llm, type APIConnectOptions } from '@livekit/agents';
import { audioPayloadRegistry } from '../stt/gemma-audio-stt.js';
import { llmEvents } from '../lib/llm-events.js';

// GemmaAudioLLM — extends the base LLM (NOT openai.LLM) to bypass the LiveKit
// OpenAI plugin's content-type whitelist, which only accepts string and
// image_content. Our STT emits `[audio key=<id> dur=<n>s]` placeholders, and
// we look up the actual audio bytes in `audioPayloadRegistry` and forward them
// to vLLM as a real OpenAI audio_url content type which vLLM accepts for
// native-audio models.

type LLMOptions = { baseURL: string; model: string };

/** Max conversation items sent to the LLM. 2026-06-25: the chat context
 *  was growing unbounded — `Built 44 msgs` after 36 turns — and the model
 *  started repeating itself as context ballooned. Cap at the last 12 user+
 *  assistant turns. Instructions/system are always kept. */
const MAX_CONTEXT_ITEMS = 12;

/**
 * Truncate a ChatContext to the most recent items, preserving instructions.
 * Mirrors `fallback-llm.ts:truncateContext`. Older audio turns in the kept
 * window are further collapsed by `buildMessages()` (MAX_AUDIO_TURNS=3).
 */
function truncateContext(chatCtx: llm.ChatContext, maxItems: number): llm.ChatContext {
  const items: any[] = chatCtx.items as any[];
  if (items.length <= maxItems + 2) return chatCtx;

  const instructionItems = items.filter((item) =>
    item.type === 'instructions' || item.role === 'system'
  );
  const conversationItems = items.filter((item) =>
    item.type !== 'instructions' && item.role !== 'system'
  );

  const kept = conversationItems.slice(-maxItems);

  const newCtx = llm.ChatContext.empty();
  for (const item of instructionItems) newCtx.insert(item);
  for (const item of kept) newCtx.insert(item);
  return newCtx;
}

export class GemmaAudioLLM extends llm.LLM {
  private baseURL: string;
  private _model: string;

  constructor(options: LLMOptions) {
    super();
    this.baseURL = options.baseURL.replace(/\/$/, '');
    this._model = options.model;
  }

  label(): string { return 'gemma-audio-llm'; }
  get model(): string { return this._model; }
  get provider(): string { return 'local-gemma'; }

  chat(opts: {
    chatCtx: llm.ChatContext;
    toolCtx?: any;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: any;
    extraKwargs?: Record<string, unknown>;
  }): any {
    return new GemmaAudioLLMStream(this, opts);
  }
}

class GemmaAudioLLMStream extends llm.LLMStream {
  private _baseURL: string;
  private _model: string;
  private _chatCtx: llm.ChatContext;
  private _extraKwargs: Record<string, unknown> | undefined;
  /** Token counter for the streaming dashboard event bus. */
  private _tokenIndex: number = 0;

  constructor(
    llmInstance: GemmaAudioLLM,
    opts: {
      chatCtx: llm.ChatContext;
      toolCtx?: any;
      connOptions?: APIConnectOptions;
      parallelToolCalls?: boolean;
      toolChoice?: any;
      extraKwargs?: Record<string, unknown>;
    },
  ) {
    super(llmInstance, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions ?? ({} as APIConnectOptions),
    });
    this._baseURL = llmInstance['baseURL'];
    this._model = llmInstance['_model'];
    // 2026-06-25: truncate the chat context BEFORE the stream runs.
    // Without this, the LLM sees the entire session history unbounded
    // (44+ items after 36 turns) and starts repeating itself.
    this._chatCtx = truncateContext(opts.chatCtx, MAX_CONTEXT_ITEMS);
    this._extraKwargs = opts.extraKwargs;
  }

  protected async run(): Promise<void> {
    try {
      const messages = this.buildMessages();
      console.log(`[GemmaAudioLLM] → vLLM ${this._baseURL}/chat/completions model=${this._model} (${messages.length} msgs)`);

      const response = await fetch(`${this._baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          messages,
          stream: true,
          // Disable chain-of-thought / reasoning mode for gemma-4 — otherwise
          // the model emits "thought\n" as its first tokens before the real
          // response, which the TTS speaks aloud.
          chat_template_kwargs: { enable_thinking: false },
          ...(this._extraKwargs ?? {}),
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`vLLM returned ${response.status}: ${errBody.slice(0, 500)}`);
      }
      if (!response.body) {
        throw new Error('vLLM response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const reqId = `chatcmpl-${Date.now()}`;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            // Tell the dashboard the response is complete so it can finalize the message.
            llmEvents.emitToken({
              text: '',
              index: this._tokenIndex,
              isStart: false,
              isEnd: true,
            });
            this.queue.close();
            return;
          }
          try {
            const obj = JSON.parse(payload);
            const choice = obj.choices?.[0];
            const id = obj.id || reqId;

            // Usage-only chunk
            if (obj.usage && !choice) {
              this.queue.put({
                id,
                usage: {
                  completionTokens: obj.usage.completion_tokens ?? 0,
                  promptTokens: obj.usage.prompt_tokens ?? 0,
                  promptCachedTokens: obj.usage.prompt_tokens_details?.cached_tokens ?? 0,
                  totalTokens: obj.usage.total_tokens ?? 0,
                },
              });
              continue;
            }

            if (!choice) continue;
            const delta = choice.delta ?? {};
            let text = delta.content;
            const extra = (delta as any).extra_content;

            // Filter "thought\n" tokens throughout the ENTIRE stream, not just
            // the prefix. The INT4 model sometimes falls into a loop where it
            // emits "thought\n" repeatedly as the whole response. Drop these
            // tokens so TTS never speaks them.
            if (text) {
              // Strip any "thought\n" or "thought " occurrences anywhere
              text = text.replace(/thought\s*\n?/gi, '');
              // If the chunk was entirely "thought\n", skip it
              if (!text.trim() && text !== ' ') continue;
            }

            // Strip meta-commentary / stage directions in parens. The persona
            // is told to never write parens, but defense in depth: any
            // "(smile)", "(Repeat: ...)", "(pause)" that slips through gets
            // dropped here so TTS never speaks it.
            if (text) {
              text = text.replace(/\s*\([^)]{1,200}\)/g, '');
            }

            // 2026-06-30: strip gemma channel/control tags. The model
            // sometimes emits "<|channel|>analysis<|message|>...<|end|>"
            // or "<|constrain|>...<|/constrain|>" markers, especially when
            // chat_template_kwargs isn't being honored. Drop block-style
            // tag pairs and any leftover standalone markers.
            if (text) {
              text = text.replace(/<\|[^|>]*\|>[\s\S]*?<\|\/[^|>]*\|>/g, '');
              text = text.replace(/<\|[^|>]*\|>/g, '');
              if (!text.trim() && text !== ' ') continue;
            }

            // Skip chunks with no usable content
            if (text === undefined && extra === undefined) continue;

            // Emit text delta to the LLM event bus so the dashboard can
            // stream tokens to the UI synchronized with the TTS audio.
            // Bookkeeping: count non-empty deltas as tokens; first one is "start".
            if (text) {
              this._tokenIndex++;
              llmEvents.emitToken({
                text,
                index: this._tokenIndex,
                isStart: this._tokenIndex === 1,
                isEnd: false,
              });
            }

            this.queue.put({
              id,
              delta: {
                role: 'assistant',
                content: text,
                extra: extra,
              },
            });
          } catch {
            // Skip malformed lines
          }
        }
      }

      this.queue.close();
    } catch (err: any) {
      console.error(`[GemmaAudioLLM] Request failed:`, err.message);
      this.queue.put({
        id: `err-${Date.now()}`,
        delta: {
          role: 'assistant',
          content: '',
        },
      });
      this.queue.close();
    }
  }

  /**
   * Build OpenAI-format messages from LiveKit ChatContext.
   * Audio placeholders → {type: "audio_url", audio_url: {url: dataURI}}.
   * Text messages stay as plain strings.
   *
   * Gemma 4 12B is encoder-free — audio is just sequence tokens to the
   * transformer. Keeping the audio in the prompt lets vLLM's prefix caching
   * reuse the cached keys/values for the unchanged prefix across turns
   * (e.g. system + audio1 + response1 stays cached; only audio2 + response2
   * get freshly computed on turn 2). This is critical for both latency and
   * for the LLM to remember what the user actually said in prior turns.
   */
  private buildMessages(): any[] {
    // First pass: collect all messages and identify audio turns.
    // We keep the last MAX_AUDIO_TURNS audio turns as real audio (for
    // prefix-cache hits on recent context) and collapse older ones into
    // a short text summary to keep KV cache usage bounded.
    //
    // With 5.43 GiB KV cache and ~7680 audio tokens/min, 2s audio ≈ 256
    // tokens. 4 turns × 256 = 1024 audio tokens — fits comfortably.
    // Without pruning, 6+ turns overflow and crash vLLM.
    const MAX_AUDIO_TURNS = 3; // max user audio turns sent as real audio

    const items: { role: string; textContent: string; isAudio: boolean; audioId?: string }[] = [];
    for (const item of this._chatCtx.items) {
      if (item.type !== 'message') continue;
      const textContent: string = (item as any).textContent ?? '';
      if (!textContent) continue;

      const keyMatch = textContent.match(/^\[audio key=([A-Za-z0-9]+)(?: dur=([0-9.]+)s)?\]$/);
      items.push({
        role: item.role,
        textContent,
        isAudio: !!keyMatch,
        audioId: keyMatch?.[1],
      });
    }

    // Count audio turns from the END backwards to know which to keep.
    let audioTurnsFromEnd = 0;
    const audioKeep = new Set<string>();
    for (let i = items.length - 1; i >= 0; i--) {
      const t: { role: string; textContent: string; isAudio: boolean; audioId?: string } | undefined = items[i];
      if (t && t.isAudio && t.audioId !== undefined) {
        audioTurnsFromEnd++;
        if (audioTurnsFromEnd <= MAX_AUDIO_TURNS) {
          audioKeep.add(t.audioId);
        }
      }
    }

    // Second pass: build the vLLM messages.
    const out: any[] = [];
    let collapsedOldAudio = false;

    for (const msg of items) {
      if (msg.isAudio && msg.audioId) {
        if (audioKeep.has(msg.audioId)) {
          // Recent audio — send as real audio_url for prefix-cache reuse.
          const entry = audioPayloadRegistry.get(msg.audioId);
          if (!entry) {
            console.warn(
              `[GemmaAudioLLM] Audio key=${msg.audioId} not in registry ` +
              `(size=${audioPayloadRegistry.size}) — sending text fallback`,
            );
            out.push({ role: msg.role, content: `[user spoke in Russian]` });
            continue;
          }
          console.log(
            `[GemmaAudioLLM] Audio payload: ${(entry.uri.length / 1024).toFixed(1)} KB ` +
            `(${entry.durationSec.toFixed(2)}s @ ${entry.sampleRate}Hz, key=${msg.audioId})`,
          );
          out.push({
            role: msg.role,
            content: [
              { type: 'text', text: "Listen to the user's audio and respond in the same language they used." },
              // SGLang's data: URI branch in load_audio is flaky for large base64 —
              // strip the prefix and send raw base64. SGLang patches in
              // utils/common.py:load_audio to decode raw base64 strings > 1KB.
              { type: 'audio_url', audio_url: { url: entry.uri.replace(/^data:audio\/[^;]+;base64,/, '') } },
            ],
          });
        } else {
          // Old audio — collapse to text summary (saves KV cache).
          // Insert ONE summary marker before the first collapsed audio
          // instead of repeating it per turn.
          if (!collapsedOldAudio) {
            collapsedOldAudio = true;
            out.push({
              role: msg.role,
              content: `[The user spoke several sentences in Russian earlier in this conversation.]`,
            });
          }
          // Skip this individual audio turn — already summarized above.
        }
        continue;
      }

      // Plain text message (assistant replies, system, etc.)
      out.push({ role: msg.role, content: msg.textContent });
    }

    const audioCount = out.filter(m => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === 'audio_url')).length;
    console.log(`[GemmaAudioLLM] Built ${out.length} msgs: ${audioCount} real audio, ${items.filter(i => i.isAudio).length - audioCount} collapsed`);
    return out;
  }
}
