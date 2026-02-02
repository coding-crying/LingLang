/**
 * ElevenLabs STT (Speech-to-Text)
 *
 * Uses ElevenLabs API for multilingual speech recognition
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text
 */

import { type APIConnectOptions, log, stt } from '@livekit/agents';
import type { SpeechEvent } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

export interface ElevenLabsSTTOptions {
  apiKey?: string;
  language?: string;
  model?: string;
}

const defaultOptions: ElevenLabsSTTOptions = {
  model: 'scribe-multilingual-v2', // Latest ElevenLabs STT model
};

export class ElevenLabsSTT extends stt.STT {
  #opts: ElevenLabsSTTOptions;
  #logger = log();
  label = 'elevenlabs.STT';

  constructor(opts: Partial<ElevenLabsSTTOptions> = {}) {
    super();
    this.#opts = { ...defaultOptions, ...opts };

    if (!this.#opts.apiKey) {
      this.#opts.apiKey = process.env.ELEVENLABS_API_KEY;
    }

    if (!this.#opts.apiKey) {
      throw new Error('ElevenLabs API key is required');
    }
  }

  async recognize(
    audioData: Buffer,
    language?: string,
    connOptions?: APIConnectOptions,
  ): Promise<SpeechEvent> {
    const startTime = Date.now();
    const lang = language || this.#opts.language || 'auto';

    try {
      this.#logger.debug('[ElevenLabs STT] Sending audio for transcription...');

      // Create FormData for multipart upload
      const formData = new FormData();

      // Convert Buffer to Blob for browser compatibility
      const audioBlob = new Blob([audioData], { type: 'audio/wav' });
      formData.append('audio', audioBlob, 'audio.wav');
      formData.append('model_id', this.#opts.model!);

      if (lang !== 'auto') {
        formData.append('language', lang);
      }

      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: {
          'xi-api-key': this.#opts.apiKey!,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs STT error ${response.status}: ${errorText}`);
      }

      const result = await response.json() as { text: string; language?: string };
      const elapsed = Date.now() - startTime;

      this.#logger.info(`[ElevenLabs STT] Transcribed in ${elapsed}ms: "${result.text.substring(0, 50)}..."`);

      return {
        type: 'final_transcript',
        alternatives: [
          {
            text: result.text,
            confidence: 0.95, // ElevenLabs doesn't provide confidence scores
            language: result.language || lang,
          },
        ],
      };

    } catch (error) {
      this.#logger.error('[ElevenLabs STT] Error:', error);
      throw error;
    }
  }

  async stream(
    language?: string,
    connOptions?: APIConnectOptions,
  ): Promise<stt.SpeechStream> {
    // ElevenLabs STT doesn't support true streaming
    // Return a buffered stream that collects audio and recognizes when ended
    return new ElevenLabsSpeechStream(this, language);
  }
}

/**
 * Buffered speech stream for ElevenLabs STT
 * Collects audio chunks and processes when stream ends
 */
class ElevenLabsSpeechStream extends stt.SpeechStream {
  #stt: ElevenLabsSTT;
  #language?: string;
  #logger = log();
  #audioChunks: Buffer[] = [];
  label = 'elevenlabs.SpeechStream';

  constructor(stt: ElevenLabsSTT, language?: string) {
    super(stt, {
      streaming: false, // Not true streaming, buffered
      interimResults: false,
    });
    this.#stt = stt;
    this.#language = language;
  }

  async pushFrame(frame: AudioFrame): Promise<void> {
    // Collect audio frames
    const buffer = Buffer.from(frame.data);
    this.#audioChunks.push(buffer);
  }

  async flush(): Promise<void> {
    if (this.#audioChunks.length === 0) {
      return;
    }

    try {
      // Combine all audio chunks
      const audioData = Buffer.concat(this.#audioChunks);
      this.#audioChunks = []; // Clear buffer

      this.#logger.debug(`[ElevenLabs STT Stream] Processing ${audioData.length} bytes`);

      // Recognize the complete audio
      const event = await this.#stt.recognize(audioData, this.#language);

      // Emit the result
      this.queue.put(event);

    } catch (error) {
      this.#logger.error('[ElevenLabs STT Stream] Error:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.queue.close();
  }
}
