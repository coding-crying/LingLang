/**
 * Service Factory
 *
 * Switches between local and cloud services based on SERVICE_MODE env var
 */

import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import type { llm, stt, tts } from '@livekit/agents';

import { CosyVoiceTTS } from '../tts/cosyvoice.js';
import { ChatterboxTTS } from '../tts/chatterbox.js';
import { ElevenLabsSTT } from '../stt/elevenlabs.js';
import { ElevenLabsTTS } from '../tts/elevenlabs.js';
import { MiniMaxLLM } from '../llm/minimax.js';
import { getLanguageConfig } from '../config/languages.js';

export type ServiceMode = 'local' | 'cloud';

export interface ServiceFactoryOptions {
  mode?: ServiceMode;
  targetLanguage?: string;
  userId?: string;
}

export class ServiceFactory {
  private mode: ServiceMode;
  private targetLanguage: string;

  constructor(opts: ServiceFactoryOptions = {}) {
    this.mode = opts.mode || (process.env.SERVICE_MODE as ServiceMode) || 'local';
    this.targetLanguage = opts.targetLanguage || process.env.DEFAULT_TARGET_LANGUAGE || 'ru';

    console.log(`[ServiceFactory] Mode: ${this.mode}, Language: ${this.targetLanguage}`);
  }

  /**
   * Create STT (Speech-to-Text) service
   */
  createSTT(): stt.STT {
    if (this.mode === 'cloud') {
      console.log('[ServiceFactory] Using ElevenLabs STT');
      const langConfig = getLanguageConfig(this.targetLanguage);

      return new ElevenLabsSTT({
        apiKey: process.env.ELEVENLABS_API_KEY,
        language: langConfig.stt.language,
        model: 'scribe-multilingual-v2',
      });
    } else {
      console.log('[ServiceFactory] Using Local STT (Faster Whisper)');
      const langConfig = getLanguageConfig(this.targetLanguage);

      return new openai.STT({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
        apiKey: 'dummy',
        language: langConfig.stt.language,
      });
    }
  }

  /**
   * Create LLM (Language Model) service
   */
  createLLM(): llm.LLM {
    if (this.mode === 'cloud') {
      console.log('[ServiceFactory] Using MiniMax LLM');

      return new MiniMaxLLM({
        apiKey: process.env.MINIMAX_API_KEY,
        model: 'MiniMax-Text-01',
        temperature: 0.7,
      });
    } else {
      console.log('[ServiceFactory] Using Local LLM (Ollama)');

      return new openai.LLM({
        baseURL: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.LOCAL_LLM_MODEL || 'ministral-3:14b',
        apiKey: 'ollama',
      });
    }
  }

  /**
   * Create TTS (Text-to-Speech) service
   */
  createTTS(): tts.TTS {
    if (this.mode === 'cloud') {
      console.log('[ServiceFactory] Using ElevenLabs TTS');
      const langConfig = getLanguageConfig(this.targetLanguage);

      return new ElevenLabsTTS({
        apiKey: process.env.ELEVENLABS_API_KEY,
        language: this.targetLanguage,
        voiceId: ElevenLabsTTS.getVoiceForLanguage(this.targetLanguage),
        model: 'eleven_turbo_v2_5',
      });
    } else {
      console.log('[ServiceFactory] Using Local TTS (CosyVoice)');
      const langConfig = getLanguageConfig(this.targetLanguage);

      const useCosyVoice = process.env.LOCAL_TTS_URL?.includes('50000');

      if (useCosyVoice) {
        return new CosyVoiceTTS({
          url: process.env.LOCAL_TTS_URL || 'http://localhost:50000',
          voice: langConfig.tts.voice,
          speed: langConfig.tts.speed || 1.0,
        });
      } else {
        return new ChatterboxTTS({
          baseURL: process.env.LOCAL_TTS_URL || 'http://localhost:8005',
          voice: langConfig.tts.voice.replace('.wav', ''),
          speed: langConfig.tts.speed || 1.0,
        });
      }
    }
  }

  /**
   * Create VAD (Voice Activity Detection) service
   * Note: VAD is always local (runs on client)
   */
  static async createVAD(): Promise<silero.VAD> {
    console.log('[ServiceFactory] Loading VAD (Silero)...');
    return await silero.VAD.load();
  }

  /**
   * Get current service mode
   */
  getMode(): ServiceMode {
    return this.mode;
  }

  /**
   * Switch service mode
   */
  setMode(mode: ServiceMode): void {
    this.mode = mode;
    console.log(`[ServiceFactory] Switched to ${mode} mode`);
  }
}
