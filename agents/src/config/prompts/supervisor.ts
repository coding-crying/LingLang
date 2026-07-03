/**
 * Planner prompt — produces natural teaching guidance, not rigid JSON.
 *
 * The planner is a background agent that reads the DB and produces a
 * short nudge for the conversation agent. The nudge gets injected into
 * the tutor's system prompt as CURRENT_FOCUS.
 *
 * 2026-07-02: Redesigned per
 * docs/superpowers/specs/2026-07-02-adaptive-loop-redesign-design.md §5.
 * Mandate rewritten from an unactionable "care about enjoyment equally" to
 * a concrete rule fed by an engagement block (turn-length trend, pacing,
 * error-density trend — the same signals the conversation prompt already
 * computes). The planner is also now the sole writer of the learner's
 * style profile (§4) — one free-text line via the existing PERSONA:
 * mechanism, replacing the processor's per-turn style-enum tagging.
 */

// 2026-07-02: rewritten aggressively (user-approved) — the old version spent
// over a third of its ~880 tokens on NOTE/PERSONA/style-profile blocks the
// planner is told to use rarely. Same parser contract (NUDGE:/SUMMARY:/
// NOTE[cat]:/PERSONA: line formats), roughly half the tokens, and the nudge
// guidance is now the headline instead of buried mid-prompt.
export const PLANNER_SYSTEM_PROMPT = `You are the strategist behind a voice language tutor. Every cycle you read the session state and steer the conversation agent with one nudge. You are the only agent that sees the whole session — the conversation agent only sees the last few turns and the latest errors, so your job is direction, not data.

Output — exactly these two lines (NOTE/PERSONA optional, see below):
NUDGE: 1-3 sentences
SUMMARY: 2-3 sentences

NUDGE is strategy. Don't repeat errors or hints the agent already sees. Decide what matters most right now and give an angle: a scenario, a topic shift, a natural way to surface a due word, when to push and when to lighten up. If engagement is dropping (shrinking turns, rising errors), change the angle before the material. Match the level: beginners get basics and support; intermediates get nuance and natural phrasing; advanced learners get register and subtlety. Never build a nudge around function words (pronouns, prepositions, articles) — exposure teaches those. A word stuck in Learning/Relearning needs a different approach, not the same quiz again.

SUMMARY is your memory — it comes back to you next cycle. Capture topics covered, what they struggled with, what clicked, and patterns you noticed.

Session gap: minutes since last session → continue where they left off; hours → light review first; days → warm up with their struggling words before anything new.

NOTE[category]: one sentence — only when you learn something durable and NEW about this learner worth remembering tomorrow. Categories: preference, level, frustration, goal, engagement. Never restate a note already shown to you. Most cycles produce no note.

PERSONA: field=value[, field=value...] — only on clear evidence the current teaching style is wrong for this learner, or to record how they like to be taught (you are the sole writer of that style read). Fields: tone (roast|warm|neutral|formal|drill-sergeant), correctionStyle (immediate|gentle|ignore|end-of-turn), teachingMode (conversational|drill|roleplay|storytelling), personaOverride (free text), extraInstructions (free text — the usual home of a 1-2 sentence style read, e.g. "Terse, likes being teased back, skip pleasantries"). Most cycles produce no persona line.` as const;


export interface PlannerContext {
  /** DB snapshot text (SRS due items, new vocab candidates, etc.) */
  dbContext: string;
  /** Active goal note from the goal-seeking cycle, or null */
  goalNote: string | null;
  /** Recent conversation history (formatted string) */
  recentHistory: string;
  /** Previous nudge text, or null if first run */
  previousNudge: string | null;
  /** How many turns ago the previous nudge was issued, or null if none. */
  previousNudgeAgeTurns: number | null;
  /** Running session summary from last planner cycle */
  runningSummary: string;
  /** Reason this planner invocation was triggered */
  reason: string;
  /** Accumulated signals since the last planner run */
  signals: string[];
  /** Active learner notes (formatted string) */
  notes: string;
  /** Recent session summaries (formatted string) */
  recentSessions: string;
  /** Onboarding state summary — null if complete, string if in-progress/not-started */
  onboardingContext?: string | null;
  /**
   * Engagement block — same signals the conversation prompt already
   * computes, shared here so the planner's mandate is actionable instead
   * of "care about enjoyment" with no inputs.
   */
  engagement: {
    /** Turn-length trend over the last ~6 turns. */
    turnLengthTrend: 'growing' | 'shrinking' | 'steady';
    pacing: 'fast' | 'medium' | 'slow';
    /** Error-density trend over recent processor runs. */
    errorTrend: 'rising' | 'falling' | 'steady';
  };
}

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const signals = ctx.signals.slice(-10).join(', ') || 'none';

  const notesSection = ctx.notes ? `\n${ctx.notes}` : '';
  const sessionsSection = ctx.recentSessions ? `\n${ctx.recentSessions}` : '';
  const summarySection = ctx.runningSummary ? `\nRunning Summary: ${ctx.runningSummary}` : '\nRunning Summary: (first cycle — no summary yet)';

  const nudgeLine = ctx.previousNudge
    ? `Previous nudge (issued ${ctx.previousNudgeAgeTurns ?? '?'} turn(s) ago): ${ctx.previousNudge}`
    : 'No previous nudge — this is the first one.';

  const engagementLine = `Engagement: turn length ${ctx.engagement.turnLengthTrend}, pacing ${ctx.engagement.pacing}, errors ${ctx.engagement.errorTrend}.`;

  return `Reason: ${ctx.reason}
Signals: ${signals}
${engagementLine}

${nudgeLine}

DB state:
${ctx.dbContext}

Goals:
${ctx.goalNote || 'None'}${notesSection}${sessionsSection}${summarySection}

Recent conversation:
${ctx.recentHistory}`;
}
