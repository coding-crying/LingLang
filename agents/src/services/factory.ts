/**
 * Service Factory
 *
 * Switches between local, cloud, and gemini services based on SERVICE_MODE env var
 *
 * Modes:
 *   local             — Qwen3-ASR + Ollama LLM + MossTTS (all local)
 *   cloud             — ElevenLabs STT + NanoGPT LLM + ElevenLabs TTS
 *   local-gemma-audio — Gemma 4 12B native-audio pass-through (experimental)
 *   local-qwen        — 2026-07-21: Qwen3.5-9B-FP8-dynamic (text/image only,
 *                        no audio modality) + Qwen3-ASR (already the primary
 *                        transcriber via GemmaAudioSTT's configureTranscription)
 *                        + OmniVoice TTS. Trades Gemma's native-audio-in
 *                        tone/pronunciation nuance for a smaller model —
 *                        weights shrink from ~13.6GB to ~12.6GB but the real
 *                        win is KV cache headroom for multi-user (see
 *                        gemma4-qat-vllm's --gpu-memory-utilization comment).
 *                        Revisit native audio-in once a local audio-native
 *                        S2S model is viable again (see audex-quant).
 *   gemini            — Gemini RealtimeModel (handles STT+LLM+TTS in one WebSocket)
 *   audex             — Audex-30B-A3B cascaded speech-to-speech server
 *                        (~/audex-quant, see WIRING.md) — separate ASR/LLM/TTS
 *                        HTTP+WS stages behind one vLLM engine. Exclusive GPU
 *                        user: vllm-qat/omnivoice-tts/llama-swap/llamacpp-embed
 *                        must be stopped for it to fit on the 3090.
 */

import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { Modality } from '@google/genai';
import { llm as llmRuntime } from '@livekit/agents';
import type { llm, stt, tts } from '@livekit/agents';

import { createTTS } from '../tts/fallback.js';
import { getLanguageConfig } from '../config/languages.js';
import { resolveVoice } from '../config/voices.js';
import { GemmaAudioSTT } from '../stt/gemma-audio-stt.js';
import { OpenRouterLLM } from '../llm/openrouter-llm.js';
import { GemmaAudioLLM } from '../llm/gemma-audio-llm.js';
import { ElevenLabsRealtimeSTT } from '../stt/elevenlabs-realtime.js';
import { AudexSTT } from '../stt/audex-stt.js';
import { AudexLLM } from '../llm/audex-llm.js';
import { AudexTTS } from '../tts/audex-tts.js';

// Lazy import for Google RealtimeModel — heavy, only needed in gemini mode
let _googleRealtime: { RealtimeModel: any } | null = null;
async function getGoogleRealtime() {
  if (!_googleRealtime) {
    const googlePlugin = await import('@livekit/agents-plugin-google');
    _googleRealtime = googlePlugin.beta.realtime;

    // Workaround: on @livekit/agents-plugin-google@1.2.3 + @livekit/agents@1.2.3,
    // the plugin's RealtimeModel ended up extending a *different* loaded
    // copy of @livekit/agents' RealtimeModel class than the one
    // @livekit/agents' own AgentActivity checks against internally
    // (`this.llm instanceof RealtimeModel` in agent_activity.js) — confirmed
    // via a standalone repro, same lockfile-resolved package version on
    // disk, just two distinct class objects at runtime (likely a tsx/dynamic
    // -import module-instance split, root cause not fully pinned down).
    // Without patching, that instanceof check silently failed, AgentActivity
    // never opened a realtime session, and the whole gemini-mode demo hung
    // in total silence with no error anywhere.
    //
    // 2026-08-04: upstream fixed the duplication at some point before 1.5.0
    // — GoogleRT.prototype already `instanceof` CoreRT.prototype with no
    // patching needed. Re-running the unconditional setPrototypeOf against
    // that state sets an object's prototype to itself, which V8 rejects
    // with "Cyclic __proto__ value" — crashing entry() on every single
    // gemini-mode session right after connecting to the room. Guard it so
    // this self-heals on whatever version is actually installed instead of
    // assuming 1.2.3's duplication forever.
    if (!(_googleRealtime.RealtimeModel.prototype instanceof llmRuntime.RealtimeModel)) {
      Object.setPrototypeOf(
        Object.getPrototypeOf(_googleRealtime.RealtimeModel.prototype),
        llmRuntime.RealtimeModel.prototype,
      );
      Object.setPrototypeOf(_googleRealtime.RealtimeModel, llmRuntime.RealtimeModel);
    }
  }
  return _googleRealtime;
}

export type ServiceMode = 'local' | 'cloud' | 'local-gemma-audio' | 'local-qwen' | 'gemini' | 'audex';

export interface ServiceFactoryOptions {
  mode?: ServiceMode;
  targetLanguage?: string;
  userId?: string;
  /** Per-user Google API key (BYO or resolved shared-key plan) — see
   *  lib/google-budget.ts. Overrides GOOGLE_API_KEY/GEMINI_API_KEY for
   *  gemini mode only when set. */
  googleApiKey?: string;
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
  private googleApiKey?: string;
  private speechLanguage?: string;
  private voiceOverride?: string;

  constructor(opts: ServiceFactoryOptions = {}) {
    this.mode = opts.mode || (process.env.SERVICE_MODE as ServiceMode) || 'local';
    this.targetLanguage = opts.targetLanguage || process.env.DEFAULT_TARGET_LANGUAGE || 'ru';
    this.googleApiKey = opts.googleApiKey;
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

    if (this.mode === 'local-qwen') {
      // Same buffer/placeholder STT class as local-gemma-audio — the actual
      // transcription is Qwen3-ASR via configureTranscription() in
      // tutor-event-driven.ts either way; this class name predates
      // local-qwen and is mode-agnostic in practice, not Gemma-specific.
      console.log(`[ServiceFactory] STT: Qwen3-ASR (via audio-buffer pass-through)`);
      return new GemmaAudioSTT();
    }

    if (this.mode === 'audex') {
      const baseURL = process.env.AUDEX_URL || 'http://127.0.0.1:7860';
      console.log(`[ServiceFactory] STT: Audex-30B-A3B @ ${baseURL}`);
      return new AudexSTT({ baseURL });
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

    if (this.mode === 'local-qwen') {
      // Same port/env-var chain as local-gemma-audio (both serve off the
      // same vllm-qat systemd unit — only the model behind port 8093
      // changed) — served-model-name is kept as gemma4-12b-it-qat on the
      // server side too, matching the precedent from the original QAT->FP8
      // Gemma swap (gemma4-qat-vllm's 2026-07-11 comment), so no other
      // fallback (SUPERVISOR_LLM_MODEL, PROCESSOR_LLM_MODEL, etc.) needs
      // touching. audioCapable:false is the one real behavior change: no
      // audio_url content ever gets sent to this text-only model.
      const url = process.env.QWEN_LOCAL_LLM_URL || process.env.GEMMA_AUDIO_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8093/v1';
      const model = process.env.QWEN_LOCAL_LLM_MODEL || process.env.GEMMA_AUDIO_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-12b-it-qat';
      console.log(`[ServiceFactory] LLM: Qwen3.5-9B (text-only, transcript-anchored) (${model} @ ${url})`);
      return new GemmaAudioLLM({
        baseURL: url,
        model,
        audioCapable: false,
      });
    }

    if (this.mode === 'audex') {
      const baseURL = process.env.AUDEX_URL || 'http://127.0.0.1:7860';
      console.log(`[ServiceFactory] LLM: Audex-30B-A3B @ ${baseURL}`);
      return new AudexLLM({ baseURL });
    }

    if (this.mode === 'gemini') {
      const { RealtimeModel } = await getGoogleRealtime();
      const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
      const langConfig = getLanguageConfig(this.targetLanguage);
      const apiKey = this.googleApiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      // The per-user/session voice wins; otherwise the shared default (see
      // config/voices.ts). langConfig's geminiVoice is the legacy per-language
      // pick that made the demo and the app greet the same person differently.
      const voice = resolveVoice(this.voiceOverride ?? langConfig.tts.geminiVoice);
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
        // Push-to-talk is an inverse mute: the mic is closed until the user
        // holds the button, and that gesture — nothing else — defines a turn.
        // Gemini's own end-of-speech detection was ALSO committing the turn,
        // so every press produced two generations: Gemini's, then ours from
        // commitUserTurn() when the transcript landed. The second interrupted
        // the first mid-word, which is why the tutor kept cutting itself off
        // and restarting the same sentence ("*Muy caliente*, very" →
        // "*Muy caliente*, huh? Very hot...", live 2026-08-10).
        //
        // Disabling automatic activity detection puts turn-taking entirely on
        // explicit activityStart/activityEnd signals, which the plugin derives
        // from the audio we forward and our commit. Hands-free mode therefore
        // can't lean on Gemini to close a turn any more and uses the local
        // Silero VAD instead — see turnDetection in tutor-event-driven.ts.
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
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
    if (this.mode === 'audex') {
      const baseURL = process.env.AUDEX_URL || 'http://127.0.0.1:7860';
      let sampleRate = 16000;
      let modelName = 'audex-30b-a3b';
      try {
        const res = await fetch(`${baseURL}/api/config`);
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.sample_rate) sampleRate = cfg.sample_rate;
          if (cfg.default_model) modelName = cfg.default_model;
        }
      } catch (err) {
        console.warn(`[ServiceFactory] Audex /api/config unreachable, using defaults: ${String(err).slice(0, 100)}`);
      }
      console.log(`[ServiceFactory] TTS: Audex-30B-A3B @ ${baseURL} (model=${modelName}, sr=${sampleRate})`);
      return new AudexTTS({ baseURL, modelName, sampleRate });
    }

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
