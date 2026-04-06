/**
 * MiniMax LLM Integration
 *
 * Uses MiniMax 2.1 API for multilingual language understanding
 * Docs: https://www.minimaxi.com/document/api/chat-completion
 */

import { type APIConnectOptions, llm, log } from '@livekit/agents';
import type { ChatContext, ChatMessage, ToolChoice } from '@livekit/agents';

export interface MiniMaxLLMOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

const defaultOptions: MiniMaxLLMOptions = {
  model: 'MiniMax-Text-01', // Latest MiniMax 2.1 model
  baseURL: 'https://api.minimax.io/v1',
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 2048,
};

export class MiniMaxLLM extends llm.LLM {
  #opts: MiniMaxLLMOptions;
  #logger = log();
  label = 'minimax.LLM';

  constructor(opts: Partial<MiniMaxLLMOptions> = {}) {
    super();
    this.#opts = { ...defaultOptions, ...opts };

    if (!this.#opts.apiKey) {
      this.#opts.apiKey = process.env.MINIMAX_API_KEY;
    }

    if (!this.#opts.apiKey) {
      throw new Error('MiniMax API key is required');
    }
  }

  chat({
    chatCtx,
    connOptions,
  }: {
    chatCtx: ChatContext;
    toolCtx?: any;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    if (!chatCtx || !chatCtx.items) {
      this.#logger.error('[MiniMax LLM] Invalid chatCtx:', chatCtx);
      throw new Error('Invalid ChatContext: missing items');
    }

    this.#logger.debug('[MiniMax LLM] Sending chat request with', chatCtx.items.length, 'items');

    // Convert ChatContext to MiniMax messages format
    const messages = chatCtx.items
      .filter((item: any) => item.type === 'message')
      .map((msg: any) => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: typeof msg.content === 'string' ? msg.content :
                 msg.content.map((c: any) => c.text || '').join(''),
      }));

    // Start the fetch and return stream immediately
    const responsePromise = fetch(`${this.#opts.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.#opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#opts.model,
        messages,
        temperature: this.#opts.temperature,
        top_p: this.#opts.topP,
        max_tokens: this.#opts.maxTokens,
        stream: true,
      }),
    });

    return new MiniMaxLLMStream(responsePromise, this.#logger);
  }
}

class MiniMaxLLMStream extends llm.LLMStream {
  #reader?: ReadableStreamDefaultReader<Uint8Array>;
  #logger: any;
  #buffer: string = '';
  #responsePromise: Promise<Response>;

  constructor(responsePromise: Promise<Response>, logger: any) {
    super();
    this.#responsePromise = responsePromise;
    this.#logger = logger;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<llm.ChatChunk> {
    try {
      // Await the response first
      const response = await this.#responsePromise;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      this.#reader = response.body.getReader();
      this.#logger.info('[MiniMax LLM] Streaming response...');

      while (true) {
        const { done, value } = await this.#reader!.read();

        if (done) {
          break;
        }

        // Decode chunk
        const chunk = new TextDecoder().decode(value);
        this.#buffer += chunk;

        // Parse SSE format (data: {...}\n\n)
        const lines = this.#buffer.split('\n');
        this.#buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.content) {
                yield {
                  type: 'content_delta',
                  delta: {
                    role: 'assistant',
                    content: delta.content,
                  },
                } as llm.ChatChunk;
              }

              // Check if this is the final chunk
              if (parsed.choices?.[0]?.finish_reason) {
                return;
              }

            } catch (err) {
              this.#logger.warn('[MiniMax] Failed to parse chunk:', data);
            }
          }
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.#logger.error(`[MiniMax LLM Stream] Error: ${errorMsg}`);
      throw error;
    }
  }

  async aclose(): Promise<void> {
    try {
      if (this.#reader) {
        await this.#reader.cancel();
      }
    } catch (err) {
      this.#logger.warn('[MiniMax] Error closing stream:', err);
    }
  }
}
