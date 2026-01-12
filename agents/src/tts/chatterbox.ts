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
          let buffer = Buffer.from(value);

          // Apply peak limiting to prevent audio clipping
          // This keeps CUDA graphs for speed while preventing pops/peaks
          buffer = this.limitAudioPeaks(buffer);

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

  /**
   * Apply soft peak limiting to prevent audio clipping
   *
   * This processes 16-bit PCM audio to prevent peaks that cause
   * popping/distortion, especially with CUDA graphs optimization.
   *
   * Strategy: Scale down samples above threshold (80% of max)
   * - Keeps CUDA graphs for performance
   * - Adds <1ms latency (negligible)
   * - No quality loss for normal speech
   */
  private limitAudioPeaks(buffer: Buffer): Buffer {
    // PCM is 16-bit signed integers (2 bytes per sample)
    const samples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 2
    );

    // Find peak level in this chunk
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (sample !== undefined) {
        peak = Math.max(peak, Math.abs(sample));
      }
    }

    // Threshold: 80% of maximum (32767 * 0.8 = 26214)
    // Fatterbox was hitting -0.1 dB (basically 100%), so we need headroom
    const threshold = 26214;

    // If peak exceeds threshold, scale everything down proportionally
    if (peak > threshold) {
      const scale = threshold / peak;
      // this.#logger.debug(`[Chatterbox] Limiting peaks: ${peak} -> ${threshold} (scale: ${scale.toFixed(3)})`);

      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (sample !== undefined) {
          samples[i] = Math.round(sample * scale);
        }
      }
    }

    return buffer;
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
        let buffer = Buffer.from(value);

        // Apply peak limiting to prevent audio clipping
        buffer = this.limitAudioPeaks(buffer);

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

  /**
   * Apply soft peak limiting to prevent audio clipping
   * Same implementation as ChatterboxChunkedStream
   */
  private limitAudioPeaks(buffer: Buffer): Buffer {
    const samples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 2
    );

    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (sample !== undefined) {
        peak = Math.max(peak, Math.abs(sample));
      }
    }

    const threshold = 26214; // 80% of max

    if (peak > threshold) {
      const scale = threshold / peak;
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (sample !== undefined) {
          samples[i] = Math.round(sample * scale);
        }
      }
    }

    return buffer;
  }
}
