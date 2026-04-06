/**
 * TTS factory with ElevenLabs fallback
 *
 * Checks MossTTS health at session startup. Falls back to ElevenLabs
 * if MossTTS is unreachable or returns an error.
 */

import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import type { tts } from '@livekit/agents';
import { MossTTS } from './mosstts.js';
import type { LanguageConfig } from '../config/languages.js';

const ELEVENLABS_VOICES: Record<string, string> = {
  ru: 'pNInz6obpgDQGcFmaJgB', // Adam
  es: 'EXAVITQu4vr4xnSDxMaL', // Bella
  fr: 'ThT5KcBeYPX3keUQqHPh', // Dorothy
  pt: 'cgSgspJ2msm6clMCkdW9', // Jessica
  ar: 'pNInz6obpgDQGcFmaJgB', // Adam
  en: 'pNInz6obpgDQGcFmaJgB', // Adam
};

function makeElevenLabs(langCode: string): tts.TTS {
  const voiceId = ELEVENLABS_VOICES[langCode] ?? 'pNInz6obpgDQGcFmaJgB';
  console.log(`[TTS] ElevenLabs voice: ${voiceId} (${langCode})`);
  return new elevenlabs.TTS({
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voice: { id: voiceId, name: 'multilingual', category: 'premade' },
    modelID: 'eleven_turbo_v2_5',
    language: langCode,
    enableSsmlParsing: false,
  });
}

/**
 * Create a TTS instance. In local mode, probes MossTTS health and
 * falls back to ElevenLabs if unreachable. In cloud mode, uses
 * ElevenLabs directly.
 */
export async function createTTS(langConfig: LanguageConfig): Promise<tts.TTS> {
  const ttsMode = process.env.TTS_MODE || process.env.SERVICE_MODE || 'local';

  if (ttsMode === 'cloud') {
    return makeElevenLabs(langConfig.code);
  }

  const url = process.env.LOCAL_TTS_URL || 'http://localhost:8880';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      console.log(`[TTS] MossTTS available (voice: ${langConfig.tts.mossVoice})`);
      return new MossTTS({
        baseURL: url,
        voice: langConfig.tts.mossVoice,
        speed: langConfig.tts.speed || 1.0,
      });
    }
    console.warn(`[TTS] MossTTS health check failed (${res.status}), falling back to ElevenLabs`);
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
    console.warn(`[TTS] MossTTS unreachable (${reason}), falling back to ElevenLabs`);
  }

  return makeElevenLabs(langConfig.code);
}
