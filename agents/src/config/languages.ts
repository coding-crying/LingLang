// Language configuration for multi-language support
import { RUSSIAN_INSTRUCTIONS } from './prompts/russian.js'
import { SPANISH_INSTRUCTIONS } from './prompts/spanish.js'
import { FRENCH_INSTRUCTIONS } from './prompts/french.js'
import { PORTUGUESE_INSTRUCTIONS } from './prompts/portuguese.js'
import { ARABIC_INSTRUCTIONS } from './prompts/arabic.js'
import { ENGLISH_POWER_VOCAB_INSTRUCTIONS } from './prompts/english.js'
import type { PromptVariant } from './prompts/common.js'

export interface LanguageConfig {
  // Metadata
  code: string              // ISO 639-1: 'ru', 'es', 'fr'
  name: string              // English name: 'Russian'
  nativeName: string        // Native name: 'Русский'

  // Speech Services
  stt: {
    language: string        // Qwen3-ASR full language name (e.g. 'Russian', 'English')
  }

  tts: {
    voice: string          // ElevenLabs voice ID (cloud) or display name
    mossVoice: string      // MossTTS voice prompt name (from voices/ dir)
    speed?: number         // Speech rate (default: 1.0)
  }

  // Pedagogy
  pedagogy: {
    targetLanguageRatio: number    // 0.0-1.0 (0.7 = 70% target language)
  }

  // Prompts
  prompts: {
    greeting: string
    instructionsTemplate: string
    variant?: PromptVariant    // Optional: 'immersive' | 'mixed' | 'assisted'
  }
}

export const LANGUAGES: Record<string, LanguageConfig> = {
  en: {
    code: 'en',
    name: 'English (Power Vocabulary)',
    nativeName: 'English',

    stt: {
      language: 'English',
    },

    tts: {
      voice: 'English',
      mossVoice: 'english_prompt_24k',
      speed: 1.0,
    },

    pedagogy: {
      // Same-language learning; keep it snappy and mostly English.
      targetLanguageRatio: 1.0,
    },

    prompts: {
      greeting: 'All right. Say one sentence. Make it interesting.',
      instructionsTemplate: ENGLISH_POWER_VOCAB_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  ru: {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',

    stt: {
      language: 'Russian',
    },

    tts: {
      voice: 'Russian',
      mossVoice: 'russian_prompt_24k',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,  // 80% Russian, 20% English for explanations
    },

    prompts: {
      greeting: 'Okay, Russian. Привет — that\'s hello. What do you already know?',
      instructionsTemplate: RUSSIAN_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  es: {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',

    stt: {
      language: 'Spanish',
    },

    tts: {
      voice: 'Spanish',
      mossVoice: 'spanish_prompt_24k',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,
    },

    prompts: {
      greeting: 'Okay, Spanish. ¡Hola! — that\'s hello. What do you already know?',
      instructionsTemplate: SPANISH_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  fr: {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',

    stt: {
      language: 'French',
    },

    tts: {
      voice: 'French',
      mossVoice: 'english_prompt_24k',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.75,
    },

    prompts: {
      greeting: 'Okay, French. Bonjour — that\'s hello. What do you already know?',
      instructionsTemplate: FRENCH_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  pt: {
    code: 'pt',
    name: 'European Portuguese',
    nativeName: 'Português Europeu',

    stt: {
      language: 'Portuguese',
    },

    tts: {
      voice: 'Portuguese',
      mossVoice: 'portuguese_prompt_24k',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,
    },

    prompts: {
      greeting: 'Okay, Portuguese. Olá — that\'s hello. What do you already know?',
      instructionsTemplate: PORTUGUESE_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  ar: {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',

    stt: {
      language: 'Arabic',
    },

    tts: {
      voice: 'Alexander',
      mossVoice: 'english_prompt_24k',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.7,
    },

    prompts: {
      greeting: 'أهلاً! Ready to learn?',
      instructionsTemplate: ARABIC_INSTRUCTIONS,
      variant: 'assisted',
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
