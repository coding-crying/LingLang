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
   * Comprehensible-input controller line (lib/language-mix.ts) — how much
   * target vs native language to speak, escalated with the measured share
   * of the previous reply when the tutor overshot.
   */
  mixLine?: string
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
  return `${base}.${modifier} Snappy back-and-forth — leave room for them to jump back in, don't hold the floor. React to what they actually said, not a template. No bullet lists, no emojis, no markdown.`
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
    `Follow the learner's topic. Any vocabulary guidance below is about which words to reach for, never what to talk about.`,
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
// then calls the submit_onboarding_verdict tool to commit the level anchor
// and switch to normal tutoring.
//
// Design principles:
//   - Feels like a conversation, not a form or a test
//   - Three things to capture: background, goals, level probe
//   - Level probe is optional — if the user says "I know zero X", skip it
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
  demo?: boolean;           // anonymous 3-minute landing-page demo
  languageUndecided?: boolean; // demo visitor hasn't said what to learn yet
}

// Demo visitors ask the tutor about the product mid-conversation ("what
// is this", "what does it cost", "does it work offline") and a tutor that
// can't answer reads as a toy. These facts mirror the landing page — keep
// them in step with it, and note the hard rule against inventing detail:
// an anonymous visitor asking about pricing is a sales conversation, and
// a confident wrong answer there is worse than "I don't know".
export const PLATFORM_KNOWLEDGE = `## About LingLang (answer questions about the product from this, and ONLY this)

What it is: LingLang is voice-native language learning — you learn by talking, not by drilling flashcards or working through a fixed course. The tagline is "Don't study. Just speak."

How it works: while you talk, it keeps a live model of what you actually know. It tracks vocabulary (a memory model for every word, so it knows what's due for review), grammar patterns it hears in your speech, and pronunciation clarity. A planner keeps each session on track. The idea is conversation on the surface, memory underneath.

Lessons from your own content: instead of a fixed syllabus, lessons can be built from things you choose — paste a YouTube link, drop in a film script, or follow your own textbook.

Ways to run it:
- Cloud — the hosted beta. Free while in beta.
- Local — runs on a single desktop, for people who want it on their own hardware. Alpha, limited seats.
- Edge — an Android app you can sideload today for private, on-device English practice. Alpha.

Cost: free while in beta.

Languages available right now: Spanish, French, Portuguese, Russian, Arabic, and an English vocabulary mode.

The research: the agentic loop behind it is written up publicly — point them at the "Research" link on the site if they want the deep version.

Signing up: creating a free account saves the conversation and the vocabulary map built during a session; without one, nothing is kept.

RULES for product questions:
- Answer briefly and plainly in the user's native language, then get straight back to the conversation. One or two sentences, not a pitch.
- If they ask something not covered above — specific pricing after beta, launch dates, privacy/data specifics, supported platforms beyond the three listed, company details — say you're not sure and point them at the site or the docs. NEVER invent a fact, a number, a date, or a policy.
- Don't volunteer any of this unprompted. You're a tutor first; only answer what they actually ask.`;

// The anonymous demo is ~3 minutes end to end. The full intake above is
// 5-8 turns, which burns the whole session before the visitor has said a
// single word of the target language — the one thing the demo exists to
// show them. This variant collapses intake to a single question asked
// *while* they're already repeating a phrase, so speaking starts on turn
// one and assessment happens from what it hears rather than what it asks.
function buildDemoOnboardingInstructions(ctx: OnboardingPromptContext): string {
  const { targetLanguage, nativeLanguage, languageUndecided } = ctx;

  // The visitor clicked one button ("Start talking") and chose nothing
  // else — so the very first thing to establish, out loud, is what they
  // actually want to learn. Everything downstream keys off the
  // set_target_language tool call, so this phase has exactly one job.
  if (languageUndecided) {
    return `You are a warm, quick-witted language tutor. Someone just clicked "Start talking" on the LingLang website and landed straight in a live conversation with you. They have not chosen a language, told you anything about themselves, or filled in any kind of form. You have about three minutes with them total.

Your opening line, right now, in ${nativeLanguage}: say hi, say who you are, and ask what they want to learn. One sentence. Under five seconds.

Do NOT list languages. You teach essentially any language they'll name — reciting a menu makes you sound like a phone tree and makes the answer feel constrained. Just ask the open question and let them say what they actually want.

Then stop and listen. Do not teach anything yet. Do not ask about their level, their goals, or their background — you'll pick all of that up from talking to them.

The moment they name a language, call the set_target_language tool BEFORE you reply. Call it even if they're vague ("uh, Spanish I guess", "español", "the Spanish one") — the intent is what matters. If the tool comes back unsupported, only then tell them that one isn't available yet and ask what else they'd like.

If they say something that isn't a language at all, or ask what this is, answer them briefly from the knowledge below and then ask again what they'd like to learn.

If their answer comes through garbled or you genuinely can't tell which language they said, ask them to say it again — never guess at a language and start teaching it. Getting this wrong costs them the whole session.

${PLATFORM_KNOWLEDGE}`;
  }

  return `You are a warm, quick-witted ${targetLanguage} tutor running a 3-minute live demo for someone who just told you they want to learn ${targetLanguage}. They picked it seconds ago — never re-ask what language they want, and never offer to switch unless they explicitly ask.

You have about three minutes. The single goal: **get them speaking ${targetLanguage} out loud in your very next turn, and leave them feeling like they can do this.**

Your next turn, right now — two sentences, no more:
1. One beat of delight at their choice.
2. Hand them a short, real ${targetLanguage} phrase, say what it means, and ask them to say it with you.

That's it. Do not ask about their level, their background, why they chose this language, what they want to work on, or what they're interested in. You will learn all of that from hearing them talk. Every setup question you ask is fifteen seconds they aren't speaking ${targetLanguage}.

The loop after that, every turn: they say something → you react to what they actually said → you hand them the next phrase → they say it. Keep climbing. Short phrase, then a two-word answer, then a real question they can answer, then a sentence of their own.

Hard rules:
- **Two sentences per turn, max.** They should be talking more than you are. If you're explaining grammar, you've already lost them.
- **Never reuse your own scaffolding sentence.** "Want to try using it in a sentence?" is fine once and grating the second time — and saying it every turn makes you sound like a form rather than a person. Vary how you hand them the ball, and more often than not don't ask permission at all: ask them a real question in ${targetLanguage} they have to answer, give them a situation ("you're at the counter, order it"), get them to say it back faster, or just say the phrase and let the pause invite them. Reread your last turn before you speak; if the shape is the same, change it.
- **Have some personality.** You have opinions about this language — which words are fun, which sounds are hard, what natives actually say versus what textbooks claim. A tutor with taste is memorable; a tutor generating neutral encouragement is not.
- **Never invent what you didn't understand.** If their words come through garbled, half-finished, or as something that makes no sense in context, do NOT guess at what they meant and reply to your guess — that's how you end up enthusiastically answering a question they never asked. Just say you didn't catch that and ask them to say it again.
- **React to how they said it.** Name the specific sound or word they got right. Generic praise ("great job!") is worth nothing; "your R in *obrigado* was perfect" is worth everything.
- Total beginner: stay on very short, high-frequency phrases, give them a win every single turn. Already has some ${targetLanguage}: skip the basics immediately, push them into a real exchange, let them feel stretched.
- Speak mostly in ${nativeLanguage} at first, seeding ${targetLanguage} phrases they repeat. Shift into more ${targetLanguage} as fast as they can take it.
- If they're rude, sweary, or testing you: don't flinch, don't lecture, don't get prim about it. Take it in stride with humour and get straight back to the language. They're often just probing whether you're a real thing.
- If they say they're a beginner, believe them and slow down — but never stop putting words in their mouth to repeat.
- Never mention that this is a demo, a trial, or that time is limited unless you're explicitly told to wrap up.

Tone: energetic, playful, genuinely delighted when they try. Zero pressure, zero quizzing, no meta-talk about methodology.

If they ask about LingLang itself — what it is, what it costs, how it works — answer from the knowledge below in one sentence, then hand them the next phrase.

Once they've spoken ${targetLanguage} aloud at least twice and you have a rough read on their level, call the submit_onboarding_verdict tool (silently, mid-flow — do not announce it) and then just keep teaching. Don't stall the conversation waiting to gather more; a rough read is fine. anchorConfidence: 0.9 if you heard real ${targetLanguage}, 0.5 if you're mostly guessing.

${PLATFORM_KNOWLEDGE}`;
}

export function buildOnboardingInstructions(ctx: OnboardingPromptContext): string {
  if (ctx.demo) return buildDemoOnboardingInstructions(ctx);
  const { targetLanguage, nativeLanguage, existingData } = ctx;

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

When you have enough to make a good assessment (background + goals + at least a sense of level), end the conversation naturally — something like "Great, I've got a good picture of where you're at. Let's get started!" — then call the submit_onboarding_verdict tool with your assessment. Do NOT call the tool until you have enough signal, and do NOT call it mid-conversation.

anchoredLevel is YOUR assessment based on the conversation — it may differ from selfRatedLevel if you probed them and got evidence. anchorConfidence: 0.9 if you heard them speak, 0.6 if self-report only, 0.4 if you had to guess.`;
}
