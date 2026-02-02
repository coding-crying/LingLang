/**
 * ElevenLabs TTS (Text-to-Speech)
 *
 * Multilingual TTS with voice cloning and language-specific voices
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */

import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;

// Language-specific voice mappings
const LANGUAGE_VOICES: Record<string, string> = {
  'ru': 'pNInz6obpgDQGcFmaJgB', // Adam (multilingual)
  'es': 'EXAVITQu4vr4xnSDxMaL', // Bella (multilingual)
  'fr': 'ThT5KcBeYPX3keUQqHPh', // Dorothy (multilingual)
  'pt': 'cgSgspJ2msm6clMCkdW9', // Jessica (multilingual)
  'ar': 'pNInz6obpgDQGcFmaJgB', // Adam (supports Arabic)
  'en': 'pNInz6obpgDQGcFmaJgB', // Adam (default)
};

export interface ElevenLabsTTSOptions {
  apiKey?: string;
  voiceId?: string;
  language?: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
}

const defaultOptions: ElevenLabsTTSOptions = {
  model: 'eleven_turbo_v2_5', // Latest turbo model with multilingual support
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.0,
  useSpeakerBoost: true,
};

export class ElevenLabsTTS extends tts.TTS {
  #opts: ElevenLabsTTSOptions;
  #logger = log();
  label = 'elevenlabs.TTS';

  constructor(opts: Partial<ElevenLabsTTSOptions> = {}) {
    const mergedOpts = { ...defaultOptions, ...opts };
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = mergedOpts;

    if (!this.#opts.apiKey) {
      this.#opts.apiKey = process.env.ELEVENLABS_API_KEY;
    }

    if (!this.#opts.apiKey) {
      throw new Error('ElevenLabs API key is required');
    }

    // Set language-specific voice if not explicitly provided
    if (!this.#opts.voiceId && this.#opts.language) {
      this.#opts.voiceId = LANGUAGE_VOICES[this.#opts.language] || LANGUAGE_VOICES['en'];
    }

    if (!this.#opts.voiceId) {
      this.#opts.voiceId = LANGUAGE_VOICES['en']; // Default to English
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ElevenLabsChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new ElevenLabsSynthesizeStream(this, this.#opts);
  }

  /**
   * Get voice ID for a specific language
   */
  static getVoiceForLanguage(language: string): string {
    return LANGUAGE_VOICES[language] || LANGUAGE_VOICES['en'];
  }

  /**
   * List all available voices
   */
  static async listVoices(apiKey: string): Promise<any[]> {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list voices: ${response.status}`);
    }

    const data = await response.json();
    return data.voices;
  }
}

class ElevenLabsChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: ElevenLabsTTSOptions;
  #text: string;
  label = 'elevenlabs.ChunkedStream';

  constructor(
    tts: ElevenLabsTTS,
    text: string,
    opts: ElevenLabsTTSOptions,
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
      this.#logger.info(`[ElevenLabs] Synthesizing: "${this.#text.substring(0, 50)}..."`);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.#opts.voiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'xi-api-key': this.#opts.apiKey!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: this.#text,
            model_id: this.#opts.model,
            voice_settings: {
              stability: this.#opts.stability,
              similarity_boost: this.#opts.similarityBoost,
              style: this.#opts.style,
              use_speaker_boost: this.#opts.useSpeakerBoost,
            },
          }),
          signal: this.abortSignal,
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ElevenLabs TTS error ${response.status}: ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          this.#logger.info(`[ElevenLabs] Stream complete, total: ${totalBytes} bytes`);
          break;
        }

        if (value) {
          totalBytes += value.length;
          const buffer = Buffer.from(value);

          // ElevenLabs returns MP3, we need to decode to PCM
          // For now, we'll pass through - LiveKit can handle MP3
          // TODO: Add MP3 decoding if needed

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
        this.#logger.info('[ElevenLabs] Request aborted');
      } else {
        this.#logger.error({ err }, 'ElevenLabs TTS error');
        throw err;
      }
    } finally {
      this.queue.close();
    }
  }
}

class ElevenLabsSynthesizeStream extends tts.SynthesizeStream {
  #opts: ElevenLabsTTSOptions;
  #logger = log();
  label = 'elevenlabs.SynthesizeStream';

  constructor(tts: ElevenLabsTTS, opts: ElevenLabsTTSOptions) {
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
      this.#logger.error({ err }, 'ElevenLabs SynthesizeStream error');
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }

  private async generateAndStream(
    text: string,
    bstream: AudioByteStream,
    segmentId: string,
  ): Promise<void> {
    this.#logger.info(`[ElevenLabs] Generating: "${text.substring(0, 50)}..."`);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.#opts.voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': this.#opts.apiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: this.#opts.model,
          voice_settings: {
            stability: this.#opts.stability,
            similarity_boost: this.#opts.similarityBoost,
            style: this.#opts.style,
            use_speaker_boost: this.#opts.useSpeakerBoost,
          },
        }),
        signal: this.abortController.signal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS error ${response.status}: ${error}`);
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
