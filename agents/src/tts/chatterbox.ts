/**
 * Chatterbox TTS Client with HTTP Streaming
 *
 * Uses Chatterbox's /v1/audio/speech endpoint with streaming enabled.
 * Audio is generated sentence-by-sentence and streamed as chunks arrive.
 */

import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;

export interface ChatterboxTTSOptions {
  baseURL?: string;
  voice?: string;
  speed?: number;
  chunkSize?: number;  // Characters per sentence chunk (default 120)
  language_id?: string;
}

const defaultOptions: ChatterboxTTSOptions = {
  baseURL: 'http://localhost:8004',
  voice: 'Russian',
  speed: 1.0,
  chunkSize: 120,
};

export class ChatterboxTTS extends tts.TTS {
  #opts: ChatterboxTTSOptions;
  label = 'chatterbox.TTS';

  constructor(opts: Partial<ChatterboxTTSOptions> = {}) {
    const mergedOpts = { ...defaultOptions, ...opts };
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = mergedOpts;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChatterboxChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new ChatterboxSynthesizeStream(this, this.#opts);
  }
}

class ChatterboxChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: ChatterboxTTSOptions;
  #text: string;
  label = 'chatterbox.ChunkedStream';

  constructor(
    tts: ChatterboxTTS,
    text: string,
    opts: ChatterboxTTSOptions,
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
      this.#logger.info(`[Chatterbox] Streaming TTS for: "${this.#text.substring(0, 50)}..."`);

      const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: this.#text,
          voice: this.#opts.voice,
          model: 'tts-1',
          response_format: 'pcm',
          speed: this.#opts.speed,
          stream: true,
          chunk_size: this.#opts.chunkSize,
          language_id: this.#opts.language_id,
        }),
        signal: this.abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Chatterbox error ${response.status}: ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          this.#logger.info(`[Chatterbox] Stream complete, total: ${totalBytes} bytes`);
          break;
        }

        if (value) {
          totalBytes += value.length;
          this.#logger.debug(`[Chatterbox] Received chunk: ${value.length} bytes`);

          // Convert Uint8Array to Buffer for AudioByteStream
          const buffer = Buffer.from(value);

          for (const frame of bstream.write(buffer)) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
        }
      }

      // Flush remaining audio
      for (const frame of bstream.flush()) {
        this.queue.put({
          requestId,
          frame,
          final: false,
          segmentId: requestId,
        });
      }

    } catch (err) {
      if (this.abortSignal?.aborted) {
        this.#logger.info('[Chatterbox] Request aborted');
      } else {
        this.#logger.error({ err }, 'Chatterbox TTS error');
        throw err;
      }
    } finally {
      this.queue.close();
    }
  }
}

class ChatterboxSynthesizeStream extends tts.SynthesizeStream {
  #opts: ChatterboxTTSOptions;
  #logger = log();
  label = 'chatterbox.SynthesizeStream';

  constructor(tts: ChatterboxTTS, opts: ChatterboxTTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const segmentId = shortuuid();

    try {
      // Collect all text from input stream
      let fullText = '';
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;

        if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
          // End of text - generate audio
          if (fullText.trim()) {
            await this.generateAndStream(fullText, bstream, segmentId);
          }
          fullText = '';
        } else {
          fullText += input;
        }
      }

      // Generate any remaining text
      if (fullText.trim()) {
        await this.generateAndStream(fullText, bstream, segmentId);
      }

    } catch (err) {
      this.#logger.error({ err }, 'Chatterbox SynthesizeStream error');
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }

  private async generateAndStream(
    text: string,
    bstream: AudioByteStream,
    segmentId: string,
  ): Promise<void> {
    this.#logger.info(`[Chatterbox] Generating: "${text.substring(0, 50)}..."`);

    const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice: this.#opts.voice,
        model: 'tts-1',
        response_format: 'pcm',
        speed: this.#opts.speed,
        stream: true,
        chunk_size: this.#opts.chunkSize,
        language_id: this.#opts.language_id,
      }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Chatterbox error ${response.status}: ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (value) {
        const buffer = Buffer.from(value);

        for (const frame of bstream.write(buffer)) {
          this.queue.put({
            requestId: shortuuid(),
            frame,
            final: false,
            segmentId,
          });
        }
      }
    }

    // Flush remaining
    for (const frame of bstream.flush()) {
      this.queue.put({
        requestId: shortuuid(),
        frame,
        final: false,
        segmentId,
      });
    }
  }
}
