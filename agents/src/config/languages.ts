// Language configuration for multi-language support
// Persona is now DB-driven (user_persona table) — see lib/persona.ts.
// To add a language: add an entry here. No persona string needed.

export interface LanguageConfig {
  // Metadata
  code: string              // ISO 639-1: 'ru', 'es', 'fr'
  name: string              // English name: 'Russian'
  nativeName: string        // Native name: 'Русский'
  nativeLanguage: string    // Default native language (overridden by user DB record)

  // Speech Services
  stt: {
    language: string        // Qwen3-ASR full language name (e.g. 'Russian', 'English')
  }

  tts: {
    voice: string          // ElevenLabs voice ID (cloud) or display name
    mossVoice: string      // MossTTS voice prompt name (from voices/ dir)
    omnivoiceVoice?: string // OmniVoice voice clone prompt name (from voices/ dir)
    omnivoiceLanguage?: string // OmniVoice language code (en, ru, es, fr, pt, ar)
    geminiVoice?: string  // Gemini RealtimeModel voice name (Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr)
    speed?: number         // Speech rate (default: 1.0)
  }

  // Pedagogy
  pedagogy: {
    targetLanguageRatio: number    // 0.0-1.0 (0.7 = 70% target language)
  }

  // Prompts
  prompts: {
    greeting: string
  }
}

export const LANGUAGES: Record<string, LanguageConfig> = {
  en: {
    code: 'en',
    name: 'English (Power Vocabulary)',
    nativeName: 'English',
    nativeLanguage: 'English',

    stt: {
      language: 'English',
    },

    tts: {
      voice: 'Eric',
      mossVoice: 'english_prompt',
      omnivoiceVoice: 'auto',
      omnivoiceLanguage: 'en',
      geminiVoice: 'Puck',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 1.0,
    },

    prompts: {
      greeting: 'All right. Say one sentence. Make it interesting.',
    },
  },

  ru: {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    nativeLanguage: 'English',

    stt: {
      language: 'Russian',
    },

    tts: {
      voice: 'Ivan',
      mossVoice: 'russian_will_chatterbox',
      omnivoiceVoice: 'russian_will_chatterbox',
      omnivoiceLanguage: 'ru',
      geminiVoice: 'Aoede',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,
    },

    prompts: {
      greeting: 'Okay, Russian. Привет — that\'s hello. What do you already know?',
    },
  },

  es: {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    nativeLanguage: 'English',

    stt: {
      language: 'Spanish',
    },

    tts: {
      voice: 'Alex',
      mossVoice: 'spanish_prompt_24k',
      omnivoiceVoice: 'spanish_prompt_24k',
      omnivoiceLanguage: 'es',
      geminiVoice: 'Charon',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,
    },

    prompts: {
      greeting: 'Okay, Spanish. ¡Hola! — that\'s hello. What do you already know?',
    },
  },

  fr: {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    nativeLanguage: 'English',

    stt: {
      language: 'French',
    },

    tts: {
      voice: 'Victoria',
      mossVoice: 'english_prompt',
      omnivoiceVoice: 'auto',
      omnivoiceLanguage: 'fr',
      geminiVoice: 'Kore',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.75,
    },

    prompts: {
      greeting: 'Okay, French. Bonjour — that\'s hello. What do you already know?',
    },
  },

  pt: {
    code: 'pt',
    name: 'European Portuguese',
    nativeName: 'Português Europeu',
    nativeLanguage: 'English',

    stt: {
      language: 'Portuguese',
    },

    tts: {
      voice: 'João',
      mossVoice: 'portuguese_prompt_24k',
      omnivoiceVoice: 'portuguese_prompt_24k',
      omnivoiceLanguage: 'pt',
      geminiVoice: 'Leda',
      speed: 1.0,
    },

    // 2026-06-25: 0.4 keeps target language present without overwhelming
    // an A1 learner.
    pedagogy: {
      targetLanguageRatio: 0.4,
    },

    prompts: {
      greeting: "Olá! Hello. Let's start with the basics, no pressure. Ready? You can answer in sim or yes.",
    },
  },

  ar: {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    nativeLanguage: 'English',

    stt: {
      language: 'Arabic',
    },

    tts: {
      voice: 'Haytham',
      mossVoice: 'english_prompt',
      omnivoiceVoice: 'auto',
      omnivoiceLanguage: 'ar',
      geminiVoice: 'Fenrir',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.7,
    },

    prompts: {
      greeting: 'أهلاً! Ready to learn?',
    },
  },
}

export function getLanguageConfig(code: string): LanguageConfig {
  const config = LANGUAGES[code]
  if (!config) {
    throw new Error(`Unsupported language: ${code}. Supported: ${Object.keys(LANGUAGES).join(', ')}`)
  }
  return config
}

export function getSupportedLanguages(): LanguageConfig[] {
  return Object.values(LANGUAGES)
}

/** Map ISO 639-1 codes to English names for prompt generation. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  ar: 'Arabic',
  de: 'German',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  hi: 'Hindi',
}

/** Convert an ISO code like 'en' to a display name like 'English'. Falls back to the code itself. */
export function nativeLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] || code.charAt(0).toUpperCase() + code.slice(1)
}
// ─── Dynamic languages (demo / realtime-model sessions only) ───
//
// The curated LANGUAGES entries above exist mostly to pin *local* speech
// services: which Qwen3-ASR language name, which MossTTS/OmniVoice clone,
// which target-language ratio. In gemini mode none of that applies — the
// realtime model does STT and TTS itself, and its voice (Aoede) is
// multilingual — so the only thing a language really needs there is its
// English name, to say in the prompt which language to teach.
//
// That's what lets the demo answer "I want to learn Japanese" instead of
// reading out a list of six and hoping the visitor wants one of them.
// These are NOT offered to real accounts: those run local STT/TTS, where a
// missing voice config means a broken session rather than a working one.
const DYNAMIC_LANGUAGES: Record<string, { name: string; nativeName: string }> = {
  de: { name: 'German', nativeName: 'Deutsch' },
  it: { name: 'Italian', nativeName: 'Italiano' },
  ja: { name: 'Japanese', nativeName: '日本語' },
  ko: { name: 'Korean', nativeName: '한국어' },
  zh: { name: 'Mandarin Chinese', nativeName: '中文' },
  nl: { name: 'Dutch', nativeName: 'Nederlands' },
  pl: { name: 'Polish', nativeName: 'Polski' },
  tr: { name: 'Turkish', nativeName: 'Türkçe' },
  hi: { name: 'Hindi', nativeName: 'हिन्दी' },
  vi: { name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  id: { name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  th: { name: 'Thai', nativeName: 'ไทย' },
  sv: { name: 'Swedish', nativeName: 'Svenska' },
  da: { name: 'Danish', nativeName: 'Dansk' },
  no: { name: 'Norwegian', nativeName: 'Norsk' },
  fi: { name: 'Finnish', nativeName: 'Suomi' },
  cs: { name: 'Czech', nativeName: 'Čeština' },
  el: { name: 'Greek', nativeName: 'Ελληνικά' },
  he: { name: 'Hebrew', nativeName: 'עברית' },
  ro: { name: 'Romanian', nativeName: 'Română' },
  hu: { name: 'Hungarian', nativeName: 'Magyar' },
  uk: { name: 'Ukrainian', nativeName: 'Українська' },
  bn: { name: 'Bengali', nativeName: 'বাংলা' },
  ta: { name: 'Tamil', nativeName: 'தமிழ்' },
}

/**
 * Curated config if we have one, otherwise a synthesized config for any
 * language the realtime model can handle. Returns null for codes we don't
 * recognise at all, so callers can tell the learner instead of guessing.
 */
export function resolveLanguageConfig(code: string): LanguageConfig | null {
  if (LANGUAGES[code]) return LANGUAGES[code]!
  const dyn = DYNAMIC_LANGUAGES[code]
  if (!dyn) return null
  return {
    code,
    name: dyn.name,
    nativeName: dyn.nativeName,
    nativeLanguage: 'en',
    stt: { language: dyn.name },
    tts: { voice: 'auto', mossVoice: 'auto', geminiVoice: 'Aoede' },
    pedagogy: { targetLanguageRatio: 0.6 },
    prompts: { greeting: `Hello! Ready to practice some ${dyn.name}?` },
  }
}

/** Every language the demo can teach — curated plus realtime-model-only. */
export function isTeachableLanguage(code: string): boolean {
  return resolveLanguageConfig(code) !== null
}
