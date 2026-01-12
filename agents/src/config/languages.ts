// Language configuration for multi-language support
import { RUSSIAN_INSTRUCTIONS } from './prompts/russian.js'
import { SPANISH_INSTRUCTIONS } from './prompts/spanish.js'
import { FRENCH_INSTRUCTIONS } from './prompts/french.js'
import { PORTUGUESE_INSTRUCTIONS } from './prompts/portuguese.js'
import { ARABIC_INSTRUCTIONS } from './prompts/arabic.js'
import type { PromptVariant } from './prompts/common.js'

export interface LanguageConfig {
  // Metadata
  code: string              // ISO 639-1: 'ru', 'es', 'fr'
  name: string              // English name: 'Russian'
  nativeName: string        // Native name: 'Русский'

  // Speech Services
  stt: {
    language: string        // Whisper language code
  }

  tts: {
    voice: string          // Voice file/ID
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
  ru: {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',

    stt: {
      language: 'ru',
    },

    tts: {
      voice: 'Russian',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,  // 80% Russian, 20% English for explanations
    },

    prompts: {
      greeting: 'Привет! Ready to learn?',
      instructionsTemplate: RUSSIAN_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  es: {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',

    stt: {
      language: 'es',
    },

    tts: {
      voice: 'Spanish.mp3',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,
    },

    prompts: {
      greeting: '¡Hola! Ready to learn?',
      instructionsTemplate: SPANISH_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  fr: {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',

    stt: {
      language: 'fr',
    },

    tts: {
      voice: 'French.wav',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.75,
    },

    prompts: {
      greeting: 'Bonjour! Ready to learn?',
      instructionsTemplate: FRENCH_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  pt: {
    code: 'pt',
    name: 'European Portuguese',
    nativeName: 'Português Europeu',

    stt: {
      language: 'pt',
    },

    tts: {
      voice: 'Portuguese',
      speed: 1.0,
    },

    pedagogy: {
      targetLanguageRatio: 0.8,
    },

    prompts: {
      greeting: 'Olá! Ready to learn?',
      instructionsTemplate: PORTUGUESE_INSTRUCTIONS,
      variant: 'mixed',
    },
  },

  ar: {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',

    stt: {
      language: 'ar',
    },

    tts: {
      voice: 'Alexander',
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
