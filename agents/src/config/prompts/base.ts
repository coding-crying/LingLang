// Conversation prompt — stable core + volatile tail.
//
// 2026-07-02: Redesigned per docs/superpowers/specs/2026-07-02-adaptive-loop-redesign-design.md
//
// Layout (§7 of the spec): the prompt is a byte-stable CORE (persona,
// learner identity, standing rules — changes only on persona patch or
// level change) followed by a volatile TAIL rebuilt every turn (frontier
// directive, word lists, error treatment, nudge, pronunciation, length).
// This layout is what lets SGLang prefix-cache the core across turns.
//
// Prompt budget (hard rule): the tail carries at most ~8 short lines.
// Anything that wants a new tail line must replace an existing one.
//
// The prompt builder is pure — no DB, no LLM, no I/O. All signals are
// computed upstream (readLearnerView, tutor-event-driven.ts) and passed
// in via PromptContext.

export interface FrontierInfo {
  /** Success-gated introduction state — see lib/frontier.ts */
  state: 'consolidate' | 'balance' | 'expand'
  /** One-line pedagogical directive for this state. */
  directive: string
  /** Formatted "lemma (translation), ..." — empty string if none. */
  dueWords: string
  /** Formatted "lemma (translation), ..." — empty string if none. */
  newWords: string
}

export interface AdaptiveContext {
  /** What part of the session we're in. Affects scaffolding vs. flow. */
  sessionPhase: 'opening' | 'warmup' | 'flow' | 'wrapup'
  /** Completed turns so far. */
  turnCount: number
  /** Errors per turn in last 3 turns, normalized 0-1. */
  errorDensity: number
  /** Response rhythm, derived from turn length trend. */
  pacing: 'fast' | 'medium' | 'slow'
}

export interface PromptContext {
  targetLanguage: string
  nativeLanguage: string
  userLevel: string
  /** Fully composed persona block (base line + tone + style profile). */
  persona: string
  frontier: FrontierInfo
  recentErrors?: string
  /** The processor's single per-turn note (grammar or pronunciation pattern worth practice). */
  grammarHints?: string
  /** The planner's "current angle" nudge. */
  goalUpdate?: string
  previousSessionContext?: string | null
  /**
   * Formatted "lemma (translation), ..." of words the learner just asked
   * for (reached for the native word mid-sentence) — see
   * learner-view.ts's demandWords. Empty string if none. Distinct from
   * dueWords: these are NOT things the learner already knows.
   */
  demandWords?: string
  /**
   * Comprehensible-input controller line (lib/language-mix.ts) — how much
   * target vs native language to speak, escalated with the measured share
   * of the previous reply when the tutor overshot.
   */
  mixLine?: string
  /**
   * Optional per-language mechanics (languages.ts's pedagogy.specialInstructions)
   * — e.g. Mandarin's tone-correction guidance. Stable for the whole
   * session (language doesn't change mid-call), so it belongs in the core,
   * not the volatile tail.
   */
  specialInstructions?: string
  /**
   * Curriculum teaching instruction (design doc §3, learner-view.ts's
   * activeChunk.card). A SINGLE short, conditionally-framed sentence
   * ("If it fits naturally, ... they're studying ..."), not a structured
   * multi-field block — an earlier Topic:/Phrases:/Vocab:/Grammar: format
   * reproducibly broke the local 12B's real audio attention (6/6
   * failures, isolated via a length-matched filler control to the
   * block's directive framing, not its token count). This shorter,
   * conditional-instruction format verified 4/4 against real audio
   * through this exact code path. If the card format or its wrapper text
   * (below) ever changes, re-verify with real audio before shipping —
   * this model's audio attention is measurably fragile to phrasing, not
   * just to raw prompt length.
   */
  lessonCard?: string
  /** Optional: adaptive signals for prompt composition. */
  adaptive?: AdaptiveContext
}

/**
 * Length line: combines level baseline with session phase and pacing.
 * Phase trumps level only when the session is at the wrap — short
 * goodbyes. Otherwise level is the floor.
 */
function computeLengthLine(
  level: string,
  phase: AdaptiveContext['sessionPhase'],
  pacing: AdaptiveContext['pacing'],
): string {
  if (phase === 'wrapup') {
    return '1 short sentence. Wrap naturally — no new content.'
  }
  // Level-based baseline — kept short across the board. This is a live
  // back-and-forth, not a monologue; complexity at higher levels should
  // show up in word choice and grammar, not turn length.
  let base: string
  if (level === 'pre_a1' || level === 'a1') {
    base = '1 short sentence'
  } else if (level === 'a2' || level === 'b1') {
    base = '1 sentence, occasionally 2'
  } else {
    base = '1-2 sentences at full complexity — save the second one for when it earns its place'
  }
  // Pacing modifier
  let modifier = ''
  if (pacing === 'fast') {
    modifier = ' Be terse — they want progress, not monologue.'
  } else if (pacing === 'slow') {
    modifier = ' Give them room — no rush to the next turn.'
  }
  return `${base}.${modifier} Snappy back-and-forth — leave room for them to jump back in, don't hold the floor. React to what they actually said, not a template. Stay the person from your persona — a quick-witted friend, never a customer-service bot; if they get cheeky, give it back. No bullet lists, no emojis, no markdown.`
}

/**
 * Error treatment: how verbose to be about correcting mistakes.
 * High error density (>0.6) = user is struggling, slow down.
 * Low density (<0.2) = user is doing well, no need to belabor.
 */
function computeErrorTreatment(errorDensity: number, errors: string): string {
  if (!errors || errors === 'None') return ''
  if (errorDensity > 0.6) {
    return `Recurring errors — keep corrections short and just one at a time: ${errors}`
  }
  if (errorDensity < 0.2) {
    return `Minor slip — just say the right form once, don't make it a lesson: ${errors}`
  }
  return `If they make these errors, just say the right form once and move on: ${errors}`
}

/**
 * Opening line: only rendered in 'opening' phase, and only mechanical
 * scaffolding — never continuity content. Deciding *how* to pick up from
 * last session (what to reference, what tone) is the planner's job: it
 * already reads the session-gap + nextSessionHint data and puts the result
 * in "Current angle" before the opening fires (see tutor-event-driven.ts's
 * sessionStartPlan await). Asking the conversation agent to synthesize
 * continuity itself from raw session data is what produced visible
 * "let me think about this" narration instead of a fluent reply — the
 * conversation agent's job is flow, not strategy.
 */
function computeOpeningLine(
  phase: AdaptiveContext['sessionPhase'],
  previousSessionContext: string | null | undefined,
  level: string,
): string {
  if (phase !== 'opening') return ''
  // A previous session exists — the planner's "Current angle" already
  // carries the pick-up guidance. Nothing more to add here.
  if (previousSessionContext) return ''
  if (level === 'pre_a1' || level === 'a1') {
    return `Opening: start with something they can answer in one word. Don't ask "how are you" in the target — use it to model the first exchange.`
  }
  return `Opening: ask one simple question in the target language to set the scene.`
}

function defaultAdaptive(): AdaptiveContext {
  return {
    sessionPhase: 'flow',
    turnCount: 0,
    errorDensity: 0,
    pacing: 'medium',
  }
}

/**
 * Native-script rule for non-Latin-script target languages. 2026-07-10:
 * confirmed live — with nothing constraining the script, the model
 * "helpfully" transliterated for a beginner ("In Russian, tea is chay...
 * you'd say Ya khochu chay", zero Cyrillic in the whole reply). The TTS
 * engine reads Latin text as English, so romanized target-language speech
 * comes out as mangled English — and romanization is also invisible to the
 * language-mix controller (measureTargetShare counts SCRIPT characters, so
 * "Ya khochu chay" measured as 0% Russian and the corrective line never
 * fired). One hard rule in the stable core. Keyed by language NAME because
 * that's what PromptContext carries. Latin-script targets (es/pt/fr) need
 * no line.
 */
const NATIVE_SCRIPT_LINE: Record<string, string> = {
  'Russian': 'Write every Russian word in Cyrillic (Я хочу чай) — NEVER in Latin transliteration ("Ya khochu chay"). Your words are spoken aloud by a voice engine: Cyrillic is pronounced as proper Russian, Latin transliteration gets read out as garbled English. The learner hears you, they don\'t read you — romanization never helps them.',
  'Mandarin Chinese': 'Write every Mandarin word in Chinese characters (我要茶) — NEVER in pinyin ("wo yao cha"). Your words are spoken aloud by a voice engine: characters are pronounced as proper Mandarin, pinyin gets read out as garbled English. The learner hears you, they don\'t read you.',
  'Arabic': 'Write every Arabic word in Arabic script — NEVER in Latin transliteration. Your words are spoken aloud by a voice engine: Arabic script is pronounced correctly, transliteration gets read out as garbled English. The learner hears you, they don\'t read you.',
}

/**
 * Build the conversation agent's system prompt: stable core + volatile tail.
 *
 * The core substring is byte-identical between calls as long as persona
 * and level haven't changed — this is what SGLang prefix-caches. Nothing
 * that changes every turn belongs in the core.
 */
export function buildInstructions(context: PromptContext): string {
  const levelKey = (context.userLevel || '').toLowerCase()
  const adaptive = context.adaptive ?? defaultAdaptive()

  // ── Stable core ────────────────────────────────────────────────
  const core = [
    context.persona,
    '',
    `You're chatting with a learner of ${context.targetLanguage}. Level: ${context.userLevel || 'beginner'}. They speak ${context.nativeLanguage} natively.`,
    '',
    `You have tools to look up words and check the learner's progress. Use them when you need to — not every turn.`,
    `Correct the underlying pattern, not just the individual word.`,
    `When you introduce a new word, do it the way a friend would mid-conversation — use it naturally, gloss it once, and hand it to them to try.`,
    // 2026-07-10 (user-reported): the tutor kept steering back to its
    // scenario over explicit user requests ("let's stick to our café — you
    // were doing so well with your coffee order!"). Direction from the
    // learner outranks every plan line below, stated as a hard priority
    // rule, not a vibe.
    `Follow the learner's lead — this outranks everything below it. If they change topic, ask you to stop, slow down, skip something, or just listen, do that IMMEDIATELY, even if it abandons a scenario or plan mid-stream. The scenario serves them, not the other way around; steering them back to your plan after they've asked for something else is the one reliably wrong move. Any vocabulary guidance below is about which words to reach for, never what to talk about.`,
    `You can't switch the target language mid-conversation — there's no tool for it. If they ask to switch languages, just tell them plainly to use the language picker in the app (the flag pill at the top) and that it'll apply next time they connect. Don't joke about it or make them guess.`,
    ...(NATIVE_SCRIPT_LINE[context.targetLanguage] ? [NATIVE_SCRIPT_LINE[context.targetLanguage]] : []),
    ...(context.specialInstructions ? [context.specialInstructions] : []),
    // 2026-07-07: this block's exact framing was verified against real
    // audio, not assumed. A first version wrapped the card with only a
    // trailing "not a script" caveat and, reproducibly (3/3 runs), the
    // model ignored real audio input entirely and opened with a scripted
    // line about the card's topic instead — a length-matched non-topical
    // filler of the same token count did NOT cause this, isolating the
    // cause to the card's directive "Topic: X" framing, not its length.
    // Adding the leading priority sentence below, BEFORE the card, fixed
    // it 3/3: the model referenced the actual audio while still working
    // the card's topic into the follow-up. If curriculum cards are ever
    // edited, re-verify with real audio before trusting a rewording —
    // this model's audio attention is measurably fragile to phrasing, not
    // just to raw prompt length.
    ...(context.lessonCard ? ['', `Always respond to what they just said first — that comes before anything below. Background material from their course, only for when it naturally fits, never a script to follow:`, `${context.lessonCard}`] : []),
  ].join('\n')

  // ── Volatile tail (hard budget: ~8 short lines) ──────────────────
  const tail: string[] = []

  const openingLine = computeOpeningLine(adaptive.sessionPhase, context.previousSessionContext, levelKey)
  if (openingLine) tail.push(openingLine)

  tail.push(context.frontier.directive)
  if (context.frontier.dueWords) {
    tail.push(`Words they already know — your scaffolding: ${context.frontier.dueWords}`)
  }
  if (context.frontier.newWords) {
    tail.push(`New words to reach for when they're ready: ${context.frontier.newWords}`)
  }

  // High-priority, transient: they just asked for this. Framed as a
  // request to fulfill, not something they already know.
  if (context.demandWords?.trim()) {
    tail.push(`They just reached for the ${context.nativeLanguage} word instead of the ${context.targetLanguage} one — hand them this the moment it fits: ${context.demandWords}`)
  }

  if (context.goalUpdate?.trim()) {
    tail.push(`Current angle: ${context.goalUpdate}`)
  }

  const errorLine = computeErrorTreatment(adaptive.errorDensity, context.recentErrors?.trim() || '')
  if (errorLine) tail.push(errorLine)

  // The processor's one per-turn note — grammar or pronunciation pattern.
  // Model it in your own speech, don't lecture about it.
  if (context.grammarHints?.trim() && context.grammarHints !== 'None') {
    tail.push(`Worth weaving in (model it, don't lecture): ${context.grammarHints}`)
  }

  // Language-mix line sits second-to-last: the tail's end is the
  // strongest position, and mix is the most-violated constraint.
  if (context.mixLine) tail.push(context.mixLine)

  tail.push(computeLengthLine(levelKey, adaptive.sessionPhase, adaptive.pacing))

  return `${core}\n\n${tail.filter(Boolean).join('\n')}`
}

// ── Onboarding prompt ────────────────────────────────────────────────────────
// Used instead of buildInstructions() when the user hasn't completed
// onboarding for this language. The agent runs a warm intake conversation,
// then calls the submit_onboarding_verdict tool to end the intake and
// switch to normal tutoring.
//
// 2026-07-10, learner-field spec §6.5 (docs/plans/2026-07-09-learner-field-
// design.md): the level probe is no longer "ask them to say a few words,
// then the model guesses a CEFR letter from vibes." It's now a genuine
// staircase — the tutor actively elicits target-language PRODUCTION across
// increasing difficulty, starting from the most common words in the
// language and climbing until the learner struggles. Each attempt is a
// normal conversation turn, graded by the exact same processor pipeline as
// regular tutoring (echo-gated, provenance='probe' — see runProcessor's
// onboarding flag in tutor-event-driven.ts) — real evidence, not a
// self-declared verdict. level-inference.ts's coverage-curve inference
// reads that evidence directly once the tool ends the intake; there's
// nothing left for the LLM to "commit."
//
// Design principles:
//   - Feels like a conversation, not a form or a test
//   - Three things to capture: background, goals, a real language sample
//   - If they say "I know zero", skip straight to teaching the first few
//     words instead — that IS the first probe rung, just starting at zero
//   - Ends with a tool call, not text the TTS could read aloud
//   - Short — 5-8 turns max, then hand off

export interface OnboardingPromptContext {
  targetLanguage: string;   // "Russian"
  nativeName: string;       // "Русский"
  nativeLanguage: string;   // "English"
  existingData?: {          // partial data already captured (e.g. from UI form)
    priorStudy?: string;
    studyDetails?: string;
    goals?: string[];
    goalDetails?: string;
    selfRatedLevel?: string;
  };
  /**
   * Real words from validated frequency_rank data, one per difficulty band
   * (see lib/onboarding.ts's getOnboardingLadder) — concrete rungs for the
   * staircase instead of leaving word selection to the model's own sense
   * of "common words." Empty for languages without frequency backfill yet
   * (spec §9) — the prompt falls back to unanchored phrasing in that case.
   */
  ladderWords?: Array<{ lemma: string; translation: string; rank: number }>;
}

export function buildOnboardingInstructions(ctx: OnboardingPromptContext): string {
  const { targetLanguage, nativeLanguage, existingData, ladderWords } = ctx;

  const ladderLine = ladderWords && ladderWords.length > 0
    ? `Real rungs to climb, easiest first (don't recite this list — use it to pick natural moments to ask for each): ${ladderWords.map((w) => `"${w.lemma}" (${w.translation})`).join(' → ')}. If they clear the hardest one, go ahead and reach a little past it on your own — this is just a floor, not a ceiling.`
    : `Start with the most basic, everyday ${targetLanguage} you can think of ("how do you say hello?", "can you count to five?", "what's 'water'?") and climb from there on your own judgment.`;

  const alreadyKnow: string[] = [];
  if (existingData?.priorStudy && existingData.priorStudy !== 'none') {
    alreadyKnow.push(`prior study: ${existingData.priorStudy}${existingData.studyDetails ? ` (${existingData.studyDetails})` : ''}`);
  }
  if (existingData?.goals?.length) {
    alreadyKnow.push(`goals: ${existingData.goals.join(', ')}`);
  }
  if (existingData?.selfRatedLevel) {
    alreadyKnow.push(`self-rated level: ${existingData.selfRatedLevel}`);
  }
  const knownContext = alreadyKnow.length > 0
    ? `\nThe user already told us: ${alreadyKnow.join('; ')}. Don't re-ask what you already know.`
    : '';

  return `You are a friendly language tutor starting a first session with a new ${targetLanguage} learner.

Your job right now is NOT to teach — it's to understand who they are and get a real sample of what they can actually do. Have a short, warm conversation (5-8 turns) to find out:

1. **Background** — Have they studied ${targetLanguage} before? Where, how long, how far did they get? (Duolingo, classes, lived there, heritage speaker, total beginner — all valid)
2. **Goals** — Why are they learning? Travel, work, heritage, media (shows/music), academic, or something else?
3. **The staircase** — this is the real assessment, and it's a game, not a quiz. Ask them to actually SAY things in ${targetLanguage}, out loud, starting easy and climbing. If they get one easily, immediately go a notch harder. If they hesitate or miss one, back off a notch and confirm they're solid there, then stop climbing — you've found their edge. Total: 4-6 rungs is plenty. If they say they know zero, skip the ladder and just teach them one or two words right now instead — that IS the first rung, just starting from nothing. ${ladderLine}
${knownContext}

Tone: warm, curious, zero pressure — frame it as "let's see how far we get," not a test with a score. This is a conversation. Ask one thing at a time. React to what they say before asking the next question. Every attempt they make, even a wrong one, is useful — don't skip the ladder just because early background chat suggested they're a beginner or advanced; the actual attempts are what matters, self-reports are often wrong.

Language: speak in ${nativeLanguage} for the background/goals part. Switch into ${targetLanguage} for the staircase itself — that's the whole point, you need them actually producing it, not talking about it.
${NATIVE_SCRIPT_LINE[targetLanguage] ? `\n${NATIVE_SCRIPT_LINE[targetLanguage]}\n` : ''}

When you've got background + goals + a real sense of where the ladder broke (or confirmed they're at zero), end the conversation naturally — something like "Nice, I've got a good feel for where you're at. Let's get started!" — then call the submit_onboarding_verdict tool. Do NOT call the tool until you've actually run the staircase, and do NOT call it mid-conversation.

selfRatedLevel is just what THEY think, for your own context — it does not set anything. Their actual level comes from how they performed on the staircase, not from this field or from your own guess.`;
}
