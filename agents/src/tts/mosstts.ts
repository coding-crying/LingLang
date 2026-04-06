/**
 * MOSS-TTS-Realtime Client
 *
 * Uses the OpenAI-compatible /v1/audio/speech endpoint served by
 * moss_tts_realtime/openai_tts_server.py (default port 8880).
 * Audio is streamed as raw PCM s16le at 24kHz mono.
 */

import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;

export interface MossTTSOptions {
  baseURL?: string;
  voice?: string;
  speed?: number;
}

const defaultOptions: MossTTSOptions = {
  baseURL: 'http://localhost:8880',
  voice: 'prompt_audio1',
  speed: 1.0,
};

export class MossTTS extends tts.TTS {
  #opts: MossTTSOptions;
  label = 'mosstts.TTS';

  constructor(opts: Partial<MossTTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = { ...defaultOptions, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new MossChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new MossSynthesizeStream(this, this.#opts);
  }
}

class MossChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: MossTTSOptions;
  #text: string;
  label = 'mosstts.ChunkedStream';

  constructor(
    tts: MossTTS,
    text: string,
    opts: MossTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

    try {
      this.#logger.info(`[MossTTS] Synthesizing: "${this.#text.substring(0, 50)}..."`);

      const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'moss-tts-realtime',
          input: this.#text,
          voice: this.#opts.voice,
          response_format: 'pcm',
          speed: this.#opts.speed,
        }),
        signal: this.abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`MossTTS error ${response.status}: ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.#logger.info(`[MossTTS] Stream complete, total: ${totalBytes} bytes`);
          break;
        }
        if (value) {
          totalBytes += value.length;
          for (const frame of bstream.write(Buffer.from(value))) {
            this.queue.put({ requestId, frame, final: false, segmentId: requestId });
          }
        }
      }

      for (const frame of bstream.flush()) {
        this.queue.put({ requestId, frame, final: false, segmentId: requestId });
      }
    } catch (err) {
      if (this.abortSignal?.aborted) {
        this.#logger.info('[MossTTS] Request aborted');
      } else {
        this.#logger.error({ err }, 'MossTTS error');
        throw err;
      }
    } finally {
      this.queue.close();
    }
  }
}

class MossSynthesizeStream extends tts.SynthesizeStream {
  #opts: MossTTSOptions;
  #logger = log();
  label = 'mosstts.SynthesizeStream';

  constructor(tts: MossTTS, opts: MossTTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const segmentId = shortuuid();

    try {
      let fullText = '';
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;

        if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
          if (fullText.trim()) {
            await this.generateAndStream(fullText, bstream, segmentId);
          }
          fullText = '';
        } else {
          fullText += input;
        }
      }

      if (fullText.trim()) {
        await this.generateAndStream(fullText, bstream, segmentId);
      }
    } catch (err) {
      this.#logger.error({ err }, 'MossTTS SynthesizeStream error');
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }

  private async generateAndStream(
    text: string,
    bstream: AudioByteStream,
    segmentId: string,
  ): Promise<void> {
    this.#logger.info(`[MossTTS] Generating: "${text.substring(0, 50)}..."`);

    const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'moss-tts-realtime',
        input: text,
        voice: this.#opts.voice,
        response_format: 'pcm',
        speed: this.#opts.speed,
      }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MossTTS error ${response.status}: ${error}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        for (const frame of bstream.write(Buffer.from(value))) {
          this.queue.put({ requestId: shortuuid(), frame, final: false, segmentId });
        }
      }
    }

    for (const frame of bstream.flush()) {
      this.queue.put({ requestId: shortuuid(), frame, final: false, segmentId });
    }
  }
}
