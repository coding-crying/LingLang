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
  baseURL: 'https://api.minimaxi.com/v1',
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

  async chat(
    chatCtx: ChatContext,
    connOptions?: APIConnectOptions,
  ): Promise<llm.LLMStream> {
    const startTime = Date.now();

    try {
      this.#logger.debug('[MiniMax LLM] Sending chat request...');

      // Convert ChatContext to MiniMax messages format
      const messages = chatCtx.messages.map((msg: ChatMessage) => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: msg.content,
      }));

      const response = await fetch(`${this.#opts.baseURL}/chat/completions`, {
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

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const elapsed = Date.now() - startTime;
      this.#logger.info(`[MiniMax LLM] Request sent in ${elapsed}ms, streaming response...`);

      return new MiniMaxLLMStream(response.body, this.#logger);

    } catch (error) {
      this.#logger.error('[MiniMax LLM] Error:', error);
      throw error;
    }
  }
}

class MiniMaxLLMStream extends llm.LLMStream {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #logger: any;
  #buffer: string = '';

  constructor(body: ReadableStream<Uint8Array>, logger: any) {
    super();
    this.#reader = body.getReader();
    this.#logger = logger;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<llm.ChatChunk> {
    try {
      while (true) {
        const { done, value } = await this.#reader.read();

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
      this.#logger.error('[MiniMax LLM Stream] Error:', error);
      throw error;
    }
  }

  async aclose(): Promise<void> {
    try {
      await this.#reader.cancel();
    } catch (err) {
      this.#logger.warn('[MiniMax] Error closing stream:', err);
    }
  }
}
