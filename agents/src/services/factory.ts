/**
 * Service Factory
 *
 * Switches between local, cloud, and gemini services based on SERVICE_MODE env var
 *
 * Modes:
 *   local             — Qwen3-ASR + Ollama LLM + MossTTS (all local)
 *   cloud             — ElevenLabs STT + NanoGPT LLM + ElevenLabs TTS
 *   local-gemma-audio — Gemma 4 12B native-audio pass-through (experimental)
 *   gemini            — Gemini RealtimeModel (handles STT+LLM+TTS in one WebSocket)
 */

import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { Modality } from '@google/genai';
import { llm as llmRuntime } from '@livekit/agents';
import type { llm, stt, tts } from '@livekit/agents';

import { createTTS } from '../tts/fallback.js';
import { getLanguageConfig } from '../config/languages.js';
import { GemmaAudioSTT } from '../stt/gemma-audio-stt.js';
import { OpenRouterLLM } from '../llm/openrouter-llm.js';
import { GemmaAudioLLM } from '../llm/gemma-audio-llm.js';
import { ElevenLabsRealtimeSTT } from '../stt/elevenlabs-realtime.js';

// Lazy import for Google RealtimeModel — heavy, only needed in gemini mode
let _googleRealtime: { RealtimeModel: any } | null = null;
async function getGoogleRealtime() {
  if (!_googleRealtime) {
    const googlePlugin = await import('@livekit/agents-plugin-google');
    _googleRealtime = googlePlugin.beta.realtime;

    // Workaround: agents-plugin-google's RealtimeModel ends up extending a
    // *different* loaded copy of @livekit/agents' RealtimeModel class than
    // the one @livekit/agents' own AgentActivity checks against internally
    // (`this.llm instanceof RealtimeModel` in agent_activity.js) — confirmed
    // via a standalone repro, same lockfile-resolved package version on
    // disk, just two distinct class objects at runtime (likely a tsx/dynamic
    // -import module-instance split, root cause not fully pinned down).
    // Without this, that instanceof check silently fails, AgentActivity
    // never opens a realtime session, and the whole gemini-mode demo hangs
    // in total silence with no error anywhere. Re-parenting the plugin
    // class's prototype chain (not per-instance) fixes `instanceof` for
    // every instance while leaving all of the plugin's own methods intact.
    Object.setPrototypeOf(
      Object.getPrototypeOf(_googleRealtime.RealtimeModel.prototype),
      llmRuntime.RealtimeModel.prototype,
    );
    Object.setPrototypeOf(_googleRealtime.RealtimeModel, llmRuntime.RealtimeModel);
  }
  return _googleRealtime;
}

export type ServiceMode = 'local' | 'cloud' | 'local-gemma-audio' | 'gemini';

export interface ServiceFactoryOptions {
  mode?: ServiceMode;
  targetLanguage?: string;
  userId?: string;
  /**
   * ISO 639-1 override for the speech/transcription language, when the
   * language the user will actually SPEAK isn't the target language.
   * Needed by the anonymous demo, which connects before the visitor has
   * chosen anything: the target is still a placeholder, but they're about
   * to answer "what do you want to learn?" in their own language.
   */
  speechLanguage?: string;
  /**
   * Gemini voice override. Like the speech language, the voice is fixed
   * when the socket opens, so a demo would otherwise be stuck with
   * whatever voice the *placeholder* language happens to specify (every
   * demo spoke with Russian's voice, whatever the visitor picked).
   * Options: Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr.
   */
  voice?: string;
}

export class ServiceFactory {
  private mode: ServiceMode;
  private targetLanguage: string;
  private speechLanguage?: string;
  private voiceOverride?: string;

  constructor(opts: ServiceFactoryOptions = {}) {
    this.mode = opts.mode || (process.env.SERVICE_MODE as ServiceMode) || 'local';
    this.targetLanguage = opts.targetLanguage || process.env.DEFAULT_TARGET_LANGUAGE || 'ru';
    this.speechLanguage = opts.speechLanguage;
    this.voiceOverride = opts.voice;

    console.log(`[ServiceFactory] Mode: ${this.mode}, Language: ${this.targetLanguage}`);
  }

  /**
   * Create STT (Speech-to-Text) service.
   * Not needed in gemini mode — RealtimeModel handles it.
   */
  createSTT(): stt.STT {
    if (this.mode === 'local-gemma-audio') {
      console.log(`[ServiceFactory] STT: Gemma 4 12B (Native Audio Pass-Through)`);
      return new GemmaAudioSTT();
    }

    if (this.mode === 'gemini') {
      throw new Error('Use createLLM() for gemini mode — RealtimeModel handles STT+TTS');
    }

    const langConfig = getLanguageConfig(this.targetLanguage);

    // Cloud mode — use Groq Whisper (fast, free tier) or custom STT endpoint
    if (this.mode === 'cloud') {
      const sttUrl = process.env.CLOUD_STT_URL || 'https://api.groq.com/openai/v1';
      const sttKey = process.env.CLOUD_STT_KEY || process.env.GROQ_API_KEY || '';
      const sttModel = process.env.CLOUD_STT_MODEL || 'whisper-large-v3';
      console.log(`[ServiceFactory] STT: ${sttModel} @ ${sttUrl}`);
      return new openai.STT({
        baseURL: sttUrl,
        apiKey: sttKey,
        model: sttModel,
        language: langConfig.stt.language,
      });
    }

    // Local mode — Qwen3-ASR
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
      const url = process.env.GEMMA_AUDIO_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8093/v1';
      const model = process.env.GEMMA_AUDIO_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-12b-it';
      console.log(`[ServiceFactory] LLM: Gemma 4 12B Native Audio (${model} @ ${url})`);
      return new GemmaAudioLLM({
        baseURL: url,
        model
      });
    }

    if (this.mode === 'gemini') {
      const { RealtimeModel } = await getGoogleRealtime();
      const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
      const langConfig = getLanguageConfig(this.targetLanguage);
      const voice = this.voiceOverride || langConfig.tts.geminiVoice || process.env.GEMINI_VOICE || 'Aoede';
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
      // Gemini fixes this at connect and it can't be changed for the life
      // of the session, so it has to reflect what the user will actually
      // SPEAK, not what they'll eventually be learning. Getting this wrong
      // is not subtle: a demo pinned to ru-RU transcribed a visitor's plain
      // English into invented Russian ("Да, я хочу подъём лыж"), which the
      // tutor then answered as if it were real.
      const language = bcp47Languages[this.speechLanguage || this.targetLanguage] || 'en-US';

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

    // Cloud mode — OpenRouter with DeepInfra provider (fast TTFT, cheap)
    const url = process.env.CONVERSATION_LLM_URL || 'https://openrouter.ai/api/v1';
    const model = process.env.CONVERSATION_LLM_MODEL || 'google/gemma-4-26b-a4b-it';
    const key = process.env.CONVERSATION_LLM_KEY || '';
    const provider = process.env.CONVERSATION_LLM_PROVIDER || 'deepinfra';

    console.log(`[ServiceFactory] LLM: ${model} via ${provider} @ OpenRouter`);
    return new OpenRouterLLM({
      baseURL: url,
      model,
      apiKey: key,
      provider,
    });
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
