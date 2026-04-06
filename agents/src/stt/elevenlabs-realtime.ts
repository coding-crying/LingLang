/**
 * ElevenLabs Scribe v2 Realtime STT
 *
 * WebSocket-based real-time speech-to-text.
 * Config is passed as URL query params (not a session_config message).
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */

import { log, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import WebSocket from 'ws';

const { SpeechEventType } = stt;

export interface ElevenLabsRealtimeSTTOptions {
  apiKey?: string;
  language?: string;
  model?: string;
  sampleRate?: number;
  commitStrategy?: 'manual' | 'vad';
  includeLanguageDetection?: boolean;
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
}

const defaultOptions: Partial<ElevenLabsRealtimeSTTOptions> = {
  model: 'scribe_v2_realtime',
  sampleRate: 16000,
  commitStrategy: 'vad',
  includeLanguageDetection: true,
  vadSilenceThresholdSecs: 1.5,
  vadThreshold: 0.4,
  minSpeechDurationMs: 100,
  minSilenceDurationMs: 100,
};

export class ElevenLabsRealtimeSTT extends stt.STT {
  #opts: ElevenLabsRealtimeSTTOptions;
  #logger = log();
  label = 'elevenlabs-realtime.STT';

  constructor(opts: ElevenLabsRealtimeSTTOptions = {}) {
    super({ streaming: true, interimResults: true });
    this.#opts = { ...defaultOptions, ...opts };
    this.#opts.apiKey ??= process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
    if (!this.#opts.apiKey) throw new Error('ElevenLabs API key is required');
  }

  protected async _recognize(_frame: AudioBuffer): Promise<stt.SpeechEvent> {
    // Not used — streaming only
    return {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: '', language: 'en', startTime: 0, endTime: 0, confidence: 0 }],
    };
  }

  stream(): stt.SpeechStream {
    return new ElevenLabsRealtimeSpeechStream(this, this.#opts);
  }
}

class ElevenLabsRealtimeSpeechStream extends stt.SpeechStream {
  #opts: ElevenLabsRealtimeSTTOptions;
  #logger = log();
  #ws?: WebSocket;
  #connected = false;
  #sessionStarted = false;
  #frameBuffer: AudioFrame[] = [];
  label = 'elevenlabs-realtime.SpeechStream';

  constructor(sttInstance: ElevenLabsRealtimeSTT, opts: ElevenLabsRealtimeSTTOptions) {
    super(sttInstance);
    this.#opts = opts;
    this.#connect();
  }

  async #connect(): Promise<void> {
    const params = new URLSearchParams({
      model_id: this.#opts.model || 'scribe_v2_realtime',
      sample_rate: String(this.#opts.sampleRate || 16000),
      commit_strategy: this.#opts.commitStrategy === 'vad' ? 'vad' : 'manual',
      include_language_detection: String(this.#opts.includeLanguageDetection ?? true),
      vad_silence_threshold_secs: String(this.#opts.vadSilenceThresholdSecs || 1.5),
      vad_threshold: String(this.#opts.vadThreshold || 0.4),
      min_speech_duration_ms: String(this.#opts.minSpeechDurationMs || 100),
      min_silence_duration_ms: String(this.#opts.minSilenceDurationMs || 100),
    });
    if (this.#opts.language && this.#opts.language !== 'auto') {
      params.set('language_code', this.#opts.language);
    }

    const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;
    this.#logger.debug('[ElevenLabs STT] Connecting...');

    this.#ws = new WebSocket(wsUrl, { headers: { 'xi-api-key': this.#opts.apiKey! } });

    this.#ws.on('open', () => {
      this.#connected = true;
      this.#logger.info('[ElevenLabs STT] Connected');
    });

    this.#ws.on('message', (data: WebSocket.Data) => this.#handleMessage(data));

    this.#ws.on('error', (err) => this.#logger.error('[ElevenLabs STT] WS error:', err));

    this.#ws.on('close', (code, reason) => {
      this.#connected = false;
      this.#logger.info(`[ElevenLabs STT] Closed: ${code} ${reason}`);
      this.queue.close();
    });
  }

  async #flushBufferedFrames(): Promise<void> {
    if (this.#frameBuffer.length === 0) return;
    this.#logger.info(`[ElevenLabs STT] Flushing ${this.#frameBuffer.length} buffered frames`);
    const frames = this.#frameBuffer;
    this.#frameBuffer = [];

    // Pace the flush to avoid overflowing ElevenLabs' realtime queue when a
    // participant is already sending audio before the websocket is fully ready.
    for (let i = 0; i < frames.length; i++) {
      if (!this.#ws || !this.#connected || !this.#sessionStarted) break;
      await this.#sendFrame(frames[i]);
      if ((i + 1) % 5 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  #handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.message_type) {
        case 'session_started':
          this.#sessionStarted = true;
          this.#logger.info('[ElevenLabs STT] Session started');
          break;

        case 'partial_transcript':
          if (msg.text?.trim()) {
            this.queue.put({
              type: SpeechEventType.INTERIM_TRANSCRIPT,
              alternatives: [{ text: msg.text, language: msg.language || 'auto', startTime: 0, endTime: 0, confidence: 0.9 }],
            });
          }
          break;

        case 'committed_transcript':
        case 'committed_transcript_with_timestamps':
          if (msg.text?.trim()) {
            this.queue.put({
              type: SpeechEventType.FINAL_TRANSCRIPT,
              alternatives: [{ text: msg.text, language: msg.language || 'auto', startTime: 0, endTime: 0, confidence: 1.0 }],
            });
          }
          break;

        case 'input_error':
        case 'auth_error':
        case 'quota_exceeded':
        case 'rate_limited':
          this.#logger.error(`[ElevenLabs STT] ${msg.message_type}:`, msg.error || msg);
          break;

        default:
          this.#logger.debug('[ElevenLabs STT] Unknown message:', msg.message_type);
      }
    } catch (err) {
      this.#logger.error('[ElevenLabs STT] Message parse error:', err);
    }
  }

  async #sendFrame(frame: AudioFrame): Promise<void> {
    if (!this.#ws || !this.#connected) return;
    const audio = Buffer.from(frame.data.buffer);
    this.#ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: audio.toString('base64'),
      commit: false,
    }));
  }

  protected async run(): Promise<void> {
    for await (const frame of this.input) {
      if (frame === stt.SpeechStream.FLUSH_SENTINEL) {
        await this.#flush();
      } else {
        const audioFrame = frame as AudioFrame;
        if (!this.#connected || !this.#sessionStarted) {
          this.#frameBuffer.push(audioFrame);
        } else {
          await this.#sendFrame(audioFrame);
        }
      }
    }
  }

  async #flush(): Promise<void> {
    if (!this.#ws || !this.#connected) return;
    this.#ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }));
  }

  async close(): Promise<void> {
    this.#ws?.close();
    this.#ws = undefined;
    this.#connected = false;
    this.queue.close();
  }
}
