/**
 * STT factory with ElevenLabs Scribe fallback
 *
 * Checks Qwen3-ASR health at session startup. Falls back to
 * ElevenLabs Scribe realtime if Qwen is unreachable.
 */

import * as openai from '@livekit/agents-plugin-openai';
import type { stt } from '@livekit/agents';
import { ElevenLabsRealtimeSTT } from './elevenlabs-realtime.js';
import type { LanguageConfig } from '../config/languages.js';

const ELEVENLABS_LANGUAGE_CODES: Record<string, string | undefined> = {
  en: undefined,
  ru: 'rus',
  es: 'spa',
  fr: 'fra',
  pt: 'por',
  ar: 'ara',
};

function makeElevenLabsSTT(langConfig: LanguageConfig): stt.STT {
  const languageCode = ELEVENLABS_LANGUAGE_CODES[langConfig.code];
  console.log(`[STT] ElevenLabs Scribe (lang: ${languageCode || 'auto'})`);
  return new ElevenLabsRealtimeSTT({
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    language: languageCode,
    commitStrategy: 'vad',
    vadSilenceThresholdSecs: 1.5,
  }) as unknown as stt.STT;
}

/**
 * Create an STT instance. Health-checks Qwen3-ASR (3s timeout) and
 * falls back to ElevenLabs Scribe if unreachable.
 */
export async function createSTT(langConfig: LanguageConfig): Promise<stt.STT> {
  const url = process.env.LOCAL_STT_URL || 'http://localhost:8001/v1';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    // Qwen3-ASR health endpoint
    const res = await fetch(url.replace('/v1', '') + '/health', { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      console.log(`[STT] Qwen3-ASR available (${langConfig.stt.language})`);
      return new openai.STT({
        baseURL: url,
        apiKey: 'dummy',
        language: langConfig.stt.language,
      }) as unknown as stt.STT;
    }
    console.warn(`[STT] Qwen3-ASR health check failed (${res.status}), falling back to ElevenLabs`);
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
    console.warn(`[STT] Qwen3-ASR unreachable (${reason}), falling back to ElevenLabs`);
  }

  return makeElevenLabsSTT(langConfig);
}
