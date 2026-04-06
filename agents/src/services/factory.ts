/**
 * Service Factory
 *
 * Switches between local and cloud services based on SERVICE_MODE env var
 */

import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import type { llm, stt, tts } from '@livekit/agents';

import { createTTS } from '../tts/fallback.js';
import { getLanguageConfig } from '../config/languages.js';
import { GemmaAudioSTT } from '../stt/gemma-audio-stt.js';
import { GemmaAudioLLM } from '../llm/gemma-audio-llm.js';
import { ElevenLabsRealtimeSTT } from '../stt/elevenlabs-realtime.js';

export type ServiceMode = 'local' | 'cloud' | 'local-gemma-audio';

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
   * Create STT (Speech-to-Text) service — Qwen3-ASR on port 8001
   */
  createSTT(): stt.STT {
    if (this.mode === 'local-gemma-audio') {
      console.log(`[ServiceFactory] STT: Gemma 4 E4B (Audio Pass-Through)`);
      return new GemmaAudioSTT();
    }

    const langConfig = getLanguageConfig(this.targetLanguage);
    console.log(`[ServiceFactory] STT: Qwen3-ASR (${langConfig.stt.language})`);
    return new openai.STT({
      baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8001/v1',
      apiKey: 'dummy',
      language: langConfig.stt.language,
    });
  }

  /**
   * Create LLM (Language Model) service
   */
  createLLM(): llm.LLM {
    if (this.mode === 'local-gemma-audio') {
      console.log(`[ServiceFactory] LLM: Gemma 4 E4B (Multimodal Reconstructor)`);
      return new GemmaAudioLLM({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8001/v1',
        model: 'google/gemma-4-E4B-it'
      });
    }

    const url = process.env.CONVERSATION_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1';
    const model = process.env.CONVERSATION_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma3:4b';
    const key = process.env.CONVERSATION_LLM_KEY || 'ollama';
    console.log(`[ServiceFactory] LLM: ${model}`);
    return new openai.LLM({ baseURL: url, model, apiKey: key });
  }

  /**
   * Create TTS — MossTTS with ElevenLabs fallback
   */
  async createTTS(): Promise<tts.TTS> {
    const langConfig = getLanguageConfig(this.targetLanguage);
    return createTTS(langConfig);
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
