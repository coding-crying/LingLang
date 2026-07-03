/**
 * OmniVoice TTS Client
 *
 * Uses the OpenAI-compatible /v1/audio/speech endpoint served by
 * omnivoice_server.py (default port 8882).
 * Audio is streamed as raw PCM s16le at 24kHz mono.
 * Supports voice cloning via precomputed VoiceClonePrompt embeddings.
 */

import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { emitEvent } from '../lib/trace.js';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;

export interface OmniVoiceTTSOptions {
  baseURL?: string;
  voice?: string;
  speed?: number;
  language?: string;
}

const defaultOptions: OmniVoiceTTSOptions = {
  baseURL: 'http://localhost:8882',
  voice: 'auto',
  speed: 1.0,
  language: undefined,
};

export class OmniVoiceTTS extends tts.TTS {
  #opts: OmniVoiceTTSOptions;
  label = 'omnivoice.TTS';

  constructor(opts: Partial<OmniVoiceTTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = { ...defaultOptions, ...opts };
  }

  /** Update voice/language mid-session (e.g. after language switch). */
  updateVoice(voice: string, language?: string): void {
    this.#opts.voice = voice;
    if (language) this.#opts.language = language;
    log().info(`[OmniVoice] Voice updated: ${voice}, lang: ${language || this.#opts.language}`);
  }

  /** Get current voice — used by the session to check if a swap is needed. */
  get voice(): string { return this.#opts.voice || 'auto'; }
  get language(): string | undefined { return this.#opts.language; }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new OmniVoiceChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new OmniVoiceSynthesizeStream(this, this.#opts);
  }
}

class OmniVoiceChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: OmniVoiceTTSOptions;
  #text: string;
  label = 'omnivoice.ChunkedStream';

  constructor(
    tts: OmniVoiceTTS,
    text: string,
    opts: OmniVoiceTTSOptions,
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
    const tStart = Date.now();
    let tFirstByte = 0;
    let totalBytes = 0;
    let cancelled = false;

    try {
      this.#logger.info(
        `[OmniVoice] Synthesizing: voice="${this.#opts.voice}" lang="${this.#opts.language ?? '-'}" text="${this.#text.substring(0, 50)}..."`,
      );

      const body: Record<string, unknown> = {
        model: 'omnivoice',
        input: this.#text,
        voice: this.#opts.voice,
        response_format: 'pcm',
        speed: this.#opts.speed,
      };
      if (this.#opts.language) {
        body.language = this.#opts.language;
      }

      const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OmniVoice error ${response.status}: ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.#logger.info(`[OmniVoice] Stream complete, total: ${totalBytes} bytes`);
          break;
        }
        if (value) {
          if (!tFirstByte) tFirstByte = Date.now();
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
        cancelled = true;
        this.#logger.info('[OmniVoice] Request aborted');
      } else {
        this.#logger.error({ err }, 'OmniVoice error');
        try {
          emitEvent('tts.error', {
            provider: 'omnivoice',
            textLen: this.#text.length,
            error: String((err as Error).message || err).substring(0, 200),
            ttfbMs: tFirstByte ? tFirstByte - tStart : 0,
          });
        } catch { /* trace unavailable */ }
        throw err;
      }
    } finally {
      this.queue.close();
      const totalMs = Date.now() - tStart;
      const ttfbMs = tFirstByte ? tFirstByte - tStart : (cancelled ? -1 : 0);
      try {
        emitEvent('tts.synthesize', {
          provider: 'omnivoice',
          textLen: this.#text.length,
          totalBytes,
          ttfbMs,
          totalMs,
          cancelled,
        });
      } catch { /* trace unavailable */ }
    }
  }
}

class OmniVoiceSynthesizeStream extends tts.SynthesizeStream {
  #opts: OmniVoiceTTSOptions;
  #logger = log();
  label = 'omnivoice.SynthesizeStream';

  constructor(tts: OmniVoiceTTS, opts: OmniVoiceTTSOptions) {
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
      this.#logger.error({ err }, 'OmniVoice SynthesizeStream error');
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }

  private async generateAndStream(
    text: string,
    bstream: AudioByteStream,
    segmentId: string,
  ): Promise<void> {
    this.#logger.info(`[OmniVoice] Generating: "${text.substring(0, 50)}..."`);

    const body: Record<string, unknown> = {
      model: 'omnivoice',
      input: text,
      voice: this.#opts.voice,
      response_format: 'pcm',
      speed: this.#opts.speed,
    };
    if (this.#opts.language) {
      body.language = this.#opts.language;
    }

    const response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OmniVoice error ${response.status}: ${error}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const READ_TIMEOUT_MS = 15_000;
    try {
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`OmniVoice stream stalled (no data for ${READ_TIMEOUT_MS}ms)`)), READ_TIMEOUT_MS),
          ),
        ]);
        if (done) break;
        if (value) {
          for (const frame of bstream.write(Buffer.from(value))) {
            this.queue.put({ requestId: shortuuid(), frame, final: false, segmentId });
          }
        }
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }

    for (const frame of bstream.flush()) {
      this.queue.put({ requestId: shortuuid(), frame, final: false, segmentId });
    }
  }
}
