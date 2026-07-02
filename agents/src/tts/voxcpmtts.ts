/**
 * VoxCPM2 TTS Client (nano-vllm-voxcpm)
 *
 * Uses the OpenAI-compatible /v1/audio/speech endpoint served by
 * nano-vllm-voxcpm/server.py (default port 8881).
 * Audio is streamed as raw PCM s16le at 48kHz mono.
 */

import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 48000;

export interface VoxCpmTTSOptions {
  baseURL?: string;
  voice?: string;
  speed?: number;
}

const defaultOptions: VoxCpmTTSOptions = {
  baseURL: 'http://localhost:8881',
  voice: 'default',
  speed: 1.0,
};

export class VoxCpmTTS extends tts.TTS {
  #opts: VoxCpmTTSOptions;
  label = 'voxcpm.TTS';

  constructor(opts: Partial<VoxCpmTTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = { ...defaultOptions, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new VoxCpmChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new VoxCpmSynthesizeStream(this, this.#opts);
  }
}

class VoxCpmChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: VoxCpmTTSOptions;
  #text: string;
  label = 'voxcpm.ChunkedStream';

  constructor(
    tts: VoxCpmTTS,
    text: string,
    opts: VoxCpmTTSOptions,
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
      this.#logger.info(`[VoxCpmTTS] Synthesizing: "${this.#text.substring(0, 50)}..."`);

      const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'voxcpm2',
          input: this.#text,
          voice: this.#opts.voice,
          response_format: 'pcm',
          speed: this.#opts.speed,
        }),
        signal: this.abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`VoxCpmTTS error ${response.status}: ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.#logger.info(`[VoxCpmTTS] Stream complete, total: ${totalBytes} bytes`);
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
        this.#logger.info('[VoxCpmTTS] Request aborted');
      } else {
        this.#logger.error({ err }, 'VoxCpmTTS error');
        throw err;
      }
    } finally {
      this.queue.close();
    }
  }
}

class VoxCpmSynthesizeStream extends tts.SynthesizeStream {
  #opts: VoxCpmTTSOptions;
  #logger = log();
  label = 'voxcpm.SynthesizeStream';

  constructor(tts: VoxCpmTTS, opts: VoxCpmTTSOptions) {
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
      this.#logger.error({ err }, 'VoxCpmTTS SynthesizeStream error');
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }

  private async generateAndStream(
    text: string,
    bstream: AudioByteStream,
    segmentId: string,
  ): Promise<void> {
    this.#logger.info(`[VoxCpmTTS] Generating: "${text.substring(0, 50)}..."`);

    const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'voxcpm2',
        input: text,
        voice: this.#opts.voice,
        response_format: 'pcm',
        speed: this.#opts.speed,
      }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`VoxCpmTTS error ${response.status}: ${error}`);
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
