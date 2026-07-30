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
    /** Tone is phonemic (changes word meaning) — gates tone-specific
     *  guidance in both the conversation agent's core prompt and the
     *  processor's grading prompt (buildFullPrompt). */
    tonal?: boolean
    /** Extra per-language guidance injected into the conversation agent's
     *  stable core prompt (base.ts), after the standard rules. Optional —
     *  most languages need nothing here since teaching style differences
     *  already live in the persona; this is for genuinely language-
     *  specific mechanics (e.g. tone correction for Mandarin). */
    specialInstructions?: string
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

  zh: {
    code: 'zh',
    name: 'Mandarin Chinese',
    nativeName: '中文',
    nativeLanguage: 'English',

    stt: {
      language: 'Chinese',
    },

    tts: {
      // Fixed 2026-07-08: `omnivoiceVoice: 'auto'` was the root cause of
      // two live complaints — a generic/wrong-sounding voice AND the voice
      // audibly changing every sentence. Root-caused in omnivoice_server.py:
      // the "auto" path calls the base model with NO reference audio at
      // all (no ref_audio_prompt), so there's nothing anchoring speaker
      // identity between calls — a zero-shot model with no reference has
      // no fixed voice to be consistent WITH. Seeded a real reference clip
      // — public-domain (LibriVox via Wikimedia Commons) recording of UDHR
      // Article 1 in Mandarin, converted to 24kHz mono WAV, transcript
      // verified against the official UN Chinese translation (traditional
      // characters, matching what the recording reads) — same pattern as
      // russian_will_chatterbox/portuguese_prompt_24k. Files:
      // agents/../TTS/OmniVoice/voices/chinese_prompt_24k.{wav,txt}.
      voice: 'Li Wei',
      mossVoice: 'english_prompt',
      // 2026-07-11: switched to chinese_moss_24k (MOSS-TTS's bundled native
      // reference, 三国演义 opening line) after Will's ear-test preferred it
      // over the LibriVox UDHR seed for Mandarin quality. Old seed files
      // remain in voices/ if a revert is ever needed.
      omnivoiceVoice: 'chinese_moss_24k',
      omnivoiceLanguage: 'zh',
      geminiVoice: 'Zephyr',
      speed: 1.0,
    },

    // No cognates with English at all (unlike the Romance languages), and
    // absolute beginners can't yet read pinyin fluently — lean on the
    // native language more than pt/ar do early on.
    pedagogy: {
      targetLanguageRatio: 0.5,
      tonal: true,
      specialInstructions:
        "Mandarin is tonal — the same syllable means different things depending on pitch (mā mother / má hemp / mǎ horse / mà scold). A learner can nail every consonant and vowel and still say the wrong word by getting the tone wrong. Listen for tone, not just segments: when a tone is off, correct it explicitly and model the right contour — don't let it slide as a minor accent issue. When you write pinyin, include tone marks (nǐ hǎo, not ni hao).",
    },

    prompts: {
      greeting: '你好! Nǐ hǎo — that\'s hello. What do you already know?',
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

/**
 * Convert an ISO code like 'en' to a display name like 'English'.
 *
 * The single source of truth for language names. There used to be four
 * separate maps — one here, one in supervisor-functions.ts, one in
 * supervisor.ts, plus DYNAMIC_LANGUAGES — and they disagreed. A Greek
 * learner ('el') got "Greek" in the tutor prompt (from langConfig.name),
 * the bare code "el" in the grading prompt (missing from the processor's
 * map, so it fell through to the raw code and read as the Spanish article),
 * and "Russian" in the supervisor (whose map defaulted to it). Names now
 * come from the config tables that already have to be right for a session
 * to run at all, so they cannot drift apart again.
 *
 * Returns the raw code for something genuinely unknown, and says so — a
 * silent wrong-language default is far more expensive to debug than a
 * prompt that reads oddly.
 */
export function nativeLanguageName(code: string): string {
  const known = LANGUAGES[code] || DYNAMIC_LANGUAGES[code]
  // A curated `name` is a product label, not purely a language name — 'en'
  // is "English (Power Vocabulary)". The parenthetical is meaningless to a
  // grading model and actively confusing in a sentence like "identify the
  // ${name} words", so trailing parentheticals come off. Genuine
  // qualifiers stay: "European Portuguese" is what we want a prompt to say.
  if (known) return known.name.replace(/\s*\([^)]*\)\s*$/, '')
  console.warn(`[languages] no name for "${code}" — prompts will use the raw code`)
  return code
}

/**
 * The config a real session should start with.
 *
 * Curated languages always work. A dynamic language only works when the
 * realtime model handles STT/TTS itself (gemini mode); in local mode there
 * is no ASR language or voice to pin, so it would start and then misbehave.
 *
 * Deliberately never throws. getLanguageConfig() did, straight out of the
 * agent's entry function, which meant a user row carrying a language the
 * curated table didn't have killed the job before it ever reached the
 * participant — the client just saw a connection that never came up. The
 * demo's set_target_language accepts the wider DYNAMIC_LANGUAGES set and
 * persists it, and signup claims that same row, so a demo visitor who
 * asked for Greek and then made an account could never connect again.
 * Starting in the wrong language is recoverable in one sentence; a session
 * that never starts is not.
 */
export function resolveSessionLanguage(
  code: string,
  mode: string,
): { config: LanguageConfig; fellBackFrom?: string } {
  const curated = LANGUAGES[code]
  if (curated) return { config: curated }
  if (REALTIME_MODES.has(mode)) {
    const dynamic = resolveLanguageConfig(code)
    if (dynamic) return { config: dynamic }
  }
  return { config: LANGUAGES[SESSION_FALLBACK_LANGUAGE]!, fellBackFrom: code }
}

/** Where resolveSessionLanguage() lands when it can't honour the request. */
export const SESSION_FALLBACK_LANGUAGE = 'en'

/**
 * True for a language the demo will happily teach but local speech services
 * can't: known here, but with no curated ASR/TTS pinning.
 *
 * This exists for the demo → account handover. A visitor asks the demo for
 * Greek, it obliges (the realtime model needs nothing but the name), and the
 * row is saved with targetLanguage 'el'. The app then starts sessions in
 * `local` by default, where 'el' has no voice — so without this the learner
 * signs up off the back of a Greek conversation and gets greeted in English.
 * Callers should upgrade the *mode* rather than downgrade the language: which
 * speech stack runs is an implementation detail, the language is the product.
 */
export function isRealtimeOnlyLanguage(code: string): boolean {
  return !LANGUAGES[code] && !!DYNAMIC_LANGUAGES[code]
}

/**
 * Modes where the realtime model does its own STT and TTS, so a language
 * needs nothing but its English name. Every other mode drives local Qwen
 * ASR and a MossTTS/OmniVoice clone, which have to be pinned per language
 * in LANGUAGES above — a dynamic language there starts fine and then has no
 * voice to speak with.
 */
const REALTIME_MODES = new Set(['gemini', 'cloud'])

/** The same set, exported for callers reconciling a mode against a language. */
export const REALTIME_MODE_NAMES: ReadonlySet<string> = REALTIME_MODES
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
