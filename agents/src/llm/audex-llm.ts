/**
 * AudexLLM — text-generation stage of the cascaded Audex-30B-A3B s2s
 * server (see ~/audex-quant/WIRING.md). Extends the base LLM (not
 * openai.LLM) because the server's `/api/generate-response` isn't
 * OpenAI-compatible: it takes a single `text` (latest utterance) plus a
 * `prompt` (system instructions), not a messages array — so history has
 * to be flattened into the prompt ourselves.
 *
 * Protocol (confirmed live 2026-07-16): POST JSON {text, prompt,
 * enable_reasoning} to `/api/generate-response`, NDJSON response where
 * `{"type":"text","text":...}` lines carry the CUMULATIVE response so far
 * (not deltas) and the final `{"type":"complete","text":...}` line has
 * the full text. We diff consecutive cumulative strings to emit deltas.
 */

import { llm, type APIConnectOptions } from '@livekit/agents';
import { llmEvents } from '../lib/llm-events.js';

type LLMOptions = { baseURL: string; enableReasoning?: boolean };

const MAX_CONTEXT_ITEMS = 12;
const MAX_HISTORY_CHARS = 2000;

function truncateContext(chatCtx: llm.ChatContext, maxItems: number): llm.ChatContext {
  const items: any[] = chatCtx.items as any[];
  if (items.length <= maxItems + 2) return chatCtx;

  const instructionItems = items.filter((item) => item.type === 'instructions' || item.role === 'system');
  const conversationItems = items.filter((item) => item.type !== 'instructions' && item.role !== 'system');
  const kept = conversationItems.slice(-maxItems);

  const newCtx = llm.ChatContext.empty();
  for (const item of instructionItems) newCtx.insert(item);
  for (const item of kept) newCtx.insert(item);
  return newCtx;
}

export class AudexLLM extends llm.LLM {
  private baseURL: string;
  private enableReasoning: boolean;

  constructor(options: LLMOptions) {
    super();
    this.baseURL = options.baseURL.replace(/\/$/, '');
    this.enableReasoning = options.enableReasoning ?? false;
  }

  label(): string { return 'audex-llm'; }
  get model(): string { return 'audex-30b-a3b'; }
  get provider(): string { return 'local-audex'; }

  chat(opts: {
    chatCtx: llm.ChatContext;
    toolCtx?: any;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: any;
    extraKwargs?: Record<string, unknown>;
  }): any {
    return new AudexLLMStream(this, opts);
  }
}

class AudexLLMStream extends llm.LLMStream {
  private _baseURL: string;
  private _enableReasoning: boolean;
  private _chatCtx: llm.ChatContext;
  private _tokenIndex = 0;

  constructor(
    llmInstance: AudexLLM,
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
    this._enableReasoning = llmInstance['enableReasoning'];
    this._chatCtx = truncateContext(opts.chatCtx, MAX_CONTEXT_ITEMS);
  }

  protected async run(): Promise<void> {
    try {
      const { text, prompt } = this.buildRequest();
      if (!text.trim()) {
        this.queue.close();
        return;
      }

      console.log(`[AudexLLM] → ${this._baseURL}/api/generate-response text="${text.slice(0, 60)}"`);

      const response = await fetch(`${this._baseURL}/api/generate-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, prompt, enable_reasoning: this._enableReasoning }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Audex generate-response ${response.status}: ${errBody.slice(0, 300)}`);
      }
      if (!response.body) throw new Error('Audex generate-response: no response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let emitted = '';
      const reqId = `audex-${Date.now()}`;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }

          if ((obj.type === 'text' || obj.type === 'complete') && typeof obj.text === 'string') {
            const cumulative: string = obj.text;
            if (cumulative.length > emitted.length && cumulative.startsWith(emitted)) {
              const delta = cumulative.slice(emitted.length);
              emitted = cumulative;
              if (delta) {
                this._tokenIndex++;
                llmEvents.emitToken({ text: delta, index: this._tokenIndex, isStart: this._tokenIndex === 1, isEnd: false });
                this.queue.put({ id: reqId, delta: { role: 'assistant', content: delta } });
              }
            } else if (cumulative !== emitted) {
              // Non-monotonic — model restarted its answer. Just resync.
              emitted = cumulative;
            }
          }

          if (obj.type === 'complete') {
            llmEvents.emitToken({ text: '', index: this._tokenIndex, isStart: false, isEnd: true });
            this.queue.close();
            return;
          }
        }
      }

      this.queue.close();
    } catch (err: any) {
      console.error('[AudexLLM] Request failed:', err.message);
      this.queue.put({ id: `err-${Date.now()}`, delta: { role: 'assistant', content: '' } });
      this.queue.close();
    }
  }

  /**
   * Flatten ChatContext into Audex's {text, prompt} shape: `text` is the
   * latest user utterance, `prompt` is system instructions plus a rendered
   * transcript of everything before it (the server has no concept of
   * multi-turn messages).
   */
  private buildRequest(): { text: string; prompt: string } {
    const instructions: string[] = [];
    const turns: { role: string; content: string }[] = [];

    const items: any[] = this._chatCtx.items as any[];
    for (const item of items) {
      if (item.type === 'instructions') {
        const c = (item as any).instructions;
        if (c) instructions.push(String(c));
        continue;
      }
      if (item.type !== 'message') continue;
      const textContent: string = (item as any).textContent ?? '';
      if (!textContent) continue;
      if (item.role === 'system') {
        instructions.push(textContent);
      } else {
        turns.push({ role: item.role, content: textContent });
      }
    }

    let text = '';
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === 'user') {
        text = turns[i]!.content;
        turns.length = i; // drop it and everything after from history
        break;
      }
    }

    let history = turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Tutor'}: ${t.content}`)
      .join('\n');
    if (history.length > MAX_HISTORY_CHARS) {
      history = history.slice(-MAX_HISTORY_CHARS);
    }

    const promptParts = [...instructions];
    if (history) promptParts.push(`Conversation so far:\n${history}`);

    return { text, prompt: promptParts.join('\n\n') };
  }
}
