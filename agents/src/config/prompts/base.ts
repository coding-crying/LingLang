// Conversation prompt — adaptive, signal-driven.
//
// 2026-06-30: Replaced static level-only adaptation with a multi-signal
// adaptive composition. The prompt is now built from:
//   - Persona (per language, from languages.ts)
//   - Level (CEFR) — sets response length/complexity
//   - Adaptive signals (session phase, error density, user engagement,
//     roast tolerance, register, pacing)
//   - DB context (words due/new, level)
//   - Recent turn analysis (errors, hints, planner's nudge)
//
// All signals are computed in tutor-event-driven.ts and passed in via
// AdaptiveContext. The prompt builder is pure — no DB, no LLM, no I/O.

export interface AdaptiveContext {
  /** What part of the session we're in. Affects scaffolding vs. flow. */
  sessionPhase: 'opening' | 'warmup' | 'flow' | 'wrapup'
  /** Completed turns so far. */
  turnCount: number
  /** Errors per turn in last 3 turns, normalized 0-1. */
  errorDensity: number
  /** Average words per user turn in last 3 turns. */
  avgUserTurnWords: number
  /** From user-style EMA — how much roast does the user tolerate? */
  roastTolerance: 'tolerant' | 'neutral' | 'skeptical'
  /** From user-style EMA — formality register. */
  register: 'formal' | 'casual' | 'profane'
  /** From user-style EMA — response rhythm. */
  pacing: 'fast' | 'medium' | 'slow'
}

export interface PromptContext {
  targetLanguage: string
  nativeName: string
  nativeLanguage: string
  userLevel: string
  persona: string
  initialContext: string
  mode?: 'voice' | 'text'
  recentErrors?: string
  grammarHints?: string
  goalUpdate?: string
  styleDirective?: string
  wordsDue?: string
  wordsNew?: string
  targetRatio?: number
  previousSessionContext?: string | null
  /** Optional: adaptive signals for prompt composition. */
  adaptive?: AdaptiveContext
}

const LEVEL_RATIOS: Record<string, number> = {
  PRE_A1: 0.15,
  ZERO: 0.15,
  NONE: 0.15,
  A1: 0.30,
  A2: 0.50,
  B1: 0.70,
  B2: 0.85,
  C1: 0.95,
  C2: 1.00,
  BEGINNER: 0.30,
  INTERMEDIATE: 0.65,
  ADVANCED: 0.95,
}

export function ratioForLevel(userLevel: string, baseRatio?: number): number {
  const key = (userLevel || '').toUpperCase().trim()
  const fromLevel = LEVEL_RATIOS[key]
  if (fromLevel !== undefined) {
    // Level ratio wins when lower (beginners get less target language),
    // base ratio wins when higher (advanced default).
    return baseRatio !== undefined ? Math.min(fromLevel, baseRatio) : fromLevel
  }
  return baseRatio ?? 0.5
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
  // Level-based baseline
  let base: string
  if (level === 'pre_a1' || level === 'a1') {
    base = '1 short sentence'
  } else if (level === 'a2' || level === 'b1') {
    base = '1-2 sentences with sub-clauses'
  } else {
    base = '2-4 sentences at full complexity'
  }
  // Pacing modifier
  let modifier = ''
  if (pacing === 'fast') {
    modifier = ' Be terse — they want progress, not monologue.'
  } else if (pacing === 'slow') {
    modifier = ' Give them room — no rush to the next turn.'
  }
  return `${base}.${modifier} React to what they actually said, not a template. No bullet lists, no emojis, no markdown.`
}

/**
 * Roast line: modulates how much wit/criticism the persona applies.
 * Tolerant users get the full roast. Skeptical users get calibrated
 * honesty without the bite. Default is "medium" roast.
 */
function computeRoastLine(
  tolerance: AdaptiveContext['roastTolerance'],
  basePersona: string,
): string {
  // Persona already encodes roast level (e.g. PT persona is "sharp Lisbon roast").
  // The adaptive line nudges the model to calibrate based on user feedback.
  if (tolerance === 'tolerant') {
    return 'Roast freely — they can take it. If they push back, you\'ll hear it.'
  }
  if (tolerance === 'skeptical') {
    return 'Calibrate honesty: be sharp, but earn trust first. Don\'t lead with the roast.'
  }
  return 'Roast with charm. Read the room — if they got quiet, soften.'
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
 * Register line: how formal to be in the target language.
 * 'formal' → no contractions, full forms. 'casual' → everyday grammar.
 * 'profane' → mirror the user's tone without forcing it.
 */
function computeRegisterLine(
  register: AdaptiveContext['register'],
  targetLanguage: string,
): string {
  if (register === 'formal') {
    return `In ${targetLanguage}, use formal grammar — no contractions, full forms.`
  }
  if (register === 'profane') {
    return `Mirror their register — if they swear, you can too, sparingly. Don't force it.`
  }
  return `In ${targetLanguage}, use everyday grammar and contractions.`
}

/**
 * Opening line: only rendered in 'opening' phase. Lighter scaffolding,
 * sets the tone. Different from "Current angle" (planner's mid-session guidance).
 */
function computeOpeningLine(
  phase: AdaptiveContext['sessionPhase'],
  previousSessionContext: string | null | undefined,
  level: string,
): string {
  if (phase !== 'opening') return ''
  if (previousSessionContext) {
    return `Opening: pick up from last session naturally — they know what they were working on.`
  }
  if (level === 'pre_a1' || level === 'a1') {
    return `Opening: start with something they can answer in one word. Don't ask "how are you" in the target — use it to model the first exchange.`
  }
  return `Opening: ask one simple question in the target language to set the scene.`
}

/**
 * Build the conversation agent's system prompt.
 *
 * Design:
 *   - Persona line 0 (highest attention).
 *   - Level + adaptive length line.
 *   - Frontier mechanic (known words vs. new).
 *   - Adaptive context (phase, engagement, error treatment, register, roast).
 *   - DB signals (words due/new, errors, hints, planner angle).
 *
 * The prompt is composed dynamically. No two users get the same prompt —
 * the level, phase, error density, and style all shape it.
 */
export function buildInstructions(context: PromptContext): string {
  const levelKey = (context.userLevel || '').toLowerCase()
  const adaptive = context.adaptive ?? defaultAdaptive()

  // ── Frontier ratio ─────────────────────────────────────────────
  const dueCount = (context.wordsDue?.split(',').filter(s => s.trim()).length ?? 0)
  const newCount = (context.wordsNew?.split(',').filter(s => s.trim()).length ?? 0)
  const fallbackRatio = ratioForLevel(context.userLevel, context.targetRatio)
  const frontierRatio = (dueCount + newCount) > 0
    ? dueCount / (dueCount + newCount)
    : fallbackRatio

  const frontierPct = Math.round(frontierRatio * 100)
  let frontierLine: string
  if ((dueCount + newCount) > 0) {
    if (frontierPct >= 70) {
      frontierLine = `Stick to words they already know (${dueCount}). Save new ones for when the user needs them.`
    } else if (frontierPct >= 40) {
      frontierLine = `Mix known (${dueCount}) and new (${newCount}). Each new word should be reachable from a known word in the same sentence.`
    } else {
      frontierLine = `Lead with new words (${newCount}) — they have enough known (${dueCount}) to scaffold. Build every new sentence on a known base.`
    }
  } else {
    frontierLine = `No due/new vocabulary yet — just react to what they said.`
  }

  // ── Adaptive lines ─────────────────────────────────────────────
  const lengthLine = computeLengthLine(levelKey, adaptive.sessionPhase, adaptive.pacing)
  const roastLine = computeRoastLine(adaptive.roastTolerance, context.persona)
  const errorLine = computeErrorTreatment(adaptive.errorDensity, context.recentErrors?.trim() || '')
  const registerLine = computeRegisterLine(adaptive.register, context.targetLanguage)
  const openingLine = computeOpeningLine(adaptive.sessionPhase, context.previousSessionContext, levelKey)

  // ── Compose ────────────────────────────────────────────────────
  const lines: string[] = [
    context.persona,
    '',
    `You're chatting with a learner of ${context.targetLanguage}. Level: ${context.userLevel || 'beginner'}. They speak ${context.nativeLanguage} natively.`,
    roastLine,
    registerLine,
  ]

  if (openingLine) {
    lines.push('', openingLine)
  }

  lines.push('', frontierLine)

  if (context.wordsDue?.trim()) {
    lines.push('', `Words they already know — your scaffolding: ${context.wordsDue}`)
  }
  if (context.wordsNew?.trim()) {
    lines.push(`New words to reach for when they're ready: ${context.wordsNew}`)
  }
  if (context.goalUpdate?.trim()) {
    lines.push('', `Current angle: ${context.goalUpdate}`)
  }
  if (errorLine) {
    lines.push('', errorLine)
  }
  if (context.grammarHints?.trim() && context.grammarHints !== 'None') {
    lines.push(`If relevant, drop in: ${context.grammarHints}`)
  }
  if (context.styleDirective?.trim()) {
    lines.push('', `Style: ${context.styleDirective}`)
  }

  if (context.previousSessionContext && !openingLine) {
    // Fold into persona line for high-attention pickup
    lines[0] = `${context.persona} ${context.previousSessionContext}`
  }

  lines.push('', lengthLine)
  return lines.join('\n')
}

function defaultAdaptive(): AdaptiveContext {
  return {
    sessionPhase: 'flow',
    turnCount: 0,
    errorDensity: 0,
    avgUserTurnWords: 5,
    roastTolerance: 'neutral',
    register: 'casual',
    pacing: 'medium',
  }
}

// ── Onboarding prompt ────────────────────────────────────────────────────────
// Used instead of buildInstructions() when the user hasn't completed
// onboarding for this language. The agent runs a warm intake conversation,
// then emits a JSON verdict that the session handler parses to commit the
// level anchor and switch to normal tutoring.
//
// Design principles:
//   - Feels like a conversation, not a form or a test
//   - Three things to capture: background, goals, level probe
//   - Level probe is optional — if the user says "I know zero X", skip it
//   - Ends with a JSON block the session handler can parse
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
}

export function buildOnboardingInstructions(ctx: OnboardingPromptContext): string {
  const { targetLanguage, nativeName, nativeLanguage, existingData } = ctx;

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

Your job right now is NOT to teach — it's to understand who they are and what they need. Have a short, warm conversation (5-8 turns) to find out:

1. **Background** — Have they studied ${targetLanguage} before? Where, how long, how far did they get? (Duolingo, classes, lived there, heritage speaker, total beginner — all valid)
2. **Goals** — Why are they learning? Travel, work, heritage, media (shows/music), academic, or something else?
3. **Level probe** — If they have any prior study, ask them to say a few words or sentences in ${targetLanguage}. React naturally. If they say they know zero, skip this.
${knownContext}

Tone: warm, curious, zero pressure. This is a conversation, not a form. Ask one thing at a time. React to what they say before asking the next question.

Language: speak in ${nativeLanguage} for this intake. You can sprinkle in a word or two of ${targetLanguage} if it feels natural, but don't teach yet.

When you have enough to make a good assessment (background + goals + at least a sense of level), end the conversation naturally — something like "Great, I've got a good picture of where you're at. Let's get started!" — then on the very next line emit this JSON block and nothing else after it:

\`\`\`onboarding_verdict
{
  "priorStudy": "none|self_taught|class|immersion|heritage",
  "studyDetails": "free text or null",
  "goals": ["travel","work","heritage","media","academic","other"],
  "goalDetails": "free text or null",
  "selfRatedLevel": "pre_a1|a1|a2|b1|b2|c1|c2",
  "anchoredLevel": "pre_a1|a1|a2|b1|b2|c1|c2",
  "anchorConfidence": 0.0,
  "anchorEvidence": "one sentence explaining your level estimate"
}
\`\`\`

anchoredLevel is YOUR assessment based on the conversation — it may differ from selfRatedLevel if you probed them and got evidence. anchorConfidence: 0.9 if you heard them speak, 0.6 if self-report only, 0.4 if you had to guess.

Do NOT emit the JSON until you have enough signal. Do NOT emit it mid-conversation.`;
}
