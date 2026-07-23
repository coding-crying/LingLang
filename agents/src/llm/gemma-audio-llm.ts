import { llm, type APIConnectOptions } from '@livekit/agents';
import { audioPayloadRegistry } from '../stt/gemma-audio-stt.js';
import { llmEvents } from '../lib/llm-events.js';

// GemmaAudioLLM — extends the base LLM (NOT openai.LLM) to bypass the LiveKit
// OpenAI plugin's content-type whitelist, which only accepts string and
// image_content. Our STT emits `[audio key=<id> dur=<n>s]` placeholders, and
// we look up the actual audio bytes in `audioPayloadRegistry` and forward them
// to vLLM as a real OpenAI audio_url content type which vLLM accepts for
// native-audio models.

type LLMOptions = { baseURL: string; model: string; audioCapable?: boolean };

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
  private _audioCapable: boolean;

  constructor(options: LLMOptions) {
    super();
    this.baseURL = options.baseURL.replace(/\/$/, '');
    this._model = options.model;
    this._audioCapable = options.audioCapable ?? true;
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
  private _audioCapable: boolean;
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
    this._audioCapable = llmInstance['_audioCapable'];
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
          // 2026-07-02: this was forcing enable_thinking:true on every
          // conversational turn, overriding the server's no-think default
          // template (see gemma4-qat-vllm) and causing full chain-of-thought
          // reasoning ("Sharp/witty? Yes. Roast with charm? Yes...") to be
          // generated as the actual reply, sometimes running long enough to
          // read as a hang. The conversation agent is the low-latency path —
          // only Processor/Planner should ever request thinking, and only
          // deliberately. Explicit false here so the default is never
          // ambiguous even if the server-side template changes again.
          chat_template_kwargs: { enable_thinking: false },
          temperature: 0.6,
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
              // This checkpoint's chat template (gemma4-12b-no-think.jinja)
              // uses asymmetric channel markers — "<|channel>thought\n...
              // \n<channel|>" — not the "<|channel|>...<|/channel|>" style
              // above, so that regex never matches them. Strip this format
              // too (mirrors the template's own strip_thinking() macro).
              text = text.replace(/<\|channel>[\s\S]*?<channel\|>/g, '');
              text = text.replace(/<\|channel>|<channel\|>/g, '');
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
    // text (see the collapse branch below — real per-turn transcript when
    // available, generic filler otherwise).
    //
    // 2026-07-10: dropped from 3 to 1. Confirmed live: with 3 simultaneous
    // raw audio clips in one request, the model produced an irrelevant
    // reply to a real, clearly-captured order attempt (VAD/STT mechanics
    // all correct — this was an attention failure, not a plumbing one).
    // This exact failure mode — the model losing track of "whose turn is
    // this" / which clip is current once multiple audio turns share a
    // context — was already documented and fixed for the PROCESSOR's own
    // pipeline (ConversationHistory.getLatestTurnMessages, tutor-event-
    // driven.ts: "a wider window doesn't help this model reason better...
    // it just gives it more surface area to get confused on"). That fix
    // was never applied here. Only the CURRENT turn needs to be real audio
    // for pronunciation/tone judgment; older turns now get a real
    // transcript instead of stale raw audio.
    // 2026-07-21: 0 for a text-only backend (Qwen3.5-9B, no audio modality)
    // — every audio turn, including the current one, must collapse to its
    // transcript text below. The transcript is already anchored inline
    // (GemmaAudioSTT appends it after the placeholder), so this only costs
    // the tone/pronunciation-from-raw-audio nuance, not the content itself.
    const MAX_AUDIO_TURNS = this._audioCapable ? 1 : 0; // max user audio turns sent as real audio

    // 2026-07-10: the STT now appends the real transcript after the
    // bracket (`[audio key=X dur=Ys] Я хочу кофе.`) — capture it. Older
    // placeholder-only turns (transcription failed/disabled) still match
    // with an undefined transcript.
    const items: { role: string; textContent: string; isAudio: boolean; audioId?: string; transcript?: string }[] = [];
    for (const item of this._chatCtx.items) {
      if (item.type !== 'message') continue;
      const textContent: string = (item as any).textContent ?? '';
      if (!textContent) continue;

      const keyMatch = textContent.match(/^\[audio key=([A-Za-z0-9]+)(?: dur=([0-9.]+)s)?\](?:\s+([\s\S]+))?$/);
      items.push({
        role: item.role,
        textContent,
        isAudio: !!keyMatch,
        audioId: keyMatch?.[1],
        transcript: keyMatch?.[3]?.trim() || undefined,
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
    let collapsedWithTranscript = 0;
    let collapsedGeneric = 0;

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
            // 2026-07-11: was hardcoded "[user spoke in Russian]" from the
            // ru-only era — in a zh session that told the model the user
            // speaks Russian, and it confabulated accordingly ("you went
            // full Russian on me!" to a verified-Chinese transcript, live).
            // Language-neutral text can never be wrong.
            out.push({ role: msg.role, content: `[voice message — transcript unavailable]` });
            continue;
          }
          console.log(
            `[GemmaAudioLLM] Audio payload: ${(entry.uri.length / 1024).toFixed(1)} KB ` +
            `(${entry.durationSec.toFixed(2)}s @ ${entry.sampleRate}Hz, key=${msg.audioId}` +
            `${msg.transcript ? ', anchored' : ', no transcript'})`,
          );
          // 2026-07-10: transcript anchor. Same pattern that fixed the
          // processor's grading pass — hand the model the verified words so
          // it judges/responds instead of also solving "what was said" from
          // raw audio under a big prompt (which produced wrong-language
          // hallucinations and inverted speaker attribution, live, 3x).
          // Audio stays attached for tone/pronunciation. No transcript
          // (transcription failed) → old instruction, old behavior.
          const anchorText = msg.transcript
            ? `The user said (verified transcript): "${msg.transcript}". Their audio is attached — respond to what they actually said, in the same language they used.`
            : "Listen to the user's audio and respond in the same language they used.";
          out.push({
            role: msg.role,
            content: [
              { type: 'text', text: anchorText },
              // 2026-07-02: the stripped-prefix workaround was SGLang-specific
              // (its load_audio patch decoded raw base64 > 1KB directly).
              // vLLM's OpenAI-compatible audio_url strictly validates the URL
              // scheme and 400s on a bare base64 string ("The URL must be
              // either a HTTP, data or file URL") — every conversational
              // audio turn was silently failing since the vLLM migration.
              // Send the full data: URI, same as the Processor's audio path
              // (tutor-event-driven.ts ConversationHistory.getContextAsMessages),
              // which never had this bug.
              { type: 'audio_url', audio_url: { url: entry.uri } },
            ],
          });
        } else {
          // Old audio — collapse to text (saves KV cache, avoids the
          // multi-audio attention failure — see MAX_AUDIO_TURNS note
          // above). Transcript preference order: inline (STT-attached,
          // travels with the message itself — survives registry GC) →
          // registry entry (processor-attached, legacy path) → generic
          // one-per-group marker.
          const inlineTranscript = msg.transcript;
          const registryTranscript = audioPayloadRegistry.get(msg.audioId)?.transcript;
          const transcript = inlineTranscript || registryTranscript;
          if (transcript) {
            collapsedWithTranscript++;
            out.push({ role: msg.role, content: `[User said: "${transcript}"]` });
          } else {
            collapsedGeneric++;
            if (!collapsedOldAudio) {
              collapsedOldAudio = true;
              out.push({
                role: msg.role,
                // 2026-07-11: was "...spoke several sentences in Russian..."
                // hardcoded from the ru-only era — see the note on the
                // registry-miss fallback above; same live confabulation.
                content: `[The user said some earlier turns by voice — transcripts unavailable.]`,
              });
            }
          }
        }
        continue;
      }

      // Plain text message (assistant replies, system, etc.)
      out.push({ role: msg.role, content: msg.textContent });
    }

    const audioCount = out.filter(m => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === 'audio_url')).length;
    console.log(
      `[GemmaAudioLLM] Built ${out.length} msgs: ${audioCount} real audio, ` +
      `${collapsedWithTranscript} collapsed→transcript, ${collapsedGeneric} collapsed→generic`,
    );
    return out;
  }
}
