/**
 * Service Factory
 *
 * Switches between local, cloud, and gemini services based on SERVICE_MODE env var
 *
 * Modes:
 *   local             — Qwen3-ASR + Ollama LLM + MossTTS (all local)
 *   cloud             — ElevenLabs STT + NanoGPT LLM + ElevenLabs TTS
 *   local-gemma-audio — Gemma 4 E4B audio pass-through (experimental)
 *   gemini            — Gemini RealtimeModel (handles STT+LLM+TTS in one WebSocket)
 */

import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { Modality } from '@google/genai';
import type { llm, stt, tts } from '@livekit/agents';

import { createTTS } from '../tts/fallback.js';
import { getLanguageConfig } from '../config/languages.js';
import { GemmaAudioSTT } from '../stt/gemma-audio-stt.js';
import { GemmaAudioLLM } from '../llm/gemma-audio-llm.js';
import { ElevenLabsRealtimeSTT } from '../stt/elevenlabs-realtime.js';

// Lazy import for Google RealtimeModel — heavy, only needed in gemini mode
let _googleRealtime: { RealtimeModel: any } | null = null;
async function getGoogleRealtime() {
  if (!_googleRealtime) {
    const googlePlugin = await import('@livekit/agents-plugin-google');
    _googleRealtime = googlePlugin.beta.realtime;
  }
  return _googleRealtime;
}

export type ServiceMode = 'local' | 'cloud' | 'local-gemma-audio' | 'gemini';

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
   * Create STT (Speech-to-Text) service.
   * Not needed in gemini mode — RealtimeModel handles it.
   */
  createSTT(): stt.STT {
    if (this.mode === 'local-gemma-audio') {
      console.log(`[ServiceFactory] STT: Gemma 4 E4B (Audio Pass-Through)`);
      return new GemmaAudioSTT();
    }

    if (this.mode === 'gemini') {
      // Gemini RealtimeModel handles STT internally — return a no-op placeholder.
      // AgentSession still expects an stt param, but the framework ignores it
      // when llm is a RealtimeModel.
      throw new Error('Use createLLM() for gemini mode — RealtimeModel handles STT+TTS');
    }

    // local mode — Qwen3-ASR
    const langConfig = getLanguageConfig(this.targetLanguage);

    if (this.mode === 'cloud') {
      const ELEVENLABS_LANGUAGE_CODES: Record<string, string | undefined> = {
        en: undefined,
        ru: 'rus',
        es: 'spa',
        fr: 'fra',
        pt: 'por',
        ar: 'ara',
      };
      const languageCode = ELEVENLABS_LANGUAGE_CODES[langConfig.code];
      console.log(`[ServiceFactory] STT: ElevenLabs Scribe v2 Realtime (lang: ${languageCode || 'auto'})`);
      return new ElevenLabsRealtimeSTT({
        apiKey: process.env.ELEVENLABS_API_KEY || '',
        language: languageCode,
        commitStrategy: 'vad',
        vadSilenceThresholdSecs: 1.5,
      }) as unknown as stt.STT;
    }

    console.log(`[ServiceFactory] STT: Qwen3-ASR (${langConfig.stt.language})`);
    return new openai.STT({
      baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8001/v1',
      apiKey: 'dummy',
      language: langConfig.stt.language,
    });
  }

  /**
   * Create LLM service.
   * In gemini mode, returns a RealtimeModel (replaces STT+LLM+TTS).
   * Otherwise returns a standard LLM.
   */
  async createLLM(): Promise<llm.LLM | llm.RealtimeModel> {
    if (this.mode === 'local-gemma-audio') {
      console.log(`[ServiceFactory] LLM: Gemma 4 E4B (Multimodal Reconstructor)`);
      return new GemmaAudioLLM({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8001/v1',
        model: 'google/gemma-4-E4B-it'
      });
    }

    if (this.mode === 'gemini') {
      const { RealtimeModel } = await getGoogleRealtime();
      const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
      const langConfig = getLanguageConfig(this.targetLanguage);
      const voice = langConfig.tts.geminiVoice || process.env.GEMINI_VOICE || 'Aoede';
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required for gemini mode');

      // Map language codes to BCP-47 format for Gemini Realtime API
      const bcp47Languages: Record<string, string> = {
        'en': 'en-US',
        'ru': 'ru-RU',
        'es': 'es-ES',
        'fr': 'fr-FR',
        'pt': 'pt-PT',  // European Portuguese
        'ar': 'ar-SA',
      };
      const language = bcp47Languages[this.targetLanguage] || 'en-US';

      console.log(`[ServiceFactory] LLM: Gemini Realtime (${model}, voice: ${voice}, language: ${language})`);
      return new RealtimeModel({
        model,
        apiKey,
        voice,
        language,
        modalities: [Modality.AUDIO],
        inputAudioTranscription: { model: 'latest' },
        outputAudioTranscription: { model: 'latest' },
      });
    }

    // local or cloud — standard OpenAI-compatible LLM
    const url = process.env.CONVERSATION_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1';
    const model = process.env.CONVERSATION_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';
    const key = process.env.CONVERSATION_LLM_KEY || process.env.LOCAL_LLM_KEY || 'ollama';
    console.log(`[ServiceFactory] LLM: ${model}`);
    return new openai.LLM({ baseURL: url, model, apiKey: key });
  }

  /**
   * Create TTS.
   * Not needed in gemini mode — RealtimeModel handles it.
   */
  async createTTS(): Promise<tts.TTS> {
    const langConfig = getLanguageConfig(this.targetLanguage);
    return createTTS(langConfig);
  }

  /**
   * Create VAD (Voice Activity Detection) service.
   * VAD is always local regardless of mode.
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
   * Whether this mode uses a RealtimeModel (no separate STT/TTS needed)
   */
  isRealtimeMode(): boolean {
    return this.mode === 'gemini';
  }

  /**
   * Switch service mode
   */
  setMode(mode: ServiceMode): void {
    this.mode = mode;
    console.log(`[ServiceFactory] Switched to ${mode} mode`);
  }
}
