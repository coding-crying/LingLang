/**
 * TTS factory with OmniVoice → MossTTS → ElevenLabs fallback chain
 *
 * Priority:
 *   1. OmniVoice (port 8882) — CUDA Graph optimized, voice clone, RTF 0.14
 *   2. MossTTS (port 8880)   — legacy, still works
 *   3. ElevenLabs (cloud)    — always available fallback
 */

import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import type { tts } from '@livekit/agents';
import { OmniVoiceTTS } from './omnivoice.js';
import { MossTTS } from './mosstts.js';
import type { LanguageConfig } from '../config/languages.js';

const ELEVENLABS_VOICES: Record<string, string> = {
  ru: 'pvaLm5vOYGVfLoOTMXXp', // Ivan-Moscow-ru (cloned from shared Ivan)
  es: 'KyMT6Qyg8yYnkTFIVou0', // Alex-Mexican-es (cloned from shared Alex)
  fr: '4xNYOZWtHccrVmb0cuXS', // Victoria-fr (cloned from shared Victoria)
  pt: 'avIawsojfrIybXJ4zbej', // Joao-eu-pt (cloned from shared João)
  ar: 'QJQ3LeiLujEUgU2iuzpj', // Haytham-ar (cloned from shared Haytham)
  en: 'cjVigY5qzO86Huf0OWal', // Eric — premade, smooth American
};

function makeElevenLabs(langCode: string): tts.TTS {
  const voiceId = ELEVENLABS_VOICES[langCode] ?? 'pNInz6obpgDQGcFmaJgB';
  // Turbo for English/Spanish (lower latency), multilingual v2 for everything else (better accents)
  const modelID = ['en', 'es'].includes(langCode) ? 'eleven_turbo_v2_5' : 'eleven_multilingual_v2';
  console.log(`[TTS] ElevenLabs voice: ${voiceId} (${langCode}, model: ${modelID})`);
  return new elevenlabs.TTS({
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voice: { id: voiceId, name: 'multilingual', category: 'cloned' },
    modelID,
    language: langCode,
    enableSsmlParsing: false,
  });
}

async function probeHealth(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create a TTS instance. Probes OmniVoice → MossTTS → ElevenLabs.
 * Set TTS_MODE=cloud to skip local probes and use ElevenLabs directly.
 * Set TTS_MODE=omnivoice to force OmniVoice (error if unreachable).
 * Set TTS_MODE=moss to force MossTTS.
 */
export async function createTTS(langConfig: LanguageConfig): Promise<tts.TTS> {
  const ttsMode = process.env.TTS_MODE || process.env.SERVICE_MODE || 'local';

  if (ttsMode === 'cloud') {
    return makeElevenLabs(langConfig.code);
  }

  // --- OmniVoice (port 8882) ---
  const omnivoiceUrl = process.env.OMNIVOICE_TTS_URL || 'http://localhost:8882';
  const omnivoiceVoice = langConfig.tts.omnivoiceVoice || 'auto';
  const omnivoiceLang = langConfig.tts.omnivoiceLanguage || langConfig.code;

  if (ttsMode === 'omnivoice') {
    console.log(`[TTS] OmniVoice forced (voice: ${omnivoiceVoice}, lang: ${omnivoiceLang})`);
    return new OmniVoiceTTS({
      baseURL: omnivoiceUrl,
      voice: omnivoiceVoice,
      speed: langConfig.tts.speed || 1.0,
      language: omnivoiceLang,
    });
  }

  // Auto-detect: try OmniVoice first (faster, lighter VRAM)
  if (await probeHealth(omnivoiceUrl)) {
    console.log(`[TTS] OmniVoice available (voice: ${omnivoiceVoice}, lang: ${omnivoiceLang})`);
    return new OmniVoiceTTS({
      baseURL: omnivoiceUrl,
      voice: omnivoiceVoice,
      speed: langConfig.tts.speed || 1.0,
      language: omnivoiceLang,
    });
  }

  // --- MossTTS (port 8880) ---
  if (ttsMode === 'moss') {
    const mossUrl = process.env.LOCAL_TTS_URL || 'http://localhost:8880';
    console.log(`[TTS] MossTTS forced (voice: ${langConfig.tts.mossVoice})`);
    return new MossTTS({
      baseURL: mossUrl,
      voice: langConfig.tts.mossVoice,
      speed: langConfig.tts.speed || 1.0,
    });
  }

  const mossUrl = process.env.LOCAL_TTS_URL || 'http://localhost:8880';
  if (await probeHealth(mossUrl)) {
    console.log(`[TTS] MossTTS available (voice: ${langConfig.tts.mossVoice})`);
    return new MossTTS({
      baseURL: mossUrl,
      voice: langConfig.tts.mossVoice,
      speed: langConfig.tts.speed || 1.0,
    });
  }

  // --- ElevenLabs fallback ---
  console.warn(`[TTS] All local TTS unreachable, falling back to ElevenLabs`);
  return makeElevenLabs(langConfig.code);
}
